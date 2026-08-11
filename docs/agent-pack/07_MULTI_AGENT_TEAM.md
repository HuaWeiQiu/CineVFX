# Multi-Agent Team

## Roles

- Orchestrator: scope, risk, final decision, and escalation.
- Architect: dependency DAG, path ownership, and acceptance commands.
- Worker: one bounded task in one isolated worktree.
- Reviewer: independent correctness, security, and architecture review.
- Tester: independent coverage and evidence review.

## Scheduling

Use `contract-first` for the first run: sequential, plan approval, final
approval, two bounded rework attempts.

After contracts merge, use `mock-slice` with at most two parallel workers:

```text
contracts
   +-> UXP shell --------+
   +-> Mock API ---------+-> integration tests
```

The UXP and API tasks may run together only when their owned paths do not
include shared contract files or the same root lockfile. Contract migrations,
OpenAPI changes, and root dependency changes are serialized.

## Evidence Gates

- Each task runs its declared acceptance commands.
- Root `pnpm check`, `pnpm test`, and `pnpm build` must pass after integration.
- Reviewer and Tester cannot write or approve failed commands.
- Photoshop-specific claims remain unverified until tested in Photoshop 2026.
