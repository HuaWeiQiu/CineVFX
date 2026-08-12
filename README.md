# CineVFX

CineVFX is a contract-first Photoshop VFX compositing system. It accepts an
arbitrary effect image/layer plus optional masks and spatial guidance, then
plans editable effect, relight, atmosphere, grade, and bloom passes. Magic,
fire, smoke, lightning, neon, particles, explosions, and lens effects are
examples carried by the same generic contracts, not hard-coded product modes.

The protected source is an immutable input. Generated layers must be placed
around it; CineVFX must not move, transform, resize, replace, or write pixels
into the protected source. Bounds metadata alone is not proof that a subject's
pixels or body geometry were preserved.

## Current Status

Stages 1-4 of the Mock end-to-end vertical slice are complete and verified in
Node. The repository contains frozen contracts, a bounded metadata-only Mock
API, a Photoshop 2026-oriented UXP Manifest v5 development shell, and
real-loopback-socket integration tests. Stage 5 provides the release and
handoff documentation in this repository.

This is a **development preview**, not a production Photoshop plugin:

- The UXP shell builds a metadata-only proxy plan and import plan.
- The local glow path was exercised in macOS Photoshop 2026 / 27.9.1: it
  created the editable two-layer group above the source, one undo removed the
  complete group, and redo restored it. Pixel-level source preservation,
  proxy/import placement, and Windows runtime remain **UNVERIFIED**.
- Real Photoshop pixel export/readback and Mock end-to-end networking remain
  **UNVERIFIED**.
- The plugin id `com.cinevfx.dev.shell` is a development id.
- There is no signed CCX, marketplace package, or one-click formal installer.
- No real AI provider, renderer, native 8K pipeline, or 8K quality claim is
  included.

See [Project State](PROJECT_STATE.md) for the evidence boundary and
[Release Guide](docs/RELEASE.md) for development packaging and sideloading.

## Architecture

```text
Photoshop 2026 / UXP Developer Tool                Node Mock API
+----------------------------------+               +--------------------------+
| Manifest v5 development panel    | GET /healthz  | loopback only            |
| metadata-only proxy plan         |-------------> | issue memory-only token  |
| protected source stable IDs      |               | no image bytes/providers |
|                                  |  X-CineVFX-Session on every /v1 request  |
| typed client + task state        |==============>| POST /v1/assets          |
| manifest validation              |               | POST /v1/jobs            |
| rollback-safe import plan        |<==============| GET status/events        |
|                                  |               | POST cancel              |
| protected source remains input   |<--------------| GET validated manifest   |
+----------------------------------+               +--------------------------+
                 |
                 +-- local glow executeAsModal: macOS 27.9.1 runtime-checked
                 +-- proxy export/import and pixel proof: UNVERIFIED
```

The six frozen business routes are `POST /v1/assets`, `POST /v1/jobs`,
`GET /v1/jobs/{id}`, `GET /v1/jobs/{id}/events`,
`POST /v1/jobs/{id}/cancel`, and `GET /v1/jobs/{id}/manifest`.
The local API canonical origin is `https://localhost:8787`. HTTPS is the
default on both platforms; Windows may explicitly opt into loopback HTTP for
development.

## Five-Stage Delivery

| Stage | Result | Completion evidence |
| --- | --- | --- |
| 1. Contracts | Frozen JSON Schema, OpenAPI, examples, generated declarations, and state rules | Contract tests `20/20`; contract check/build passed |
| 2. Mock API | Bounded assets/jobs/events/cancel/manifest service with idempotency and redacted logs | API tests `59/59`; API check/build passed |
| 3. UXP shell | Manifest v5 panel, typed client, task state, local glow host, proxy/import planning, and validation | UXP tests `156/156`; real project-pinned `tsc`, check, and build passed |
| 4. Integration | Authenticated health/session transport and Mock workflow over real Node sockets | Root tests `6/6`, including four real-socket integration tests; root check/build passed |
| 5. Delivery handoff | MIT license, current-state documentation, deterministic development ZIP/checksums and UDT instructions | Current root suite `14/14`, including four packaging tests; documentation and diff checks pass |

Counts are the 2026-08-12 delivery snapshot. Automated tests do not substitute
for the Photoshop acceptance work listed in [Project State](PROJECT_STATE.md).

## Repository Shape

```text
apps/photoshop-uxp       Photoshop development shell and planning layer
apps/api-server          bounded metadata-only Mock API
packages/contracts       schemas, examples, OpenAPI-facing runtime helpers
packages/effect-spec     generic deterministic effect primitives
services/vfx-renderer    future procedural rendering boundary
services/ai-pipeline     future optional model/provider boundary
tests                    root contract and real-socket integration evidence
```

## Development

Prerequisites: Node.js 24 or newer and pnpm 10.33.0.

```bash
pnpm install
pnpm check
pnpm test
pnpm build
# or run all three gates in order
pnpm verify
```

The build phase also validates the real UXP load tree and regenerates the
deterministic unsigned files in `dist/release/`.

Build the UXP Developer Tool load tree:

```bash
pnpm --dir apps/photoshop-uxp build
```

In UXP Developer Tool, add
`apps/photoshop-uxp/dist/plugin/manifest.json`, load it against an installed
Photoshop 2026 / 27.x host, and open the CineVFX panel. This is sideloading an
unpacked development build; it is not a CCX installation.

For network actions, start the local API using the certificate setup in
[apps/api-server/README.md](apps/api-server/README.md). The canonical command
uses HTTPS:

```bash
export CINEVFX_MOCK_TLS_KEY_FILE=/absolute/path/to/mock-key.pem
export CINEVFX_MOCK_TLS_CERT_FILE=/absolute/path/to/mock-cert.pem
pnpm --dir apps/api-server start
```

On Windows, the same environment variables can point to a current-user trusted
certificate. An explicit development-only HTTP fallback is also available:

```powershell
Remove-Item Env:CINEVFX_MOCK_TLS_KEY_FILE -ErrorAction SilentlyContinue
Remove-Item Env:CINEVFX_MOCK_TLS_CERT_FILE -ErrorAction SilentlyContinue
$env:CINEVFX_MOCK_HOST = "127.0.0.1"
$env:CINEVFX_MOCK_ALLOW_HTTP = "1"
pnpm --dir apps/api-server start
```

When using HTTP, set the panel API URL to `http://127.0.0.1:8787`. The default
remains `https://localhost:8787`.

Detailed package instructions:

- [Photoshop UXP development shell](apps/photoshop-uxp/README.md)
- [Mock API and certificate trust](apps/api-server/README.md)
- [Frozen contracts](docs/contracts/README.md)
- [Release and Windows handoff](docs/RELEASE.md)

To rerun only the deterministic unsigned development packaging step:

```bash
pnpm release:dev
```

Artifacts are written to `dist/release/`; see the release guide before sharing
them.

## License

MIT. See [LICENSE](LICENSE).
