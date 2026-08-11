# System Architecture

```text
Photoshop UXP
  -> proxy/mask/guidance assets
  -> versioned API and job state machine
  -> Mock or real provider
  -> Layer Manifest plus hashed pass assets
  -> validated Photoshop import transaction
```

## Modules

- `apps/photoshop-uxp`: host UI, proxy export, progress, manifest validation,
  layer import, metadata, cancellation, and recovery.
- `apps/api-server`: assets, jobs, events, idempotency, TTL, provider routing,
  and manifest publication.
- `packages/contracts`: JSON Schema, OpenAPI, examples, and generated TS/Python types.
- `packages/effect-spec`: Curve, Particle, Volume, Sprite, Surface, and Lens primitives.
- `services/vfx-renderer`: deterministic procedural passes.
- `services/ai-pipeline`: optional segmentation, depth, relight, and edit providers.

## Dependency Rule

Contracts land first. UXP and API may then proceed in parallel because both
consume the same frozen examples. Renderer and AI integration start only after
the Mock slice passes end to end.

## Photoshop Safety

Network waits occur outside modal scope. Import uses `executeAsModal`, a single
suspended history state, stable document/layer IDs, cancellation checks, hash
validation before writes, and rollback on any pass failure.
