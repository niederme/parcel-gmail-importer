import {retryable,retryAt,recoveryView,RECOVERY_LEASE_MS} from './recovery.ts';
import type {Recovery} from './recovery.ts';
import {Blocked,object,exactKeys,sha256} from './contract.ts';
import {q} from './db.ts';
import type {Database} from './db.ts';

// Discovery bookkeeping only. This module has no provider/network dependency and
// never touches shipment ledger, quota, control/lease or brief tables.
const FILTER='-in:spam -in:trash {shipped shipment tracking "on its way" "out for delivery" "package"} -from:amazon.com';
const idPattern=/^[a-f0-9]{8,64}$/;
const keyPattern=/^[A-Za-z0-9_-]{1,100}$/;
export type Item={reviewed:boolean;status:'unreviewed'|'reviewed'|'excluded'|'imported'|'pending_verification';verification_hold:boolean;pending_read:boolean;unavailable_404:boolean;retry_not_before:string|null};
type Search={id:string;query:string;started_at:string;cursor:string|null;pages:number};
type Guard={active:boolean;code:'rate_limited'|'source_unavailable'|'none';retry_not_before:string|null};
export type Progress={recovery?:Recovery|null;watermark:string;pending:Search|null;items:Record<string,Item>;guard:Guard;journal_baseline:{retained_count:number;missing_count:number};last_error:{code:string;at:string}|null};
type Row={revision:number;state_json:string;operation_id:string;updated_at:string};
function fail(code='invalid_progress_schema'):never{throw new Blocked(code)}
function str(v:unknown,re:RegExp){if(typeof v!=='string'||!re.test(v))fail();return v as string}
function integer(v:unknown,min=0,max=1000000){if(!Number.isSafeInteger(v)||Number(v)<min||Number(v)>max)fail();return v as number}
function bool(v:unknown){if(typeof v!=='boolean')fail();return v as boolean}
export function stamp(v:unknown):string {if(typeof v!=='string')fail();const m=/^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)(?:\.(\d{1,6}))?(?:Z|\+00:00)$/.exec(v as string);if(!m||!Number.isFinite(Date.parse(v as string)))fail();const s=m![1]+'.'+(m![2]??'').padEnd(6,'0')+'Z';if(new Date(s).toISOString().slice(0,19)!==s.slice(0,19))fail();return s}
function nullableStamp(v:unknown){return v===null?null:stamp(v)}
function cursor(v:unknown){if(v===null)return null;if(typeof v!=='string'||v.length<1||v.length>4096||/[\x00-\x1f\x7f]/.test(v))fail();return v}
export function plannedQuery(watermark:string){return `after:${Math.floor(Date.parse(watermark)/1000)-3600} ${FILTER}`}
function item(v:unknown):Item{const a=object(v);exactKeys(a,['reviewed','status','verification_hold','pending_read','unavailable_404','retry_not_before']);if(!['unreviewed','reviewed','excluded','imported','pending_verification'].includes(a.status as string))fail();return {reviewed:bool(a.reviewed),status:a.status as Item['status'],verification_hold:bool(a.verification_hold),pending_read:bool(a.pending_read),unavailable_404:bool(a.unavailable_404),retry_not_before:nullableStamp(a.retry_not_before)}}
function items(v:unknown){const a=object(v);if(Object.keys(a).length>10000)fail('progress_capacity_exceeded');const r:Record<string,Item>={};for(const [k,x] of Object.entries(a))r[str(k,idPattern)]=item(x);return r}
function guard(v:unknown):Guard{const a=object(v);exactKeys(a,['active','code','retry_not_before']);if(!['rate_limited','source_unavailable','none'].includes(a.code as string))fail();const g={active:bool(a.active),code:a.code as Guard['code'],retry_not_before:nullableStamp(a.retry_not_before)};if(g.active&&g.code==='none')fail();return g}
const initialItem=():Item=>({reviewed:false,status:'unreviewed',verification_hold:false,pending_read:true,unavailable_404:false,retry_not_before:null});

