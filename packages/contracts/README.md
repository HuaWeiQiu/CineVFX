# @cinevfx/contracts

Versioned executable contracts for the CineVFX Mock vertical slice.

## Contents

- `schemas/` — JSON Schema (draft 2020-12) for EffectSpec, AssetDescriptor,
  JobRequest, JobStatus, JobEvent, and LayerManifest
- `examples/valid/` — fixtures that must validate
- `examples/invalid/` — negative evidence for malformed payloads
- `generated/` — TypeScript types produced by `pnpm build`
- `src/` — runtime validators and job state-machine helpers

Root OpenAPI lives at `../../openapi/openapi.json` and references these schemas.
Human-oriented notes live in `../../docs/contracts/`.

## Commands

```bash
pnpm --dir packages/contracts check
pnpm --dir packages/contracts test
pnpm --dir packages/contracts build
```

## Invariants

- Successful job results always carry a validated Layer Manifest with editable passes.
- Golden magic appears only as a labeled benchmark example, never a product mode.
- Examples contain no image bytes, prompts, credentials, absolute paths, or protected content.
- Asset digests referenced by manifests are verified `sha256:<hex>` values.
