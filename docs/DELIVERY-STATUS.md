# Delivery status

Updated: 2026-09-27. The complete scope and release gates are in [the delivery plan](PROFESSIONAL-DELIVERY-PLAN.md).

## Confirmed constraints

- Preferred data location: NYC/New York. Any nearby regional alternative needs to be made explicit.
- Hosting/AI budget is not yet set. No paid resources or provider spending have been authorized or provisioned in this implementation batch.
- Current public hosting is the static frontend/demo. Real backend staging, media services and their operation are still required.
- Platform/provider accounts, domain ownership, launch audience/policies, budget cap and operating/support owner remain decisions to resolve.

## Tracked phases

| Phase | Work | Status | Issue |
| --- | --- | --- | --- |
| 0 | define the release and establish the baseline | In progress | [Track](https://github.com/wiltobuild/Vexa/issues/3) |
| 1 | reproducible platform and deployed staging | In progress | [Track](https://github.com/wiltobuild/Vexa/issues/4) |
| 2 | account lifecycle, authorization and privacy foundations | Not started as a release phase | [Track](https://github.com/wiltobuild/Vexa/issues/5) |
| 3 | complete community and social workflows | Not started as a release phase | [Track](https://github.com/wiltobuild/Vexa/issues/6) |
| 4 | reliable everyday messaging | Not started as a release phase | [Track](https://github.com/wiltobuild/Vexa/issues/7) |
| 5 | attachments and safe content handling | Not started as a release phase | [Track](https://github.com/wiltobuild/Vexa/issues/8) |
| 6 | real voice, then optional video/screenshare | Not started as a release phase | [Track](https://github.com/wiltobuild/Vexa/issues/9) |
| 7 | production Recall and consented group history | Not started as a release phase | [Track](https://github.com/wiltobuild/Vexa/issues/10) |
| 8 | real AI summaries and a useful history product | Not started as a release phase | [Track](https://github.com/wiltobuild/Vexa/issues/11) |
| 9 | coherent product, accessibility and browser quality | Not started as a release phase | [Track](https://github.com/wiltobuild/Vexa/issues/12) |
| 10 | operations, security review, capacity and recovery | Not started as a release phase | [Track](https://github.com/wiltobuild/Vexa/issues/13) |
| 11 | release candidate, launch and professional handoff | Not started as a release phase | [Track](https://github.com/wiltobuild/Vexa/issues/14) |

## Current implementation batch

Implemented in [PR #15](https://github.com/wiltobuild/Vexa/pull/15); validation evidence is recorded in its CI checks: ordered transactional migrations with checksums and concurrency locking; preserved legacy bootstrap path; validated production startup configuration; explicit proxy allowlists; safe default quotas; separate liveness/readiness endpoints; real-Postgres migration regression tests in CI; migration/configuration operating instructions.

These are Phase 1 foundations, not completion of Phase 1 or the full plan. The existing product features remain available. Phase 0 has an audited baseline, documented budget/region constraints and issues, but scope/operational ownership decisions remain open.

Next: select a concrete staging deployment within an agreed budget/region; build reproducible deployment artifacts and demonstrate restore/rollback. Account recovery and the early two-peer audio spike follow the foundations. No draft-message implementation has started.