function recordSourceFailure(s:Progress,code:string,op:Record<string,unknown>,now:string,epoch:number,operationId:string){
 const attempt=s.recovery?.attempt;
   if(attempt&&(op.recovery_attempt_id!==attempt.id||Date.parse(attempt.expires_at)<=epoch))fail('recovery_attempt_conflict');
   if(!attempt&&op.recovery_attempt_id!==undefined)fail('recovery_attempt_conflict');
   const wasManual=s.guard.active&&!s.recovery;
   s.last_error={code,at:now};if(op.guard!==undefined){const g=guard(op.guard);if(s.guard.active&&!attempt&&(!g.active||g.code!==s.guard.code||(s.guard.retry_not_before!==null&&(g.retry_not_before===null||g.retry_not_before<s.guard.retry_not_before))))fail('guard_clear_requires_authorization');if(s.guard.retry_not_before&&(!g.retry_not_before||g.retry_not_before<s.guard.retry_not_before))g.retry_not_before=s.guard.retry_not_before;s.guard=g;}
   if(retryable(code)&&!wasManual){
    const attempts=s.recovery?.attempts??0;
    const next=retryAt(epoch,attempts,operationId,s.guard.retry_not_before);
    s.recovery={category:code,attempts,next_attempt_at:next,attempt:null};
    s.guard={active:true,code:code==='rate_limited'?'rate_limited':'source_unavailable',retry_not_before:stamp(next)};
   }else{s.recovery=null;if(!s.guard.active)s.guard={active:true,code:'source_unavailable',retry_not_before:null};}
}

