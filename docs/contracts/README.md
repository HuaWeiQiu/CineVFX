# CineVFX Contracts

This directory documents the frozen P0/P1 Mock vertical-slice contracts.

Executable sources of truth:

| Artifact | Path |
| --- | --- |
| JSON Schemas | `packages/contracts/schemas/` |
| Valid examples | `packages/contracts/examples/valid/` |
| Invalid examples | `packages/contracts/examples/invalid/` |
| OpenAPI | `openapi/openapi.json` |
| Generated types | `packages/contracts/generated/types.d.ts` |
| Runtime helpers | `packages/contracts/src/` |

## Documents

1. **EffectSpec** — normalized canvas, arbitrary effect references, guidance,
   primitives, seed, and version fields.
2. **AssetDescriptor** — media type, dimensions, digest, alpha mode, TTL, purpose.
3. **JobRequest / JobStatus** — idempotency and monotonic lifecycle
   `CREATED → VALIDATING → QUEUED → PREPROCESSING → RENDERING → POSTPROCESSING → EXPORTING → SUCCEEDED`,
   plus terminal `FAILED`, `CANCELLED`, and `EXPIRED`.
4. **JobEvent** — ordered lifecycle/progress/error events.
5. **LayerManifest** — ordered editable passes, masks, blend/opacity/adjustments,
   and verified asset digests.

## Product Rules Encoded in Contracts

- Golden magic is only a labeled benchmark fixture (`bench_golden_magic`), never
  a product mode or schema discriminator.
- Successful jobs always expose a Layer Manifest with at least one editable pass.
- Protected source layers are immutable and must remain untouched on import.
- Examples contain no image bytes, prompts, credentials, absolute paths, or
  protected user content.

## Mock Endpoints

OpenAPI covers exactly these six endpoints:

- `POST /v1/assets`
- `POST /v1/jobs`
- `GET /v1/jobs/{id}`
- `GET /v1/jobs/{id}/events`
- `POST /v1/jobs/{id}/cancel`
- `GET /v1/jobs/{id}/manifest`

## Validation

```bash
pnpm --dir packages/contracts check
pnpm --dir packages/contracts test
pnpm --dir packages/contracts build
```
