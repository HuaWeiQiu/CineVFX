# Photoshop Host-Evidence Runbook

This runbook is the operator procedure for collecting **later** Photoshop 2026
host evidence for the local soft-glow path. Completing or even following these
steps is **not** a claim that the checks have passed.

Do **not** flip `photoshopRuntimeVerified` to `true` because this file exists,
because Node tests pass, or because a subset of cases looks successful. That
flag remains `false` until a later, separately recorded full cross-platform
runtime matrix is accepted. This runbook does not edit release metadata.

## 1. What this runbook is for

Collect reproducible host observations for:

1. UXP Developer Tool load of `apps/photoshop-uxp/dist/plugin/manifest.json`.
2. Windows Photoshop 2026 create / undo / redo of the local glow group.
3. The same create / undo / redo path on a **transparent pixel layer**.
4. The same create / undo / redo path on a **smart object**.
5. A 20-cycle create+undo timing matrix at 4K and 8K, recording p50, p95,
   Photoshop scratch peak, and UXP heap.

These cases come from the P0 host-acceptance list. They remain
**UNVERIFIED** unless a later, separately owned host log records a real run.

## 2. What is not host evidence

The following are **not** Photoshop host evidence, even when they pass:

- `pnpm test`, `pnpm check`, `pnpm build`, `pnpm verify`
- UXP package Node tests (including fake Imaging API / fake `executeAsModal`)
- Mock API, OpenAPI, contract, or real-loopback-socket tests
- Agent or reviewer prose without a dated host log
- Layer bounds, panel status text, or a screenshot of the panel alone
- The earlier macOS Photoshop 27.9.1 sideload check (narrow, not this matrix)

Node tests prove planning, redaction, and fake-host contracts. They do not
prove Photoshop DOM, history, Imaging, scratch, heap, or Windows behavior.

Do not treat a green Node suite as permission to mark any row below `PASS`.

## 3. Safety while collecting evidence

- Do not move, transform, resize, replace, or write pixels into the protected
  source layer. The source stays in place; only derived layers are created.
- Do not claim absolute subject preservation from layer bounds alone.
- Do not log image bytes, prompts, credentials, session tokens, or absolute
  local paths (document paths, scratch-disk paths, home directories).
- Do not commit fixture images, heap snapshots, or user documents to the repo.
- Local glow does not need the Mock API and must not send pixels to a network.
- Do not use the panel **开发测试（Mock）** controls as glow host evidence.
- Do not invent p50/p95, scratch, or heap numbers. Leave a field **UNVERIFIED**
  until a real host run fills it.

## 4. Host and plugin prerequisites

Required on the evidence machine:

- Windows 10/11 with an entitled Adobe Photoshop 2026 / 27.x install
- Adobe UXP Developer Tool connected to that Photoshop process
- Node.js 24+ and pnpm 10.33.0, only to **build** the load tree
- A freshly built load tree at `apps/photoshop-uxp/dist/plugin/`

Build the load tree from the repository root **before** every evidence session:

```powershell
pnpm --dir apps/photoshop-uxp build
```

Confirm the load directory contains exactly:

```text
apps/photoshop-uxp/dist/plugin/manifest.json
apps/photoshop-uxp/dist/plugin/index.html
apps/photoshop-uxp/dist/plugin/index.js
apps/photoshop-uxp/dist/plugin/styles.css
```

Load **that** `manifest.json`. Do not add
`apps/photoshop-uxp/manifest.json` (package source). Do not load a signed CCX.
Development plugin id is `com.cinevfx.dev.shell`.

Expected local-glow result names (Chinese, fixed by the plan):

```text
CineVFX 发光
├── 柔光扩散
└── 发光边缘
```

History name is `CineVFX 发光`. One Photoshop history step must cover the
whole group. One undo must remove the complete group. One redo must restore it.

## 5. Evidence log rules

Create a **local** log outside the repository (or a later, separately owned
evidence file). Every case records at least:

