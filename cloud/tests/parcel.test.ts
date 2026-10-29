import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync,readdirSync} from 'node:fs';
import {validate,descriptionOf,sha256} from '../lib/parcel/contract.ts';
import {ParcelService} from '../lib/parcel/service.ts';
import {handleMcp} from '../lib/parcel/mcp.ts';
import {q,withLease} from '../lib/parcel/db.ts';
import type {Database,Statement} from '../lib/parcel/db.ts';
const catalog={ups:{name:'UPS'},fedex:{name:'FedEx'},swiship:{name:'Amazon (Third Party)'},amzlus:{name:'Amazon'},nullok:{name:'Null',extra_required:null},extra:{name:'Private',extra_required:5}};
const candidate=(i=0)=>({carrier_code:'ups',tracking_number:'1Z'+String(i).padStart(16,'0'),merchant_label:'Example Shop',item_name:'Raincoat',verified:{merchant:true,tracking:true,non_amazon_retail:true,merchant_label_only:true,requires_extra_data:false,item_summary_benign:true}});
class TestDB implements Database {
 raw=new DatabaseSync(':memory:'); failWrites=false;
 constructor(){for(const name of readdirSync(new URL('../drizzle',import.meta.url)).filter(x=>x.endsWith('.sql')).sort())this.raw.exec(readFileSync(new URL('../drizzle/'+name,import.meta.url),'utf8'))}
 prepare(sql:string):Statement {let values:unknown[]=[];const stmt={bind(...args:unknown[]){values=args;return stmt},first:async<T>()=>(this.raw.prepare(sql).get(...values as [])??null) as T|null,all:async<T>()=>({results:this.raw.prepare(sql).all(...values as []) as T[]}),run:async()=>{if(this.failWrites)throw new Error('synthetic storage failure');const result=this.raw.prepare(sql).run(...values as []);return {meta:{changes:Number(result.changes)}}}};return stmt}
 async batch(statements:Statement[]){this.raw.exec('BEGIN IMMEDIATE');try{const results=[];for(const s of statements)results.push(await s.run());this.raw.exec('COMMIT');return results}catch(e){this.raw.exec('ROLLBACK');throw e}}
}
async function setup(options:{active?:boolean,mode?:string}={}) {const db=new TestDB();const now=1800000000000;const calls:{url:string,method:string,body?:string}[]=[];const deliveries:{carrier_code:string,tracking_number:string,description?:string}[]=[];let mode=options.mode??'ok';let postHook:(()=>Promise<void>)|undefined;
 await q(db,'INSERT INTO control(id,migration_digest,verified_at) VALUES(1,?,?)',options.active===false?null:'synthetic-migration',options.active===false?null:now).run();
 const fetcher=async(url:unknown,init?:RequestInit)=>{const u=String(url),method=init?.method??'GET';calls.push({url:u,method,body:init?.body as string|undefined});assert.equal(init?.redirect,'manual');assert.equal(init?.credentials,'omit');if(u.endsWith('supported_carriers.json')){assert.equal(init?.headers,undefined);return Response.json(catalog)}
 assert.equal((init?.headers as Record<string,string>)['api-key'],'synthetic-key');
 if(method==='POST'){const body=JSON.parse(init!.body as string);const row=await q(db,'SELECT status FROM ledger WHERE pair=?',body.carrier_code+':'+body.tracking_number).first<{status:string}>();assert.equal(row?.status,'uncertain');assert.ok(await q(db,"SELECT id FROM quota WHERE kind='add'").first());if(postHook)await postHook();if(mode==='timeout')throw new Error('synthetic timeout');if(mode==='failed')return Response.json({success:false});if(mode==='malformed')return new Response('not json');if(mode!=='stale')deliveries.push(body);return Response.json({success:true});}
 if(mode==='readfailed')return new Response('no',{status:502});return Response.json({success:true,deliveries:deliveries.map(x=>({...x,extra_information:'never retained private data'}))});};
 const config={DB:db,PARCEL_API_KEY:'synthetic-key',PARCEL_WRITES_ENABLED:'true',OWNER_EMAIL_SHA256:await sha256('owner@example.test')};const service=new ParcelService(config,{fetch:fetcher as typeof fetch,now:()=>now});return {db,now,calls,deliveries,service,config,fetcher,setMode:(m:string)=>mode=m,setPostHook:(h:()=>Promise<void>)=>postHook=h};
}
test('strict source candidate schema and privacy rules',()=>{assert.equal(descriptionOf(validate(candidate(),catalog)),'Example Shop: Raincoat');for(const patch of [{email:'private'},{merchant_label:'Amazon'},{merchant_label:'Whole Foods'},{carrier_code:'extra'},{carrier_code:'unknown'},{tracking_number:'ORDER123'},{tracking_number:'TBA1234567890'},{item_name:null},{item_name:'private@example.test'},{item_name:'x'.repeat(41)}])assert.throws(()=>validate({...candidate(),...patch},catalog));const s=candidate();s.item_name='Prescription medicine';assert.equal(descriptionOf(validate(s,catalog)),'Example Shop');s.item_name='Raincoat';s.verified.item_summary_benign=false;assert.equal(descriptionOf(validate(s,catalog)),'Example Shop');assert.doesNotThrow(()=>validate({...candidate(),carrier_code:'amzlus',tracking_number:'TBA1234567890'},catalog));assert.doesNotThrow(()=>validate({...candidate(),carrier_code:'nullok'},catalog));assert.throws(()=>validate({...candidate(),verified:{...candidate().verified,tracking:1}},catalog));assert.throws(()=>validate({...candidate(),verified:{...candidate().verified,raw_email:true}},catalog));});
test('reserve before POST, exact payload, readback and duplicate protection',async()=>{const s=await setup();assert.equal((await s.service.ingest(candidate())).status,'added_and_read_verified');assert.deepEqual(JSON.parse(s.calls.find(c=>c.method==='POST')!.body!),{carrier_code:'ups',tracking_number:candidate().tracking_number,description:'Example Shop: Raincoat'});assert.equal((await s.service.ingest(candidate())).status,'skipped_duplicate_or_pending');assert.equal(s.calls.filter(c=>c.method==='POST').length,1);const st=await s.service.status();assert.equal(st.additions_last_24h,1);assert.equal(st.reads_last_hour,4);assert.ok(!JSON.stringify(s.db.raw.prepare('SELECT * FROM parcel_cache').all()).includes('never retained'));});
for(const mode of ['timeout','failed','malformed'])test(`uncertain ${mode} remains durable across restart, never retries`,async()=>{const s=await setup({mode});await assert.rejects(s.service.ingest(candidate()));const restarted=new ParcelService(s.config,{fetch:s.fetcher as typeof fetch,now:()=>s.now});assert.equal((await restarted.ingest(candidate())).status,'skipped_duplicate_or_pending');assert.equal(s.calls.filter(c=>c.method==='POST').length,1);assert.equal((await restarted.status()).additions_last_24h,1);});
test('cached readback does not falsely confirm or authorize resend',async()=>{const s=await setup({mode:'stale'});assert.equal((await s.service.ingest(candidate())).status,'submitted_pending_reconciliation');assert.equal((await s.service.ingest(candidate())).status,'skipped_duplicate_or_pending');s.deliveries.push({carrier_code:'ups',tracking_number:candidate().tracking_number,description:'Example Shop: Raincoat'});await s.service.verify();assert.equal((await q(s.db,'SELECT status FROM ledger').first<{status:string}>())?.status,'seen');});
test('concurrent same or different requests cannot write concurrently',async()=>{for(const second of [candidate(),candidate(2)]){const s=await setup();let unblock:()=>void=()=>{};let entered:()=>void=()=>{};const ready=new Promise<void>(r=>entered=r);s.setPostHook(async()=>{entered();await new Promise<void>(r=>unblock=r)});const first=s.service.ingest(candidate());await ready;await assert.rejects(s.service.ingest(second),/importer_busy/);unblock();await first;assert.equal(s.calls.filter(c=>c.method==='POST').length,1)}});
test('20 failed additions exhaust rolling daily allowance',async()=>{const s=await setup({mode:'timeout'});for(let i=0;i<20;i++)await assert.rejects(s.service.ingest(candidate(i)));await assert.rejects(s.service.ingest(candidate(21)),/daily_add_limit/);assert.equal(s.calls.filter(c=>c.method==='POST').length,20);assert.equal((await s.service.status()).additions_last_24h,20);});
test('20 read reservations include failures and block 21st',async()=>{const s=await setup({mode:'readfailed'});for(let i=0;i<10;i++)await assert.rejects(s.service.verify());await assert.rejects(s.service.verify(),/hourly_read_limit/);assert.equal((await s.service.status()).reads_last_hour,20);assert.equal(s.calls.length,10);});
test('durable lease is never stolen on elapsed time',async()=>{const s=await setup();await q(s.db,'UPDATE control SET token=?,locked_at=? WHERE id=1','crashed-owner',1).run();await assert.rejects(s.service.verify(),/importer_busy/);assert.equal(s.calls.length,0);assert.equal((await s.service.status()).recovery_required,true);});
test('storage failure prevents outbound calls',async()=>{const s=await setup();s.db.failWrites=true;await assert.rejects(s.service.ingest(candidate()));assert.equal(s.calls.filter(c=>c.method==='POST').length,0)});
test('missing key, migration and cutover gates fail before network',async()=>{const s=await setup({active:false});await assert.rejects(s.service.ingest(candidate()),/migration_or_connection/);s.config.PARCEL_API_KEY='';await assert.rejects(s.service.ingest(candidate()),/key_not_configured/);s.config.PARCEL_API_KEY='synthetic-key';s.config.PARCEL_WRITES_ENABLED='false';await assert.rejects(s.service.ingest(candidate()),/cutover_not_enabled/);assert.equal(s.calls.length,0);});
test('migration requires explicit gate; verifies pairs and exact attempt counts, idempotent',async()=>{const s=await setup({active:false});const input={seen:['fedex:123456789012'],uncertain:['fedex:123456789013'],attempts:[s.now-1000,s.now-2000],reads:[s.now-500]};await assert.rejects(s.service.importLedger(input),/migration_not_authorized/);s.config.PARCEL_WRITES_ENABLED='false';(s.config as Record<string,unknown>).PARCEL_MIGRATION_ALLOWED='true';await assert.rejects(s.service.importLedger(input),/connection_not_verified/);await s.service.verify();const result=await s.service.importLedger(input);assert.equal(result.status,'migration_verified');assert.equal((await s.service.importLedger(input)).status,'migration_already_verified');assert.equal((await s.service.status()).additions_last_24h,2);assert.equal((await s.service.status()).writes_enabled,false);assert.equal(s.calls.filter(c=>c.method==='POST').length,0);});
function request(method:string,args:unknown={},headers:Record<string,string>={}){return new Request('https://private.example/mcp',{method:'POST',headers:{'content-type':'application/json',...headers},body:JSON.stringify({jsonrpc:'2.0',id:1,method,...(method==='tools/call'?{params:args}:{})})})}
test('unauthenticated, service-only and wrong-owner calls fail closed',async()=>{const s=await setup();for(const h of [{},{'OAI-Sites-Authorization':'Bearer synthetic-service'},{'oai-authenticated-user-id':'other','oai-authenticated-user-email':'other@example.test'}]){const r=await handleMcp(request('tools/call',{name:'parcel_status',arguments:{}},h as Record<string,string>),s.config);assert.ok([401,403].includes(r.status));assert.ok(!JSON.stringify(await r.json()).includes('synthetic-key'))}assert.equal(s.calls.length,0)});
test('authorized initialization, static discovery, status; arbitrary arguments rejected',async()=>{const s=await setup();const h={'oai-authenticated-user-id':'owner-site-id','oai-authenticated-user-email':'owner@example.test'};for(const method of ['initialize','tools/list']){const r=await handleMcp(request(method,{},h),s.config);assert.equal(r.status,200);const body=JSON.stringify(await r.json());assert.ok(!body.includes('synthetic-key'));assert.ok(!body.includes('owner@example.test'));assert.ok(!body.includes('1Z000000'))}const r=await handleMcp(request('tools/call',{name:'parcel_status',arguments:{}},h),s.config);assert.equal(((await r.json()) as {result:{isError?:boolean}}).result.isError,undefined);const bad=await handleMcp(request('tools/call',{name:'parcel_status',arguments:{secret:'do not store'}},h),s.config);assert.equal(((await bad.json()) as {result:{isError?:boolean}}).result.isError,true)});
test('existing short placeholder tracking does not block refresh',async()=>{const s=await setup();s.deliveries.push({carrier_code:'pholder',tracking_number:'12345'});await s.service.verify();assert.ok(await q(s.db,'SELECT pair FROM ledger WHERE pair=?','pholder:12345').first());});
test('migration marker failure can resume identical snapshot without double quota',async()=>{const s=await setup({active:false});s.config.PARCEL_WRITES_ENABLED='false';(s.config as Record<string,unknown>).PARCEL_MIGRATION_ALLOWED='true';await s.service.verify();const original=s.db.prepare.bind(s.db);let fail=true;s.db.prepare=(sql)=>{if(sql.startsWith('UPDATE control SET migration_digest')&&fail){fail=false;throw new Error('synthetic marker failure')}return original(sql)};const snapshot={seen:['pholder:12345'],uncertain:[],attempts:[s.now],reads:[]};await assert.rejects(s.service.importLedger(snapshot));assert.equal((await s.service.status()).migration_verified,false);assert.equal((await s.service.importLedger(snapshot)).status,'migration_verified');assert.equal((await s.service.status()).additions_last_24h,1);});

