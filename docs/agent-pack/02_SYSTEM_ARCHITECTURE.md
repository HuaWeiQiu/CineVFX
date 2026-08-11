# System Architecture

```text
Photoshop 2026 / UXP Manifest v5 development shell
  |
  | metadata-only proxy/mask/effect-reference descriptors
  | protected source {documentStableId, layerStableId} remains immutable
  |
  +-- GET /healthz ------------------------------------------+
  |      receive bounded memory-only session token           |
  |                                                          v
  +== X-CineVFX-Session on every /v1 request ==> Node Mock API
         POST /v1/assets                              |
         POST /v1/jobs                                | deterministic lifecycle
         GET  /v1/jobs/{id}                           | fixed generic manifest
         GET  /v1/jobs/{id}/events                    | bounded metadata stores
         POST /v1/jobs/{id}/cancel                     |
         GET  /v1/jobs/{id}/manifest <----------------+
  |
  +-- validate identities, digests, order, and editable passes
  +-- create one-history rollback-safe import plan
  +-- real Photoshop export/import/executeAsModal: UNVERIFIED
```

## Transport Boundary

- Canonical local origin: `https://localhost:8787`.
- Allowed development origins are frozen in
  `openapi/local-development-transport.json`.
- HTTPS with TLS 1.2 or newer is the default. Windows can explicitly opt into
  loopback HTTP with `CINEVFX_MOCK_ALLOW_HTTP=1`; there is no silent downgrade.
- The API binds only to `localhost` or `127.0.0.1`, validates Host, does not
  enable CORS, bounds request bodies and response reads, and never treats the
  session token as user identity or production authentication.
- OpenAPI owns business JSON models. The local transport document owns
  `/healthz`, the session header, TLS/host rules, and effective HTTP statuses.

## Modules

- `apps/photoshop-uxp`: panel UI, typed client, task state, metadata-only proxy
  planning, manifest validation, import planning, cancellation, and redaction.
- `apps/api-server`: bounded assets/jobs/events, idempotency, cancellation,
  deterministic lifecycle, manifest publication, local transport, and logging.
- `packages/contracts`: JSON Schema, OpenAPI-related examples, generated
  TypeScript declarations, and runtime validators.
- `packages/effect-spec`: generic Curve, Particle, Volume, Sprite, Surface, and
  Lens primitives. No magic-specific discriminator is allowed.
- `services/vfx-renderer`: future deterministic procedural pass generation.
- `services/ai-pipeline`: future optional segmentation, depth, relight, and edit providers.

## Dependency Rule

Contracts landed first. API and UXP consume the same frozen shapes. Renderer
and AI integration remain deferred until real Photoshop export/import and
failure recovery pass on Windows and macOS.

## Photoshop Safety

The current implementation verifies the safety architecture and plan in Node:
stable document/layer IDs, immutable protected-source references, digest and
manifest checks, network exclusion from planned write scope, and simulated
rollback. Actual Photoshop writes must later run in bounded `executeAsModal`
transactions with suspended history, cancellation checks, rollback, and
post-operation source comparison. None of those host operations is claimed as
verified by the current automated suite.
