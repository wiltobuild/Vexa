# Verification: audio-spike (Apollo)

Date: 2026-09-27. Branch `feat/audio-spike`, HEAD `32a523b`.

## Status: partially verified — live two-browser audio check blocked on a host issue, not on the code

Static verification (typecheck, build, unit tests, two independent rounds
of adversarial code review with fix passes) is complete and passing. The
one thing genuinely *not yet proven* is the acceptance criteria's live,
real-audio, two-browser check (AC1/AC2/AC3/AC4's manual repro) and the
`apps/media` integration test suite against a real Postgres/Redis/mediasoup
stack — both require Docker, and Docker Desktop's engine would not stay up
on this host during this session (see "Blocked: Docker" below). This is a
pre-existing host issue (the same crash occurred three times on
2026-09-25, before this task started), not something introduced by this
work, and not evidence against the implementation itself.

## What was verified (this session, real command output)

1. **`pnpm install --frozen-lockfile`** — succeeds, including `mediasoup`'s
   native prebuild (`mediasoup-worker-3.27.1-win32-x64.tgz`) and
   `mediasoup-client`'s pure-JS install.
2. **`pnpm -r typecheck`** — all 5 workspace projects (`packages/shared`,
   `apps/api`, `apps/gateway`, `apps/media`, `apps/web`) pass clean, run
   independently after every commit on this branch (Phase 0, Track A,
   Track B, and both fix-pass commits).
3. **`pnpm -r test`** (unit-level, no live Postgres/Redis/mediasoup) —
   `packages/shared` (11 tests), `apps/web` (8 tests, including the new
   `apps/web/src/media/media.test.ts` covering `reqId` correlation, the
   `existingProducers`/`newProducer` shared-consume-path assertion, and the
   listener-registration-order regression test), `apps/api` (11 tests, 1
   pre-existing skip unrelated to this task) all pass. `apps/gateway`'s 7
   tests and `apps/media`'s 6 tests are `VEXA_INTEGRATION=1`-gated and
   correctly report `# SKIP` without it set — they were never run for real
   in this session (see below).
4. **`pnpm build`** — `apps/web`'s production build succeeds (`vite build`,
   12s, no errors). The other services have no compile step (matching this
   repo's existing convention — they run via `tsx` directly).
5. **Two independent adversarial code reviews** (Codex/`gpt-5.6-terra`
   reviewing the Sonnet-built `apps/media` server; a Sonnet agent
   reviewing the Codex-built `apps/web` client), each followed by a fix
   pass from the track's own original builder, re-verified by the
   orchestrating session (typecheck + test output reproduced independently
   rather than trusting either builder's self-report). Findings and fixes
   are recorded in the commit messages for `c3143a7` and `32a523b`.
6. **Design-level verification via 3 rounds of plan review** (before any
   code was written) — recorded in `plan.md`'s "Resolved from independent
   review" section.

## What was NOT verified (and why)

- **AC1/AC2**: two real authenticated browser sessions exchanging real
  audio through the SFU. Requires `apps/media` running (Docker-hosted per
  the plan) plus Postgres/Redis/`apps/api`/`apps/gateway` up. Not run.
- **AC3 (live repro)**: the automated permission-denial test exists in
  `apps/media/test/integration.test.ts` (channel-type check, unrelated
  account, tier-1/tier-2 ownership, the new duplicate-consume-409 test) but
  has never executed against a real stack — only confirmed to load and
  skip cleanly without `VEXA_INTEGRATION=1`.
- **AC4 (live repro)**: leave/tab-close cleanup and the 30s session-sweep
  force-close were implemented and reasoned through in review, but not
  observed running against a live mediasoup worker.
- **AC5**: `pnpm -r test` was NOT run with `VEXA_INTEGRATION=1` — only the
  non-integration subset above.
- **Docker build**: `apps/media/Dockerfile` and the `docker-compose.yml`
  `media` service block were never actually built/started (`docker build`
  /`docker compose up` never completed successfully this session).

## Blocked: Docker Desktop would not stay up on this host

Docker Desktop's backend process crashed repeatedly on startup with:
```
starting services: initializing Inference manager: listening on
unix://C:/Users/wilsh/AppData/Local/Docker/run/dockerInference: remove
C:/.../dockerInference: The file cannot be accessed by the system.
(listener: The filename, directory name, or volume label syntax is
incorrect.)
```
(and, on a later attempt, the identical failure for a different internal
socket — `docker-secrets-engine/engine.sock`). Root cause: three stray
zero-byte Windows reparse-point files (leftover AF_UNIX socket handles
from a prior crash) under `%LocalAppData%\Docker\run\` and
`%LocalAppData%\docker-secrets-engine\` that the Windows `DeleteFile` API
refused to remove ("cannot be accessed by the system"), but which were
removable from inside the `docker-desktop` WSL distro (they were visible
there at `/mnt/host/c/...`). Removing them via WSL and relaunching Docker
Desktop cleared each specific failure, but a *new* internal socket hit
the same "cannot be accessed" error on the next attempt — consistent with
Windows' AF_UNIX (`afunix.sys`) socket support being in a bad state at the
OS level, not a single corrupted file. This same crash occurred three
times on 2026-09-25 (before this task existed), confirming it predates this
work. The user chose to fix this with a full system reboot, done outside
this session's scope.

**Next step once Docker is confirmed healthy** (a fresh session/task,
since a reboot ends this one): run Phase 3 exactly as planned —
`docker compose up -d` (now includes `media`), `pnpm db:migrate`,
`pnpm dev:all` (excludes `@vexa/media`, native as today), two real browser
sessions joining the same voice channel, the denial/cleanup repros, and
`VEXA_INTEGRATION=1 pnpm --filter @vexa/media test` /
`VEXA_INTEGRATION=1 pnpm --filter @vexa/gateway test`.

## Known gaps (by design, documented not hidden)

- **Cross-network/TURN**: not proven and not attempted — this spike's
  `announcedAddress=127.0.0.1` config is same-machine-only by design. A
  real deployment needs a public/STUN-discovered announced address and a
  TURN fallback, neither implemented here.
- **Mid-call *permission-bits* revocation** (e.g. a moderator removing
  `SPEAK` from a still-logged-in, still-valid-session user mid-call) is not
  caught — only session *invalidation* (logout/expiry) is continuously
  re-verified (the 30s sweep). This is a deliberate, explicitly out-of-scope
  gap per the approved plan, not an oversight.
- **Horizontal scaling**: `apps/media` is single-instance, in-memory
  (routers/registries/peer maps live in process memory, no persistence).
  Explicitly out of scope for this spike.
- **No native mediasoup event-listener cleanup** (e.g.
  `producer.on('transportclose', ...)`): cleanup only happens through the
  app's own `teardownPeer` triggers, not mediasoup's own native close
  events. Flagged by the Track A builder as a possible gap if the native
  worker can close objects independently of the app's own `.close()` calls
  — not exercised or disproven in this session.
- **Ports/topology for the record**: media WS on `3003`; RTP/ICE UDP+TCP
  range `40000-40099`; Docker-hosted `mediasoup-worker` with
  `announcedAddress=127.0.0.1`.

## Files changed (full branch diff, `f394f99..32a523b`)

See `git log e7fac0a..32a523b --stat` for the complete list. Summary by
commit:
- `e7fac0a` — bootstrap agent workflow docs (unrelated to audio-spike
  itself, committed on this branch since it preceded the branch point).
- `ffd3bec` — Phase 0: frozen WS contract (`packages/shared/src/media.ts`),
  `authenticateSession`/`sessionStillValid` extraction, gateway refactor to
  use them.
- `1c3452a` — Track A: `apps/media` service (server, Docker, `dev:all` fix).
- `eabd716` — Track B: `apps/web` client integration + voice UI.
- `c3143a7` — Track A fix pass (async-teardown races, unbounded consumers,
  unhandled sweep rejection).
- `32a523b` — Track B fix pass (mic-track leak on leave, `newProducer`
  listener-registration race).

## Recommendation

Do not merge to `main` yet. The static/design verification is thorough
(two review rounds pre-implementation, two more post-implementation, all
with real fix passes and independently re-verified command output), but
the plan's own exit gate — "two authenticated browsers... exchange real
audio" — has not been observed. Merging before that would misrepresent a
feasibility spike as a proven one. Resume with the live-stack Phase 3 run
as the next task once Docker is healthy.
