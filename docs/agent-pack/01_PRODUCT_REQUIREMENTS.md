# Product Requirements

## Product Definition

CineVFX accepts an arbitrary effect image/layer, optional text, subject masks,
and spatial guidance. It returns editable effect, relight, atmosphere, grade,
and bloom passes for Photoshop.

Golden magic is the first benchmark fixture, not a hard-coded feature boundary.
The same contracts must later support fire, smoke, lightning, neon, particles,
explosions, and lens/light overlays.

## Protected Source Contract

The protected source layer is immutable. CineVFX must not move, transform,
resize, warp, replace, or write pixels into it. Generated subject-light passes
must be separate layers and masks. A bounds check is useful for transaction
safety but is not proof that internal body geometry or pixels are unchanged.

## P0/P1 User Flow

1. Select a source layer and optional selection/mask in Photoshop.
2. Select or import an effect reference layer.
3. Export bounded proxies, masks, and normalized guidance.
4. Submit a versioned Mock job.
5. Observe progress and support cancellation/retry.
6. Validate asset hashes and the Layer Manifest.
7. Import editable placeholder passes without modifying protected inputs.
8. Undo the complete import in one Photoshop history step.

## Acceptance

- No real model is required for the vertical slice.
- Contract examples validate in TypeScript and backend tests.
- A failed or cancelled import leaves no partial Photoshop group.
- Network/model waits never run inside `executeAsModal`.
- Logs do not contain image bytes, credentials, prompts, or absolute local paths.
