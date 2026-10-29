# Private cloud setup

1. Register a new owner-private ChatGPT Site for this folder. The sanitized `.openai/hosting.json` declares `DB` and MCP capability but intentionally has no project ID. Let Sites persist the new identifier privately; do not commit deployment-specific identifiers to the public repository.
2. Generate/apply the checked-in D1 migrations through the normal Sites publishing workflow. Keep the existing binding name `DB` and all migration history intact.
3. Configure `OWNER_EMAIL_SHA256` as the SHA-256 hexadecimal digest of the owner’s trimmed, lowercased, verified ChatGPT email. Calculate it privately; do not publish the email or digest. Missing or mismatched ownership configuration fails closed. The platform must strip/replace identity headers; do not expose this Worker behind a proxy that trusts caller-supplied identity headers.
4. The user opens https://chatgpt.com/sites, selects the Site, and chooses More actions → Settings. Save `PARCEL_API_KEY` as a secret runtime value. Never paste the key into chat, source, an MCP argument, a log, or D1. Agents must not retrieve the key. Official instructions: https://learn.chatgpt.com/docs/sites?surface=app#configure-runtime-environment-values
5. Keep `PARCEL_WRITES_ENABLED=false` and `PARCEL_MIGRATION_ALLOWED=false`. Publish the approved saved version to apply runtime settings. Changing a setting alone does not update the deployed Worker.
6. Connect the private plugin provisioned by the Site. The supported manual route is Plugins → Personal → Created by you. Use `parcel_status` to check configuration and then an authorized `parcel_verify_connection` call to verify read access. This consumes two reserved read slots and adds no delivery.
7. Follow [RUNBOOK.md](RUNBOOK.md) to pause the existing writer, migrate its final ledger, and perform one coordinated writer handover. A genuinely fresh installation also needs an explicitly approved empty-ledger import to establish the migration gate. Do not enable additions before migration, connection, and schedule ownership are verified.

Sites owns authentication and the provisioned plugin. Do not create custom OAuth, accept a key in the app UI, or add a separate credential vault. Keep owner-only access; sharing the UI is not permission to share the shipment ledger.

## Candidate producer

Use the existing authorized mail-reading workflow. Confirm the merchant, actual tracking number, carrier mapping, non-Amazon-retail origin, and absence of extra-data requirements. Omit sensitive or uncertain item summaries. An Amazon carrier can be valid for a non-Amazon merchant; Amazon retail orders are excluded. Verification booleans are upstream attestations, not evidence by themselves.

Use the exact schemas returned by MCP discovery. Never send raw messages, email addresses, postcodes, or order/account information. Do not submit the synthetic test fixtures to a real account.
