# @cinevfx/api-server

Dependency-light, metadata-only **Mock API** for the CineVFX vertical slice.

This package implements the six frozen contract endpoints using **Node built-ins
only**. It validates asset and job metadata against the frozen
`packages/contracts` schemas, advances jobs through a deterministic monotonic
lifecycle, publishes fixed generic editable Layer Manifests, and redacts
sensitive fields from logs.

No image bytes, models, providers, renderer services, or network-fetched
dependencies are used.

## Endpoints

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/v1/assets` | Register asset metadata (proxy, mask, effect reference, …) |
| `POST` | `/v1/jobs` | Create or replay an idempotent job (`Idempotency-Key` required) |
| `GET` | `/v1/jobs/{id}` | Fetch current `JobStatus` |
| `GET` | `/v1/jobs/{id}/events` | List ordered events (`afterSequence` optional) |
| `POST` | `/v1/jobs/{id}/cancel` | Request cancellation (idempotent when already cancelled) |
| `GET` | `/v1/jobs/{id}/manifest` | Fetch validated Layer Manifest (succeeded jobs only) |

The six frozen endpoints:

- `POST /v1/assets`
- `POST /v1/jobs`
- `GET /v1/jobs/{id}`
- `GET /v1/jobs/{id}/events`
- `POST /v1/jobs/{id}/cancel`
- `GET /v1/jobs/{id}/manifest`

OpenAPI authority: `openapi/openapi.json` (repository root).

## Local usage

From the repository root (or this package directory):

```bash
# syntax / structure check
pnpm --dir apps/api-server check

# package tests (in-process + HTTP)
pnpm --dir apps/api-server test

# local build smoke (writes dist/build-manifest.json)
pnpm --dir apps/api-server build

# start Mock API on 127.0.0.1:8787
pnpm --dir apps/api-server start
```

Environment overrides:

- `CINEVFX_MOCK_HOST` (default `127.0.0.1`)
- `CINEVFX_MOCK_PORT` (default `8787`)

### Typical Mock flow

1. `POST /v1/assets` for each input asset descriptor (metadata only).
2. `POST /v1/jobs` with a `JobRequest` body and matching `Idempotency-Key` header.
3. `GET /v1/jobs/{id}` and/or `GET /v1/jobs/{id}/events` for status.
4. On success, `GET /v1/jobs/{id}/manifest` for the validated editable passes.

Exact request replay with the same idempotency key returns **200** and the same
`jobId`. A reused key with a different body is rejected with **409**.
Exact `POST /v1/assets` metadata replay returns the stored descriptor with
**201**, matching the frozen OpenAPI response surface.

### Deterministic lifecycle outcomes

By default the Mock advances a valid job to `SUCCEEDED` immediately and
publishes a fixed generic Layer Manifest with editable passes and digest
agreement.

Label-based steers (effectSpec.label substrings) for local testing:

| Label contains | Outcome |
| --- | --- |
| `force-fail` / `mock-fail` | terminal `FAILED` |
| `force-expire` / `mock-expire` | terminal `EXPIRED` |
| `force-hold` / `mock-hold` | stop at `RENDERING` (for cancel tests) |

`options.dryRun: true` leaves the job in `CREATED`.
`options.ttlSeconds` at the schema minimum (`60`) forces `EXPIRED`.

Terminal states are immutable: cancel on a non-cancelled terminal job returns
**409**; cancel on an already cancelled job is idempotent (**200**).

## Bounds

- Max request body: 256 KiB (configurable via store limits)
- Max assets: 256
- Max jobs: 128
- Max events per job: 256

## Logging

Logs are JSON lines. Sensitive keys (`prompt`, credentials, paths, image
content fields, …) and path/token-like values are redacted. Do not expect image
bytes or absolute local paths in log output.

## Package layout

```text
apps/api-server/
  src/           # service, HTTP, lifecycle, manifest factory, redaction
  scripts/       # check, build, start
  tests/         # node:test suite
  README.md
  package.json
```

## Unverified / out of scope

- Persistence, authentication, multi-tenant isolation
- Real image transfer, storage backends, CDN
- AI models, ComfyUI, GPU providers, renderer services
- Production rate limiting and horizontal scaling

Those concerns are intentionally excluded from the Mock vertical slice.
