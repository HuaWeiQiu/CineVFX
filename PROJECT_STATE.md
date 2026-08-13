# Project State

## Status

- Phase: Stage 5 development-preview delivery handoff
- Delivery state: Stages 1-4 complete in Node; T1–T3 added Node identity/cleanup
  contracts and a host-evidence runbook. The product remains a development preview.
- Photoshop state: local glow creation/undo/redo verified on macOS Photoshop 27.9.1;
  wider acceptance, including every T3 runbook row, is still unverified
- Last updated: 2026-08-14
- `photoshopRuntimeVerified` remains `false`. Node tests are not Photoshop host evidence.

## Completed And Verified

1. **Contracts**: frozen schemas, examples, OpenAPI business surface, generated
   TypeScript declarations, and lifecycle rules. Contract tests: `20/20`.
2. **Mock API**: bounded metadata-only assets, jobs, ordered events,
   cancellation, manifests, idempotency, local session guard, and redacted
   logging. API tests: `59/59`.
3. **UXP shell**: Photoshop 2026 / 27.x-oriented Manifest v5 panel, typed HTTP
   client, task state, proxy/export planning, manifest validation, and
   rollback-safe import planning, plus a bounded active-layer local glow host.
   UXP Node tests after T2: `165/165`; project-pinned
   TypeScript compilation passed. These counts are Node-only.
4. **Integration**: public UXP client and workflow crossed the real Node
   loopback socket through `/healthz`, `X-CineVFX-Session`, and all required
   job paths. Root tests: `6/6`, including four real-socket integration tests.
5. **Delivery handoff**: MIT licensing, architecture/status truth, deterministic
   development ZIP/checksum tooling, certificate guidance, and Windows/macOS
   sideload boundaries are documented. The current root suite is `15/15`,
   including four release packaging, four command-runner, and one handoff
   contract test.
6. **T1 Imaging identity (Node only)**: the glow host captures a source-layer
   SHA-256 through Imaging `getPixels` when that API is present, checks parent,
   bounds, visibility, opacity, blend, and locks before and after the write, and
   disposes `imageData` promptly. Missing Imaging stays unverified and never
   invents a hash. Node tests used a fake Imaging API and asserted dispose.
   No real-host SHA-256 was measured.
7. **T2 leftover-group cleanup (Node only)**: on cancel or failure after group
   create, first duplicate, or blur, the host deletes leftover created roots
   inside the existing modal/history transaction, then discards history. Cleanup
   fails closed if a leftover cannot be removed or contains the protected source.
   The service does not start a second write. Node fakes cover orchestration
   only. Real host cancel remains unverified.
8. **T3 host-evidence runbook**:
   [`docs/runbooks/photoshop-host-evidence.md`](docs/runbooks/photoshop-host-evidence.md)
   is the later operator procedure for UXP Developer Tool load, Windows
   create/undo/redo, a transparent pixel layer, a smart object, and 4K/8K
   timing. Every row in that file is `UNVERIFIED`. The runbook is not evidence
   that those checks passed.

All package/root `check`, `test`, and `build` gates passed for the 2026-08-12
delivery snapshot. T1 and T2 recorded the same Node gates again, plus
`pnpm --filter photoshop-uxp test` (`161/161` after T1, `165/165` after T2).
This evidence is Node-only unless stated otherwise.

The local glow path was also exercised in macOS Photoshop 2026 / 27.9.1 on an
853 x 1280 RGB 8-bit background layer. It created `CineVFX 发光` above the
source with `柔光扩散` and `发光边缘`; one undo removed the complete group and
redo restored it. The source layer remained present, but pixel-level source
identity was not measured on that host, and that session did not use UXP
Developer Tool.

## Frozen Decisions

- CineVFX is a separate repository; GlowFX remains a separate lightweight plugin.
- The product accepts an arbitrary effect image/layer. Golden magic remains a
  benchmark fixture, never a schema discriminator or fixed workflow.
- The original protected source is immutable. Bounds checks are useful safety
  inputs, not proof of absolute subject or pose preservation.
- Photoshop, API, renderer, and future providers communicate through versioned contracts.
- The local development API canonical origin is `https://localhost:8787`.
  Windows loopback HTTP requires explicit `CINEVFX_MOCK_ALLOW_HTTP=1` opt-in.
- Development loading uses UXP Developer Tool and
  `apps/photoshop-uxp/dist/plugin/manifest.json`.
  There is no signed CCX or one-click formal installation in this phase.
- The product remains a development preview until the remaining P0 host matrix
  is actually recorded. Do not treat a green Node suite, a runbook file, or this
  fact sync as permission to set `photoshopRuntimeVerified` to `true`.

## Unverified

- Windows Photoshop 2026 local-glow create / undo / redo
- Transparent pixel layer create / undo / redo on a real host
- Smart object create / undo / redo on a real host
- UXP Developer Tool load of `apps/photoshop-uxp/dist/plugin/manifest.json`
- 4K and 8K 20-cycle p50 / p95, Photoshop scratch peak, and UXP heap
- Real host cancel and mid-write failure leftover cleanup
- Any Imaging API SHA-256 that was not measured on a real host
- Cross-platform acceptance of active-document and selected-layer capture
- Photoshop pixel readback and proxy/mask/effect-reference export
- HTTPS certificate trust and UXP networking inside Photoshop 2026
- Wider Photoshop runtime behavior beyond the checked macOS local-glow path
- Signed CCX packaging, marketplace plugin id, review, and compatibility
- Persistence, multi-user authentication, production deployment, and rate limiting
- Procedural renderer, AI/model providers, model/weight licenses, and GPU behavior
- Native 8K generation, performance, memory use, and output-quality claims

## Next Gate

Follow [`docs/runbooks/photoshop-host-evidence.md`](docs/runbooks/photoshop-host-evidence.md)
on a real Photoshop 2026 host. Do not mark any runbook row `PASS` from Node
output. Still needed before a signed CCX or marketplace release: Windows
create/undo/redo, transparent pixel and smart-object fixtures, UXP Developer
Tool load of the dist manifest, real host cancel, a real-host Imaging SHA-256,
4K/8K timing, HTTPS trust and API connectivity, and real active-document export
in place of fixed Mock metadata.

The current Chinese implementation handoff is
[`docs/HANDOFF.zh-CN.md`](docs/HANDOFF.zh-CN.md).