test('brief is a single SELECT with no network, mutation, quota or lease change',async()=>{
 const s=await setup();await s.service.ingest(candidate());
 const before=s.db.raw.prepare('SELECT * FROM control').all();const quota=s.db.raw.prepare('SELECT * FROM quota').all();
 const n=s.calls.length;const original=s.db.prepare.bind(s.db);const sqls:string[]=[];
 s.db.prepare=(sql)=>{sqls.push(sql);assert.match(sql.trim(),/^SELECT /);return original(sql)};
 const r=await s.service.brief();assert.equal(r.freshness,'fresh');assert.equal(r.shipments.length,1);
 assert.equal(r.shipments[0].company,'Example Shop');assert.equal(r.shipments[0].item,'Raincoat');
 assert.equal(r.shipments[0].label_source,'trusted_validated_ingest');assert.equal(r.shipments[0].status,'unknown');
 assert.equal(s.calls.length,n);assert.equal(sqls.length,1);assert.deepEqual(s.db.raw.prepare('SELECT * FROM control').all(),before);assert.deepEqual(s.db.raw.prepare('SELECT * FROM quota').all(),quota);
 assert.ok(!JSON.stringify(r).includes(candidate().tracking_number));
});
test('arbitrary account descriptions never create labels; documented status enum only',async()=>{
 const s=await setup();s.deliveries.push({carrier_code:'ups',tracking_number:candidate().tracking_number,description:'Private person: Prescription medicine',status_code:4,date_expected:'private@example.test'} as never);
 await s.service.verify();const r=await s.service.brief();assert.equal(r.shipments[0].status,'out_for_delivery');assert.equal(r.shipments[0].company,null);assert.equal(r.shipments[0].item,null);
 assert.ok(!JSON.stringify(r).includes('Private'));assert.ok(!JSON.stringify(r).includes('date_expected'));assert.equal(s.db.raw.prepare('SELECT count(*) n FROM brief_labels').get()!.n,0);
 (s.deliveries[0] as unknown as {status_code:unknown}).status_code='4';await s.service.verify();assert.equal((await s.service.brief()).shipments[0].status,'unknown');
});
test('safe labels require matched digest; unsafe or unattested items remain omitted',async()=>{
 for(const [item,attested] of [['Prescription medicine',true],['Raincoat',false]] as const){const s=await setup();const c=candidate();c.item_name=item;c.verified.item_summary_benign=attested;await s.service.ingest(c);assert.equal((await s.service.brief()).shipments[0].item,null);assert.equal(s.db.raw.prepare('SELECT item FROM brief_labels').get()!.item,null);}
 const s=await setup();await s.service.ingest(candidate());s.deliveries[0].description='Edited account text';await s.service.verify();assert.equal((await s.service.brief()).shipments[0].company,null);
});
test('brief freshness boundaries, future timestamps, missing cache and valid empty cache',async()=>{
 const s=await setup();assert.equal((await s.service.brief()).reason,'cache_missing');await s.service.verify();const at=s.now;
 const read=(now:number)=>new ParcelService(s.config,{now:()=>now,fetch:()=>{throw Error('network forbidden')}}).brief();
 assert.equal((await read(at)).total_cached,0);assert.equal((await read(at+7200000)).freshness,'fresh');
 assert.equal((await read(at+7200001)).freshness,'stale');assert.equal((await read(at+86400000)).freshness,'stale');
 const expired=await read(at+86400001);assert.equal(expired.freshness,'unavailable');assert.equal(expired.total_cached,null);assert.deepEqual(expired.shipments,[]);
 assert.equal((await read(at-1)).reason,'cache_timestamp_invalid');
});
test('brief labels expire without read-time writes and are pruned on existing refresh',async()=>{
 const s=await setup();await s.service.ingest(candidate());await q(s.db,'UPDATE brief_labels SET attested_at=?',s.now-30*86400000).run();
 const r=await s.service.brief();assert.equal(r.shipments[0].company,null);assert.equal(s.db.raw.prepare('SELECT count(*) n FROM brief_labels').get()!.n,1);
 await s.service.verify();assert.equal(s.db.raw.prepare('SELECT count(*) n FROM brief_labels').get()!.n,0);
});
test('brief output is bounded and no old import label is retroactively attested',async()=>{
 const s=await setup();for(let i=0;i<105;i++)s.deliveries.push({carrier_code:'ups',tracking_number:candidate(i).tracking_number,description:'Example Shop: Raincoat'});
 await s.service.verify();assert.equal((await s.service.ingest(candidate())).status,'skipped_duplicate_or_pending');
 const r=await s.service.brief();assert.equal(r.total_cached,105);assert.equal(r.shipments.length,100);assert.equal(r.truncated,true);assert.ok(r.shipments.every(x=>x.company===null));
});
test('brief MCP is owner-only, strict, and statically read-only',async()=>{
 const s=await setup();for(const h of [{},{'OAI-Sites-Authorization':'Bearer service'},{'oai-authenticated-user-id':'wrong','oai-authenticated-user-email':'wrong@example.test'}]){const r=await handleMcp(request('tools/call',{name:'parcel_brief_summary',arguments:{}},h as Record<string,string>),s.config);assert.ok([401,403].includes(r.status));}
 const h={'oai-authenticated-user-id':'owner','oai-authenticated-user-email':'owner@example.test'};
 const ok=await handleMcp(request('tools/call',{name:'parcel_brief_summary',arguments:{}},h),s.config,{now:()=>s.now,fetch:s.fetcher as typeof fetch});assert.equal((await ok.json() as {result:{isError?:boolean}}).result.isError,undefined);
 const bad=await handleMcp(request('tools/call',{name:'parcel_brief_summary',arguments:{refresh:true}},h),s.config);assert.equal((await bad.json() as {result:{isError?:boolean}}).result.isError,true);
 const discovery=await handleMcp(request('tools/list'),s.config);const tool=(await discovery.json() as {result:{tools:{name:string,annotations:{readOnlyHint:boolean}}[]}}).result.tools.find((t:{name:string})=>t.name==='parcel_brief_summary');assert.equal(tool!.annotations.readOnlyHint,true);assert.equal(s.calls.length,0);
});
test('brief works during held recovery lease without clearing or renewing it',async()=>{
 const s=await setup();await s.service.verify();await q(s.db,'UPDATE control SET token=?,locked_at=?','held-lease',1).run();
 assert.equal((await s.service.brief()).freshness,'fresh');assert.equal((await q(s.db,'SELECT token FROM control').first<{token:string}>())!.token,'held-lease');
});
test('active coverage distinguishes unknown pre-upgrade rows, no active, truncation and stale data',async()=>{
 const s=await setup();await s.service.verify();assert.equal((await s.service.brief()).coverage.can_state_no_active,true);
 await q(s.db,'INSERT INTO parcel_cache(pair,description_hash,status_code) VALUES (?,?,?)','ups:1Z0000000000000000','hash',0).run();
 let r=await s.service.brief();assert.equal(r.coverage.active_membership_unknown_count,1);assert.equal(r.coverage.can_state_no_active,false);assert.equal(r.shipments[0].is_active,null);
 await q(s.db,'UPDATE parcel_cache SET is_active=0').run();r=await s.service.brief();assert.equal(r.coverage.can_state_no_active,true);assert.equal(r.coverage.unlabeled_count,1);
 await q(s.db,'UPDATE parcel_cache SET is_active=1').run();r=await s.service.brief();assert.equal(r.coverage.active_cached_count,1);assert.equal(r.coverage.can_state_no_active,false);
 await q(s.db,'UPDATE parcel_cache SET is_active=0').run();const stale=new ParcelService(s.config,{now:()=>s.now+7200001});assert.equal((await stale.brief()).coverage.can_state_no_active,false);
});
test('refresh tracks active endpoint membership separately from status and prioritizes exceptions',async()=>{
 const s=await setup();const recent=[{carrier_code:'ups',tracking_number:candidate(0).tracking_number,status_code:0},{carrier_code:'ups',tracking_number:candidate(1).tracking_number,status_code:7}];
 const active=[recent[1]];const fetcher=async(url:unknown)=>Response.json({success:true,deliveries:String(url).includes('filter_mode=active')?active:recent});
 const service=new ParcelService(s.config,{now:()=>s.now,fetch:fetcher as typeof fetch});await service.verify();const r=await service.brief();assert.equal(r.coverage.active_cached_count,1);assert.equal(r.shipments[0].status,'exception');assert.equal(r.shipments[0].is_active,true);assert.equal(r.shipments[1].is_active,false);
});
test('label reservation failure rolls back quota and uncertain entry before POST',async()=>{
 const s=await setup();const original=s.db.prepare.bind(s.db);s.db.prepare=(sql)=>{const statement=original(sql);if(sql.startsWith('INSERT INTO brief_labels'))statement.run=async()=>{throw Error('synthetic label storage failure')};return statement};
 await assert.rejects(s.service.ingest(candidate()),/label storage/);assert.equal(s.calls.filter(x=>x.method==='POST').length,0);
 assert.equal(s.db.raw.prepare("SELECT count(*) n FROM quota WHERE kind='add'").get()!.n,0);assert.equal(s.db.raw.prepare('SELECT count(*) n FROM ledger').get()!.n,0);
});
test('stored label count is capped without pruning ledger or quota history',async()=>{
 const s=await setup();for(let i=1;i<602;i++)await q(s.db,'INSERT INTO brief_labels(pair,description_hash,company,item,attested_at) VALUES (?,?,?,?,?)','ups:'+candidate(i).tracking_number,'hash','Example Shop',null,s.now-1).run();
 await s.service.ingest(candidate());assert.equal(s.db.raw.prepare('SELECT count(*) n FROM brief_labels').get()!.n,600);assert.equal((await s.service.brief()).shipments[0].company,'Example Shop');assert.equal((await s.service.status()).additions_last_24h,1);
});

