# Private Parcel importer

A TypeScript/Cloudflare Workers port of the validated candidate contract from niederme/parcel-gmail-importer, commit 6b49856692d7dc253f352d0b8d732598702716c9. This Site does not access Gmail or parse mail. The existing trusted producer remains responsible for verifying the shipment, merchant, and item privacy.

## Deployment state

The reference cloud importer is active after verified ledger migration. Its prior local writer is retired, and one authorized external hourly producer supplies candidates. No account-specific deployment identifiers, flags, credentials, history, counts, or timestamps are included here. Use authenticated live status as the authority for an actual deployment.

Fresh deployments must remain owner-private and begin with writes/migration disabled. The platform’s verified identity headers and a privately configured owner digest enforce ownership. Discovery returns static schemas only; service-only requests cannot access user data.

## Secure key management

The supported user-managed route is https://chatgpt.com/sites → this Site → More actions → Settings. Enter PARCEL_API_KEY as a secret runtime value, then deploy the approved saved version to apply the new environment revision. Official instructions: https://learn.chatgpt.com/docs/sites?surface=app#configure-runtime-environment-values

The user enters and saves the key directly. Do not retrieve or display its value, paste it into chat or MCP arguments, copy it from the Mac, commit it to source, or store it in D1. Use parcel_status to check presence and parcel_verify_connection for an authorized read-only connection test. Preserve existing secrets when changing non-secret mode flags.

## Controlled cutover

1. Confirm the Site's private plugin and Parcel key are configured. Use parcel_status; never include the key in a tool argument.
2. Call parcel_verify_connection. It makes two read requests and persists the quota reservation before either one.
3. Pause the sole upstream producer and stop or exclusively lock every local writer before taking the final snapshot. Keep that pause/lock in place through import verification and the completed handover. Obtain an explicitly approved snapshot of the local ledger. Do not read the Mac's .env or key. Preserve the complete seen and uncertain pair sets and rate-limit timestamps. Swift Codable Date values are seconds since 2001-01-01; convert these to Unix milliseconds by rounding (value + 978307200) * 1000 upward, preserving conservative quota expiry. Retain every attempt, including failures. Cache dates need not be imported; cloud reads refresh them.
4. Set PARCEL_MIGRATION_ALLOWED=true only for the approved transfer. Keep the local writer and producer paused. Import the snapshot and verify returned digest/counts, with actual local source counts confirmed. A conflicting snapshot fails closed. Same-snapshot retries are idempotent.
5. Proceed under the user's approved handover instruction only after verification is complete. Prevent overlapping local/cloud writers during the switch and conservatively preserve account-level rate usage. Only then set PARCEL_WRITES_ENABLED=true, PARCEL_MIGRATION_ALLOWED=false and apply the runtime revision. Switch the single existing Gmail producer to parcel_ingest_candidate, verify that no duplicate schedule remains, and only then release the local hold with the old writer retired. No cloud schedule is created by this code.

For a fresh installation with no prior local ledger, still require an explicit approved empty snapshot (`seen`, `uncertain`, `attempts`, and `reads` each an empty array) after connection verification. Importing it establishes the same migration gate without omitting any known account history. Never substitute an empty snapshot when a prior ledger exists.

## Import safety

One permanent D1 lease serializes read/write operations across isolates. The lease is never automatically stolen, even if old. A terminated request may have reached Parcel; stale locks require supervised recovery with read-only reconciliation. There is deliberately no public unlock or retry endpoint.

Addition quota and the uncertain pair are saved in one D1 transaction before POST. Failures, malformed replies, and network timeouts consume quota and keep the pair blocked. Even a successful POST is reported as pending until a fresh readback sees the expected description digest. Missing cached results never authorize a retry. Reconciliation can confirm existing pairs but cannot resend them.

Recent plus active reads use a five-minute local cache for normal ingest. Verification/check calls force reads. Both read slots are reserved before either request; failures count. Limits are rolling 20 additions/24 hours and 20 reads/hour. These local controls cannot see independent clients using the same account; do not run competing producers.

Only pair keys, description hashes, operation timestamps, quota records, and setup markers are retained. Sensitive or unclear item text becomes company-only before any Parcel write; the server denylist is defense in depth, not a comprehensive classifier. The trusted producer must omit any sensitive or unclear item. Responses and errors never reflect Parcel's raw bodies or secrets. No telemetry or raw request logging is added.

## Testing

node --experimental-transform-types --test tests/parcel.test.ts
node --experimental-transform-types --test tests/d1-integration.test.ts
npx tsc --noEmit

Tests use synthetic credentials and fake Parcel responses only. The second suite exercises real local D1 through Miniflare. It never calls Parcel. Coverage includes unauthorized owners/service-only access, strict schema and carrier mapping, exact outbound body, crashes/timeouts/failures, persisted quotas, races, deduplication, cached readback, migration retry, and stale lease safety.

## Recovery and changes

Do not delete ledger history or quotas to clear a block. Do not interpret missing active/recent results as a complete account history. Do not change sharing to repair authentication. Migration SQL and metadata are immutable once deployed; append new schema migrations. The Site uses platform D1 only and no separate paid resources were purchased.
