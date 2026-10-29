import type {Database} from './db.ts';
import {ProgressService} from './progress.ts';
import {readBrief} from './brief.ts';
import {refreshHealth,REFRESH_AGE_MS} from './maintenance.ts';

export async function pipelineHealth(db:Database,now:number) {
  const [progress,brief,refresh]=await Promise.all([
    new ProgressService(db,()=>now).read(),readBrief(db,now),refreshHealth(db)
  ]);
  const age=progress.status==='ready'?Math.max(0,Math.floor((now-Date.parse(progress.watermark))/1000)):null;
  return {
    discovery:progress.status==='ready'?{
      status:progress.guard.active?'blocked':age!>90*60?'behind':'current',
      coverage_through:progress.watermark,coverage_age_seconds:age,
      next_action:progress.recovery.next_action,retry_not_before:progress.recovery.retry_not_before,
      recovery_attempts:progress.recovery.attempts,last_error:progress.last_error?.code??null
    }:{status:'uninitialized',next_action:'review_setup'},
    candidates:progress.status==='ready'?{
      status:progress.hold_count?'pending':'clear',held_count:progress.hold_count,
      pending_reads:progress.pending_read_count,verification_holds:progress.verification_hold_count,
      unavailable_messages:progress.unavailable_count
    }:{status:'unknown'},
    parcel_cache:{status:brief.freshness,as_of:brief.as_of,age_seconds:brief.cache_age_seconds,
      complete:brief.coverage.complete,truncated:brief.truncated,
      refresh_due:brief.cache_age_seconds===null||brief.cache_age_seconds*1000>=REFRESH_AGE_MS,
      refresh_failures:refresh?.failures??0,last_refresh_error:refresh?.last_error??null,
      retry_not_before:refresh?.retry_at?new Date(refresh.retry_at).toISOString():null},
    consumer_snapshot:{status:'unverified',reason:'receiver_readback_not_available_to_cloud_service'}
  };
}
