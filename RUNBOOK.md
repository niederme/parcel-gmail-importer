# Operations

Build into the staged `bin/parcel-gmail-importer-next`; self-tests are synthetic and never access `.env` or the network. On initial setup, move it to `bin/parcel-gmail-importer`. For upgrades, stop upstream orchestration and confirm no helper owns the state lock before replacing the installed binary. Retain a local rollback executable. Do not run competing schedulers.

## Private state and limits

Set `PARCEL_STATE_DIR` to an absolute durable private directory for Linux/cloud jobs. By default, state is stored outside the checkout at `~/Library/Application Support/GmailParcelImporter/state.json` (the legacy directory name is retained for compatibility). Directory permissions are `0700`, files `0600`. A nonblocking descriptor-held `flock` on the existing `lock` file prevents overlapping runs. Do not delete or replace the lock file, or edit state while a helper owns it. Lock contention means defer and retry later.

The helper remembers carrier/tracking pairs seen in Parcel or handled locally. Recent/active reads are cached for five minutes during ingestion; `verify` and `check` always refresh. It reserves two reads before refresh and limits itself to 20 per rolling hour. Additions are durably reserved before POST and limited to 20 attempts per rolling 24 hours, including failures. Other clients using the same account are outside these local budgets. Carrier catalog lookup is public and fail-closed; authenticated requests have 30-second per-request timeouts and reject redirects.

## Reconciliation

`added` means Parcel confirmed success. `skipped_existing` means a known pair already exists. `skipped_duplicate_or_pending` can include an unresolved previous attempt. Any failed or ambiguous addition retains a durable pending reservation; do not blindly retry or automatically clear it. A fresh `check` can confirm presence in recent/active lists, but absence does not prove an older or ambiguous addition failed. Reconcile in Parcel and require explicit review before retrying or adjusting state. Never delete/re-add a delivery just to rename it.

## Upstream Gmail integration

Use a separately authorized Gmail reader with pagination and an overlapping lookback. Verify sender/merchant, shipment versus order identifiers, carrier mapping, and label sensitivity before setting attestations. Keep a private per-message/per-pair source journal outside Git containing only the identifiers and status needed for review, never full email bodies, product details, or keys. Advance a source to handled only after confirmed addition or established duplicate; retain unresolved candidates when advancing a scan watermark. Feed candidates sequentially.

An optional scheduler belongs to that upstream integration. This repository creates none. Configure one only after a reviewed end-to-end test, and report access/rate-limit blockers instead of changing permissions or hammering endpoints.

## Privacy

`.env*`, `bin/`, logs, candidate files, progress journals, and state files are ignored. Git ignore does not remove previously tracked files. Review the index and history before publishing. The secret-file loader requires a user-owned regular file with mode `0400` or `0600`; keep the key inside the helper and never log HTTP headers, bodies, raw responses, or errors.

Official references: [view deliveries](https://parcelapp.net/help/api-view-deliveries.html), [add delivery](https://parcelapp.net/help/api-add-delivery.html), [carrier catalog](https://api.parcel.app/external/supported_carriers.json).

Cloud preparation retains the same state model; see [CLOUD.md](CLOUD.md) for single-host locking constraints, secret configuration, and cutover gates.
