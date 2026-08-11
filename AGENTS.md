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
- Keep commits small, recoverable, and independently reviewable.

## Baseline Commands

- `pnpm check`
- `pnpm test`
- `pnpm build`
