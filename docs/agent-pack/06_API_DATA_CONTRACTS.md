# API and Data Contracts

The contract package is the authority. OpenAPI and generated types must agree
with executable JSON Schema examples.

## Required Documents

- `EffectSpec`: normalized canvas, references, guidance, primitives, seed, and versions.
- `AssetDescriptor`: id, media type, dimensions, hash, alpha mode, TTL, and purpose.
- `JobRequest` and `JobStatus`: idempotency, state, progress, errors, and cancellation.
- `LayerManifest`: ordered passes, blend mode, opacity, mask, asset, and adjustments.

## State Machine

```text
CREATED -> VALIDATING -> QUEUED -> PREPROCESSING -> RENDERING
        -> POSTPROCESSING -> EXPORTING -> SUCCEEDED
```

Terminal alternatives are `FAILED`, `CANCELLED`, and `EXPIRED`. State changes
are monotonic, retriable commands are idempotent, and every asset referenced by
a successful manifest has a verified digest.

## Mock Slice Endpoints

- `POST /v1/assets`
- `POST /v1/jobs`
- `GET /v1/jobs/{id}`
- `GET /v1/jobs/{id}/events`
- `POST /v1/jobs/{id}/cancel`
- `GET /v1/jobs/{id}/manifest`
