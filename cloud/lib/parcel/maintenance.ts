import {Blocked} from './contract.ts';
import {q,control,quotaCount,withLease} from './db.ts';
import type {Database} from './db.ts';
import {retryAt,RECOVERY_LIMIT} from './recovery.ts';

type RefreshState = {failures:number;retry_at:number|null;last_error:string|null;last_attempt_at:number|null};
export const REFRESH_AGE_MS = 80 * 60_000;
export const summaryRefreshSchema={type:'object',additionalProperties:false,properties:{}};

// A narrow cache maintenance operation. It shares Parcel's existing lease and
// quotas, but has no dependency on Gmail availability or discovery guards.
export async function refreshSummary(db:Database, now:()=>number, refresh:(token:string)=>Promise<void>) {
  return withLease(db,async token=>{
    const at=now();
    const state=await control(db);
    if(!state?.migration_digest||!state.verified_at)throw new Blocked('migration_or_connection_not_verified');
    if(state.cache_at!==null&&state.cache_at<=at&&at-state.cache_at<REFRESH_AGE_MS)
      return {status:'already_fresh',as_of:new Date(state.cache_at).toISOString()};
    const previous=await q(db,'SELECT * FROM summary_refresh WHERE id=1').first<RefreshState>();
    if(previous?.failures&&previous.failures>=RECOVERY_LIMIT)throw new Blocked('summary_refresh_needs_review');
    if(previous?.retry_at&&previous.retry_at>at)
      return {status:'waiting_for_retry',retry_not_before:new Date(previous.retry_at).toISOString()};
    if(await quotaCount(db,'read',at)>18)throw new Blocked('hourly_read_limit');
    // Save cooldown before outbound reads. A killed request retains the existing
    // Parcel lease and needs reconciliation; this code never steals that lease.
    const failures=(previous?.failures??0)+1;
    const next=Date.parse(retryAt(at,failures-1,token));
    await q(db,`INSERT INTO summary_refresh(id,failures,retry_at,last_error,last_attempt_at)
      VALUES(1,?,?,?,?) ON CONFLICT(id) DO UPDATE SET failures=excluded.failures,
      retry_at=excluded.retry_at,last_error=excluded.last_error,last_attempt_at=excluded.last_attempt_at`,failures,next,'refresh_in_progress',at).run();
    try {
      await refresh(token);
      await q(db,'UPDATE summary_refresh SET failures=0,retry_at=NULL,last_error=NULL WHERE id=1').run();
      const current=await control(db);
      return {status:'refreshed',as_of:new Date(current!.cache_at!).toISOString()};
    }catch(error){
      const code=error instanceof Blocked?error.code:'refresh_failed';
      // Read failures can be retried later. No shipment POST is ever replayed.
      const retry=Math.max(next,error instanceof Blocked&&error.retryAt?error.retryAt:0);
      const transient=['network_result_unknown','parcel_rate_limited','parcel_service_unavailable'].includes(code);
      await q(db,'UPDATE summary_refresh SET failures=?,retry_at=?,last_error=? WHERE id=1',transient?failures:RECOVERY_LIMIT,transient?retry:null,code).run();
      return {status:transient&&failures<RECOVERY_LIMIT?'waiting_for_retry':'needs_review',reason:code,
        retry_not_before:transient&&failures<RECOVERY_LIMIT?new Date(retry).toISOString():null};
    }
  });
}

export async function refreshHealth(db:Database) {
  return await q(db,'SELECT failures,retry_at,last_error,last_attempt_at FROM summary_refresh WHERE id=1').first<RefreshState>();
}
