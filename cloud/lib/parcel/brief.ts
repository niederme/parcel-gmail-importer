import type {Database} from './db.ts';
import {sha256,safeItemName} from './contract.ts';
import {storedTiming} from './timing.ts';
import type {ExpectedDelivery,LatestEvent} from './timing.ts';
export const BRIEF_LABEL_RETENTION_MS=30*86400000;
export const BRIEF_FRESH_MS=2*3600000;
export const BRIEF_MAX_AGE_MS=24*3600000;
export const BRIEF_LIMIT=100;
const statuses=['delivered','frozen','in_transit','awaiting_pickup','out_for_delivery','not_found','failed_attempt','exception','information_received'] as const;
type Row={cache_at:number|null;pair:string|null;description_hash:string|null;status_code:number|null;is_active:number|null;expected_delivery:string|null;latest_event:string|null;total:number;active_count:number;membership_unknown_count:number;company:string|null;item:string|null;attested_at:number|null};
/** Cache-only: a single SELECT snapshot. Never refresh, mutate storage or consume a lease/quota. */
export async function readBrief(db:Database,now:number) {
 const rows=(await db.prepare(`SELECT c.cache_at,p.pair,p.description_hash,p.status_code,p.is_active,p.expected_delivery,p.latest_event,
 (SELECT count(*) FROM parcel_cache) AS total,(SELECT count(*) FROM parcel_cache WHERE is_active=1) AS active_count,(SELECT count(*) FROM parcel_cache WHERE is_active IS NULL OR is_active NOT IN (0,1)) AS membership_unknown_count,l.company,l.item,l.attested_at
 FROM control c LEFT JOIN parcel_cache p ON 1=1
 LEFT JOIN brief_labels l ON l.pair=p.pair AND l.description_hash=p.description_hash
 AND l.attested_at>? AND l.attested_at<=?
 WHERE c.id=1 ORDER BY CASE WHEN p.status_code IN (6,7) THEN 0 WHEN p.status_code=4 THEN 1 WHEN p.status_code IN (2,3,8) THEN 2 WHEN p.status_code IS NULL THEN 3 ELSE 4 END,p.pair LIMIT ?`).bind(now-BRIEF_LABEL_RETENTION_MS,now,BRIEF_LIMIT+1).all<Row>()).results;
 const at=rows[0]?.cache_at??null;
 const valid=typeof at==='number'&&Number.isSafeInteger(at)&&at>=0&&at<=now;
 const age=valid?now-at!:null;
 const available=age!==null&&age<=BRIEF_MAX_AGE_MS;
 const shipments=available?await Promise.all(rows.filter(r=>r.pair!==null).slice(0,BRIEF_LIMIT).map(async r=>({
  shipment_id:await sha256(r.pair!),
  carrier_code:r.pair!.split(':',1)[0],
  status:r.status_code!==null&&Number.isInteger(r.status_code)&&r.status_code>=0&&r.status_code<statuses.length?statuses[r.status_code]:'unknown',
  status_code:r.status_code!==null&&Number.isInteger(r.status_code)&&r.status_code>=0&&r.status_code<statuses.length?r.status_code:null,
  is_active:r.is_active===1?true:r.is_active===0?false:null,
  company:r.company??null,item:r.company?safeItemName(r.item):null,
  label_source:r.company!==null?'trusted_validated_ingest':null,
  expected_delivery:storedTiming<ExpectedDelivery>(r.expected_delivery,'expected'),
  latest_event:storedTiming<LatestEvent>(r.latest_event,'event'),
 }))):[];
 return {schema_version:1,source:'parcel_cache',generated_at:new Date(now).toISOString(),
  freshness:available?(age!<=BRIEF_FRESH_MS?'fresh':'stale'):'unavailable',
  as_of:valid?new Date(at!).toISOString():null,cache_age_seconds:age===null?null:Math.floor(age/1000),
  fresh_for_seconds:BRIEF_FRESH_MS/1000,max_age_seconds:BRIEF_MAX_AGE_MS/1000,
  reason:available?null:at===null?'cache_missing':!valid?'cache_timestamp_invalid':'cache_expired',
  total_cached:available?(rows[0]?.total??0):null,truncated:available&&(rows[0]?.total??0)>BRIEF_LIMIT,
  coverage:{scope:'recent_and_active_cache',complete:available&&(rows[0]?.total??0)<=BRIEF_LIMIT,returned_count:shipments.length,unlabeled_count:available?shipments.filter(s=>s.label_source===null).length:null,unknown_status_count:available?shipments.filter(s=>s.status_code===null).length:null,counts_scope:'returned_shipments',active_cached_count:available?(rows[0]?.active_count??0):null,active_membership_unknown_count:available?(rows[0]?.membership_unknown_count??0):null,can_state_no_active:available&&age!<=BRIEF_FRESH_MS&&(rows[0]?.active_count??0)===0&&(rows[0]?.membership_unknown_count??0)===0},
  shipments};
}
