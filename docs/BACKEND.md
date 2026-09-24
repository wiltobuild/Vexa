# Backend foundation

This is an executable foundation, not a claim that all eight build gates pass. The frontend offers a local interactive preview and a separate connected workspace. Connected mode uses real accounts, persisted guilds/channels/messages, optimistic sending, search, pagination and gateway subscriptions. Start the services before entering connected mode.

## Run locally

Requires Node 22+, pnpm, Docker with Compose. Copy `.env.example` to `.env`, run `pnpm install`, then `docker compose up -d`. The Postgres init script installs the schema on a new volume; use `pnpm --filter @vexa/api migrate` when applying it to an existing database. Run `pnpm --filter @vexa/api dev` and `pnpm --filter @vexa/gateway dev` in separate terminals. Set `WEB_ORIGIN` to the exact browser origin, for example `http://127.0.0.1:5173`. The Vite development server proxies `/api` and `/gateway` to the local services. The Redis/Postgres/MinIO credentials are local development values, never production secrets. Each API replica must have a different `WORKER_ID` (0–1023).

## REST contract

Every mutating request requires the configured `Origin` header. Requests use JSON and `credentials: 'include'`. Authentication uses an opaque 256-bit cookie, hashed in Postgres, httpOnly, SameSite Strict; production adds Secure. Passwords use Argon2id. Auth routes have stricter Redis-backed rate limits.

| Method | Path | Body / behavior |
|---|---|---|
| POST | `/auth/register` | `{email, username, password}`; password length 12–128 |
| POST | `/auth/login` | `{email,password}` |
| POST | `/auth/logout` | Invalidates cookie/session |
| GET | `/me` | Current private profile |
| GET/POST | `/guilds` | List joined guilds; create with `{name}` and default `general` channel |
| GET/POST | `/guilds/:guildId/channels` | List visible; owner can create `{name,type,parentId?}` |
| GET | `/guilds/:guildId/members` | First 100 members, membership required |
| GET | `/channels/:channelId/messages?before=ID&limit=50` | Newest first, max 100 |
| POST | `/channels/:channelId/messages` | `{content,nonce,replyTo?}`; UUID nonce reconciles retries |
| PATCH | `/channels/:channelId/messages/:messageId` | Author edit `{content}` |
| DELETE | `/channels/:channelId/messages/:messageId` | Author or manage-messages permission |
| POST | `/channels/:channelId/typing` | Emits an expiring typing event |
| PUT | `/channels/:channelId/read-state` | `{messageId}`; only moves cursor forward |
| GET | `/channels/:channelId/search?q=words` | Postgres full-text search, permission checked |
| GET | `/health` | Verifies Postgres and Redis |

All IDs are decimal strings. Content is plain text; clients must render it as text, never raw HTML. The API does not fetch link embeds or accept file uploads yet. Categories do not implicitly inherit overwrites; each channel's explicit overwrite set is authoritative in this pass. Channel creation is owner-only pending the full guild management API.

## Gateway v1

Connect to `ws://localhost:3002` with the same session cookie and allowed browser origin. Server sends `{op:0,d:{heartbeatInterval:25000,protocolVersion:1}}`. Send `{op:1,d:{channels:["ID"]}}` to identify. Save the `session.ready` dispatch's sessionId and sequence. Send `{op:2}` every 25 seconds; server acknowledges with `op:5`. Missing heartbeats close the socket. Change subscriptions with `{op:7,d:{channels:["ID"]}}`.

After disconnect send `{op:4,d:{sessionId,seq,channels}}`. Redis retains approximately 10,000 ordered dispatches; permitted missed events replay before `session.resumed`. Invalid/expired replay windows return `op:6`; identify again and refetch. Session resume lives for an hour, refreshed by heartbeats. Each channel dispatch rechecks the HTTP session and current database permissions. Unauthorized subscriptions are dropped. Sequence numbers are global, so gaps are expected for events belonging to other channels. Client processing should be idempotent by message ID/nonce.

REST persists before an atomic Redis Lua script assigns a sequence, appends to the replay stream and publishes. Gateway nodes independently subscribe to Redis. A production transactional outbox is still required to close the Postgres-commit/Redis-publish failure window. No guaranteed exactly-once delivery or load/latency number is claimed.

## Verification and remaining gates

`pnpm --filter @vexa/shared test` covers overwrite precedence, owner/admin bypass, unrelated overwrites, snowflake order/worker uniqueness/clock regression/exhaustion and contract bounds. `pnpm -r typecheck` checks all service code. Backend integration tests require running services: set `VEXA_INTEGRATION=1` and run `pnpm --filter @vexa/gateway test`.

Pending: full integration execution, transactional outbox, per-user token-bucket quotas, complete denied-route suite, friends/DM APIs, invite and role management, moderation/audit writers, unread mention derivation, presence fan-out, lazy member ranges, uploads/SSRF-isolated embeds, media SFU and two-browser audio test, transcription workers and explicit consent/retention, OTel/Grafana, k6 measurements and production deployment. SQL includes the planned entities without implying their features are implemented. No E2EE is implemented; server-side plaintext search is intentional. Transcription feature flags default off.