export class ProgressService {
 constructor(private db:Database,private now:()=>number=Date.now){}
 async read(input:unknown={}){const a=object(input);exactKeys(a,[],['message_ids','include_reviewed_ids','holds_after_id','reviewed_after_id','expected_revision']);const ids=a.message_ids??[];if(!Array.isArray(ids)||ids.length>200)fail();ids.forEach(x=>str(x,idPattern));if(a.include_reviewed_ids!==undefined)bool(a.include_reviewed_ids);const row=await q(this.db,'SELECT * FROM discovery_progress WHERE id=1').first<Row>();if(!row)return {status:'uninitialized' as const,revision:0};if(a.expected_revision!==undefined&&integer(a.expected_revision)!==row.revision)fail('progress_revision_conflict');const afterH=a.holds_after_id===undefined?'':str(a.holds_after_id,idPattern),afterR=a.reviewed_after_id===undefined?'':str(a.reviewed_after_id,idPattern);const s=JSON.parse(row.state_json) as Progress;const entries=Object.entries(s.items).sort(([a],[b])=>a.localeCompare(b));const held=entries.filter(([,v])=>v.verification_hold||v.pending_read||v.unavailable_404||v.retry_not_before),holdPage=held.filter(([k])=>k>afterH).slice(0,200),reviewed=entries.filter(([,v])=>v.reviewed),reviewPage=reviewed.filter(([k])=>k>afterR).slice(0,2000);return {status:'ready' as const,revision:row.revision,updated_at:row.updated_at,watermark:s.watermark,next_query:plannedQuery(s.watermark),next_query_is_planned_only:true,pending_search:s.pending,guard:s.guard,recovery:recoveryView(s.recovery,s.guard.active,this.now()),last_error:s.last_error,journal_baseline:s.journal_baseline,item_count:entries.length,reviewed_count:entries.filter(([,v])=>v.reviewed).length,hold_count:held.length,pending_read_count:entries.filter(([,v])=>v.pending_read).length,verification_hold_count:entries.filter(([,v])=>v.verification_hold).length,unavailable_count:entries.filter(([,v])=>v.unavailable_404).length,holds:Object.fromEntries(holdPage),holds_complete:held.filter(([k])=>k>afterH).length<=200,holds_next_after_id:held.filter(([k])=>k>afterH).length>200?holdPage.at(-1)![0]:null,...(a.include_reviewed_ids?{reviewed_message_ids:reviewPage.map(([k])=>k),reviewed_complete:reviewed.filter(([k])=>k>afterR).length<=2000,reviewed_next_after_id:reviewed.filter(([k])=>k>afterR).length>2000?reviewPage.at(-1)![0]:null}:{}),items:Object.fromEntries((ids as string[]).filter(k=>s.items[k]).map(k=>[k,s.items[k]]))}}
 async commit(input:unknown){const a=object(input);exactKeys(a,['expected_revision','operation_id','run_id','operation']);const revision=integer(a.expected_revision);const operationId=str(a.operation_id,keyPattern),runId=str(a.run_id,keyPattern);const op=object(a.operation);const type=str(op.type,/^(initialize|begin_search|begin_recovery|begin_message_recovery|message_read_failure|message_read_success|page_success|search_failure|merge_resolution|set_guard)$/);const digest=await sha256(JSON.stringify(a));const previous=await q(this.db,'SELECT request_hash,revision FROM discovery_audit WHERE operation_id=?',operationId).first<{request_hash:string;revision:number}>();if(previous){if(previous.request_hash!==digest)fail('operation_id_reused');return {status:'already_committed',revision:previous.revision,current:await this.read()}}
 const row=await q(this.db,'SELECT * FROM discovery_progress WHERE id=1').first<Row>();if((row?.revision??0)!==revision)fail('progress_revision_conflict');const now=stamp(new Date(this.now()).toISOString());let s:Progress;const oldWatermark=row?(JSON.parse(row.state_json) as Progress).watermark:null;
 if(type==='initialize'){
  exactKeys(op,['type','watermark','fully_paginated','items','guard','journal_baseline']);if(row)fail('progress_already_initialized');if(op.fully_paginated!==true)fail('initial_coverage_not_verified');const watermark=stamp(op.watermark);if(watermark>now)fail('future_watermark');const baseline=object(op.journal_baseline);exactKeys(baseline,['retained_count','missing_count']);s={watermark,pending:null,items:items(op.items),guard:guard(op.guard),journal_baseline:{retained_count:integer(baseline.retained_count),missing_count:integer(baseline.missing_count)},last_error:null};
 }else{
  if(!row)fail('progress_not_initialized');s=JSON.parse(row!.state_json) as Progress;
  if(type==='begin_search'){
   exactKeys(op,['type','search_id','query']);if(s.pending)fail('search_already_pending');if(s.guard.active)fail('source_guard_active');if(op.query!==plannedQuery(s.watermark))fail('query_boundary_mismatch');s.pending={id:str(op.search_id,keyPattern),query:op.query as string,started_at:now,cursor:null,pages:0};s.last_error=null;
  }else if(type==='begin_recovery'){
   exactKeys(op,['type','search_id','cursor','attempt_id']);
   if(!s.pending||op.search_id!==s.pending.id||cursor(op.cursor)!==s.pending.cursor)fail('search_cursor_conflict');
   if(s.recovery?.message_id||recoveryView(s.recovery,s.guard.active,this.now()).next_action!=='begin_recovery')fail('recovery_not_eligible');
   const r=s.recovery!;r.attempts++;r.attempt={id:str(op.attempt_id,keyPattern),expires_at:new Date(this.now()+RECOVERY_LEASE_MS).toISOString()};
   r.next_attempt_at=retryAt(this.now(),r.attempts,operationId,s.guard.retry_not_before);
  }else if(type==='message_read_failure'){
   exactKeys(op,['type','message_id','code'],['guard','recovery_attempt_id']);const id=str(op.message_id,idPattern),v=s.items[id];
   if(!v||!v.pending_read||v.unavailable_404)fail('message_not_pending_read');
   if(s.recovery&&s.recovery.message_id!==id)fail('recovery_target_conflict');
   const code=str(op.code,/^(rate_limited|forbidden|permission_denied|unavailable|network_error|partial|unknown|not_found)$/);
   if(code==='not_found'){
    const attempt=s.recovery?.attempt;if(attempt&&(op.recovery_attempt_id!==attempt.id||Date.parse(attempt.expires_at)<=this.now()))fail('recovery_attempt_conflict');
    v.unavailable_404=true;v.retry_not_before=null;s.recovery=null;
   }else{
    recordSourceFailure(s,code,op,now,this.now(),operationId);
    if(s.recovery){s.recovery.message_id=id;v.retry_not_before=stamp(s.recovery.next_attempt_at);}
   }
  }else if(type==='begin_message_recovery'){
   exactKeys(op,['type','message_id','attempt_id']);const id=str(op.message_id,idPattern),v=s.items[id];
   if(!v||!v.pending_read||v.unavailable_404||s.recovery?.message_id!==id)fail('recovery_target_conflict');
   if(recoveryView(s.recovery,s.guard.active,this.now()).next_action!=='begin_message_recovery')fail('recovery_not_eligible');
   const r=s.recovery;r.attempts++;r.attempt={id:str(op.attempt_id,keyPattern),expires_at:new Date(this.now()+RECOVERY_LEASE_MS).toISOString()};
   r.next_attempt_at=retryAt(this.now(),r.attempts,operationId,s.guard.retry_not_before);
  }else if(type==='message_read_success'){
   exactKeys(op,['type','message_id','recovery_attempt_id']);const id=str(op.message_id,idPattern),v=s.items[id],r=s.recovery;
   if(!s.guard.active||!r?.attempt||r.message_id!==id||r.attempt.id!==op.recovery_attempt_id||Date.parse(r.attempt.expires_at)<=this.now()||!v?.pending_read||v.unavailable_404)fail('recovery_attempt_conflict');
   // Source access recovered. Content classification remains pending and requires
   // the ordinary evidence-backed merge_resolution, never an automatic import.
   v.retry_not_before=null;s.recovery=null;s.guard={active:false,code:'none',retry_not_before:null};s.last_error=null;
  }else if(type==='page_success'){
   exactKeys(op,['type','search_id','cursor','next_cursor','message_ids'],['recovery_attempt_id']);const p=s.pending;if(!p||op.search_id!==p.id||cursor(op.cursor)!==p.cursor)fail('search_cursor_conflict');if(s.guard.active){const attempt=s.recovery?.attempt;if(s.recovery?.message_id||!attempt||op.recovery_attempt_id!==attempt.id||Date.parse(attempt.expires_at)<=this.now())fail('source_guard_active');}
   else if(op.recovery_attempt_id!==undefined)fail('recovery_attempt_conflict');
   const next=cursor(op.next_cursor);if(next!==null&&next===p!.cursor)fail('nonadvancing_cursor');if(!Array.isArray(op.message_ids)||op.message_ids.length>1000)fail();for(const k of op.message_ids){const id=str(k,idPattern);if(!s.items[id])s.items[id]=initialItem()}p!.pages++;p!.cursor=next;if(next===null){if(p!.started_at<s.watermark)fail('watermark_regression');s.watermark=p!.started_at;s.pending=null}s.last_error=null;s.recovery=null;s.guard={active:false,code:'none',retry_not_before:null};
  }else if(type==='search_failure'){
   exactKeys(op,['type','search_id','cursor','code'],['guard','recovery_attempt_id']);if(!s.pending||op.search_id!==s.pending.id||cursor(op.cursor)!==s.pending.cursor)fail('search_cursor_conflict');const code=str(op.code,/^(rate_limited|forbidden|permission_denied|unavailable|network_error|partial|unknown)$/);if(s.recovery?.message_id)fail('recovery_target_conflict');recordSourceFailure(s,code,op,now,this.now(),operationId);
  }else if(type==='set_guard'){
   exactKeys(op,['type','guard'],['clear_authorized']);const g=guard(op.guard);if(s.guard.active&&(!g.active||g.code!==s.guard.code||(s.guard.retry_not_before!==null&&(g.retry_not_before===null||g.retry_not_before<s.guard.retry_not_before)))&&op.clear_authorized!==true)fail('guard_clear_requires_authorization');s.guard=g;s.recovery=null;
  }else{
   exactKeys(op,['type','items'],['resolve_ids','restore_unavailable_ids']);const updates=items(op.items);const resolve=op.resolve_ids??[],restore=op.restore_unavailable_ids??[];if(!Array.isArray(resolve)||!Array.isArray(restore)||resolve.length>1000||restore.length>1000)fail();resolve.forEach(x=>str(x,idPattern));restore.forEach(x=>str(x,idPattern));for(const [id,v] of Object.entries(updates)){const old=s.items[id];if(old){if(old.reviewed&&!v.reviewed)fail('review_regression');if((old.verification_hold&&!v.verification_hold||old.pending_read&&!v.pending_read||old.retry_not_before&&(!v.retry_not_before||v.retry_not_before<old.retry_not_before))&&!resolve.includes(id))fail('resolution_required');if(old.unavailable_404&&!v.unavailable_404&&!restore.includes(id))fail('unavailable_resolution_required')}s.items[id]=v}
  }
 }
 if(Object.keys(s.items).length>10000)fail('progress_capacity_exceeded');const serialized=JSON.stringify(s);if(new TextEncoder().encode(serialized).length>2000000)fail('progress_capacity_exceeded');const nextRevision=revision+1;
 // CAS + audit is one transaction. Audit is conditional on THIS operation_id,
 // since a zero-change UPDATE does not abort a D1 batch.
 const change=row?q(this.db,'UPDATE discovery_progress SET revision=?,state_json=?,operation_id=?,updated_at=? WHERE id=1 AND revision=?',nextRevision,serialized,operationId,now,revision):q(this.db,'INSERT OR IGNORE INTO discovery_progress(id,revision,state_json,operation_id,updated_at) VALUES(1,?,?,?,?)',nextRevision,serialized,operationId,now);
 const result=await this.db.batch([change,q(this.db,'INSERT OR IGNORE INTO discovery_audit(operation_id,run_id,request_hash,revision,old_watermark,new_watermark,operation,at) SELECT ?,?,?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM discovery_progress WHERE id=1 AND operation_id=? AND revision=?)',operationId,runId,digest,nextRevision,oldWatermark,s.watermark,type,now,operationId,nextRevision),q(this.db,'DELETE FROM discovery_audit WHERE operation_id IN (SELECT operation_id FROM discovery_audit ORDER BY revision DESC LIMIT -1 OFFSET 10000) AND EXISTS(SELECT 1 FROM discovery_progress WHERE id=1 AND operation_id=? AND revision=?)',operationId,nextRevision)]);
 if(result[0].meta.changes!==1){const winner=await q(this.db,'SELECT request_hash,revision FROM discovery_audit WHERE operation_id=?',operationId).first<{request_hash:string;revision:number}>();if(winner?.request_hash===digest)return {status:'already_committed',revision:winner.revision,current:await this.read()};fail('progress_revision_conflict');}if(result[1].meta.changes!==1)fail('progress_commit_uncertain');return {status:'committed',revision:nextRevision,watermark:s.watermark,pending_search:s.pending,next_query:plannedQuery(s.watermark),next_query_is_planned_only:true};
 }
}