| Field | Rule |
| --- | --- |
| Date (UTC) | Calendar day the host was driven |
| Operator | Person at the machine |
| OS | Windows edition + build |
| Photoshop | Exact 2026 / 27.x version from Help > System Info |
| UXP Developer Tool | Tool version |
| Plugin load path | Must be the `dist/plugin/manifest.json` tree |
| Plugin id / version | From the loaded manifest |
| Document mode / depth | RGB 8-bit or RGB 16-bit only |
| Layer kind | `pixel` or `smartObject` |
| Result | `PASS`, `FAIL`, `BLOCKED`, or `UNVERIFIED` |
| Notes | Host-visible facts only; no image bytes or local paths |

A row stays `UNVERIFIED` until that host is actually driven. `BLOCKED` means
the case could not start (no Windows host, UXP Developer Tool would not load,
document rejected). `BLOCKED` is not `PASS`.

Do not copy Node test output into the Result column.

## 6. Load with UXP Developer Tool

This case is a prerequisite for every host row below.

1. Quit any previously loaded CineVFX plugin in UXP Developer Tool.
2. Start Photoshop 2026, then start UXP Developer Tool.
3. Connect UXP Developer Tool to the Photoshop 2026 process.
4. **Add Plugin** and select
   `apps/photoshop-uxp/dist/plugin/manifest.json`
   (Windows Explorer:
   `apps\photoshop-uxp\dist\plugin\manifest.json`).
5. Confirm UXP Developer Tool shows id `com.cinevfx.dev.shell` and Manifest v5.
6. Click **Load**. After a rebuild, click **Reload** rather than adding a
   second plugin.
7. In Photoshop, open **Plugins > CineVFX Dev Shell > CineVFX** (or
   **增效工具 > CineVFX Dev Shell > CineVFX**).
8. Confirm the panel title is **CineVFX**, the first section is **本地效果**,
   and the primary action is **创建柔和发光**.

Pass only if all of the following are true:

- UXP Developer Tool loaded the **dist** manifest, not the package source manifest.
- The panel appears without a load error in UXP Developer Tool.
- **刷新** becomes usable after a document is open.

This case does **not** prove create/undo/redo, source-pixel identity, HTTPS,
or Mock networking.

| Field | Value |
| --- | --- |
| Result | UNVERIFIED |
| Loaded path was `dist/plugin/manifest.json` | UNVERIFIED |
| Panel **本地效果** visible | UNVERIFIED |

## 7. Shared create / undo / redo procedure

Use this sequence for Windows, transparent-pixel, and smart-object cases.
Do not skip Refresh after changing the document or selection.

1. Open an RGB 8-bit or 16-bit document. CMYK, grayscale, 32-bit, and no
   document are expected rejects — record `BLOCKED` with the host message
   code/status text, not a pass.
2. Select **exactly one** visible pixel layer or smart object. Groups, type,
   adjustment layers, hidden layers, and multi-selection are expected rejects.
3. In the CineVFX panel, click **刷新**. Confirm **当前图层** shows a pixel
   layer or smart object plus RGB 8/16-bit size metadata.
4. Leave default glow parameters unless a case says otherwise:
   color `#FFD36A`, intensity 70, spread 36 px, bloom radius 18 px.
5. Click **创建柔和发光**. Wait until the panel is no longer busy.
6. In the Layers panel, confirm a top-level group `CineVFX 发光` sits
   **above** the source and contains `柔光扩散` then `发光边缘`.
7. Confirm the source layer is still present, still selected or still in the
   same parent, and was not renamed, hidden, locked differently, moved, or
   rasterized by the plugin.
8. Undo once (`Ctrl+Z`, or Edit > Undo `CineVFX 发光`).
9. Confirm the entire `CineVFX 发光` group is gone and the source remains.
   No leftover `CineVFX 发光`, `柔光扩散`, or `发光边缘` layer may remain.
10. Redo once (`Ctrl+Shift+Z` or `Ctrl+Y`, or Edit > Redo `CineVFX 发光`).
11. Confirm the same complete group returns above the same source.

Fail the case if any of the following happen:

- The plugin writes into, moves, or replaces the source.
- Undo removes the source or only one of the two derived layers.
- Redo does not restore both derived layers inside `CineVFX 发光`.
- A second `CineVFX 发光` group remains after undo.
- The action required more than one history step to create or undo.

Bounds agreement is a useful check. It is **not** proof that source pixels or
subject geometry are unchanged. Pixel SHA-256 / Imaging API identity is a
separate host check and is not claimed by a pass in this runbook.

