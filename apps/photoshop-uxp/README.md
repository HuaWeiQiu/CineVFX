# @cinevfx/photoshop-uxp

Photoshop **2026 / 27.x-oriented** UXP **manifestVersion 5** development shell for the
CineVFX Mock vertical slice.

This package provides:

- Compact, responsive, Photoshop-style panel UI
- Public typed HTTP client surface for all six frozen Mock endpoints
- Panel task state machine
- Metadata-only proxy export **planning**
- Layer Manifest validation
- Protected-source-safe import **plan** (one bounded transaction, rollback, no partial group)
- Network waits kept outside Photoshop write/modal plan scope
- Log redaction helpers

## UNVERIFIED (do not claim otherwise)

The following are **explicitly UNVERIFIED** in this development shell:

| Capability | Status |
| --- | --- |
| Real Photoshop proxy export / pixel readback | **UNVERIFIED** |
| `executeAsModal` / history / undo execution | **UNVERIFIED** |
| Layer placement into the document | **UNVERIFIED** |
| Runtime source preservation | **UNVERIFIED** |
| Windows runtime | **UNVERIFIED** |
| One-click signed installation | **UNVERIFIED** |
| Real marketplace plugin ID | **UNVERIFIED** (uses `com.cinevfx.dev.shell`) |
| Marketplace compatibility | **UNVERIFIED** |
| End-to-end runtime success in Photoshop | **UNVERIFIED** |

Bounds metadata is **not** proof of subject preservation.

## Package commands

From the repository root:

```bash
pnpm --dir apps/photoshop-uxp check
pnpm --dir apps/photoshop-uxp test
pnpm --dir apps/photoshop-uxp build
```

- `check` — structural package + strict Manifest v5 and classic-bundle validation
- `test` — Node deterministic unit tests (no Photoshop, no network services)
- `build` — writes `dist/build.json` and a UXP Developer Tool load tree at
  `dist/plugin/`; it is not a signed installer

## Mock API

Panel default base URL: `https://localhost:8787`.

- Photoshop on macOS requires HTTPS and a locally trusted certificate.
- Photoshop on Windows may use `http://127.0.0.1:8787` for loopback development.

Endpoints (metadata only):

1. `POST /v1/assets`
2. `POST /v1/jobs`
3. `GET /v1/jobs/{id}`
4. `GET /v1/jobs/{id}/events`
5. `POST /v1/jobs/{id}/cancel`
6. `GET /v1/jobs/{id}/manifest`

## Development install (macOS)

1. Install **Adobe Photoshop 2026 / 27.x** and **UXP Developer Tool**.
2. Build the sideload tree: `pnpm --dir apps/photoshop-uxp build`.
3. In UXP Developer Tools → **Add Plugin** → select
   `apps/photoshop-uxp/dist/plugin/manifest.json`. Do not select the package
   source manifest.
4. Load / reload the plugin against Photoshop.
5. Open the **CineVFX** panel from the Photoshop Plugins menu.
6. In this phase, verify plugin loading, UI, and local proxy planning only.
   Submit, Cancel, and network-backed Import on macOS require the trusted-HTTPS
   Mock API added by the next integration phase. The current Mock API is HTTP
   only, and Photoshop UXP on macOS does not support plain HTTP.

## Development install (Windows)

1. Install **Adobe Photoshop 2026 / 27.x** and **UXP Developer Tool** on Windows.
2. Build: `pnpm --dir apps/photoshop-uxp build`.
3. In UXP Developer Tool, add
   `apps\photoshop-uxp\dist\plugin\manifest.json`.
4. Load the plugin and open the **CineVFX** panel.
5. For the default non-TLS Mock API, change the panel URL to
   `http://127.0.0.1:8787`.
6. Windows runtime (Photoshop on Windows) is **UNVERIFIED** in this repository phase.

There is **no** one-click signed installer and **no** marketplace package in this
shell. Plugin id `com.cinevfx.dev.shell` is a **development** id only.

The build converts the source module graph to one classic `index.js` file because
the Photoshop UXP HTML entry loads a classic script. The generated
`dist/plugin/` contains exactly `manifest.json`, `index.html`, `index.js`, and
`styles.css`; each build recreates the folder so stale files cannot be loaded.

## Usage (panel)

This phase is a deterministic development shell. Its visible buttons currently
use fixed demo layer/document IDs and 1024 x 1024 metadata; they do **not** read
the active Photoshop document, selected layer, pixels, or bounds.

1. Optionally edit the Mock API base URL and effect label (arbitrary labels are
   allowed; golden-magic is benchmark metadata only).
2. **Plan proxy** — builds a metadata-only proxy plan for the fixed demo source
   (no Photoshop DOM or pixel export). Real active-layer capture remains
   **UNVERIFIED**.
3. **Submit job** — registers planned asset metadata via `POST /v1/assets`,
   creates a job via `POST /v1/jobs`, polls job/events, then fetches and
   validates the Layer Manifest on success. All network waits run outside
   write/modal scope through `runOutsideWrites`.
4. **Cancel** — sends idempotent `POST /v1/jobs/{id}/cancel` when a job is
   active (repeat cancels are accepted).
5. **Plan import** — reuses the validated manifest (or fetches it), enforces
   frozen-schema validation, and builds a single-history, rollback-safe import
   plan that never mutates the protected source. Real `executeAsModal` /
   placement remains **UNVERIFIED**.

## Public API (Node / tests)

```js
import {
  createCinevfxClient,
  createTaskController,
  planProxyExport,
  validateLayerManifest,
  planManifestImport,
  createWriteScopeGuard,
  UNVERIFIED,
} from "@cinevfx/photoshop-uxp";
```

## Safety invariants

- Never modify, move, transform, resize, replace, or write pixels into the
  protected source layer (plan-enforced; runtime **UNVERIFIED**).
- Network / model waits never run inside the modal write plan.
- Successful import plans require validated editable passes and digest agreement.
- Failed import simulation rolls back the entire result group (no partial group).
- Logs redact image bytes, credentials, prompts, and absolute local paths.

## Out of scope

- Image bytes in repo fixtures or logs
- AI models, ComfyUI, providers, GPU generation
- Signed publishing / marketplace submission
- Network-fetched npm dependencies
