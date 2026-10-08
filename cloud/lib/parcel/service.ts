import {Blocked,validate,pairOf,descriptionOf,sha256,object,exactKeys,validatePair} from './contract.ts';
import type {Catalog,Candidate} from './contract.ts';
import {control,q,quotaCount,reserveRead,reserveAddition,assertLease,withLease} from './db.ts';
import type {Database} from './db.ts';
export type Config={DB?:Database;PARCEL_API_KEY?:string;PARCEL_WRITES_ENABLED?:string;PARCEL_MIGRATION_ALLOWED?:string;OWNER_EMAIL_SHA256?:string};
export type Dependencies={fetch?:typeof fetch;now?:()=>number};
const BASE='https://api.parcel.app/external/';
async function limitedJson(response:Response,max=1000000) {if(response.status!==200||!response.body) throw new Blocked('parcel_request_failed');const reader=response.body.getReader();const pieces:Uint8Array[]=[];let total=0;while(true){const p=await reader.read();if(p.done)break;total+=p.value.length;if(total>max){await reader.cancel();throw new Blocked('response_too_large')}pieces.push(p.value)}const all=new Uint8Array(total);let offset=0;for(const piece of pieces){all.set(piece,offset);offset+=piece.length}try{return JSON.parse(new TextDecoder().decode(all))}catch{throw new Blocked('invalid_delivery_response')}}
export class ParcelService {
  db:Database;fetcher:typeof fetch;now:()=>number;
  constructor(public config:Config,deps:Dependencies={}) {if(!config.DB)throw new Blocked('storage_unavailable');this.db=config.DB;this.fetcher=deps.fetch??fetch.bind(globalThis);this.now=deps.now??Date.now;}
  private key(){const k=this.config.PARCEL_API_KEY;if(!k)throw new Blocked('key_not_configured');if(!/^[\x21-\x7e]{1,4096}$/.test(k)||/["']/.test(k))throw new Blocked('key_configuration_invalid');return k;}
  private async request(path:string,body?:object) {const key=this.key();try{const response=await this.fetcher(BASE+path,{method:body?'POST':'GET',headers:{'api-key':key,'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined,redirect:'manual',credentials:'omit',cache:'no-store',signal:AbortSignal.timeout(15000)});const json=object(await limitedJson(response));if(json.success!==true)throw new Blocked('parcel_request_failed');return json;}catch(e){if(e instanceof Blocked)throw e;throw new Blocked('network_result_unknown')}}
  async catalog():Promise<Catalog> {try{const response=await this.fetcher(BASE+'supported_carriers.json',{redirect:'manual',credentials:'omit',cache:'no-store',signal:AbortSignal.timeout(15000)});const value=object(await limitedJson(response));for(const [code,c] of Object.entries(value)){const data=object(c);if(!/^[a-z0-9]{2,20}$/.test(code)||typeof data.name!=='string'||(data.extra_required!=null && !Number.isInteger(data.extra_required)))throw new Blocked('carrier_catalog_unavailable')}return value as Catalog}catch{throw new Blocked('carrier_catalog_unavailable')}}
  async status() {const c=await control(this.db);const counts=(await q(this.db,'SELECT status,count(*) AS count FROM ledger GROUP BY status').all<{status:string,count:number}>()).results;return {status:'ready',key_configured:!!this.config.PARCEL_API_KEY,writes_enabled:this.config.PARCEL_WRITES_ENABLED==='true'&&!!c?.migration_digest&&!!c.verified_at,migration_verified:!!c?.migration_digest,connection_verified_at:c?.verified_at??null,last_read_at:c?.cache_at??null,lease_held:!!c?.token,recovery_required:!!c?.token&&this.now()-(c.locked_at??0)>180000,additions_last_24h:await quotaCount(this.db,'add',this.now()),reads_last_hour:await quotaCount(this.db,'read',this.now()),ledger:counts};}
  private async refresh(token:string,force=false) {
    const state=await control(this.db);const now=this.now();if(!force&&state?.cache_at&&now>=state.cache_at&&now-state.cache_at<300000)return;
    await reserveRead(this.db,token,now);
    const recent=await this.request('deliveries/?filter_mode=recent');const active=await this.request('deliveries/?filter_mode=active');
    const pairs=new Map<string,string>();for(const response of [recent,active]) {if(!Array.isArray(response.deliveries))throw new Blocked('invalid_delivery_response');for(const entry of response.deliveries){const d=object(entry);if(typeof d.carrier_code!=='string'||typeof d.tracking_number!=='string')throw new Blocked('invalid_delivery_response');const pair=validatePair(d.carrier_code.toLowerCase()+':'+d.tracking_number.toUpperCase());pairs.set(pair,typeof d.description==='string'?await sha256(d.description):'');}}
    await assertLease(this.db,token);
    // Store only pair and description digest, never Parcel's addresses or other fields.
    const rows=JSON.stringify([...pairs].map(([pair,hash])=>({pair,hash})));
    await this.db.batch([q(this.db,'DELETE FROM parcel_cache'),q(this.db,`INSERT INTO parcel_cache(pair,description_hash) SELECT json_extract(value,'$.pair'),json_extract(value,'$.hash') FROM json_each(?)`,rows),q(this.db,`INSERT INTO ledger(pair,status,created_at,updated_at) SELECT pair,'seen',?,? FROM parcel_cache WHERE true ON CONFLICT(pair) DO UPDATE SET status=CASE WHEN ledger.status='uncertain' AND ledger.description_hash IS NOT NULL AND ledger.description_hash<>(SELECT description_hash FROM parcel_cache WHERE pair=excluded.pair) THEN 'uncertain' ELSE 'seen' END,updated_at=excluded.updated_at`,now,now),q(this.db,'UPDATE control SET cache_at=? WHERE id=1 AND token=?',now,token)]);
  }
  async verify() {this.key();return withLease(this.db,async token=>{await this.refresh(token,true);await q(this.db,'UPDATE control SET verified_at=? WHERE id=1 AND token=?',this.now(),token).run();return {status:'read_verified'};});}
  async check(input:unknown) {const c=validate(input,await this.catalog());this.key();return withLease(this.db,async token=>{await this.refresh(token,true);return this.checked(c);});}
  private async checked(c:Candidate) {const row=await q(this.db,'SELECT description_hash FROM parcel_cache WHERE pair=?',pairOf(c)).first<{description_hash:string}>();return {status:'read_verified',candidate_exists:!!row,description_matches:row?.description_hash===await sha256(descriptionOf(c))};}
  async ingest(input:unknown) {
    // All gates are checked before making even a carrier-catalog call.
    this.key();if(this.config.PARCEL_WRITES_ENABLED!=='true')throw new Blocked('cutover_not_enabled');
    const initial=await control(this.db);if(!initial?.migration_digest||!initial.verified_at)throw new Blocked('migration_or_connection_not_verified');
    const c=validate(input,await this.catalog());const pair=pairOf(c);const description=descriptionOf(c);
    return withLease(this.db,async token=>{
      if(await q(this.db,'SELECT status FROM ledger WHERE pair=?',pair).first())return {status:'skipped_duplicate_or_pending'};
      await this.refresh(token);if(await q(this.db,'SELECT status FROM ledger WHERE pair=?',pair).first())return {status:'skipped_existing'};
      // Reserve two read slots for the post-write verification before sending.
      if(await quotaCount(this.db,'read',this.now())>18)throw new Blocked('hourly_read_limit');
      await reserveAddition(this.db,token,pair,await sha256(description),this.now());
      await assertLease(this.db,token);
      await this.request('add-delivery/',{carrier_code:c.carrier_code,tracking_number:c.tracking_number,description});
      // Even an acknowledged POST remains uncertain until readback confirms it.
      try {await this.refresh(token,true);const result=await this.checked(c);if(result.candidate_exists&&result.description_matches)return {status:'added_and_read_verified'};}catch {return {status:'submitted_pending_reconciliation'};}
      return {status:'submitted_pending_reconciliation'};
    });
  }
  async importLedger(input:unknown) {
    this.key();if(this.config.PARCEL_MIGRATION_ALLOWED!=='true'||this.config.PARCEL_WRITES_ENABLED==='true')throw new Blocked('migration_not_authorized');
    const o=object(input);exactKeys(o,['seen','uncertain','attempts','reads']);for(const field of ['seen','uncertain','attempts','reads'])if(!Array.isArray(o[field])||(o[field] as unknown[]).length>10000)throw new Blocked('invalid_ledger');
    if((o.attempts as unknown[]).length>20||(o.reads as unknown[]).length>20)throw new Blocked('invalid_ledger_quota_size');
    const seen=[...new Set((o.seen as unknown[]).map(validatePair))].sort();const uncertain=[...new Set((o.uncertain as unknown[]).map(validatePair))].sort();const now=this.now();
    const dates=(a:unknown[])=>a.map(t=>{if(typeof t!=='number'||!Number.isSafeInteger(t)||t<0||t>now)throw new Blocked('invalid_ledger_timestamp');return t}).sort((a,b)=>a-b);
    const attempts=dates(o.attempts as unknown[]),reads=dates(o.reads as unknown[]);const canonical=JSON.stringify({seen,uncertain,attempts,reads});const digest=await sha256(canonical);
    return withLease(this.db,async token=>{const state=await control(this.db);if(!state?.verified_at)throw new Blocked('connection_not_verified');if(state.migration_digest)return {status:state.migration_digest===digest?'migration_already_verified':'migration_conflict',digest:state.migration_digest};
      if(state.migration_pending && state.migration_pending!==digest)throw new Blocked('migration_conflict');
      // JSON expansion bounds query count while keeping the whole import transactional.
      const records=[...seen.map(pair=>({pair,status:'seen'})),...uncertain.filter(pair=>!seen.includes(pair)).map(pair=>({pair,status:'uncertain'}))];
      const reservations=[...attempts.map((at,i)=>({id:'migration:'+digest+':add:'+i,kind:'add',at})),...reads.map((at,i)=>({id:'migration:'+digest+':read:'+i,kind:'read',at}))];
      await this.db.batch([q(this.db,'UPDATE control SET migration_pending=? WHERE id=1 AND token=?',digest,token),q(this.db,`INSERT INTO ledger(pair,status,created_at,updated_at) SELECT json_extract(value,'$.pair'),json_extract(value,'$.status'),?,? FROM json_each(?) WHERE true ON CONFLICT(pair) DO NOTHING`,now,now,JSON.stringify(records)),q(this.db,`INSERT INTO quota(id,kind,at) SELECT json_extract(value,'$.id'),json_extract(value,'$.kind'),json_extract(value,'$.at') FROM json_each(?) WHERE true ON CONFLICT(id) DO NOTHING`,JSON.stringify(reservations))]);
      const restored=new Set((await q(this.db,'SELECT pair FROM ledger').all<{pair:string}>()).results.map(r=>r.pair));
      if([...seen,...uncertain].some(pair=>!restored.has(pair)))throw new Blocked('migration_readback_failed');
      const a=await q(this.db,'SELECT count(*) AS n FROM quota WHERE id>=? AND id<?','migration:'+digest+':','migration:'+digest+';').first<{n:number}>();if(a?.n!==attempts.length+reads.length)throw new Blocked('migration_readback_failed');
      await q(this.db,'UPDATE control SET migration_digest=?,migration_at=?,migration_pending=NULL WHERE id=1 AND token=?',digest,now,token).run();return {status:'migration_verified',digest,seen_count:seen.length,uncertain_count:uncertain.length,attempt_count:attempts.length,read_count:reads.length};
    });
  }
}
