import test from 'node:test';
import assert from 'node:assert/strict';
import {Miniflare} from 'miniflare';
import {readFileSync,readdirSync} from 'node:fs';
import {ProgressService,plannedQuery} from '../lib/parcel/progress.ts';
import type {Database} from '../lib/parcel/db.ts';
import {handleMcp,tools} from '../lib/parcel/mcp.ts';
const epoch=Date.parse('2026-10-26T01:30:00Z');
const watermark='2026-10-26T01:17:38.771824Z';
const hold={reviewed:true,status:'pending_verification',verification_hold:true,pending_read:false,unavailable_404:false,retry_not_before:null};
const excluded={...hold,status:'excluded',verification_hold:false};
const guard={active:false,code:'none',retry_not_before:null};
const init={type:'initialize',watermark,fully_paginated:true,items:{'1111111111111111':hold,'2222222222222222':{...hold,unavailable_404:true}},guard,journal_baseline:{retained_count:7,missing_count:1}};
async function setup(clock=()=>epoch){const mf=new Miniflare({modules:true,script:'export default {fetch(){return new Response("ok")}}',d1Databases:['DB'],compatibilityDate:'2026-05-15',inspectorPort:0});const db=await mf.getD1Database('DB');for(const name of readdirSync(new URL('../drizzle',import.meta.url)).filter(x=>x.endsWith('.sql')).sort()){const sql=readFileSync(new URL('../drizzle/'+name,import.meta.url),'utf8');for(const statement of sql.split('--> statement-breakpoint'))if(statement.trim())await db.prepare(statement).run()}return {mf,db,service:new ProgressService(db as unknown as Database,clock)}}
async function ready(service:ProgressService,input:unknown={}){const s=await service.read(input);if(s.status!=='ready')throw new Error('expected initialized');return s}
function request(revision:number,operation_id:string,operation:unknown){return {expected_revision:revision,operation_id,run_id:'synthetic_run',operation}}
test('durable pagination, monotonic watermark, minimal state and safe resolutions',async()=>{const {mf,db,service}=await setup();try{
 assert.deepEqual(await service.read(),{status:'uninitialized',revision:0});
 await service.commit(request(0,'init',init));const repeat=await service.commit(request(0,'init',init));assert.equal(repeat.status,'already_committed');
 await assert.rejects(service.commit(request(0,'stale_init',init)),/progress_revision_conflict/);
 await assert.rejects(service.commit(request(1,'invalid_begin',{type:'begin_search',search_id:'s1',query:'after:0'})),/query_boundary_mismatch/);
 const begin=await service.commit(request(1,'begin',{type:'begin_search',search_id:'s1',query:plannedQuery(watermark)}));assert.equal(begin.revision,2);
 await service.commit(request(2,'page1',{type:'page_success',search_id:'s1',cursor:null,next_cursor:'cursor-page2',message_ids:['aaaaaaaa11111111']}));
 let state=await ready(service,{include_reviewed_ids:true});assert.equal(state.watermark,watermark);assert.equal(state.pending_search?.cursor,'cursor-page2');
 await service.commit(request(3,'failure',{type:'search_failure',search_id:'s1',cursor:'cursor-page2',code:'network_error'}));
 state=await ready(service);assert.equal(state.watermark,watermark);assert.equal(state.pending_search?.cursor,'cursor-page2');
 await assert.rejects(service.commit(request(4,'wrong_cursor',{type:'page_success',search_id:'s1',cursor:null,next_cursor:null,message_ids:[]})),/search_cursor_conflict/);
 await assert.rejects(service.commit(request(4,'bad_failure',{type:'search_failure',search_id:'s1',cursor:'cursor-page2',code:'network_error',watermark:'2001-01-01T00:00:00Z'})),/invalid_schema/);
 await service.commit(request(4,'manual_recovery',{type:'set_guard',guard,clear_authorized:true}));
 await service.commit(request(5,'terminal',{type:'page_success',search_id:'s1',cursor:'cursor-page2',next_cursor:null,message_ids:[]}));
 state=await ready(service);assert.equal(state.watermark,'2026-10-26T01:30:00.000000Z');assert.equal(state.pending_search,null);assert.deepEqual(state.journal_baseline,{retained_count:7,missing_count:1});
 await assert.rejects(service.commit(request(6,'clear_without_resolution',{type:'merge_resolution',items:{'1111111111111111':excluded}})),/resolution_required/);
 await service.commit(request(6,'review_new',{type:'merge_resolution',items:{'aaaaaaaa11111111':excluded},resolve_ids:['aaaaaaaa11111111']}));
 state=await ready(service,{message_ids:['aaaaaaaa11111111'],include_reviewed_ids:true});assert.equal(state.holds?.['1111111111111111'].verification_hold,true);assert.equal(state.holds?.['2222222222222222'].unavailable_404,true);assert.equal(state.items?.['aaaaaaaa11111111'].reviewed,true);
 await assert.rejects(service.commit(request(7,'clear_404',{type:'merge_resolution',items:{'2222222222222222':excluded},resolve_ids:['2222222222222222']})),/unavailable_resolution_required/);
 for(const table of ['ledger','control','quota','parcel_cache','brief_labels'])assert.equal((await db.prepare(`SELECT count(*) AS n FROM ${table}`).first<{n:number}>())?.n,0);
}finally{await mf.dispose()}});
test('racing stale writers cannot overwrite newer state or append audit; guard blocks searches',async()=>{const {mf,db,service}=await setup();try{
 await service.commit(request(0,'init',init));
 const a=request(1,'writerA',{type:'merge_resolution',items:{'aaaaaaaa11111111':excluded}}),b=request(1,'writerB',{type:'merge_resolution',items:{'bbbbbbbb22222222':excluded}});
 const results=await Promise.allSettled([service.commit(a),service.commit(b)]);assert.equal(results.filter(x=>x.status==='fulfilled').length,1);assert.equal((await db.prepare('SELECT count(*) AS n FROM discovery_audit').first<{n:number}>())?.n,2);
 const state=await ready(service,{message_ids:['aaaaaaaa11111111','bbbbbbbb22222222']});assert.equal(Object.keys(state.items??{}).length,1);
 await service.commit(request(2,'hold',{type:'set_guard',guard:{active:true,code:'rate_limited',retry_not_before:null}}));
 await assert.rejects(service.commit(request(3,'blocked_begin',{type:'begin_search',search_id:'s',query:plannedQuery(watermark)})),/source_guard_active/);
 await assert.rejects(service.commit(request(3,'unapproved_clear',{type:'set_guard',guard})),/guard_clear_requires_authorization/);
 await service.commit(request(3,'approved_clear',{type:'set_guard',guard,clear_authorized:true}));
 await assert.rejects(service.commit(request(1,'old_failure',{type:'set_guard',guard:{active:true,code:'rate_limited',retry_not_before:null}})),/progress_revision_conflict/);
}finally{await mf.dispose()}});
test('initialization rejects future and partial coverage; MCP retains private authorization',async()=>{const {mf,db,service}=await setup();try{
 await assert.rejects(service.commit(request(0,'future',{...init,watermark:'2030-01-01T00:00:00Z'})),/future_watermark/);
 await assert.rejects(service.commit(request(0,'partial',{...init,fully_paginated:false})),/initial_coverage_not_verified/);
 assert.equal(tools.filter(t=>t.name.startsWith('parcel_')).length,10);
 const res=await handleMcp(new Request('https://example.invalid/mcp',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'parcel_discovery_progress',arguments:{}}})}),{DB:db as unknown as Database},{fetch:()=>{throw new Error('provider call forbidden')}});
 assert.equal(res.status,401);
}finally{await mf.dispose()}});
test('identical concurrent commits are idempotent; transaction failure leaves no partial state',async()=>{const {mf,db,service}=await setup();try{
 const same=request(0,'identical',init);const replies=await Promise.all([service.commit(same),service.commit(same)]);assert.deepEqual(new Set(replies.map(r=>r.status)),new Set(['committed','already_committed']));assert.equal((await ready(service)).revision,1);
 const database=db as unknown as Database;
 const broken:Database={prepare:database.prepare.bind(database),batch:(statements)=>database.batch([...statements,database.prepare('INSERT INTO table_that_does_not_exist(x) VALUES(1)')])};
 await assert.rejects(new ProgressService(broken,()=>epoch).commit(request(1,'atomic_failure',{type:'merge_resolution',items:{'cccccccc33333333':excluded}})));
 const after=await ready(service,{message_ids:['cccccccc33333333']});assert.equal(after.revision,1);assert.deepEqual(after.items,{});assert.equal((await db.prepare('SELECT count(*) AS n FROM discovery_audit').first<{n:number}>())?.n,1);
 await service.commit(request(1,'active_timed',{type:'set_guard',guard:{active:true,code:'rate_limited',retry_not_before:'2026-10-27T00:00:00Z'}}));
 await assert.rejects(service.commit(request(2,'weaken',{type:'set_guard',guard:{active:true,code:'rate_limited',retry_not_before:null}})),/guard_clear_requires_authorization/);
}finally{await mf.dispose()}});
test('bounded read pagination reports incomplete coverage and rejects mixed revisions',async()=>{const {mf,service}=await setup();try{
 const many=Object.fromEntries(Array.from({length:205},(_,i)=>[(i+1000).toString(16).padStart(16,'0'),hold]));await service.commit(request(0,'many',{...init,items:many}));const first=await ready(service);assert.equal(first.holds_complete,false);assert.equal(Object.keys(first.holds).length,200);const last=await ready(service,{expected_revision:1,holds_after_id:first.holds_next_after_id});assert.equal(last.holds_complete,true);assert.equal(Object.keys(last.holds).length,5);
 await service.commit(request(1,'new_revision',{type:'merge_resolution',items:{'dddddddd44444444':excluded}}));await assert.rejects(service.read({expected_revision:1,holds_after_id:first.holds_next_after_id}),/progress_revision_conflict/);
}finally{await mf.dispose()}});

