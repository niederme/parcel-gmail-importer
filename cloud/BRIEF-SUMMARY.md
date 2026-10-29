# Cached brief export

The owner-private implementation exposes the owner-only `parcel_brief_summary` MCP tool with exactly `{}` arguments. It is a single D1 SELECT, never refreshes Parcel or writes storage, and needs no API key. Authentication remains the existing owner-ID/email-digest check; service-only access is rejected.

## Contract version 1

- `schema_version`: 1
- `source`: `parcel_cache`
- `generated_at`: UTC ISO timestamp of this read
- `as_of`: UTC ISO timestamp of the last successful existing recent+active refresh, or null
- `freshness`: `fresh` through 2 hours, `stale` through 24 hours, otherwise `unavailable`
- `cache_age_seconds`: nonnegative integer or null
- `fresh_for_seconds`: 7200; `max_age_seconds`: 86400
- `reason`: null, `cache_missing`, `cache_timestamp_invalid`, or `cache_expired`
- `total_cached`: cache count when available, otherwise null
- `truncated`: true when more than 100 cached shipments exist
- `shipments`: at most 100 records prioritizing exceptions, out-for-delivery and other active statuses, then identity; empty when unavailable
  - `shipment_id`: SHA-256 of the internal pair, never raw tracking
  - `carrier_code`: validated cached carrier code
  - `status_code`: documented Parcel integer 0–8, or null
  - `status`: `delivered`, `frozen`, `in_transit`, `awaiting_pickup`, `out_for_delivery`, `not_found`, `failed_attempt`, `exception`, `information_received`, or `unknown`
  - `is_active`: true/false from membership in the active response; null for pre-upgrade records
  - `company`, `item`: separately attested safe labels or null
  - `label_source`: `trusted_validated_ingest` when company is available, otherwise null

Consumers must inspect freshness before use, retain the as-of time, and not treat unavailable as an empty account. Stale data may be displayed only as stale. Do not treat this recent+active cache as complete shipment history. Truncation precludes whole-account conclusions or aggregate claims from just the returned records. A fresh cache reflects Parcel API data, which can itself be cached by Parcel; it is not a live carrier refresh.

## Coverage rules

`coverage` explicitly describes only the recent+active cache. `complete` means available and all cached records fit the result, not full account history. `returned_count`, `unlabeled_count`, and `unknown_status_count` describe returned shipments. `counts_scope` is `returned_shipments`. `active_cached_count` and `active_membership_unknown_count` are separate whole-cache counts computed in the same SELECT; unavailable counts are null. `can_state_no_active` is true only for a fresh snapshot with zero active cached records and no unknown active memberships. This is a cached-as-of conclusion, not a live-carrier claim. Do not infer it independently from missing labels, status strings, an empty expired result, or the sampled rows.

## Privacy and source provenance

Parcel account descriptions, raw event text, addresses, tracking numbers, and arbitrary extra fields never enter the summary. Documented status_code integers, active-endpoint membership, and strictly normalized safe timing are retained from refreshes. The status mapping is documented at https://parcelapp.net/help/api-view-deliveries.html.

Optional backward-compatible shipment fields (absent in old exports, nullable in new exports):

- `expected_delivery`: `{date, time, end_date, end_time, timezone, source}` or null. Dates are real `YYYY-MM-DD` calendar dates; times are `HH:mm` or null. Date-only input never invents midnight. Floating midnight with no absolute timestamp or delivery window is conservatively displayed as date-only; this also normalizes old cached timing at read time. `timezone` is null for the source's timezone-unspecified clock, or `UTC` only when an explicit offset or plausible epoch establishes an instant. `source` is `parcel_api`.
- `latest_event`: `{status, date, time, timezone, source}` or null. Status is a canonical safe code derived from an actual carrier event, not the shipment status: `delivered`, `out_for_delivery`, `delivery_attempted`, `available_for_pickup`, `arrived_at_facility`, `departed_facility`, `in_transit`, `label_created`, `customs_clearance`, or `delivery_exception`. No raw event/location/additional text is retained.

The parser accepts strict ISO calendar/date-time strings only. It recognizes integer epochs only within disjoint plausible seconds/milliseconds ranges for 2000–2099. It rejects malformed, relative, ambiguous/localized dates, impossible dates, inconsistent timezone windows and reversed windows. Numeric strings are not accepted. Latest-event ordering requires all event dates to parse on one timezone basis; ties with different event kinds fail closed. Consumers must not interpret `timezone:null` as local-machine time or UTC. Unrecognized API formats stay null until explicitly supported. No extra read happens during a brief.

Company/item labels originate from a trusted validated shipment candidate, either a new import or explicit cache-only repair. Existing attestations and item screening apply; sensitive or unattested items are not stored. Labels are saved atomically with the existing uncertain-pair/addition reservation, before POST. Label-write failure therefore blocks the whole reservation/POST. A label appears only when the cache's description digest matches its stored digest. Account-edited descriptions fail closed. Arbitrary account descriptions remain untrusted; duplicate ingest requests do not retroactively attest labels.

Labels are readable for strictly less than 30 days from attestation, with at most 600 retained rows. Expired/future-dated labels are removed during the existing authorized refresh or new reservation path; the summary never runs cleanup. If imports/refreshes stop, expired labels remain physically stored until the next authorized mutation, but they are immediately excluded from read results. Existing deduplication and quota history are never pruned by this change.

## Explicit label repair

`parcel_repair_brief_label` accepts a validated `candidate`, with the same merchant/tracking/non-Amazon-retail and benign-item attestations as ingestion. It makes no network calls and needs no Parcel key. It changes only `brief_labels`, with one conditional SQL statement. It requires a fresh valid cache, an existing seen ledger pair, no held importer lease, and a matching safe-description digest. Candidate validation alone does not make account descriptions trusted; the caller must independently verify the source merchant and tracking.

When an independently verified shipment notice proves the merchant and tracking but an old account label differs, optional `evidence` must contain exactly `source: independently_verified_shipment_notice` and the current `cached_description_hash`. If that digest differs from the safe candidate description, this explicit repair stores company-only, never the account text or a new item. A subsequent account edit invalidates the label. This route must never be used to infer a merchant from arbitrary Parcel text.

Repairs do not update Parcel deliveries, ledger, quota, cache or control. Existing unexpired identical attestations retain their original expiry; fresh source re-attestation can renew expired labels. The 600-row bound remains. Sensitive, child-specific or unattested items become company-only. `trusted_validated_ingest` remains the v1 provenance tag for these trusted producer-validated candidates to avoid a breaking enum change.

## Deployment and migration

Keep the existing project, private audience, D1 binding, runtime settings and schedules. The additive `0003_lumpy_jean_grey.sql` migration adds nullable normalized timing columns to `parcel_cache`; all existing ledger, quota, lock and uncertainty behavior stays intact. Deploy the exact tested source using the standard Sites workflow. Publish a receiver compatible with the optional fields before the producer.

A cache-only post-deploy read cannot recover fields discarded by the old version. Reuse the existing refresh schedule, or a separately authorized bounded `parcel_verify_connection` for end-to-end verification (two rate-budgeted GETs, no delivery write). Do not refresh on every brief. Existing validated labels can be repaired explicitly after a successful fresh read; do not resend duplicate deliveries.

Rollback to old application code tolerates these additive columns. Never drop tables or erase migration, ledger or quota history to roll back.
