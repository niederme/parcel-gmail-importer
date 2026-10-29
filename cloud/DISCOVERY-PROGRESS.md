# Durable discovery progress (private MCP)

This feature adds **discovery_progress** and **discovery_audit** to the existing D1 binding. It never reads Gmail/Parcel, calls a provider, touches the five existing importer tables, modifies credentials/access, or creates a schedule. Existing owner authentication applies to both new tools.

## Authority and incremental workflow

`parcel_discovery_progress` is authoritative. Workspace JSON/journal files are diagnostics only. Read it at the start of every run; do not restore cloud data from a stale local snapshot. Require initialized state before discovery. If the read fails, stop discovery without changing pending work.

1. Read the current revision, guard, watermark and pending search. A planned query is **not completed coverage**. If a pending search exists, resume exactly its query/cursor/search ID. Do not open a competing search.
2. If no pending search exists and the source guard permits work, commit `begin_search` using the returned exact planned query. The server records a conservative search-start timestamp before Gmail is called. This is the search coverage time, not the finish time. The existing filter is retained verbatim with an exact epoch boundary one hour before the last complete watermark.
3. Call Gmail using the stored exact query and cursor. Persist each successful page through `page_success`, passing the cursor that was requested, the returned next cursor (null only on a successful terminal page), and all message IDs on that page. Previously known messages retain their review/hold state. Newly discovered IDs become pending reads.
4. Only a successful terminal page advances discovery to its recorded start and clears pending search. Candidate verification may remain pending independently; it does not widen the next discovery query.
5. On a failed page, record `search_failure` with the same search ID/cursor and a bounded reason code. It cannot accept or update a watermark, nor discard the pending query. Include any actual source cooldown/hold as `guard` in that same failure commit, so the error and guard are atomic; `set_guard` also supports separately authorized recovery. An active guard remains active after its time passes. Transient failures now return a bounded recovery plan; use the narrowly scoped transitions below. Manual/authentication guards still require separately authorized recovery. Routine runs must not use `set_guard` to clear them.
6. Resolve message IDs with `merge_resolution`, providing only affected records. An omitted record is unchanged. Reviewed state cannot regress. Clearing pending reads, verification holds or shortening retry guards requires `resolve_ids`; clearing unavailable/404 additionally requires `restore_unavailable_ids` and separately authorized source recovery. Never automatically retry a404. The server cannot assess email evidence; the trusted producer must verify source evidence before resolving/importing.

Every commit requires `expected_revision`, a unique `operation_id`, and `run_id`. On conflict, reread durable state and reassess the operation. Never blindly replace the state from an old snapshot. Retry an uncertain commit with the **same exact arguments**; it returns `already_committed` if the request digest matches. A revision is advanced by one atomically with the state and audit. Failed CAS changes no state/audit. Concurrent same-request retries are idempotent.

## Read coverage

Default read includes metadata and at most200 held/pending records; `holds_complete:false` requires continuation with `holds_after_id:holds_next_after_id`. Optional reviewed-ID output is bounded to2000 per page and has analogous `reviewed_complete`/`reviewed_next_after_id` fields. Supply `expected_revision` on continuation pages; if it conflicts, start over rather than combine different snapshots. Selected statuses for at most200 IDs can be requested via `message_ids`. Counts cover the entire stored state, not only the returned page. Never treat a truncated tool response as complete.

## Initialization and retention

`initialize` is a one-time atomic import of a verified fully paginated watermark, minimal per-ID statuses/holds, current guard and historical journal counts. It accepts no raw email, descriptions, tracking numbers or purchase data. It does not fabricate missing historical journal entries. It fails if cloud progress already exists or the baseline is future/partial. Initialization must be coordinated with the existing producer; initialize from the latest verified checkpoint, then switch producer instructions to the new API. No schedule pause or additional schedule is needed.

State is bounded to10000 IDs and2MB. Incoming MCP requests are independently limited to512KB, so a large initialization may fail closed; never truncate records to fit. Current migration is within that cap. At capacity, obtain an explicit retention design rather than silently deleting holds/reviews. Minimal audit retains the latest10000 operations (old/new watermark, revision, operation/run IDs, request hash, server timestamp). Idempotency receipts exist within that window; an older retry still fails its stale revision and cannot overwrite current state.

## Verification

`node --experimental-transform-types --test tests/progress.test.ts`

Tests use real local D1 with synthetic data and zero provider calls. Validate publication through the owner-private Sites workflow; verify current live tool state and exact migrated counts. Same-run readback is not proof across restored workspaces: the next hourly run must fetch this durable revision before any Gmail search and continue without regression. Preserve the existing schedule and all shipment/summary safeguards.

## Bounded transient recovery

The October 29 repair preserves the existing revision/audit transaction and stores optional recovery metadata alongside progress. No progress reinitialization is needed. Existing manual guards without recovery metadata remain held. `search_failure` and `message_read_failure` create recovery plans only for explicit `rate_limited`, `unavailable`, `network_error`, or `partial` failures. A provider deadline is never shortened. Unknown/authentication failures require review.

Read `recovery.next_action` and `retry_not_before`. Wait until eligible, then commit `begin_recovery` for the exact pending search/cursor or `begin_message_recovery` for its exact message ID. The commit reserves one five-minute attempt under CAS and consumes one of six attempts. Include its attempt ID as `recovery_attempt_id` in the matching success/failure transition. A crash consumes the attempt and cannot open an unlimited retry loop. Retries use increasing 5/15/30/60/120/240-minute delays plus at most one minute of stable jitter; the existing hourly schedule supplies the next execution opportunity.

A matching page success clears only this transient source guard. Nonterminal success never advances the watermark. `message_read_success` clears the matched source guard but leaves the message pending until classification; it does not verify or import a shipment. An actual `not_found` result preserves an unavailable message and does not permit an automatic retry. Manual guards, authentication failures, exhausted budgets and expired/mismatched attempt responses fail closed. The producer must implement this contract in its own existing scheduler.