test('no-reset throttle recovers one exact page without dropping holds or advancing early',async()=>{
 let now=epoch;const {mf,service,db}=await setup(()=>now);try{
  await service.commit(request(0,'init',init));
  await service.commit(request(1,'start',{type:'begin_search',search_id:'s',query:plannedQuery(watermark)}));
  await service.commit(request(2,'page',{type:'page_success',search_id:'s',cursor:null,next_cursor:'page2',message_ids:['aaaaaaaa11111111']}));
  await service.commit(request(3,'throttle',{type:'search_failure',search_id:'s',cursor:'page2',code:'rate_limited',guard:{active:true,code:'rate_limited',retry_not_before:null}}));
  let state=await ready(service);assert.equal(state.recovery.next_action,'wait_for_retry');
  assert.equal(state.watermark,watermark);assert.equal(state.pending_search?.cursor,'page2');
  await assert.rejects(service.commit(request(4,'early',{type:'begin_recovery',search_id:'s',cursor:'page2',attempt_id:'a'})),/recovery_not_eligible/);
  now=Date.parse(state.recovery.retry_not_before!);
  const probe=request(4,'probe',{type:'begin_recovery',search_id:'s',cursor:'page2',attempt_id:'a'});
  await service.commit(probe);assert.equal((await service.commit(probe)).status,'already_committed');
  assert.equal((await ready(service)).guard.active,true);
  await assert.rejects(service.commit(request(5,'overlap',{type:'begin_recovery',search_id:'s',cursor:'page2',attempt_id:'b'})),/recovery_not_eligible/);
  await assert.rejects(service.commit(request(5,'unbound',{type:'page_success',search_id:'s',cursor:'page2',next_cursor:null,message_ids:[]})),/source_guard_active/);
  await service.commit(request(5,'recovered',{type:'page_success',search_id:'s',cursor:'page2',next_cursor:'page3',message_ids:[],recovery_attempt_id:'a'}));
  state=await ready(service);assert.equal(state.guard.active,false);assert.equal(state.watermark,watermark);
  assert.equal(state.hold_count,3);assert.equal(state.recovery.next_action,'continue_discovery');
  await service.commit(request(6,'terminal',{type:'page_success',search_id:'s',cursor:'page3',next_cursor:null,message_ids:[]}));
  assert.equal((await ready(service)).watermark,'2026-10-26T01:30:00.000000Z');
  for(const table of ['ledger','quota','control'])assert.equal((await db.prepare(`SELECT count(*) n FROM ${table}`).first<{n:number}>())?.n,0);
 }finally{await mf.dispose()}
});