const stampSchema={type:['string','null']};
const itemSchema={type:'object',additionalProperties:false,required:['reviewed','status','verification_hold','pending_read','unavailable_404','retry_not_before'],properties:{reviewed:{type:'boolean'},status:{enum:['unreviewed','reviewed','excluded','imported','pending_verification']},verification_hold:{type:'boolean'},pending_read:{type:'boolean'},unavailable_404:{type:'boolean'},retry_not_before:stampSchema}};
const itemsSchema={type:'object',propertyNames:{pattern:'^[a-f0-9]{8,64}$'},additionalProperties:itemSchema,maxProperties:10000};
const guardSchema={type:'object',additionalProperties:false,required:['active','code','retry_not_before'],properties:{active:{type:'boolean'},code:{enum:['none','rate_limited','source_unavailable']},retry_not_before:stampSchema}};
const opSchema=(type:string,properties:object,required:string[])=>({type:'object',additionalProperties:false,properties:{type:{const:type},...properties},required:['type',...required]});
export const progressReadSchema={type:'object',additionalProperties:false,properties:{message_ids:{type:'array',maxItems:200,items:{type:'string',pattern:'^[a-f0-9]{8,64}$'}},include_reviewed_ids:{type:'boolean'},holds_after_id:{type:'string',pattern:'^[a-f0-9]{8,64}$'},reviewed_after_id:{type:'string',pattern:'^[a-f0-9]{8,64}$'},expected_revision:{type:'integer',minimum:0}}};
export const progressCommitSchema={type:'object',additionalProperties:false,required:['expected_revision','operation_id','run_id','operation'],properties:{expected_revision:{type:'integer',minimum:0},operation_id:{type:'string',pattern:'^[A-Za-z0-9_-]{1,100}$'},run_id:{type:'string',pattern:'^[A-Za-z0-9_-]{1,100}$'},operation:{oneOf:[
 opSchema('initialize',{watermark:{type:'string'},fully_paginated:{const:true},items:itemsSchema,guard:guardSchema,journal_baseline:{type:'object',additionalProperties:false,required:['retained_count','missing_count'],properties:{retained_count:{type:'integer',minimum:0},missing_count:{type:'integer',minimum:0}}}},['watermark','fully_paginated','items','guard','journal_baseline']),
 opSchema('begin_search',{search_id:{type:'string'},query:{type:'string'}},['search_id','query']),
 opSchema('message_read_failure',{message_id:{type:'string'},code:{enum:['rate_limited','forbidden','permission_denied','unavailable','network_error','partial','unknown','not_found']},guard:guardSchema,recovery_attempt_id:{type:'string'}},['message_id','code']),
 opSchema('begin_message_recovery',{message_id:{type:'string'},attempt_id:{type:'string'}},['message_id','attempt_id']),
 opSchema('message_read_success',{message_id:{type:'string'},recovery_attempt_id:{type:'string'}},['message_id','recovery_attempt_id']),
 opSchema('begin_recovery',{search_id:{type:'string'},cursor:stampSchema,attempt_id:{type:'string'}},['search_id','cursor','attempt_id']),
 opSchema('page_success',{search_id:{type:'string'},cursor:stampSchema,next_cursor:stampSchema,recovery_attempt_id:{type:'string'},message_ids:{type:'array',maxItems:1000,items:{type:'string'}}},['search_id','cursor','next_cursor','message_ids']),
 opSchema('search_failure',{search_id:{type:'string'},cursor:stampSchema,code:{enum:['rate_limited','forbidden','permission_denied','unavailable','network_error','partial','unknown']},guard:guardSchema,recovery_attempt_id:{type:'string'}},['search_id','cursor','code']),
 opSchema('merge_resolution',{items:itemsSchema,resolve_ids:{type:'array',items:{type:'string'}},restore_unavailable_ids:{type:'array',items:{type:'string'}}},['items']),
 opSchema('set_guard',{guard:guardSchema,clear_authorized:{type:'boolean'}},['guard'])
]}}};
