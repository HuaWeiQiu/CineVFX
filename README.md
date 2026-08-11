# CineVFX

CineVFX is a contract-first Photoshop VFX compositing system. It accepts an
arbitrary effect image/layer plus optional subject masks and guidance, then
returns editable Photoshop passes with scene matching and subject-safe light
integration.

The product is not a magic-only filter and does not promise that AI can safely
rewrite a person. The protected source remains immutable; generated passes are
composited around it.

## Current Phase

P0/P1 delivers a Mock end-to-end vertical slice only:

1. Freeze EffectSpec, Job, Asset, Event, and Layer Manifest contracts.
2. Export a bounded Photoshop proxy and masks.
3. Submit them to a Mock API.
4. Receive a fixed, validated Layer Manifest.
5. Import editable placeholder passes in one recoverable Photoshop operation.

No large model, ComfyUI workflow, remote image provider, or 8K claim is allowed
until this vertical slice and its failure recovery pass.

## Repository Shape

```text
apps/photoshop-uxp
apps/api-server
packages/contracts
packages/effect-spec
services/vfx-renderer
services/ai-pipeline
tests
```

## Development

```bash
pnpm check
pnpm test
pnpm build
agent-team validate
agent-team doctor
```

Multi-Agent runs start with the `contract-first` strategy. `mock-slice` may be
used only after the shared contracts are merged and clean.
