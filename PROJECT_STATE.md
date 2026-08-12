# Project State

## Status

- Phase: Stage 5 development-preview delivery handoff
- Delivery state: Stages 1-4 complete in Node; documentation and development packaging ready
- Photoshop state: local glow creation/undo/redo verified on macOS Photoshop 27.9.1; wider acceptance in progress
- Last updated: 2026-08-12

## Completed And Verified

1. **Contracts**: frozen schemas, examples, OpenAPI business surface, generated
   TypeScript declarations, and lifecycle rules. Contract tests: `20/20`.
2. **Mock API**: bounded metadata-only assets, jobs, ordered events,
   cancellation, manifests, idempotency, local session guard, and redacted
   logging. API tests: `59/59`.
3. **UXP shell**: Photoshop 2026 / 27.x-oriented Manifest v5 panel, typed HTTP
   client, task state, proxy/export planning, manifest validation, and
   rollback-safe import planning, plus a bounded active-layer local glow host.
   UXP Node tests: `156/156`; project-pinned
   TypeScript compilation passed.
4. **Integration**: public UXP client and workflow crossed the real Node
   loopback socket through `/healthz`, `X-CineVFX-Session`, and all required
   job paths. Root tests: `6/6`, including four real-socket integration tests.
5. **Delivery handoff**: MIT licensing, architecture/status truth, deterministic
   development ZIP/checksum tooling, certificate guidance, and Windows/macOS
   sideload boundaries are documented. The current root suite is `15/15`,
   including four release packaging, four command-runner, and one handoff
   contract test.

All package/root `check`, `test`, and `build` gates passed for the 2026-08-12
delivery snapshot. This evidence is Node-only unless stated otherwise.

The local glow path was also exercised in macOS Photoshop 2026 / 27.9.1 on an
853 x 1280 RGB 8-bit background layer. It created `CineVFX 发光` above the
source with `柔光扩散` and `发光边缘`; one undo removed the complete group and
redo restored it. The source layer remained present, but pixel-level source
identity was not measured.

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

## Unverified

- Cross-platform acceptance of active-document and selected-layer capture
- Photoshop pixel readback and proxy/mask/effect-reference export
- Windows and failure-injection acceptance of local glow placement/history/rollback
- Runtime proof that protected source pixels and geometry remain unchanged
- HTTPS certificate trust and UXP networking inside Photoshop 2026
- Wider Photoshop runtime behavior beyond the checked macOS local-glow path
- Signed CCX packaging, marketplace plugin id, review, and compatibility
- Persistence, multi-user authentication, production deployment, and rate limiting
- Procedural renderer, AI/model providers, model/weight licenses, and GPU behavior
- Native 8K generation, performance, memory use, and output-quality claims

## Next Gate

Continue the manual Photoshop 2026 acceptance matrix: repeat local glow on
Windows and failure/cancel cases, load the unpacked build with UXP Developer
Tool, verify HTTPS trust and API connectivity, replace fixed Mock metadata with
real active-document export, and compare protected-source pixels and geometry
before considering a signed CCX or marketplace release.

The current Chinese implementation handoff is
[`docs/HANDOFF.zh-CN.md`](docs/HANDOFF.zh-CN.md).
