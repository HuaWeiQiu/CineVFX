# Project State

## Status

- Phase: Stage 5 development-preview delivery handoff
- Delivery state: Stages 1-4 complete in Node; documentation and development packaging ready
- Photoshop state: UXP Manifest v5 development shell only; host execution remains unverified
- Last updated: 2026-08-12

## Completed And Verified

1. **Contracts**: frozen schemas, examples, OpenAPI business surface, generated
   TypeScript declarations, and lifecycle rules. Contract tests: `20/20`.
2. **Mock API**: bounded metadata-only assets, jobs, ordered events,
   cancellation, manifests, idempotency, local session guard, and redacted
   logging. API tests: `59/59`.
3. **UXP shell**: Photoshop 2026 / 27.x-oriented Manifest v5 panel, typed HTTP
   client, task state, proxy/export planning, manifest validation, and
   rollback-safe import planning. UXP Node tests: `130/130`; project-pinned
   TypeScript compilation passed.
4. **Integration**: public UXP client and workflow crossed the real Node
   loopback socket through `/healthz`, `X-CineVFX-Session`, and all required
   job paths. Root tests: `6/6`, including four real-socket integration tests.
5. **Delivery handoff**: MIT licensing, architecture/status truth, deterministic
   development ZIP/checksum tooling, certificate guidance, and Windows/macOS
   sideload boundaries are documented. The current root suite is `14/14`,
   including four release packaging and four command-runner tests.

All package/root `check`, `test`, and `build` gates passed for the 2026-08-12
delivery snapshot. This evidence is Node-only unless stated otherwise.

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

- Real active-document and selected-layer capture in Photoshop
- Photoshop pixel readback and proxy/mask/effect-reference export
- Real layer placement, `executeAsModal`, suspended history, undo, and rollback
- Runtime proof that protected source pixels and geometry remain unchanged
- HTTPS certificate trust and UXP networking inside Photoshop 2026
- Photoshop runtime behavior on Windows and macOS
- Signed CCX packaging, marketplace plugin id, review, and compatibility
- Persistence, multi-user authentication, production deployment, and rate limiting
- Procedural renderer, AI/model providers, model/weight licenses, and GPU behavior
- Native 8K generation, performance, memory use, and output-quality claims

## Next Gate

Run the manual Photoshop 2026 acceptance matrix on Windows and macOS: load the
unpacked development build with UXP Developer Tool, verify HTTPS trust and API
connectivity, replace fixed demo metadata with real active-document export,
execute the bounded import through `executeAsModal`, inspect the layer stack,
verify one-step undo/rollback, and compare protected-source pixels and geometry
before considering a signed CCX or marketplace release.