test('explicit label repair is cache-only, digest-bound and preserves every guard table',async()=>{
 const s=await setup();s.deliveries.push({carrier_code:'ups',tracking_number:candidate().tracking_number,description:'Example Shop: Raincoat'});await s.service.verify();
 const before=Object.fromEntries(['control','ledger','quota','parcel_cache'].map(t=>[t,s.db.raw.prepare('SELECT * FROM '+t).all()]));const n=s.calls.length;
 assert.equal((await s.service.repairLabel(candidate())).status,'label_repaired');assert.equal((await s.service.brief()).shipments[0].item,'Raincoat');
 assert.equal(s.calls.length,n);for(const [table,rows] of Object.entries(before))assert.deepEqual(s.db.raw.prepare('SELECT * FROM '+table).all(),rows);
 const at=s.db.raw.prepare('SELECT attested_at FROM brief_labels').get()!.attested_at;const later=new ParcelService(s.config,{now:()=>s.now+1000,fetch:()=>{throw Error('network forbidden')}});await later.repairLabel(candidate());assert.equal(s.db.raw.prepare('SELECT attested_at FROM brief_labels').get()!.attested_at,at);
});
test('label repair fails closed on stale/future cache, mismatched candidate, uncertainty and held lease',async()=>{
 for(const kind of ['stale','future','hash','uncertain','missing','lease']){const s=await setup();s.deliveries.push({carrier_code:'ups',tracking_number:candidate().tracking_number,description:'Example Shop: Raincoat'});await s.service.verify();
 if(kind==='stale')await q(s.db,'UPDATE control SET cache_at=?',s.now-7200001).run();if(kind==='future')await q(s.db,'UPDATE control SET cache_at=?',s.now+1).run();if(kind==='hash')await q(s.db,'UPDATE parcel_cache SET description_hash=?','wrong').run();if(kind==='uncertain')await q(s.db,"UPDATE ledger SET status='uncertain'").run();if(kind==='missing')await q(s.db,'DELETE FROM ledger').run();if(kind==='lease')await q(s.db,'UPDATE control SET token=?','held').run();
 const n=s.calls.length;await assert.rejects(s.service.repairLabel(candidate()),/label_repair_requires/);assert.equal(s.calls.length,n);assert.equal(s.db.raw.prepare('SELECT count(*) n FROM brief_labels').get()!.n,0);
 }
});
test('explicit source-reverified digest repair stores only company for child-specific account label',async()=>{
 const s=await setup();const raw='Example Shop: A private child-specific description';s.deliveries.push({carrier_code:'ups',tracking_number:candidate().tracking_number,description:raw});await s.service.verify();const c=candidate();c.item_name='Kids Raincoat';
 await assert.rejects(s.service.repairLabel(c),/label_repair_requires/);
 await assert.rejects(s.service.repairLabel(c,{source:'account_description',cached_description_hash:await sha256(raw)}),/invalid_label_repair_evidence/);
 await assert.rejects(s.service.repairLabel(c,{source:'independently_verified_shipment_notice',cached_description_hash:'0'.repeat(64)}),/label_repair_requires/);
 const n=s.calls.length;await s.service.repairLabel(c,{source:'independently_verified_shipment_notice',cached_description_hash:await sha256(raw)});const brief=await s.service.brief();assert.equal(brief.shipments[0].company,'Example Shop');assert.equal(brief.shipments[0].item,null);assert.equal(s.calls.length,n);assert.ok(!JSON.stringify(brief).includes('child'));assert.ok(!JSON.stringify(s.db.raw.prepare('SELECT * FROM brief_labels').all()).includes('child'));
 s.deliveries[0].description='changed';await s.service.verify();assert.equal((await s.service.brief()).shipments[0].company,null);
});
test('repair storage failure never touches ledger, quota, cache or network',async()=>{
 const s=await setup();s.deliveries.push({carrier_code:'ups',tracking_number:candidate().tracking_number,description:'Example Shop: Raincoat'});await s.service.verify();const n=s.calls.length;const before=s.db.raw.prepare('SELECT * FROM ledger').all();s.db.failWrites=true;
 await assert.rejects(s.service.repairLabel(candidate()),/storage failure/);assert.equal(s.calls.length,n);assert.deepEqual(s.db.raw.prepare('SELECT * FROM ledger').all(),before);assert.equal(s.db.raw.prepare('SELECT count(*) n FROM brief_labels').get()!.n,0);
});
test('cache refresh retains only safe timing and actual canonical carrier event',async()=>{
 const s=await setup();s.deliveries.push({carrier_code:'ups',tracking_number:candidate().tracking_number,description:'private account text',status_code:2,date_expected:'2026-10-13 12:00',date_expected_end:'2026-10-13 16:00',events:[{date:'2026-10-11 12:00',event:'Arrived at USPS Regional Facility, private address',location:'private location',additional:'private detail'}]} as never);await s.service.verify();const r=await s.service.brief();assert.equal(r.shipments[0].expected_delivery!.end_time,'16:00');assert.equal(r.shipments[0].expected_delivery!.timezone,null);assert.equal(r.shipments[0].latest_event!.status,'arrived_at_facility');assert.equal(r.shipments[0].status,'in_transit');assert.ok(!JSON.stringify(r).includes('private'));assert.ok(!JSON.stringify(s.db.raw.prepare('SELECT * FROM parcel_cache').all()).includes('private'));
});
test('repair MCP is owner-only and rejects extra evidence or refresh arguments',async()=>{
 const s=await setup();const args={name:'parcel_repair_brief_label',arguments:{candidate:candidate()}};const denied=await handleMcp(request('tools/call',args),s.config);assert.equal(denied.status,401);
 const h={'oai-authenticated-user-id':'owner','oai-authenticated-user-email':'owner@example.test'};const r=await handleMcp(request('tools/call',{...args,arguments:{...args.arguments,refresh:true}},h),s.config);assert.equal((await r.json() as {result:{isError:boolean}}).result.isError,true);assert.equal(s.calls.length,0);
});

