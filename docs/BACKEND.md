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
| GET | `/guilds/:guildId/permissions` | Caller's own guild-level bits and owner flag, `{bits,owner}` |
| GET/POST | `/guilds/:guildId/roles` | List roles; create `{name,permissions}` (requires `MANAGE_GUILD`) |
| PATCH/DELETE | `/guilds/:guildId/roles/:roleId` | Edit or delete a role (requires `MANAGE_GUILD`; the `@everyone` role, `id===guildId`, cannot be deleted) |
| PUT/DELETE | `/guilds/:guildId/members/:userId/roles/:roleId` | Grant/revoke a role (requires `MANAGE_GUILD`) |
| DELETE | `/guilds/:guildId/members/:userId` | Kick (requires `KICK_MEMBERS`; owner cannot be kicked) |
| GET/POST | `/guilds/:guildId/bans` | List bans; ban `{userId,reason?}` (requires `BAN_MEMBERS`; also removes membership) |
| DELETE | `/guilds/:guildId/bans/:userId` | Unban (requires `BAN_MEMBERS`) |
| PUT | `/guilds/:guildId/members/:userId/timeout` | `{minutes}` (0 clears); strips `SEND_MESSAGES`/`SPEAK` immediately, no reconnect needed (requires `MODERATE_MEMBERS`) |
| GET | `/guilds/:guildId/audit-log` | Last 50 moderation/role actions (requires `MANAGE_GUILD`) |
| GET | `/relationships` | `{friends,outgoing,incoming,blocked}`, each a list of `{id,username,avatar_url}` |
| POST | `/relationships/requests` | `{username}`; if they'd already requested you, this accepts instead of duplicating |
| POST | `/relationships/:userId/accept` | Accept an incoming request |
| DELETE | `/relationships/:userId` | Decline/cancel/unfriend (whichever applies); never touches a block |
| POST/DELETE | `/relationships/:userId/block` | Block/unblock; blocking also closes any existing DM both ways |
| GET/POST | `/dms` | List your DM channels (each with the other participant); open one with `{userId}`, reused if it already exists |
| GET | `/health` | Verifies Postgres and Redis |

All IDs are decimal strings. Content is plain text; clients must render it as text, never raw HTML. The API accepts bounded consented audio for private transcription; it does not fetch link embeds or accept message attachments yet. Categories do not implicitly inherit overwrites; each channel's explicit overwrite set is authoritative in this pass. Channel creation is owner-only pending the full guild management API.

**Friends and DMs.** `relationships` is a directed table: a `'pending'` row is always the sender's own outgoing request, and the recipient's incoming view is the same row queried from the other side — never duplicated. Sending a request when the other side already has one pending for you completes the friendship immediately instead of leaving two rows pointing past each other. Usernames are case-insensitively unique (`users_username_unique` in `infra/schema.sql`) so `/relationships/requests` can resolve a `{username}` unambiguously. A DM channel (`type='dm'`, no `guild_id`) is created once per pair and reused on a later `POST /dms`; `channelPermissions` in `apps/api/src/db.ts` gives it a separate, simpler check than guild channels (`dm_members` membership, no roles/overwrites/timeouts) and denies the whole channel — not just sending — the moment either side blocks the other, even retroactively on a DM that predates the block. Group DMs (`type='group_dm'`) share the same schema and permission path but have no creation endpoint yet.

**Role and moderation permissions never let a non-owner escalate.** Creating/editing a role, or granting one to a member, is rejected with 403 unless every bit in the requested `permissions` is already held by the actor (owner bypasses this, matching `ALL_PERMISSIONS`). So `MANAGE_GUILD` alone is not a path to self-granted `ADMINISTRATOR` or any other bit the actor doesn't hold — see `guildPermissions`/`requireGuild` in `apps/api/src/db.ts`.

