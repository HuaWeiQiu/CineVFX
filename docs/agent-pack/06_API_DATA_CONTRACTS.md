# API and Data Contracts

The contract package is the JSON-model authority. OpenAPI, generated
declarations, examples, and runtime validation must agree. Local transport
details are separately frozen in `openapi/local-development-transport.json`.

## Required Documents

- `EffectSpec`: normalized canvas, arbitrary effect references, guidance,
  generic primitives, seed, and versions.
- `AssetDescriptor`: id, media type, dimensions, digest, alpha mode, TTL, and purpose.
- `JobRequest` and `JobStatus`: idempotency, state, progress, errors, and cancellation.
- `JobEvent`: unique ordered event identity and monotonic sequence.
- `LayerManifest`: protected source identity, ordered editable passes, blend,
  opacity, masks, assets, adjustments, and verified digests.

## State Machine

```text
CREATED -> VALIDATING -> QUEUED -> PREPROCESSING -> RENDERING
        -> POSTPROCESSING -> EXPORTING -> SUCCEEDED
```

Terminal alternatives are `FAILED`, `CANCELLED`, and `EXPIRED`. State changes
are monotonic, retriable commands are idempotent, terminal observations must
agree, and every asset referenced by a successful manifest has a verified digest.

## Local Development Transport

1. `GET /healthz` returns a bounded `no-store` response and an opaque
   per-process session token.
2. The client keeps the token in memory and sends `X-CineVFX-Session` on every
   `/v1/*` request.
3. The six business endpoints are:
   - `POST /v1/assets`
   - `POST /v1/jobs`
   - `GET /v1/jobs/{id}`
   - `GET /v1/jobs/{id}/events`
   - `POST /v1/jobs/{id}/cancel`
   - `GET /v1/jobs/{id}/manifest`
4. Every declared HTTP error response uses the OpenAPI `ErrorObject`.
   Connection-only body timeout is listed separately.

The real-socket integration tests verify this transport in Node. Photoshop UXP
origin permission enforcement, certificate trust, and host networking remain
**UNVERIFIED**.