test('summary maintenance refreshes independently of Gmail and coalesces repeated calls',async()=>{
 const s=await setup();
 await q(s.db,"INSERT INTO discovery_progress(id,revision,state_json,operation_id,updated_at) VALUES(1,1,?,'test','test')",JSON.stringify({guard:{active:true,code:'rate_limited'}})).run();
 const discovery=s.db.raw.prepare('SELECT * FROM discovery_progress').all();
 assert.equal((await s.service.refreshBrief()).status,'refreshed');assert.equal(s.calls.length,2);
 assert.equal((await s.service.refreshBrief()).status,'already_fresh');assert.equal(s.calls.length,2);
 assert.equal((await s.service.brief()).freshness,'fresh');
 assert.deepEqual(s.db.raw.prepare('SELECT * FROM discovery_progress').all(),discovery);
 assert.equal(s.calls.filter(c=>c.method==='POST').length,0);
});

test('failed summary refresh preserves cache, persists cooldown and honors provider retry time',async()=>{
 const s=await setup();await s.service.verify();let now=s.now+81*60_000;let calls=0;
 const service=new ParcelService(s.config,{now:()=>now,fetch:async()=>{calls++;return new Response(null,{status:429,headers:{'Retry-After':'7200'}})}});
 const result=await service.refreshBrief();assert.equal(result.status,'waiting_for_retry');
 assert.ok(result.retry_not_before&&Date.parse(result.retry_not_before)>=now+7200000);
 assert.equal((await service.brief()).as_of,new Date(s.now).toISOString());
 assert.equal((await service.refreshBrief()).status,'waiting_for_retry');assert.equal(calls,1);
 now+=7200000;
 const restarted=new ParcelService(s.config,{now:()=>now,fetch:async()=>Response.json({success:true,deliveries:[]})});
 assert.equal((await restarted.refreshBrief()).status,'refreshed');
 assert.equal((await restarted.brief()).as_of,new Date(now).toISOString());
});

