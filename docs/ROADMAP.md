# Build gates — no timelines

The phases below are acceptance gates, not time estimates. A phase remains open until its stated checks actually pass; having an endpoint, schema, or sample interface alone does not satisfy the gate.

| Phase | Deliverable | Done criteria | This pass |
|---|---|---|---|
| 0 Foundation | pnpm workspace, Docker stack, CI, Snowflakes, cookie auth | Healthy Compose stack; CI green; auth integration tests | Implemented foundation; Docker unavailable on authoring host. CI provisions DB/Redis. |
| 1 Guilds & text | Guilds/channels, cursor-paginated REST chat, UI shell | CRUD/pagination coverage; browser creates guild and sends real message | Connected UI + REST implementation; demo browser flow tested; complete live browser gate open. |
| 2 Gateway | Redis delivery, protocol, resume, typing, presence | Two-client real-time test; exact missed-event replay test | Delivery/resume integration test included; presence fan-out and outbox open. |
| 3 Permissions & social | Roles/overrides, invites, friends/DMs, moderation, audit | Table-driven permission tests; denied-access test for every route/dispatch | Permission calculator, role CRUD/assignment (escalation-guarded), invite UI, and moderation (kick/ban/timeout + audit log) implemented and integration-tested; friends/DMs and the full denied-access matrix open. |
| 4 Rich messaging | Presigned uploads, thumbnails, safe Markdown, embeds/reactions | Upload round-trip; XSS and SSRF tests | Safe client Markdown + XSS browser check; local demo reactions/attachments; production pipeline open. |
| 5 Voice & video | mediasoup, mute/deafen, video/screen share | Two real browser peers exchange audio through SFU | Not implemented. Must complete early audio spike next. |
| 6 Vexa Recall | Consented transcription and searchable history | Consent/permission/retention/worker tests; real audio-to-text demo | Searchable sample UI + feature design only. |
| 7 Scale & polish | Multiple nodes, k6, OTel/Grafana, search, deployment | Measured target with reproducible test setup; reachable production deployment | Full-text search and polished responsive UI; scale/observability/deployment open. |

## Execution order

1. Finish the Phase 0/1 live integration checks, including denied routes, expired/revoked sessions and abuse cases.
2. Run an early two-person mediasoup spike before expanding rich messaging.
3. Close gateway persistence gaps using a transactional outbox and test reconnect under concurrent traffic.
4. Complete roles/overrides, invites, friends/DMs and moderation. Treat server-side authorization as required for every operation.
5. After Phase 3 passes, rich messaging and voice may be developed in parallel against the shared contracts.
6. Build transcription only on a proven SFU, with explicit consent and access-controlled retention.
7. Measure scale, report actual results and environment, then deploy. Never substitute an example load-test number for a measurement.

## Required security checks

- Auth registration/login/logout, invalid credentials, expiration, session revocation, Origin rejection and rate limits.
- Every resource route and dispatch rejects an unrelated user; role changes and membership removal take effect without reconnect.
- Markdown cannot execute HTML/script; URL protocols are restricted by the renderer.
- Upload MIME signatures, sizes, file names and object access are validated server-side before any production upload UI is enabled.
- Embed worker cannot access loopback, private networks, metadata endpoints or redirect into them.
- Invite expiration, exhaustion, ban checks and duplicate membership are safe under concurrent joins.
- Transcription never receives non-consenting tracks and search never bypasses channel access.

See BACKEND.md for known implementation limitations. None of these future checks are represented as already passed.
