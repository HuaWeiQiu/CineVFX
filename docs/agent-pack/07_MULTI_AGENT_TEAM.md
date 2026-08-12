# Multi-Agent Team

## Roles

- Orchestrator: scope, path ownership, risk, final decision, and integration.
- Architect: dependency DAG, contracts, acceptance commands, and boundaries.
- Worker: one bounded task in an isolated worktree; does not commit.
- Reviewer: independent correctness, security, and architecture review.
- Tester: independent coverage and evidence review.

## Completed Scheduling

The delivery followed a contract-first DAG:

```text
Stage 1 contracts
   +-> Stage 2 Mock API --------+
   +-> Stage 3 UXP shell -------+-> Stage 4 real-socket integration
                                      -> Stage 5 delivery documentation
```

Contract work was serialized before dependent API/UXP work. Workers owned
disjoint paths; shared root files and lockfiles stayed controller-owned. Each
phase passed deterministic tests, a read-only adversarial review, targeted
fixes, retesting, and rereview before controller integration.

## Evidence Gates

- Contract package: `20/20` tests plus check/build.
- Mock API: `59/59` tests plus check/build.
- UXP shell: `156/156` Node tests plus project-pinned `tsc`, check/build.
- Stage 4 root slice: `6/6` tests, including four real Node socket integration tests.
- Current Stage 5 root suite: `15/15`, adding four deterministic release
  packaging tests, four cross-platform command-runner tests, and one Chinese
  handoff contract test.
- Root/package check and build gates passed.
- Staged changes: `git diff --cached --check` before handoff.

Counts are the 2026-08-12 snapshot. Passing these gates verifies the Node
implementation and development load tree, not the Photoshop host.

## Remaining Execution Rule

Photoshop-specific work must keep separate Windows and macOS evidence. A future
worker may not mark proxy pixel export, `executeAsModal`, layer placement,
history/undo, certificate trust, runtime source preservation, signed CCX, or
marketplace compatibility complete without real Photoshop 2026 inspection.
