# Vexa — professional delivery plan

Last audited: 2026-09-27. Baseline: commit `617c069`, branch `feat/demo-ai-recap` (PR #2 open at audit time).

## Purpose and completion standard

Deliver a maintainable, secure, accessible, operated web product for gaming communities: accounts, servers, messaging, voice rooms, and consent-based Recall with useful AI recaps. A polished demo is one deliverable; a functioning multi-user service and its operating documentation are separate deliverables. This plan covers both.

This is the primary delivery roadmap. [ROADMAP.md](ROADMAP.md) remains a historical build-gate snapshot; use this document for future prioritization. Checkboxes describe work still required to close a phase, including hardening existing features. No phase is complete solely because its happy path works or its schema exists.

A professional release requires:

- Actual user journeys working against deployed services, across independent accounts and devices.
- Authorization, privacy, recovery, accessibility and failure handling demonstrated by evidence.
- Reproducible builds, controlled migrations, tested backups and rollback, observable services and an accountable operator.
- Honest product boundaries: sample presence, room participants and AI recaps remain labeled; no live call, recording, E2EE or AI-generation claims without implementation.
- A handoff another engineer can run and operate without the author present.

No dates are promised here. Estimate phases after the infrastructure and voice feasibility work; use the exit gates to decide completion. Product scope, budget and launch policy decisions have explicit owners below rather than hidden assumptions.

## Audited starting point

| Area | Implemented today | Remaining professional-delivery gap |
| --- | --- | --- |
| Frontend/demo | Responsive React/Vite UI, local workspace, character profiles, reactions, pins, room previews; separate Recall modes and three selectable sample summaries | Demo is not a multi-user service; accessibility/browser audits, design consistency and onboarding remain |
| Accounts | Cookie sessions, Argon2id passwords, origin checks, registration/login/logout, avatar and bio editing | Verified email, recovery, session management, account deletion/export, abuse controls, privileged-account protection |
| Community | Server/channel creation, memberships, roles, invites, moderation, friends and 1:1 DMs | Lifecycle operations, permission-management UX, group DMs, race handling, complete denial coverage |
| Messaging | Stored messages, safe Markdown, replies/edits/deletes, full-text search, typing, reactions and pins | Saved drafts, unread/mentions/notifications, connected virtualization, history/reconnect consistency, attachment pipeline |
| Realtime | WebSocket identify/resume, authorization per dispatch, Redis replay and transactional outbox | Presence, durable recovery under faults, scalable fan-out, permission-change UX, operational metrics |
| Voice/video | Demo room previews and local microphone capture for personal notes | No real group audio, SFU integration, TURN/network traversal, video or screen sharing |
| Personal Recall | On-device English Whisper; authenticated hosted transcription, timestamps, private history, export/deletion and 30-day retention | Broader device testing, distributed quotas, provider fault handling and production operational proof |
| Group Recall/AI | Group consent design; illustrative AI recap archive | No group recording pipeline or real recap-generation pipeline, no durable generation jobs/evaluations |
| Delivery | Monorepo, local Compose dependencies, CI with real Postgres/Redis integration and Chromium flows; static preview deployment | Hosted API/gateway/media services, versioned migrations, restore drills, environment isolation and release procedure |

Evidence reviewed: [README](../README.md), [API routes](../apps/api/src/index.ts), [permissions](../apps/api/src/db.ts), [gateway](../apps/gateway/src/index.ts), [migration runner](../apps/api/src/migrate.ts), [schema](../infra/schema.sql), [Recall](../apps/api/src/recall.ts), [CI](../.github/workflows/ci.yml), [browser tests](../apps/web/e2e), and the demo/connected React components. This is an engineering inventory, not an independent security assessment.

The proposed saved-draft work was not implemented before this planning request; it belongs to Phase 4.

## Release stages and ownership

| Stage | Required outcome |
| --- | --- |
| Showcase | Reliable demo, labeled sample data, repeatable presentation script, no fake live actions |
| Private alpha | Isolated deployed accounts and messaging; Phases 0–4 plus applicable accessibility, recovery, monitoring and support gates from 9–10. Voice/AI remain disabled until their own gates pass |
| Voice/Recall beta | Phases 6–8 complete, consent and access controls proven, bounded invited cohort, staffed support and incident response |
| Professional v1 | All mandatory phase gates below passed; optional features explicitly excluded from the release promise; Phase 11 handoff signed off |

Product owner owns audience, scope, costs and launch decisions. Engineering owns implementation and evidence. Design/QA owns UX and accessibility verification. Operations/security owns infrastructure, recovery and security review. One person may fill multiple roles, but name an actual accountable person for each before launch.

For every phase, create issues with these fields: outcome, dependencies, accountable owner, size estimate, acceptance checks, evidence link, rollout/rollback and current status. Status values: not started, in progress, blocked, verification, complete. Record the date and evidence when closing a gate.

## Phase 0 — define the release and establish the baseline

**Depends on:** nothing. **Owner:** product + engineering.

- [ ] Decide intended audience, age policy, supported countries/languages, browser/device support, invite-only versus public signup, and the first release's limits.
- [ ] Freeze v1 scope: responsive web, core text/social, real group audio, consented Recall and real AI recaps. Treat video/screenshare, embeds and billing as explicit decisions, not assumed launch promises.
- [ ] Set operating budget, expected concurrency, storage limits, retention policy and support responsibilities. Define free/paid usage rules before enabling uncapped provider spending.
- [ ] Review open PR #2 and preserve the agreed navigation: voice rooms separate from history; Sample showcase first/default; AI summary second; microphone third; modes at the top.
- [ ] Record the accepted baseline commit, known defects and test evidence; create a demo-versus-connected capability matrix and release checklist.
- [ ] Convert this plan into trackable issues with owners. Produce architecture decision records (ADRs) for hosting, media service, permissions, retention and AI processing.

**Exit gate:** scope, non-goals, release stages, budgets and ownership are documented; every launch requirement maps to an issue and an acceptance check.

## Phase 1 — reproducible platform and deployed staging

**Depends on:** Phase 0. **Owner:** engineering + operations.

- [ ] Provision separate development, staging and production configurations with separate credentials/data. Select and document deployment locations and data region.
- [ ] Deploy the web app, long-running API and WebSocket gateway, private Postgres/Redis, object storage and an eventual worker/media tier. Verify actual runtime/network support before choosing hosts; a static frontend deployment alone is insufficient.
- [ ] Configure domains, TLS, same-origin API/gateway routing, secure cookies, narrowly trusted proxies and private service networking. The current `TRUST_PROXY` handling is boolean; do not assume it supports a CIDR allowlist without implementing one.
- [ ] Replace whole-schema replay as the migration strategy with ordered, tracked, locked migrations. Keep a fresh-install path and test upgrades from the current schema with representative data.
- [ ] Add validated startup configuration, secret storage/rotation, readiness/liveness, graceful shutdown and unique Snowflake worker-ID allocation.
- [ ] Make fresh-clone setup reproducible on supported developer systems; document the authoring host's Docker limitation and a supported remote/local development route.
- [ ] Add CI lint/format, dependency and secret scanning, migration-upgrade tests, environment smoke tests and useful failure artifacts. Protect main with required checks/review and reproducible release artifacts.
- [ ] Establish backup and restore basics before accepting alpha data; begin logs/metrics here rather than waiting until Phase 10.

**Exit gate:** a clean checkout builds; a previous database upgrades without loss; two independent browsers register and exchange a message on staging over HTTPS/WSS; deployment rollback and a first database restore are demonstrated.

## Phase 2 — account lifecycle, authorization and privacy foundations

**Depends on:** Phase 1. **Owner:** backend + security/product.

- [ ] Implement email verification, secure password reset/change, email change, session listing/revocation and logout-all. Expired/single-use tokens and non-enumerating recovery responses need explicit tests.
- [ ] Add MFA or equivalent strong authentication for privileged operators; decide whether it is offered or required for community administrators.
- [ ] Test signup/login brute-force protection and introduce account/IP/action quotas with shared enforcement. Ensure test-only quota overrides cannot silently become production policy.
- [ ] Build a route/event authorization matrix covering unrelated users, blocked users, removed members, timeouts, role changes, expired/revoked sessions and admin/owner distinctions. Test HTTP, WebSocket, replay, search and exports.
- [ ] Audit privilege escalation and role hierarchy on edits, assignment, removal and moderation. Make membership changes and authorization-sensitive writes transactionally consistent where necessary.
- [ ] Add security headers/content policy, dependency review and secret/log redaction. Test hostile Markdown and all new content surfaces. Document a threat model and security-reporting route.
- [ ] Implement account export/deletion and session/data cleanup; define ownership transfer when an owner deletes an account. Document what is retained, anonymized or removed and why.
- [ ] Map all personal data, providers and retention paths. Prepare privacy/terms/community policy drafts for review appropriate to the launch audience and regions; do not claim compliance from a checklist alone.

**Exit gate:** account recovery/revocation/deletion work end to end; the access matrix passes; critical/high security findings are resolved or the affected feature cannot ship; privileged access and data handling have explicit owners.

## Phase 3 — complete community and social workflows

**Depends on:** Phase 2. **Owner:** full-stack engineering + design.

- [ ] Complete server rename/settings, leave/delete, ownership transfer and channel/category rename/delete/order. Honor MANAGE_CHANNELS rather than owner-only creation where intended.
- [ ] Provide role and channel-overwrite management UI, explain effective access and settle category inheritance behavior. Enforce role hierarchy consistently and record audit entries for role/permission changes.
- [ ] Add invite listing, expiry/use controls, revocation and clear join failures; test concurrent joins, exhausted invites and bans.
- [ ] Complete friend-request discovery/error states and social update events. Enforce one 1:1 DM per pair at the database/transaction level under simultaneous creation.
- [ ] Implement group DMs: create/name, add/remove members, leave, participant limits, block behavior and ownership rules. Define whether new members can read old history and test the chosen policy.
- [ ] Add real presence with multi-device aggregation, expiry and privacy settings; remove illustrative presence from connected surfaces.
- [ ] Paginate/search larger member lists and give moderators working ban/unban, timeout, report and audit-log interfaces.

**Exit gate:** three independent accounts complete invite, role change, group DM, removal/block and moderation journeys; access changes apply without reconnect; destructive operations have clear confirmation and tested outcomes.

## Phase 4 — reliable everyday messaging

**Depends on:** Phases 2–3. **Owner:** frontend + backend.

- [ ] Save per-conversation text/reply drafts in demo and connected mode, scoped by origin/account/channel; do not expose another account's draft. Preserve composition when entering/cancelling edits and define draft cleanup on logout/deletion.
- [ ] Complete unread counts, mentions, read receipts/cursors as scoped by product, notification preferences, browser notification permission UX and mute behavior. Avoid misleading read acknowledgements for unseen background messages.
- [ ] Virtualize connected history and preserve scroll position when loading older messages. Keep older pages, optimistic sends and new edits/deletes coherent during refetch/reconnect.
- [ ] Add message permalinks/jump-to-message, jump from search/pins, search pagination/filtering and author metadata. Handle missing/deleted reply targets.
- [ ] Harden retries, nonce idempotency, request cancellation on navigation, duplicate replay, multi-tab state and offline/reconnect notices. Verify failure never silently drops an acknowledged message.
- [ ] Exercise outbox recovery during Redis/API failure and publisher restart, slow-client pressure, stale replay windows and concurrent message/reaction/pin changes. Retain at-least-once semantics and idempotent clients.
- [ ] Fix input-method composition handling, long messages/URLs, keyboard navigation and all loading/empty/error states. Complete real behavior behind inbox/notification controls or remove them from connected mode.

**Exit gate:** drafts survive navigation/reload without cross-account leakage; histories remain correct after reconnect; two-client send/edit/delete/reply/search/reaction/pin flows pass; a fault-injection report documents recovery and duplication behavior.

## Phase 5 — attachments and safe content handling

**Depends on:** Phases 1–4. **Owner:** backend + frontend + security.

- [ ] Implement authorized upload initialization, short-lived upload access, completion validation, attachment-message association and private downloads.
- [ ] Enforce signatures, sizes, extensions and per-account/server storage quotas. Sanitize names, remove unwanted image metadata and prevent active content execution.
- [ ] Add a scanning/quarantine policy, thumbnail/preview worker, progress/cancel/retry UI, object lifecycle cleanup and handling for orphaned uploads or deleted messages/accounts.
- [ ] Test access revocation for attachments in DMs, private channels and removed memberships; document the short-lived URL exposure window.
- [ ] If embeds ship, isolate URL fetching and block loopback/private/metadata addresses, redirect and DNS-rebinding bypasses; cap response size/time and never forward user credentials. Otherwise keep embeds disabled and documented.
- [ ] Keep demo local attachments clearly separate from uploaded files and ensure thumbnails/failures do not break history layout.

**Exit gate:** allowed uploads survive reload and can be downloaded by authorized members only; malformed/oversized/hostile files are rejected or quarantined; cleanup and quota tests pass; optional embeds have their own security gate.

## Phase 6 — real voice, then optional video/screenshare

**Depends on:** Phases 1–2 for the early spike; Phase 3 permissions before beta. **Owner:** realtime/media engineering.

Start the feasibility spike immediately after the deployed foundation and authentication are usable, before investing heavily in Phases 5, 7 or 8. Validate the existing mediasoup direction against actual hosting/network/operating constraints, or document a deliberate alternative in an ADR.

- [ ] Prove two authenticated browsers on different networks exchange real audio, including a TURN-only case. Record deployment, media path, ports, NAT handling and operating cost assumptions.
- [ ] Build authenticated room membership/signaling, permission-gated joins, device selection, mute/deafen, speaking indicators, volume controls, join/leave and visible connection/failure states.
- [ ] Handle device permission denial/removal, Bluetooth/device switching, network changes, reconnects, tab closure and graceful media-node shutdown. Release microphone/camera tracks on leave.
- [ ] Add participant limits, moderator disconnect/mute controls, room occupancy events and isolation between rooms. Reconcile UI mute state with actual media flow.
- [ ] Add server-side controls needed to forward only consented media to Recall; recording remains off until Phase 7 passes.
- [ ] If committed for v1, implement video/screenshare, resolution/bandwidth adaptation, permissions and platform-specific screen/audio limitations. Otherwise hide these actions and publish them as later scope.

**Exit gate:** external-network peers complete a 30-minute audio session with reconnect/device changes; unauthorized joins and cross-room leaks are denied; mute/leave tests verify actual track behavior; media capacity and quality are measured on the intended deployment.

## Phase 7 — production Recall and consented group history

**Depends on:** Phases 2, 3 and 6; storage/job foundations as needed. **Owner:** media/backend + privacy/product.

- [ ] Harden personal Whisper notes: distributed quotas/concurrency, cancellation, provider timeouts/retries, audio resource bounds and model-loading/device compatibility. Preserve the existing real on-device option and truthful language support.
- [ ] Implement session-level and per-participant consent, visible indicators, joining mid-recording, withdrawal and failure states. Decide whether the product requires unanimous consent or permits only consenting tracks, and make that policy unambiguous.
- [ ] Enforce consent at the forwarding boundary; withholding/revoking consent must prevent that participant's audio reaching the transcription worker, not merely hide the resulting text.
- [ ] Persist voice sessions, consent events, speaker identity, timestamped segments, retention and transcript access grants. Authenticate speaker identity rather than trusting a client label.
- [ ] Introduce durable jobs with retries, idempotency, bounded concurrency, cancellation, partial completion and dead-letter/manual recovery. Avoid duplicate transcripts after restarts.
- [ ] Implement searchable channel history, permission-checked view/export/delete and per-session retention. Decide whether users who were absent may view a recap; current membership alone must not become an accidental policy.
- [ ] Delete expired content and derived artifacts consistently. Define backup retention/deletion behavior and prove removed members cannot use search/export to recover restricted transcripts.
- [ ] Keep raw audio storage off by default; clips or source playback require separate explicit consent, access policy, storage and retention implementation.

**Exit gate:** no-consent and withdrawal tests observe zero disallowed forwarding; worker restart does not duplicate notes; history/export deny unauthorized users; retention runs and removes the intended data; a multi-person session is transcribed with traceable timestamps.

## Phase 8 — real AI summaries and a useful history product

**Depends on:** Phase 7 and Phase 10's cost/telemetry foundations. **Owner:** AI/backend + frontend/product.

- [ ] Turn the current demo archive into an authenticated real session history with date/channel filters, pagination, loading/empty/error states and stable session/summary URLs.
- [ ] Generate structured recaps from authorized transcripts: title, overview, highlights with source timestamps, decisions and action items where supported. Derive counts/durations from actual session data.
- [ ] Store generation ID, source transcript version, model/prompt version, job state, timestamps and usage/cost. Support safe retries, regeneration and deletion without losing provenance.
- [ ] Treat transcript text as untrusted input. Defend against prompt injection and prevent the model from gaining tools or access to other sessions. Validate output shape and render safely.
- [ ] Link claims/highlights to supporting segments; do not invent clips, quotes, participants or actions. Show partial transcript/uncertainty states and allow feedback/correction.
- [ ] Build a consented or synthetic evaluation set covering noisy audio, overlapping speech, silence, short calls, slang, missed context and hostile instructions. Evaluate factual support, omissions, attribution, tone and usefulness before choosing final model/settings.
- [ ] Define usage allowances, spending caps, queue priorities, timeout/fallback UX and operator kill switches. Do not select a vendor/model by undocumented assumptions about pricing or availability.
- [ ] Preserve demo sample recaps as a separate showcase. Label real AI output and document limitations without implying human verification.

**Exit gate:** a new real session produces a persisted recap with traceable highlights; replays/retries do not duplicate charges/jobs unexpectedly; permissions/deletion propagate to summaries; human evaluation meets a documented rubric with no cross-session data leakage or fabricated source links.

## Phase 9 — coherent product, accessibility and browser quality

**Depends on:** starts in Phase 0; final pass follows Phases 3–8. **Owner:** design + frontend/QA.

- [ ] Refactor oversized App/ConnectedWorkspace modules into feature components/hooks; share types/contracts and UI primitives where useful without mixing demo persistence with real accounts.
- [ ] Standardize spacing, type, navigation, dialogs, buttons, toasts and status states. Keep all primary actions functional; distinguish preview-only behavior clearly.
- [ ] Finish onboarding, account/server settings, invitation landing, profile/identity management, draft indicators and discoverability of history/recaps. Add a repeatable presentation/reset flow with reliable sample data.
- [ ] Review keyboard-only use, focus order/return, modal traps, screen-reader names/status announcements, contrast, reduced motion and touch targets. Target WCAG 2.2 AA; test manually as well as with automated tooling.
- [ ] Define and verify a browser/device matrix, including Chromium, Firefox and WebKit plus real mobile microphone/network behavior. Explain unsupported capabilities instead of failing silently.
- [ ] Measure cold/warm loading, lazy Whisper assets, large histories/member lists and low-memory behavior. Add bundle/performance budgets, avoid eager model downloads and verify graceful model-download failure.
- [ ] Add visual regression coverage for key routes and responsive states; support locale-aware dates/time zones and non-Latin input without claiming full localization prematurely.

**Exit gate:** core flows pass keyboard/screen-reader and supported-browser checks; no unresolved critical accessibility defects; mobile layouts and loading/error states are usable; performance measurements meet the agreed budgets.

## Phase 10 — operations, security review, capacity and recovery

**Depends on:** foundations start in Phase 1; final exercise includes the release candidate. **Owner:** operations + security + engineering.

- [ ] Add structured redacted logs, correlation IDs, error reporting, traces and dashboards for API latency/errors, DB pools, gateway disconnect/replay, outbox age, job backlog, media quality and AI cost.
- [ ] Define service objectives and alert thresholds; assign responders, severity rules, escalation, status communication and incident/postmortem templates.
- [ ] Configure encrypted backups, point-in-time recovery where supported, storage/versioning policies and restores into a clean isolated environment. Include database, object metadata, secrets/configuration and Redis recovery semantics.
- [ ] Load-test realistic connected users, messages, presence, large histories and media rooms; measure database authorization/fan-out cost before optimizing. Test one-node failure, Redis loss, provider outage, slow clients and rolling deploys.
- [ ] Bound queues, retention, quotas, connection counts, recording duration and retries. Document per-user/server/media/AI cost and enforce budget alerts/kill switches.
- [ ] Run an independent security review of authentication, authorization, uploads, media signaling, transcription consent, AI data boundaries and deployment configuration. Resolve launch blockers and retest.
- [ ] Build operator tools for abuse reports, account/server actions, job replay and diagnostics with least privilege and an audit trail. Support staff should not receive unrestricted message access by default.
- [ ] Document backup/restore, rollback, credential rotation, dependency patching, outage response, provider failure and user-data requests; rehearse them.

**Exit gate:** a timed recovery drill meets agreed RPO/RTO; alerts are demonstrated; the intended load profile is reproducible; cost limits work; security review and incident ownership are recorded.

### Proposed initial acceptance targets — approve and measure, do not claim as achieved

| Measure | Starting target / decision |
| --- | --- |
| Staging capacity profile | 200 simultaneous text clients, 20 messages/second, 10 audio rooms of 8 participants; document dataset, topology and test duration |
| Text API latency | p95 under 500 ms under the approved load, excluding uploads/AI jobs; define region and network conditions |
| Live text delivery | p95 under 1 second from accepted send to receiving client under the same test conditions |
| Connected-service availability | Proposed 99.9% monthly objective; define measurement, exclusions and response coverage before promising it |
| Recovery | Proposed database RPO at most 24 hours and RTO at most 4 hours for initial v1; revise to match product needs and test it |
| Voice/AI quality | Establish measured connection success, media-quality, transcription/recap accuracy and completion-latency thresholds after the early spike/evaluation |
| Cost | Explicit monthly budget and per-account recording/generation/storage limits; no unbounded paid workload |

These are planning targets, not benchmarks, warranties, provider capabilities or purchased capacity. Adjust them openly before launch if evidence or budget requires it.

## Phase 11 — release candidate, launch and professional handoff

**Depends on:** all committed feature gates and Phases 9–10. **Owner:** product + engineering + operations.

- [ ] Freeze launch scope and triage the full defect list. No unresolved critical/high security issues, consent leaks, data-loss defects or broken core journeys; document lower-severity known limitations.
- [ ] Run release-candidate acceptance on staging using production-like configuration, migrations, independent accounts, real browsers/networks, upload data and a consented voice session through summary generation.
- [ ] Rehearse deployment and rollback, including database compatibility and worker/media draining. Use gradual exposure/feature flags and explicit abort criteria.
- [ ] Finish README, setup guide, architecture/ADRs, API/event contracts, environment reference, migration/restore instructions, operator runbooks, QA evidence, demo script and release notes.
- [ ] Confirm asset/model/dependency licenses and attribution, project licensing/ownership, privacy/terms/support contacts and required launch-policy review.
- [ ] Hand over repository and infrastructure access, billing/renewal ownership, secret locations (never plaintext secrets in docs), monitoring and backup responsibilities.
- [ ] Run a bounded invited pilot, gather product feedback and fix demonstrated failures before widening access. Set an observation window, support coverage and rollback authority for launch.
- [ ] Tag the release, publish the changelog, record exact deployed versions and schedule ongoing dependency, recovery, security and quality review.

**Exit gate:** a second engineer can set up, deploy, restore and operate the project from its documentation; the product owner accepts the release checklist; the production smoke test passes; support and incident response are staffed.

## Recommended execution sequence

1. Close Phase 0 and build deployed staging/migrations/recovery foundations in Phase 1.
2. Close account/security basics in Phase 2; run the early Phase 6 two-peer audio spike immediately. Resolve the largest product feasibility risk before more cosmetic expansion.
3. Complete community/social and messaging in Phases 3–4, including saved drafts. Evolve accessibility, instrumentation and operator tooling alongside every change.
4. Complete attachments in Phase 5 and production audio in Phase 6; keep optional video/embeds out until explicitly gated.
5. Build consented group Recall in Phase 7, then real summary generation/history in Phase 8. Do not build a real-summary claim on sample transcripts alone.
6. Finish Phases 9–10 across the complete product, then release and hand over through Phase 11.

The phase numbers organize deliverables, not a demand that all work be serialized. Shared security, UX and operations work starts early; dependencies and staffing determine what can overlap.

## First implementation batches after this plan

| Priority | Concrete batch | Evidence of completion |
| --- | --- | --- |
| 1 | Scope/architecture decisions, feature inventory and issue ownership | Accepted scope and ADRs; linked backlog |
| 2 | Versioned migrations, configuration validation and reproducible staging | Fresh install plus upgrade test; two-browser staging chat |
| 3 | Recovery/session lifecycle and authorization regression matrix | Recovery and revoked-session tests; denial coverage report |
| 4 | Authenticated two-peer audio feasibility spike | Cross-network and TURN-only audio evidence with deployment notes |
| 5 | Saved drafts, history/reconnect correctness and connected virtualization | Navigation/reload isolation tests and long-history measurements |
| 6 | Fill community/group-DM lifecycle gaps | Multi-account acceptance suite |

## Handoff contents and evidence register

Maintain a release evidence index linking each completed phase to the relevant PRs, CI run, manual/browser report, migrations, security review, deployment record and operational drill. Record failed checks and skipped tests, not just successful screenshots.

The final repository should contain the source and lockfile; environment template; developer bootstrap; migrations and representative seed data; CI/release definitions; service/API/event contracts; architecture decisions; license/attribution inventory; test/evaluation fixtures and reports; demo instructions; runbooks; and a prioritized post-release backlog. Credentials stay in the designated secret store.

Optional later work, unless Phase 0 explicitly adds it to v1: native desktop/mobile clients, billing/subscriptions, bots/integrations, public community discovery, advanced search/analytics, multilingual AI beyond validated languages, richer moderation automation and multi-region operation. End-to-end encryption would require a separate architecture/product decision because it changes server-readable search and Recall; do not imply the current design provides it.
