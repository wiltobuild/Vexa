# Foundation operations

## Versioned migrations

`pnpm db:migrate` requires Postgres only; it no longer creates a Redis client or requires a local `.env` file when the environment is supplied by the host. Node 24+ is required for the checked-in scripts.

`infra/migrations/0001_baseline.sql` is the frozen, idempotent snapshot of the schema before migration tracking. Existing installations run it once without dropping their data; fresh installations get the same tables and triggers. `infra/schema.sql` is retained as a legacy bootstrap/test fixture, not the future migration entry point. Compose no longer initializes the schema implicitly: explicitly migrate after the database is healthy.

The runner creates `schema_migrations`, obtains a transaction-scoped advisory lock, verifies the applied history/checksums, then applies pending SQL and history rows in one transaction. A failure rolls back all pending migrations in that invocation. Concurrent runners wait on the same lock; the loser rechecks the recorded history. Lock wait is bounded to 15 seconds and statements to 120 seconds. Rerun after addressing contention or a failed migration; do not bypass history checks.

Add new files as `0002_descriptive_name.sql`, `0003_...`, etc. Never edit, rename, delete or insert before an applied migration. Checksums normalize CRLF to LF so Windows and Linux agree. Migration files must be valid inside a transaction: no explicit BEGIN/COMMIT, database creation, concurrent index operations or irreversible external side effects. Plan exceptional online operations separately with review and a tested recovery procedure.

Before production upgrades: back up the database; verify the restore; test upgrade against a staging copy; review table locks and the operation's time requirements. Existing case-insensitive duplicate usernames cause the baseline unique index to fail safely; resolve them with an approved data-cleanup plan, never automatic deletion.

This runner does not implement automatic down migrations. Prefer additive expand/contract changes and application rollback to a compatible version. A checkout missing an applied migration refuses to migrate; rolling back application code is different from rewriting database history. A destructive recovery requires a deliberate restore with a documented data-loss window.

## Configuration

API/gateway validate configuration before connecting. Errors identify the field without echoing its value. Production requires explicit DATABASE_URL, REDIS_URL, an exact HTTPS WEB_ORIGIN (no path/trailing slash), and WORKER_ID (0–1023). Set a distinct worker ID on each API process; automatic allocation is still a deployment task. Gateway shares validation but does not generate IDs.

Set HOST to the intended bind interface and API_PORT/GATEWAY_PORT to integers in 1–65535. Production refuses the sample database password, blanket proxy trust and raised CI quotas. Redis TLS/private networking and database transport/access policy still need deployment configuration; successful parsing is not a security certification.

TRUST_PROXY defaults to false. Behind a reverse proxy, allow only its real addresses/CIDRs (comma-separated). Do not use a client-controlled header or a broad private range unless the network boundary makes that range trustworthy. The optional loopback/linklocal/uniquelocal aliases require the same care. WEB_ORIGIN must match the externally visible application origin used for cookies and WebSocket authentication.

OPENAI_API_KEY remains optional and server-only. Without it, hosted transcription is unavailable; demo on-device transcription is unaffected. No cloud service was provisioned by these changes.

## Health endpoints

API and gateway expose unauthenticated `/live` (process alive) and `/ready` (Postgres and Redis checks), retaining `/health` as dependency health. Use liveness for restart decisions and readiness for routing traffic. These checks do not prove schema compatibility, restore capability, media availability or successful AI calls; add deployment smoke tests for those capabilities.

## Verification

Unit tests cover safe defaults, proxy configuration and redacted configuration failures. The API integration test creates isolated temporary schemas and checks fresh installation, legacy data preservation, concurrent runners, checksum/history rejection and rollback of a partially executed failed upgrade. CI runs it with real Postgres. The gateway integration suite probes service liveness/readiness.

Still required to close Phase 1: deployed staging, operator-owned secrets and regions, restore/rollback drills, unique worker allocation, readiness timeouts, graceful-drain verification, broader CI security tooling and reproducible deployment artifacts. Passing these tests does not close those gates.
