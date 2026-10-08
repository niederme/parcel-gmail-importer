# Parcel Gmail Importer: cloud adapter

A private, owner-only ChatGPT Site and MCP adapter for the Parcel API, built with TypeScript, Cloudflare Workers, D1, and Vinext. This is an independent personal project, not an official Parcel product.

This folder contains the cloud adapter alongside the repository’s existing Swift helper. It does not read Gmail or parse email. A separately authorized producer supplies a strict, verified shipment candidate; raw email, addresses, and account credentials are never tool arguments.

## Contents

- `lib/parcel/`: validation, privacy reduction, persistent quota/dedupe ledger, server-side owner checks, and MCP tools
- `app/`: minimal setup/status UI and HTTP endpoints
- `db/` and `drizzle/`: schema and append-only D1 migrations
- `tests/`: synthetic safety tests, actual local D1 integration, Worker-fetch regression, and UI rendering checks
- [SETUP.md](SETUP.md): private deployment, secure key entry, and connection
- [RUNBOOK.md](RUNBOOK.md): migration, safe cutover, limits, and recovery

## Local checks

Node.js 24 or later is required for the test suite’s built-in SQLite support. From this directory:

```sh
npm ci
npm run check
```

All tests use synthetic credentials and intercepted responses. They never contact a live Parcel account. The build creates Workers-compatible output; it does not deploy anything. For development, use `npm run dev`.

## Safety properties

Only the owner’s trusted platform identity may invoke data-bearing tools. A durable, non-expiring D1 lease serializes operations. Both read slots are reserved before fetching recent/active deliveries; an uncertain pair and addition attempt are committed before POST. Failed or unknown additions cannot resend automatically. Readback must confirm the description digest before reporting a verified addition.

Limits are 20 attempted additions per rolling 24 hours, including failures, and 20 reads per hour. Cached reads can never prove a missing addition did not occur. Redirects are not followed; only HTTP 200 with `success: true` is accepted. The native Worker fetch function is bound to its global receiver and uses manual redirect handling, covered by a Worker-runtime regression test.

## Publication and deployment state

The reference cloud deployment is active following verified ledger migration; its previous local writer is retired. One external hourly producer supplies candidates. This repository does not install or modify that schedule, and contains no deployed Site identity, owner digest, private URL, runtime values, real tracking history, or credentials. A fresh deployment starts with writes and migration disabled.

## License and assets

Project code follows the repository’s MIT license. Retain the bundled OpenAI license notice. The UI references Parcel’s official icon from Apple’s CDN without redistributing the image. That artwork is excluded from the project’s MIT grant; see [BRAND-SOURCES.md](BRAND-SOURCES.md). Its presence does not imply affiliation or endorsement.
