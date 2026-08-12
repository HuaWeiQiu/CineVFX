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
| Local glow `executeAsModal` / history / undo | **VERIFIED on macOS Photoshop 27.9.1** |
| Local glow layer placement | **VERIFIED on macOS Photoshop 27.9.1** |
| Runtime source preservation | **UNVERIFIED** |
| Windows runtime | **UNVERIFIED** |
| One-click signed installation | **UNVERIFIED** |
| Real marketplace plugin ID | **UNVERIFIED** (uses `com.cinevfx.dev.shell`) |
| Marketplace compatibility | **UNVERIFIED** |
| Wider end-to-end runtime success | **UNVERIFIED** |

Bounds metadata is **not** proof of subject preservation.

The macOS runtime check used an 853 x 1280 RGB 8-bit background layer. The
plugin created `CineVFX 发光` with `柔光扩散` and `发光边缘`, one undo removed
the complete result group, and redo restored it. This does not prove source
pixel identity, Windows behavior, Mock networking, or real proxy/import paths.

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
- Before its first business request, each client performs a bounded same-origin
  `GET /healthz`, validates and caches the opaque local session token, and sends
  it as `X-CineVFX-Session` on every `/v1` request. The token is not exposed by
  the public client, task state, logs, or panel UI.

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
6. For network actions, start the Mock API with an explicit TLS key and
   certificate as documented by `apps/api-server/README.md`, then trust that
   development certificate locally. Repository Node integration tests verify
   the real socket protocol only; Photoshop UXP runtime certificate trust and
   end-to-end Photoshop networking remain **UNVERIFIED**.

## Development install (Windows)

1. Install **Adobe Photoshop 2026 / 27.x** and **UXP Developer Tool** on Windows.
2. Build: `pnpm --dir apps/photoshop-uxp build`.
3. In UXP Developer Tool, add
   `apps\photoshop-uxp\dist\plugin\manifest.json`.
4. Load the plugin and open the **CineVFX** panel.
5. For explicit HTTP development, clear both Mock TLS file environment
   variables, set `CINEVFX_MOCK_HOST=127.0.0.1` and
   `CINEVFX_MOCK_ALLOW_HTTP=1`, then change the panel URL to
   `http://127.0.0.1:8787`. The canonical/default path remains trusted HTTPS.
6. Windows runtime (Photoshop on Windows) is **UNVERIFIED** in this repository phase.

There is **no** one-click signed installer and **no** marketplace package in this
shell. Plugin id `com.cinevfx.dev.shell` is a **development** id only.

The build converts the source module graph to one classic `index.js` file because
the Photoshop UXP HTML entry loads a classic script. The generated
`dist/plugin/` contains exactly `manifest.json`, `index.html`, `index.js`, and
`styles.css`; each build recreates the folder so stale files cannot be loaded.

## Usage (panel)

The **Local Effect** controls read the active Photoshop document, exactly one
selected layer, bit depth, kind, and bounds. They do not read image bytes into
JavaScript or send image data to the Mock API. The separate **Development test
(Mock)** controls still use fixed demo IDs and metadata.

1. Select one visible pixel layer or smart object in an RGB 8/16-bit document.
2. Set glow color, intensity, spread, and bloom radius, then choose **Create
   soft glow**. CineVFX creates one editable group above the source with edge
   glow and bloom derivatives. The source is only duplicated, never edited.
3. Optionally edit the Mock API base URL and effect label (arbitrary labels are
   allowed; golden-magic is benchmark metadata only).
4. **Plan proxy** — builds a metadata-only proxy plan for the fixed demo source
   (no Photoshop DOM or pixel export). Real active-layer capture remains
   **UNVERIFIED**.
5. **Submit job** — registers planned asset metadata via `POST /v1/assets`,
   creates a job via `POST /v1/jobs`, polls job/events, then fetches and
   validates the Layer Manifest on success. All network waits run outside
   write/modal scope through `runOutsideWrites`.
6. **Cancel** — sends idempotent `POST /v1/jobs/{id}/cancel` when a job is
   active (repeat cancels are accepted).
7. **Plan import** — reuses the validated manifest (or fetches it), enforces
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