The API trusts `X-Forwarded-For` by default (`trustProxy`, see `.env.example`'s `TRUST_PROXY`) so the per-IP rate limiter doesn't collapse into one shared bucket behind a reverse proxy/CDN; set `TRUST_PROXY=false` only when the API is reachable directly with no proxy in front.

## Gateway v1

Connect to `ws://localhost:3002` with the same session cookie and allowed browser origin. Server sends `{op:0,d:{heartbeatInterval:25000,protocolVersion:1}}`. Send `{op:1,d:{channels:["ID"]}}` to identify. Save the `session.ready` dispatch's sessionId and sequence. Send `{op:2}` every 25 seconds; server acknowledges with `op:5`. Missing heartbeats close the socket. Change subscriptions with `{op:7,d:{channels:["ID"]}}`.

After disconnect send `{op:4,d:{sessionId,seq,channels}}`. Redis retains approximately 10,000 ordered dispatches; permitted missed events replay before `session.resumed`. Invalid/expired replay windows return `op:6`; identify again and refetch. Session resume lives for an hour, refreshed by heartbeats. Each channel dispatch rechecks the HTTP session and current database permissions. Unauthorized subscriptions are dropped. Sequence numbers are global, so gaps are expected for events belonging to other channels. Client processing should be idempotent by message ID/nonce.

Message and reaction triggers persist an outbox entry atomically with each mutation. A single advisory-locked publisher retries pending entries through an atomic Redis Lua script that assigns a sequence, appends to the replay stream and publishes. Gateway nodes independently subscribe to Redis. Retried batches may repeat events and clients reconcile them. No guaranteed exactly-once delivery or load/latency number is claimed.

## Verification and remaining gates

`pnpm --filter @vexa/shared test` covers overwrite precedence, owner/admin bypass, unrelated overwrites, snowflake order/worker uniqueness/clock regression/exhaustion and contract bounds. `pnpm -r typecheck` checks all service code. Backend integration tests require running services: set `VEXA_INTEGRATION=1` and run `pnpm --filter @vexa/gateway test`.

Pending: per-user token-bucket quotas, complete denied-route suite, group DMs, unread mention derivation, presence fan-out, lazy member ranges, uploads/SSRF-isolated embeds, media SFU and two-browser audio test, group-call transcription workers and track-level consent/retention, OTel/Grafana, k6 measurements and production deployment. SQL includes the planned entities without implying their features are implemented. No E2EE is implemented; server-side plaintext search is intentional. Transcription feature flags default off. Role management, invites, member moderation (kick/ban/timeout, with an audit-log writer) and friends/1:1 DMs (with request/accept/block, reachable from the web UI) are implemented and covered by `apps/gateway/test/integration.test.ts` and `apps/web/e2e/connected.spec.ts`.


## Personal Recall and profiles

See [Whisper and profiles](WHISPER-AND-PROFILES.md). `PATCH /me` accepts `{avatar,bio}`; `GET /me/transcriptions/status` reports Whisper availability; `GET/POST /me/transcriptions` lists/creates private notes; `DELETE /me/transcriptions/:id` deletes an owned note. POST requires one multipart `audio` file and `X-Vexa-Consent: microphone-transcription`, plus the normal cookie/origin checks.

## Message reactions

The demo and connected workspace share a 12-choice reaction picker. `GET /channels/:channelId/reactions?messages=ID,ID` returns `{message_id,emoji,count,reacted}` for up to 100 messages, scoped to the channel and current viewer. It never returns reactor account IDs. `PUT/DELETE /channels/:channelId/messages/:messageId/reactions/:emoji` adds/removes only the authenticated user's reaction. Supported values match the picker; writes require SEND_MESSAGES and reads require VIEW_CHANNEL. Timeouts and blocked DMs use the existing channel permissions.

The composite primary key makes repeated PUTs idempotent. Reaction mutations enqueue `reaction.update` with `{messageId}` in the same transaction; the gateway rechecks access before delivery. Clients refetch aggregates on updates and reconnects. Run `pnpm db:migrate` to install the new trigger before starting the updated API. The integration suite covers concurrent duplicate writes, cross-channel IDs, unrelated accounts, timeouts, DM blocks, deletion cleanup and delivery to another WebSocket client.

## Pinned messages

`GET /channels/:channelId/pins` returns `{messages,canManage}` with up to 50 pinned messages, newest pin first, including pins older than the current message-history page. `PUT/DELETE /channels/:channelId/pins/:messageId` pins/unpins a message idempotently. Server channels require VIEW_CHANNEL, SEND_MESSAGES and MANAGE_MESSAGES; either DM participant can manage pins while the DM remains accessible. Timeouts and blocks deny mutations. Channel-level permissions, including overwrites, determine the returned `canManage` flag.

Run `pnpm db:migrate` for `message_pins` and its durable `pin.update` outbox trigger. Channel locking enforces the 50-pin cap under concurrent requests. Message deletion cascades to its pin. Clients refresh the pin list on pin changes, message edits/deletes and reconnects. The demo retains local pins; connected pins persist in Postgres.