test('provider cooldown is respected and crashed recovery attempts exhaust a durable budget',async()=>{
 let now=epoch;const {mf,service}=await setup(()=>now);try{
  await service.commit(request(0,'init',init));await service.commit(request(1,'start',{type:'begin_search',search_id:'s',query:plannedQuery(watermark)}));
  const until='2026-10-27T00:00:00Z';
  await service.commit(request(2,'fail',{type:'search_failure',search_id:'s',cursor:null,code:'rate_limited',guard:{active:true,code:'rate_limited',retry_not_before:until}}));
  assert.ok(Date.parse((await ready(service)).recovery.retry_not_before!)>=Date.parse(until));
  for(let i=0;i<6;i++){
   const state=await ready(service);now=Date.parse(state.recovery.retry_not_before!);
   await service.commit(request(state.revision,'attempt'+i,{type:'begin_recovery',search_id:'s',cursor:null,attempt_id:'a'+i}));
   now+=24*3600000; // Simulate process death, not a failed provider response.
  }
  const state=await ready(service);assert.equal(state.recovery.next_action,'recovery_exhausted');
  assert.equal(state.recovery.attempts,6);assert.equal(state.watermark,watermark);assert.equal(state.guard.active,true);
  await assert.rejects(service.commit(request(state.revision,'seventh',{type:'begin_recovery',search_id:'s',cursor:null,attempt_id:'seventh'})),/recovery_not_eligible/);
 }finally{await mf.dispose()}
});