test('summary authentication failures escalate and do not schedule blind retries',async()=>{
 const s=await setup();let calls=0;
 const service=new ParcelService(s.config,{now:()=>s.now,fetch:async()=>{calls++;return new Response(null,{status:401})}});
 const result=await service.refreshBrief();assert.equal(result.status,'needs_review');assert.equal(result.reason,'parcel_authentication_required');
 await assert.rejects(service.refreshBrief(),/summary_refresh_needs_review/);assert.equal(calls,1);
});

test('summary maintenance respects held leases, exhausted quota, setup and owner authentication',async()=>{
 const s=await setup();await q(s.db,"UPDATE control SET token='held',locked_at=1 WHERE id=1").run();
 await assert.rejects(s.service.refreshBrief(),/importer_busy/);assert.equal(s.calls.length,0);
 await q(s.db,'UPDATE control SET token=NULL WHERE id=1').run();
 for(let i=0;i<19;i++)await q(s.db,"INSERT INTO quota(id,kind,at) VALUES(?,'read',?)",'read'+i,s.now).run();
 await assert.rejects(s.service.refreshBrief(),/hourly_read_limit/);assert.equal(s.calls.length,0);
 const other=await setup({active:false});await assert.rejects(other.service.refreshBrief(),/migration_or_connection/);assert.equal(other.calls.length,0);
 const response=await handleMcp(request('tools/call',{name:'parcel_refresh_brief',arguments:{}}),s.config);
 assert.equal(response.status,401);assert.equal(s.calls.length,0);
});
