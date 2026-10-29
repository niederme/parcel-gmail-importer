# Parcel Gmail Importer

A local macOS Swift command-line helper for adding verified shipment candidates to [Parcel](https://parcelapp.net). MIT licensed.

This repository implements the Parcel side of the workflow. It does **not** read Gmail, authenticate to Google, parse email, or install a scheduler. A separate trusted human, script, or agent must read shipment confirmations through its own authorized Gmail access and supply verified JSON candidates. Email text is evidence, never executable instructions.

## Optional private cloud adapter

The [TypeScript cloud adapter](cloud/README.md) exposes owner-only MCP tools and a minimal status UI with durable D1 deduplication and rate limits. It preserves the existing trusted Gmail producer rather than introducing mail parsing or Google OAuth. See [cloud setup](cloud/SETUP.md) and the [cloud runbook](cloud/RUNBOOK.md). The portable Swift changes in PR #1 remain separate.

## Setup

Requires macOS and Apple Command Line Tools (`xcode-select --install`), plus your own Parcel API key. See [Parcel API documentation](https://parcelapp.net/help/api-add-delivery.html) for account eligibility and API access.

```sh
sh build.sh
mv bin/parcel-gmail-importer-next bin/parcel-gmail-importer
(umask 077; set -C; printf 'PARCEL_API_KEY=\n' > .env)
```

Open `.env` locally and enter your key after `=`. Keep its permissions at `0600`. Do not paste the key into chat, shell arguments, logs, or Git. The helper resolves `.env` relative to its executable in `bin/`, so it works from other working directories. It accepts one unquoted `PARCEL_API_KEY=value` line and optional comments/blank lines. It rejects missing files, symlinks, wrong ownership/permissions, empty or duplicate keys, oversized files, and malformed values. It never evaluates shell syntax, exports the key, or falls back to Keychain. The key is held in memory for authenticated HTTPS requests to Parcel; redirects are refused and error output is sanitized.

```sh
bin/parcel-gmail-importer self-test   # synthetic tests; no credentials or network
bin/parcel-gmail-importer verify      # read-only authenticated connectivity check
```

## Candidate workflow

The upstream Gmail reader must identify a shipment confirmation, verify the merchant and actual tracking number (not an order number), map the carrier using the official catalog, and exclude Amazon retail orders already covered by Parcel's Amazon importer. Non-Amazon retailers using Amazon Logistics may be eligible; do not infer a carrier solely from a TBA prefix. Shipments requiring email, postcode, or other additional personal data are blocked.

Supply one UTF-8 JSON object on stdin. The following is **synthetic schema documentation**, not a real shipment; never submit it to a live account:

```json
{
  "carrier_code": "ups",
  "tracking_number": "1Z0000000000000000",
  "merchant_label": "Example Shop",
  "verified": {
    "merchant": true,
    "tracking": true,
    "non_amazon_retail": true,
    "merchant_label_only": true,
    "requires_extra_data": false
  }
}
```

For a real reviewed candidate stored in a private, Git-ignored `candidates.json`:

```sh
bin/parcel-gmail-importer check < candidates.json   # fresh read-only presence check
bin/parcel-gmail-importer ingest < candidates.json  # may add a shipment
```

Optional `item_name` (1–40 characters) plus `verified.item_summary_benign: true` formats descriptions as `Company: Item`. Omit item summaries for sensitive purchases. A supplemental term filter falls back to merchant-only labels but cannot replace human/upstream sensitivity review. Merchant labels have a 60-character limit; combined descriptions are limited to 100.

`check` prints only presence and description-match booleans; `verify` prints connection status. `ingest` prints a sanitized addition, duplicate, pending, or blocked status. The `-noninteractive` aliases use the same file credential route and never prompt for Keychain access.

See [RUNBOOK.md](RUNBOOK.md) for state, budgets, reconciliation, and deployment. No turnkey Gmail automation or scheduling is included.