## 8. Windows Photoshop 2026 create / undo / redo

Drive the shared procedure on **Windows** Photoshop 2026 / 27.x after a
successful UXP Developer Tool load.

Suggested first Windows fixture (if no cut-out asset is available):

- New RGB 8-bit document, modest size (for example 1024 x 1024).
- One unlocked pixel layer, not a locked Background.
- Some transparent pixels around the painted/subject pixels.

A locked, opaque Background is a weak Windows smoke test: the glow will cover
the full canvas. Prefer a layer with transparency for this case when possible.

| Field | Value |
| --- | --- |
| Result | UNVERIFIED |
| Photoshop version | UNVERIFIED |
| Create produced `CineVFX 发光` / `柔光扩散` / `发光边缘` | UNVERIFIED |
| One undo removed the complete group | UNVERIFIED |
| One redo restored the complete group | UNVERIFIED |
| Source still present and unmoved | UNVERIFIED |

macOS results, if collected later, belong in a separate log row. They do not
complete this Windows case.

## 9. Transparent pixel layer

Purpose: prove the host accepts a normal pixel layer whose **transparency
contour** is not the full canvas, and that undo/redo still owns the whole group.

Prepare a **local** fixture. Do not add it to the repository.

1. RGB 8-bit document.
2. One visible **pixel** layer (not a smart object, group, type, or adjustment layer).
3. Subject pixels surrounded by real transparency. Do not flatten. Do not use
   a locked Background. Do not simulate transparency with a layer mask only
   if the layer pixels themselves are opaque.
4. Select only that layer.

Then run the shared create / undo / redo procedure.

Additional observations to record:

- Panel layer kind after **刷新** is a pixel layer, not a smart object.
- The glow follows the transparent silhouette rather than washing the whole
  canvas. A full-canvas wash on this fixture is a **FAIL** for this case
  (it usually means the layer had no alpha hole).
- Source parent, visibility, opacity, blend mode, and lock flags look
  unchanged in the Layers panel.

| Field | Value |
| --- | --- |
| Result | UNVERIFIED |
| Layer kind after Refresh | UNVERIFIED |
| Transparency contour (not full-canvas wash) | UNVERIFIED |
| Create / undo / redo | UNVERIFIED |
| Source parent / locks / opacity / blend unchanged (panel) | UNVERIFIED |

## 10. Smart object

Purpose: prove the host accepts a visible smart object and still uses one
history step.

Prepare a **local** fixture. Do not add it to the repository.

1. Start from a transparent pixel layer as in the previous case, or place an
   embedded file.
2. Convert that layer to a Smart Object
   (`Layer > Smart Objects > Convert to Smart Object`).
3. Keep it visible and selected. Do not enter the smart-object document; the
   active layer in the parent document must be the smart object.

Then run the shared create / undo / redo procedure.

Additional observations to record:

- Panel layer kind after **刷新** is a smart object.
- The plugin did not rasterize or replace the smart object.
- Undo/redo still removes/restores the entire `CineVFX 发光` group.

| Field | Value |
| --- | --- |
| Result | UNVERIFIED |
| Layer kind after Refresh | UNVERIFIED |
| Smart object not rasterized / replaced | UNVERIFIED |
| Create / undo / redo | UNVERIFIED |

## 11. 4K / 8K timing, Photoshop scratch peak, and UXP heap

Purpose: record performance and memory **observations**. This case does not
authorize an 8K quality claim, a native 8K pipeline claim, or flipping
`photoshopRuntimeVerified`.

### 11.1 Documents

Create **local** RGB **8-bit** documents. 16-bit 8K is expected to fail closed
on the plan memory estimate (~1.48 GiB) and is a separate reject check, not
the timing matrix.

| Label | Canvas | Expected plan gate |
| --- | --- | --- |
| 4K | 3840 x 2160 (~8.3 MP) | Allowed to plan |
| 8K | 7680 x 4320 (~33.2 MP) | Allowed to plan as 8-bit (~759 MiB estimate) |

Each document needs one visible transparent pixel layer **or** one visible
smart object, selected alone. Record which kind was used. Do not use a locked
opaque Background for the timing matrix.

