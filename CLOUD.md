# Cloud migration preparation

This branch prepares a Linux CLI/container worker. It does not deploy anything, expose a server, create cloud resources, migrate credentials or state, authenticate to Gmail, install a scheduler, or stop an existing importer.

## Minimal architecture and caller boundary

A separately authorized Gmail producer verifies candidates and supplies one JSON object through stdin to an isolated worker job. A provider-native authenticated job API (or a reviewed private MCP adapter) must bridge that producer to the job. The existing chat's Gmail connection does not authenticate a container and is not copied into it. No inbound HTTP listener or anonymous endpoint is included.

Each job runs `check`, `verify`, or `ingest`, returns only the existing sanitized JSON output, and shares one private durable state directory. Start with a single worker/serialized queue on one host. `flock` is for a local POSIX filesystem; it is not a distributed lock across replicas or object storage. Multiple nodes need transactional shared state and a distributed lease before they are safe.

The Linux/container route needs a selected host with a callable authenticated job API, persistent local storage, outbound HTTPS to Parcel, and secret injection. A Sites-hosted MCP on Cloudflare Workers cannot run the Swift executable; it would require a TypeScript port with transactional durable storage (for example D1) and equivalent reservation semantics. Select the callable route before adding a server or provider-specific infrastructure.

## Configuration

| Variable | Meaning |
| --- | --- |
| `PARCEL_STATE_DIR` | Absolute private durable directory; container default `/state`. Native default retains the legacy macOS state path. |
| `PARCEL_SECRET_FILE` | Absolute path to a mounted text file with one unquoted `PARCEL_API_KEY=value` line. File must be regular, not a symlink, owned by the worker UID, mode `0400` or `0600`, at most 8192 bytes. |
| `PARCEL_API_KEY` | Optional platform-injected secret environment value, never a command-line argument. Prefer the mounted file because platform inspection/crash tooling may expose environment variables. |

Setting both secret variables fails closed. With neither set, the native helper reads the checkout-root `.env`. Missing/empty/malformed credentials fail before authenticated requests; there is no Keychain fallback. Never put secrets in Docker build arguments, image layers, source, job payloads, logs, or PRs. Create a new secret in the chosen provider only after explicit approval; this preparation does not read/copy an existing `.env`.

State directory must be owned by the worker UID and mode `0700`; lock/state files require `0600`. The runtime image uses UID/GID `10001`. A host/platform administrator must provision volume and secret ownership accordingly. A platform that can only mount a root-owned world-readable secret needs a different approved injection arrangement; do not relax the file checks.

## Build and synthetic validation

Requires Docker on the build host, or an installed Swift toolchain on Linux/macOS:

```sh
sh build.sh
# or
docker build -t parcel-helper:local .
docker run --rm --network none --read-only \
  --tmpfs /tmp:rw,noexec,nosuid,size=32m parcel-helper:local self-test
```

The official `swift:6.4.0-noble` image is used for both build and runtime, preserving runtime libraries. The version tag is not an immutable digest; pin a reviewed digest before deployment. The Docker build context is allowlisted to the Dockerfile, build script, and Swift source, excluding secrets, history, ledgers, and binaries. No secrets or network requests are required by self-tests. CI builds and tests Linux and runs the runtime without networking.

After provisioning approved private mounts (paths below are placeholders, not existing secrets), a job invocation would be:

```sh
docker run --rm -i --read-only \
  --tmpfs /tmp:rw,noexec,nosuid,size=32m \
  --mount type=bind,src=/approved/private/state,dst=/state \
  --mount type=bind,src=/approved/private/parcel-secret,dst=/run/secrets/parcel,readonly \
  -e PARCEL_SECRET_FILE=/run/secrets/parcel \
  parcel-helper:local check < /approved/private/candidates.json
```

Only switch the mode to `ingest` for an explicitly verified real candidate. Bind mount the same durable state for every invocation. Never use an ephemeral `/state` for production, even if a single check succeeds. `verify` and `check` reserve read budgets and update local seen/cache state, although they do not mutate Parcel deliveries.

## Shared behavioral contract for a future port

Retain the candidate schema and conservative validation in README, and the synthetic self-tests in `Sources/Importer.swift` as the reference fixtures. Required equivalence:

- Reject ambiguous/order identifiers, Amazon retail, unsupported carriers, and extra personal-data requirements. Require explicit attestations and conservative label rules. Optional benign item descriptions have identical fallback/length behavior.
- Normalize carrier/tracking pairs; retain seen and uncertain reservations across restarts. An uncertain reservation blocks automatic retry.
- Atomically reserve an addition **before** any POST, retaining it on all failures. Limit to 20 attempts per rolling 24 hours, including failed attempts.
- Reserve two reads before recent/active refresh; limit to 20 reads per rolling hour and use a five-minute cache only for ingestion. Presence checks always refresh; historical absence is inconclusive.
- Serialize state changes. POSIX worker uses the same lock file and atomic replace plus file/directory `fsync`; a database port needs equivalent transactional reservation and locking, not a read-then-write race.
- Permit only authenticated Parcel HTTPS requests, refuse redirects, and sanitize outputs. Never return keys, raw HTTP errors/responses, delivery lists, or candidate bodies.

The Swift synthetic suite tests credential parsing/permissions/symlinks, configuration validation, lock contention, durable pending/budget state round-trip, duplicate/pending crash reservations, budget rollover, cache expiry, and candidate/description rules. These are the minimum regression gates for either cloud route.

## Cutover gates and decisions

Decide hosting/caller authentication, secret injection, durable storage and backup, single-worker execution/timeout semantics, and ownership of the existing hourly Gmail orchestration. Do not create a competing schedule.

Before cutover: complete Linux CI, provision approved private resources and credentials, confirm the caller can invoke read-only verification, and test duplicate/pending/rate-limit behavior with synthetic state. Pause the local writer, acquire its existing state lock, and copy/reconcile the ledger and upstream watermark privately under an approved migration procedure. Never start a cloud writer with an empty history while the local writer remains active. Verify the migrated state and read-only candidate presence before enabling cloud ingestion, and retain a rollback plan. No production cutover is performed by this PR.

References: [Swift Linux installation](https://swift.org/install/linux/ubuntu/24_04/), [official Swift images](https://hub.docker.com/_/swift), [Docker volumes](https://docs.docker.com/engine/storage/volumes/), [Docker secrets](https://docs.docker.com/engine/swarm/secrets/).
