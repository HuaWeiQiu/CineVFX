# Product Requirements

## Product Definition

CineVFX accepts an arbitrary effect image/layer, optional text, subject masks,
and spatial guidance. It returns editable effect, relight, atmosphere, grade,
and bloom passes for Photoshop.

Golden magic is the first benchmark fixture, not a hard-coded feature boundary.
The same contracts support fire, smoke, lightning, neon, particles, explosions,
lens/light overlays, and other user-supplied effect layers.

## Protected Source Contract

The protected source layer is immutable. CineVFX must not move, transform,
resize, warp, replace, or write pixels into it. Generated subject-light passes
must be separate layers and masks. A bounds check is useful for transaction
safety but is not proof that internal body geometry or pixels are unchanged.

## Target User Flow

1. Select a source layer and optional selection/mask in Photoshop.
2. Select or import any effect reference layer.
3. Export bounded proxies, masks, and normalized guidance.
4. Submit a versioned job.
5. Observe progress and support cancellation/retry.
6. Validate asset digests and the Layer Manifest.
7. Import editable passes without modifying protected inputs.
8. Undo the complete import in one Photoshop history step.

## Current Development Preview

The Node-verified shell implements steps 4-6 against the metadata-only Mock API
and creates deterministic plans for steps 3 and 7. Its visible panel currently
uses fixed demo document/layer IDs and dimensions. It does not read active
Photoshop pixels, export a real proxy, place layers, or call `executeAsModal`.

## Acceptance

Verified in Node:

- Contract examples, generated declarations, and runtime validators agree.
- The Mock client/workflow crosses a real loopback socket and validates a
  generic editable manifest.
- Cancellation, identity binding, bounds, redaction, and simulated rollback
  paths are covered by deterministic tests.
- Planning enforces that network/model waits stay outside write/modal scope.

Still requires Photoshop 2026 acceptance:

- A failed or cancelled real import leaves no partial Photoshop group.
- `executeAsModal`, suspended history, and one-step undo work in the host.
- Export/import never changes protected-source pixels, transform, or geometry.
- HTTPS trust and UXP networking work on both Windows and macOS.

No real model, native 8K pipeline, or subject-preservation quality claim is part
of the current development preview.
