# Repository Guidance

## Product Boundary

CineVFX is a Photoshop UXP-assisted, general-purpose VFX compositing system.
An imported effect image/layer is an input. Magic, fire, smoke, lightning,
particles, and lens effects are examples, not hard-coded product modes.

## Non-Negotiable Invariants

- Never modify, move, transform, resize, or replace the user's protected source layer.
- Do not claim absolute subject preservation from layer bounds alone.
- Keep Photoshop writes outside network/model waits and inside bounded modal transactions.
- Every successful result must include a validated Layer Manifest and editable passes.
- Do not introduce a large image model before the Mock vertical slice passes.
- Do not log image bytes, prompts, local paths, credentials, or protected user content.

## Architecture Boundaries

- `apps/photoshop-uxp/`: Photoshop state, proxy export, task UI, and manifest import.
- `apps/api-server/`: job, asset, event, cancellation, and provider orchestration.
- `packages/contracts/`: JSON Schema, OpenAPI, examples, and generated contract types.
- `packages/effect-spec/`: deterministic effect primitives and merge/migration rules.
- `services/vfx-renderer/`: procedural passes; no Photoshop DOM access.
- `services/ai-pipeline/`: optional segmentation/depth/relighting providers.
- `tests/`: cross-module contract, integration, visual, and performance evidence.

## Multi-Agent Rules

- Contract changes are serialized and land before dependent UXP/backend work.
- Parallel tasks must own disjoint paths; root lockfiles are a shared boundary.
- Workers may only edit declared owned paths in their isolated worktree.
- Deterministic checks can veto any Agent verdict.
- Implementers cannot approve their own work; reviewer and tester stay read-only.
- The Agent Team task lifecycle is worker changes, deterministic quality gates,
  staged-diff review/test, then a controller-owned commit. Workers must not commit.
- An unchanged `HEAD` and an uncommitted staged task diff are expected before
  approval. Reviewer and tester must not request changes only because a task
  commit or commit SHA does not exist yet.
- Review remains strict for correctness, security, data loss, architecture,
  acceptance coverage, test weakening, failed deterministic commands, missing
  or empty diffs, out-of-scope paths, and internally inconsistent evidence.
- Read-only specialists evaluate controller-recorded command results. Any
  independent probe must itself be read-only; inability to rerun a command that
  intentionally writes generated output is not by itself a product failure.
- Tests labeled read-only must not write temporary files or generated output.
- Do not claim TypeScript compilation unless a project-pinned compiler actually
  runs. Schema/declaration parity is the accepted evidence until then.
- Controller-created commits must remain small, recoverable, and independently
  reviewable.

## Baseline Commands

- `pnpm check`
- `pnpm test`
- `pnpm build`
