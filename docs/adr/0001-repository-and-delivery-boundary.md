# ADR-0001: Repository and Delivery Boundary

## Status

Accepted, 2026-08-12.

## Decision

CineVFX is a new monorepo rather than a feature branch of GlowFX. GlowFX keeps
its local, deterministic, no-network release contract. Reusable UXP transaction,
metadata, queue, and packaging patterns may be ported with tests, but GlowFX's
fixed blur recipe is not the CineVFX domain model.

The first milestone is contract and Mock driven. Real AI providers and GPU
workflows are deferred until Photoshop export/import and failure recovery are
proven without them.

## Consequences

- Releases, plugin IDs, permissions, privacy notices, and issue histories remain separate.
- CineVFX accepts the cost of a backend and provider abstraction.
- Shared concepts are copied deliberately; there is no runtime dependency on GlowFX.
- Cross-platform and model-license acceptance becomes a CineVFX release gate.
