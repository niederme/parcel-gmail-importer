// Bounded retries for Gmail reads only. Never authorizes a Parcel write or a
// manual/authentication guard, and never discards a pending search or message.
export const RECOVERY_LIMIT = 6;
export const RECOVERY_LEASE_MS = 5 * 60_000;
const DELAYS = [5, 15, 30, 60, 120, 240].map(n => n * 60_000);
export type Recovery = {
  category: string;
  message_id?: string;
  attempts: number;
  next_attempt_at: string;
  attempt: { id: string; expires_at: string } | null;
};
export const retryable = (code: string) =>
  ['rate_limited', 'unavailable', 'network_error', 'partial'].includes(code);

// Stable per-operation jitter makes an uncertain commit safe to replay.
export function retryAt(now: number, attempts: number, key: string, providerTime: string | null = null) {
  let hash = 0;
  for (const c of key) hash = (Math.imul(hash, 31) + c.charCodeAt(0)) >>> 0;
  const delay = DELAYS[Math.min(attempts, DELAYS.length - 1)] + hash % 60_000;
  return new Date(Math.max(now + delay, providerTime ? Date.parse(providerTime) : 0)).toISOString();
}

export function recoveryView(recovery: Recovery | null | undefined, guarded: boolean, now: number) {
  if (!guarded) return { next_action: 'continue_discovery', attempts: 0, retry_not_before: null };
  if (!recovery) return { next_action: 'review_source_guard', attempts: 0, retry_not_before: null };
  if (recovery.attempt && Date.parse(recovery.attempt.expires_at) > now)
    return { next_action: 'wait_for_recovery_attempt', attempts: recovery.attempts, retry_not_before: recovery.attempt.expires_at };
  if (recovery.attempts >= RECOVERY_LIMIT)
    return { next_action: 'recovery_exhausted', attempts: recovery.attempts, retry_not_before: null };
  return { message_id: recovery.message_id??null, next_action: Date.parse(recovery.next_attempt_at) > now ? 'wait_for_retry' : recovery.message_id?'begin_message_recovery':'begin_recovery',
    attempts: recovery.attempts, retry_not_before: recovery.next_attempt_at };
}
