import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { planProxyExport } from "../src/proxy/proxy-plan.mjs";
import { FORBIDDEN_SOURCE_OPS } from "../src/constants.mjs";

describe("planProxyExport", () => {
  it("builds metadata-only plan with protected source immutability", () => {
    const plan = planProxyExport(
      {
        layerStableId: "ps_layer_stable_source_01",
        documentStableId: "ps_doc_stable_01",
        bounds: { x: 10, y: 20, width: 2048, height: 1024 },
      },
      {
        effectLabel: "neon-rain",
        maxEdge: 1024,
        effectLayer: { layerStableId: "ps_layer_effect_01" },
        subjectMaskLayer: { layerStableId: "ps_layer_mask_01" },
        guidanceAnchors: [
          { id: "a1", point: { x: 0.2, y: 0.8 }, radius: 0.1 },
        ],
      },
    );

    assert.equal(plan.kind, "proxy_export_plan");
    assert.equal(plan.execution.verified, false);
    assert.equal(plan.protectedSource.immutable, true);
    assert.equal(plan.protectedSource.boundsAreNotPreservationProof, true);
    for (const op of FORBIDDEN_SOURCE_OPS) {
      assert.ok(plan.protectedSource.operationsForbidden.includes(op));
    }
    assert.equal(plan.effectLabel, "neon-rain");
    assert.equal(plan.plannedAssets.length, 3);
    assert.ok(plan.plannedAssets.every((a) => a.digestPending === true));
    assert.ok(plan.canvas.width <= 1024);
    assert.ok(plan.canvas.height <= 1024);
    assert.ok(plan.nextPhases.every((p) => p.allowsNetwork === true));
    // No image bytes anywhere
    const serialized = JSON.stringify(plan);
    assert.equal(serialized.includes("base64"), false);
    assert.equal(serialized.includes("imageBytes"), false);
  });

  it("accepts arbitrary effect labels (not magic-only)", () => {
    for (const label of ["fire", "smoke", "lightning", "particles", "lens-flare"]) {
      const plan = planProxyExport(
        { layerStableId: "src" },
        { effectLabel: label },
      );
      assert.equal(plan.effectLabel, label);
    }
  });

  it("requires protected source layer id", () => {
    assert.throws(() => planProxyExport({}));
  });

  const base = {
    layerStableId: "ps_layer_stable_source_01",
    bounds: { x: 0, y: 0, width: 512, height: 256 },
  };

  it("requires native integer maxEdge values in the supported range", () => {
    assert.equal(planProxyExport(base, { maxEdge: 64 }).canvas.width, 64);
    assert.equal(planProxyExport(base, { maxEdge: 2048 }).canvas.width, 512);
    for (const maxEdge of ["1024", null, Number.NaN, 63, 2049, 64.5]) {
      assert.throws(
        () => planProxyExport(base, { maxEdge: /** @type {any} */ (maxEdge) }),
        /maxEdge|finite/,
      );
    }
  });

  it("requires native finite bounds with positive dimensions", () => {
    for (const [key, value] of [
      ["x", "0"],
      ["y", null],
      ["width", Number.NaN],
      ["height", Number.POSITIVE_INFINITY],
    ]) {
      assert.throws(
        () =>
          planProxyExport({
            ...base,
            bounds: { ...base.bounds, [key]: value },
          }),
        /finite/,
      );
    }
    for (const [key, value] of [
      ["width", 0],
      ["height", -1],
    ]) {
      assert.throws(
        () =>
          planProxyExport({
            ...base,
            bounds: { ...base.bounds, [key]: value },
          }),
        /positive/,
      );
    }
  });

  it("validates color space, labels, and native unsigned integer seeds", () => {
    assert.throws(
      () => planProxyExport(base, { colorSpace: "cmyk" }),
      /colorSpace/,
    );
    assert.throws(
      () => planProxyExport(base, { colorSpace: /** @type {any} */ (null) }),
      /colorSpace/,
    );
    assert.equal(planProxyExport(base, { seed: 0 }).seed, 0);
    assert.equal(planProxyExport(base, { seed: 4294967295 }).seed, 4294967295);
    for (const seed of ["1", null, Number.NaN, -1, 1.5, 4294967296]) {
      assert.throws(
        () => planProxyExport(base, { seed: /** @type {any} */ (seed) }),
        /seed|finite/,
      );
    }
    assert.throws(
      () => planProxyExport(base, { effectLabel: "x".repeat(129) }),
      /128/,
    );
  });

  it("validates optional layer metadata without coercion", () => {
    assert.throws(
      () =>
        planProxyExport(base, {
          effectLayer: { layerStableId: "" },
        }),
      /effectLayer/,
    );
    assert.throws(
      () =>
        planProxyExport(base, {
          subjectMaskLayer: { layerStableId: "mask", bounds: { x: 0, y: 0, width: 0, height: 1 } },
        }),
      /positive|bounds/,
    );
    for (const [field, value] of [
      ["documentStableId", 123],
      ["documentStableId", ""],
      ["name", 123],
    ]) {
      assert.throws(
        () =>
          planProxyExport(base, {
            effectLayer: {
              layerStableId: "effect_layer",
              [field]: value,
            },
          }),
        new RegExp(String(field)),
      );
    }
    assert.throws(
      () =>
        planProxyExport(
          {
            ...base,
            documentStableId: /** @type {any} */ (7),
          },
          {},
        ),
      /documentStableId/,
    );
  });

  it("requires a bounded guidance array and strict anchor shapes", () => {
    assert.equal(planProxyExport(base).guidance.anchors.length, 1);
    assert.deepEqual(
      planProxyExport(base, { guidanceAnchors: [] }).guidance.anchors,
      [],
    );
    assert.throws(
      () =>
        planProxyExport(base, {
          guidanceAnchors: /** @type {any} */ ({ id: "a1" }),
        }),
      /array/,
    );
    assert.throws(
      () =>
        planProxyExport(base, {
          guidanceAnchors: Array.from({ length: 33 }, (_, index) => ({
            id: `a_${index}`,
            point: { x: 0.5, y: 0.5 },
          })),
        }),
      /at most 32/,
    );
    assert.throws(
      () =>
        planProxyExport(base, {
          guidanceAnchors: /** @type {any} */ (new Array(1)),
        }),
      /anchor|omits array/,
    );

    const valid = { id: "a1", point: { x: 0, y: 1 }, radius: 0 };
    assert.deepEqual(
      planProxyExport(base, { guidanceAnchors: [valid] }).guidance.anchors,
      [valid],
    );

    for (const anchor of [
      null,
      [],
      { id: "a", point: { x: 0.5, y: 0.5 } },
      { id: "A1", point: { x: 0.5, y: 0.5 } },
      { id: "a1", point: { x: "0.5", y: 0.5 } },
      { id: "a1", point: { x: 0.5, y: null } },
      { id: "a1", point: { x: -0.1, y: 0.5 } },
      { id: "a1", point: { x: 0.5, y: 1.1 } },
      { id: "a1", point: { x: Number.NaN, y: 0.5 } },
      { id: "a1", point: { x: 0.5, y: 0.5 }, radius: "0.2" },
      { id: "a1", point: { x: 0.5, y: 0.5 }, radius: -0.1 },
      { id: "a1", point: { x: 0.5, y: 0.5 }, radius: 1.1 },
      { id: "a1", point: { x: 0.5, y: 0.5 }, extra: true },
      { id: "a1", point: { x: 0.5, y: 0.5, z: 0.5 } },
    ]) {
      assert.throws(() =>
        planProxyExport(base, {
          guidanceAnchors: /** @type {any} */ ([anchor]),
        }),
      );
    }
  });

  it("snapshots protected source and nested proxy inputs before validation", () => {
    const dynamicSource = {
      bounds: { x: 0, y: 0, width: 512, height: 256 },
    };
    Object.defineProperty(dynamicSource, "layerStableId", {
      enumerable: true,
      get() {
        return "ps_layer_dynamic_01";
      },
    });
    assert.throws(
      () => planProxyExport(dynamicSource),
      /data-only|stable metadata/,
    );

    const dynamicBounds = { x: 0, y: 0, height: 256 };
    Object.defineProperty(dynamicBounds, "width", {
      enumerable: true,
      get() {
        return 512;
      },
    });
    assert.throws(
      () =>
        planProxyExport(
          { layerStableId: "ps_layer_stable_source_01", bounds: dynamicBounds },
          {},
        ),
      /data-only|stable metadata/,
    );

    const dynamicInput = {};
    Object.defineProperty(dynamicInput, "seed", {
      enumerable: true,
      get() {
        return 42;
      },
    });
    assert.throws(
      () => planProxyExport(base, dynamicInput),
      /data-only|stable metadata/,
    );

    const anchor = { id: "a1", radius: 0.2 };
    Object.defineProperty(anchor, "point", {
      enumerable: true,
      get() {
        return { x: 0.5, y: 0.5 };
      },
    });
    assert.throws(
      () => planProxyExport(base, { guidanceAnchors: [anchor] }),
      /data-only|stable metadata/,
    );
  });
});
