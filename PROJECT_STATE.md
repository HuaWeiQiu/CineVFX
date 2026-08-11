# Project State

## Status

- Phase: P0 repository and contract bootstrap
- Delivery state: not yet runnable in Photoshop
- Agent execution: waiting for an existing unrelated AgentDeck run to finish
- Last updated: 2026-08-12

## Frozen Decisions

- CineVFX is a new repository; GlowFX remains a separate lightweight plugin.
- The product accepts arbitrary effect layers; golden magic is a benchmark fixture only.
- The first executable milestone is a Mock end-to-end vertical slice.
- Original subject pixels and geometry are protected by immutability and validation,
  not merely by checking layer bounds.
- Photoshop, backend, renderer, and AI providers communicate through versioned contracts.

## Unverified

- Photoshop proxy export and manifest import
- FastAPI runtime and persistence choice
- Procedural VFX renderer implementation
- Subject preservation metrics
- Native 8K final rendering
- Windows Photoshop behavior
- Model and weight licenses

## Next Gate

Approve a contract-first Agent task DAG that produces contracts, Mock API,
minimal UXP shell, and integration evidence without adding a real AI model.