test('authentication, unknown and manual guards never become automatic recovery permits',async()=>{
 for(const code of ['permission_denied','forbidden','unknown']){const {mf,service}=await setup();try{
  await service.commit(request(0,'init',init));await service.commit(request(1,'start',{type:'begin_search',search_id:'s',query:plannedQuery(watermark)}));
  await service.commit(request(2,'fail',{type:'search_failure',search_id:'s',cursor:null,code}));
  assert.equal((await ready(service)).recovery.next_action,'review_source_guard');
  await service.commit(request(3,'misclassified',{type:'search_failure',search_id:'s',cursor:null,code:'network_error'}));
  assert.equal((await ready(service)).recovery.next_action,'review_source_guard');
 }finally{await mf.dispose()}}
});

test('failed recovery preserves provider timing and rejects expired or wrong attempt responses',async()=>{
 let now=epoch;const {mf,service}=await setup(()=>now);try{
  await service.commit(request(0,'init',init));await service.commit(request(1,'start',{type:'begin_search',search_id:'s',query:plannedQuery(watermark)}));
  await service.commit(request(2,'fail',{type:'search_failure',search_id:'s',cursor:null,code:'network_error'}));
  now=Date.parse((await ready(service)).recovery.retry_not_before!);
  await service.commit(request(3,'probe',{type:'begin_recovery',search_id:'s',cursor:null,attempt_id:'a'}));
  await assert.rejects(service.commit(request(4,'bad',{type:'search_failure',search_id:'s',cursor:null,code:'network_error',recovery_attempt_id:'b'})),/recovery_attempt_conflict/);
  await service.commit(request(4,'failure',{type:'search_failure',search_id:'s',cursor:null,code:'network_error',recovery_attempt_id:'a'}));
  const state=await ready(service);assert.equal(state.recovery.attempts,1);assert.equal(state.recovery.next_action,'wait_for_retry');
  now=Date.parse(state.recovery.retry_not_before!);await service.commit(request(5,'second',{type:'begin_recovery',search_id:'s',cursor:null,attempt_id:'b'}));
  now+=6*60_000;
  await assert.rejects(service.commit(request(6,'late',{type:'page_success',search_id:'s',cursor:null,next_cursor:null,message_ids:[],recovery_attempt_id:'b'})),/source_guard_active/);
 }finally{await mf.dispose()}
});

test('message read throttle recovers after discovery completed without marking content reviewed',async()=>{
 let now=epoch;const {mf,service}=await setup(()=>now);try{
  await service.commit(request(0,'init',init));await service.commit(request(1,'start',{type:'begin_search',search_id:'s',query:plannedQuery(watermark)}));
  await service.commit(request(2,'terminal',{type:'page_success',search_id:'s',cursor:null,next_cursor:null,message_ids:['aaaaaaaa11111111']}));
  await service.commit(request(3,'read_fail',{type:'message_read_failure',message_id:'aaaaaaaa11111111',code:'rate_limited'}));
  let state=await ready(service);const coverage=state.watermark;assert.equal(state.pending_search,null);
  now=Date.parse(state.recovery.retry_not_before!);state=await ready(service);
  assert.equal(state.recovery.next_action,'begin_message_recovery');
  await assert.rejects(service.commit(request(4,'wrong',{type:'begin_message_recovery',message_id:'2222222222222222',attempt_id:'a'})),/recovery_target_conflict/);
  await service.commit(request(4,'probe',{type:'begin_message_recovery',message_id:'aaaaaaaa11111111',attempt_id:'a'}));
  await service.commit(request(5,'read_ok',{type:'message_read_success',message_id:'aaaaaaaa11111111',recovery_attempt_id:'a'}));
  state=await ready(service,{message_ids:['aaaaaaaa11111111']});assert.equal(state.guard.active,false);
  assert.equal(state.watermark,coverage);assert.equal(state.items['aaaaaaaa11111111'].reviewed,false);
  assert.equal(state.items['aaaaaaaa11111111'].pending_read,true);assert.equal(state.hold_count,3);
 }finally{await mf.dispose()}
});

test('a missing message is isolated and never receives an automatic retry permit',async()=>{
 const {mf,service}=await setup();try{
  await service.commit(request(0,'init',init));await service.commit(request(1,'start',{type:'begin_search',search_id:'s',query:plannedQuery(watermark)}));
  await service.commit(request(2,'terminal',{type:'page_success',search_id:'s',cursor:null,next_cursor:null,message_ids:['aaaaaaaa11111111']}));
  await service.commit(request(3,'missing',{type:'message_read_failure',message_id:'aaaaaaaa11111111',code:'not_found'}));
  const state=await ready(service);assert.equal(state.guard.active,false);assert.equal(state.holds['aaaaaaaa11111111'].unavailable_404,true);
  await assert.rejects(service.commit(request(4,'retry_missing',{type:'begin_message_recovery',message_id:'aaaaaaaa11111111',attempt_id:'a'})),/recovery_target_conflict/);
 }finally{await mf.dispose()}
});