If the panel refuses the document with a memory-limit status, record
`BLOCKED` plus bit depth and pixel count. Do not force the host past the gate.

### 11.2 What to measure

For **each** canvas size, run **20** successful cycles:

1. Click **创建柔和发光**.
2. Confirm the complete `CineVFX 发光` group exists.
3. Undo once so the group is gone.
4. Confirm no leftover CineVFX group remains.
5. Record the wall-clock duration of that create+undo cycle.

Use the same glow parameters for all 20 cycles. Do not change documents mid
series. Discard a cycle only if Photoshop shows a modal error or the panel
reports failure; note the discard and replace it so the published series still
has 20 successful samples, or mark the whole series `FAIL`.

Sort the 20 durations ascending as `t1 … t20` (milliseconds).

| Statistic | Definition for this runbook |
| --- | --- |
| p50 | `t10` (nearest-rank, 50th percentile of 20 samples) |
| p95 | `t19` (nearest-rank, 95th percentile of 20 samples) |

Do not average first. Do not drop outliers to improve the percentile.

Also record, for the whole 20-cycle series:

- **Photoshop scratch peak**: highest scratch-disk use observed while the
  series ran. Read it from Photoshop's Performance / scratch UI or the status
  bar Efficiency / scratch readout. Record the peak as a size with a unit,
  not the absolute scratch-folder path. Do not invent a size.
- **UXP heap**: JavaScript heap used by the loaded plugin, read from the
  UXP Developer Tool debugger Memory view attached to that plugin. Record
  start, end, and peak. Do not save heap snapshots that contain image
  buffers into the repository.

If a meter is unavailable, write `UNAVAILABLE` and how you looked. Do not
substitute Node `process.memoryUsage()`, Task Manager working-set alone, or a
guess.

### 11.3 Timing worksheet (fill later)

4K series:

| Field | Value |
| --- | --- |
| Result | UNVERIFIED |
| Layer kind | UNVERIFIED |
| Bit depth | UNVERIFIED |
| n | 20 (target) |
| p50 create+undo (ms) | UNVERIFIED |
| p95 create+undo (ms) | UNVERIFIED |
| Photoshop scratch peak | UNVERIFIED |
| UXP heap start / peak / end | UNVERIFIED |

8K series:

| Field | Value |
| --- | --- |
| Result | UNVERIFIED |
| Layer kind | UNVERIFIED |
| Bit depth | UNVERIFIED |
| n | 20 (target) |
| p50 create+undo (ms) | UNVERIFIED |
| p95 create+undo (ms) | UNVERIFIED |
| Photoshop scratch peak | UNVERIFIED |
| UXP heap start / peak / end | UNVERIFIED |

Optional reject check (not a timing pass):

| Field | Value |
| --- | --- |
| 8K RGB 16-bit refused by memory gate | UNVERIFIED |

## 12. Matrix (all UNVERIFIED until a host run)

| Case | Host evidence status |
| --- | --- |
| UXP Developer Tool load of `apps/photoshop-uxp/dist/plugin/manifest.json` | UNVERIFIED |
| Windows Photoshop 2026 create / undo / redo | UNVERIFIED |
| Transparent pixel layer create / undo / redo | UNVERIFIED |
| Smart object create / undo / redo | UNVERIFIED |
| 4K, 20-cycle p50 / p95 / Photoshop scratch peak / UXP heap | UNVERIFIED |
| 8K, 20-cycle p50 / p95 / Photoshop scratch peak / UXP heap | UNVERIFIED |

A later owner may copy this table into project-state or release notes only
after real host logs exist. Until then, product docs must keep Windows
runtime, 4K/8K memory, and `photoshopRuntimeVerified` in the unverified
column.

## 13. After a real host session

When every row is `PASS` on Windows Photoshop 2026 with the UXP Developer
Tool load path above, a **later** documentation task may cite those logs.
That later task still must not:

- set `photoshopRuntimeVerified` to `true` from this runbook alone
- treat Node tests as the evidence
- claim 8K output quality or a native 8K pipeline
- claim Imaging API pixel identity unless that separate check was recorded
- claim Mock HTTPS / UXP certificate trust unless that separate check ran

This file is the procedure. It is not the evidence.
