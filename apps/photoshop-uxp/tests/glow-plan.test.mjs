import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  GlowPlanError,
  planGlowEffect,
} from "../src/effects/glow-plan.mjs";

function validContext(overrides = {}) {
  return {
    documentId: 7,
    sourceLayerId: 11,
    documentMode: "rgb",
    bitsPerChannel: 8,
    layerKind: "pixel",
    visible: true,
    bounds: { x: 10, y: 20, width: 1000, height: 500 },
    sourceSnapshot: {
      documentId: 7,
      sourceLayerId: 11,
    },
    ...overrides,
  };
}

function validSettings(overrides = {}) {
  return {
    recipeId: "soft_glow",
    color: "#22d7Ff",
    intensity: 70,
    size: 36,
    blur: 18,
    blendMode: "screen",
    ...overrides,
  };
}

describe("planGlowEffect", () => {
  it("builds a deeply frozen non-destructive glow plan", () => {
    const plan = planGlowEffect(validContext(), validSettings());
    assert.equal(plan.kind, "local_glow_plan");
    assert.equal(plan.recipeId, "soft_glow");
    assert.deepEqual(plan.settings.rgb, { red: 34, green: 215, blue: 255 });
    assert.equal(plan.settings.color, "#22D7FF");
    assert.equal(plan.settings.outerOpacity, 70);
    assert.equal(plan.settings.bloomOpacity, 46);
    assert.deepEqual(plan.names, {
      group: "CineVFX 发光",
      edge: "发光边缘",
      bloom: "柔光扩散",
    });
    assert.equal(plan.source.immutable, true);
    assert.ok(plan.source.operationsForbidden.includes("modify_pixels"));
    assert.equal(plan.transaction.mode, "single_history_state");
    assert.equal(plan.transaction.rollbackOnAnyFailure, true);
    assert.equal(plan.transaction.allowsNetwork, false);
    assert.equal(plan.memory.pixelCount, 500_000);
    assert.equal(plan.memory.estimatedPeakBytes, 12_000_000);
    assert.equal(plan.memory.calculatedWith, "bigint");
    assert.equal(Object.isFrozen(plan), true);
    assert.equal(Object.isFrozen(plan.source.sourceSnapshot), true);
    assert.equal(Object.isFrozen(plan.settings.rgb), true);
    assert.throws(() => {
      plan.settings.rgb.red = 0;
    }, TypeError);
  });

  it("accepts both supported source kinds, bit depths, blend modes, and limits", () => {
    const lowSettings = validSettings({
      intensity: 0,
      size: 1,
      blur: 0.1,
      blendMode: "linearDodge",
    });
    delete lowSettings.recipeId;
    const low = planGlowEffect(
      validContext({ layerKind: "smartObject", bitsPerChannel: 16 }),
      lowSettings,
    );
    assert.equal(low.recipeId, "soft_glow");
    assert.equal(low.settings.bloomOpacity, 0);
    assert.equal(low.memory.bytesPerComponent, 2);

    const high = planGlowEffect(
      validContext(),
      validSettings({ intensity: 100, size: 250, blur: 250 }),
    );
    assert.equal(high.settings.outerOpacity, 100);
    assert.equal(high.settings.bloomOpacity, 65);
  });

  it("rejects unknown, missing, dynamic, custom-prototype, and non-data input", () => {
    assert.throws(
      () => planGlowEffect({ ...validContext(), extra: true }, validSettings()),
      /context\.extra is not allowed/,
    );
    assert.throws(
      () => planGlowEffect(validContext(), { ...validSettings(), extra: true }),
      /settings\.extra is not allowed/,
    );
    const missing = validContext();
    delete missing.sourceSnapshot;
    assert.throws(() => planGlowEffect(missing, validSettings()), /required/);
    const missingSetting = validSettings();
    delete missingSetting.color;
    assert.throws(
      () => planGlowEffect(validContext(), missingSetting),
      /settings\.color is required/,
    );

    const dynamic = validContext();
    Object.defineProperty(dynamic, "documentId", {
      enumerable: true,
      get() {
        throw new Error("must not execute");
      },
    });
    assert.throws(
      () => planGlowEffect(dynamic, validSettings()),
      /data-only|stable/,
    );
    assert.throws(
      () =>
        planGlowEffect(
          Object.assign(Object.create({ inherited: true }), validContext()),
          validSettings(),
        ),
      /custom prototype/,
    );
    assert.throws(
      () =>
        planGlowEffect(
          validContext({ sourceSnapshot: { callback() {} } }),
          validSettings(),
        ),
      /unsupported function/,
    );
    assert.throws(
      () =>
        planGlowEffect(
          validContext({
            sourceSnapshot: { documentId: 7, sourceLayerId: 11, extra: true },
          }),
          validSettings(),
        ),
      /sourceSnapshot\.extra is not allowed/,
    );
    assert.throws(
      () =>
        planGlowEffect(
          validContext({
            sourceSnapshot: { documentId: 7, sourceLayerId: 12 },
          }),
          validSettings(),
        ),
      /must match/,
    );
  });

  it("strictly validates context primitives and bounds without coercion", () => {
    for (const [field, value] of [
      ["documentId", 0],
      ["sourceLayerId", -1],
      ["documentId", 1.5],
      ["sourceLayerId", "11"],
      ["documentMode", "RGB"],
      ["bitsPerChannel", 32],
      ["layerKind", "group"],
      ["visible", 1],
    ]) {
      assert.throws(
        () => planGlowEffect(validContext({ [field]: value }), validSettings()),
        new RegExp(String(field)),
      );
    }
    for (const [field, value] of [
      ["x", Number.NaN],
      ["y", Number.POSITIVE_INFINITY],
      ["width", "100"],
      ["height", null],
      ["width", 0],
      ["height", -1],
    ]) {
      assert.throws(() =>
        planGlowEffect(
          validContext({
            bounds: { ...validContext().bounds, [field]: value },
          }),
          validSettings(),
        ),
      );
    }
    assert.throws(
      () =>
        planGlowEffect(
          validContext({ bounds: { ...validContext().bounds, top: 1 } }),
          validSettings(),
        ),
      /bounds\.top is not allowed/,
    );
  });

  it("strictly validates settings and never coerces numeric values", () => {
    for (const [field, value] of [
      ["recipeId", "magic"],
      ["color", "22D7FF"],
      ["color", "#GG0000"],
      ["intensity", -0.1],
      ["intensity", 101],
      ["intensity", "70"],
      ["size", 0],
      ["size", 251],
      ["blur", 0],
      ["blur", 251],
      ["blur", Number.NaN],
      ["blendMode", "overlay"],
    ]) {
      assert.throws(() =>
        planGlowEffect(validContext(), validSettings({ [field]: value })),
      );
    }
  });

  it("uses ceil dimensions with BigInt and enforces 100MP and 1GiB hard limits", () => {
    const fractional = planGlowEffect(
      validContext({ bounds: { x: 0, y: 0, width: 2.1, height: 3.1 } }),
      validSettings(),
    );
    assert.equal(fractional.memory.pixelWidth, 3);
    assert.equal(fractional.memory.pixelHeight, 4);
    assert.equal(fractional.memory.pixelCount, 12);

    assert.throws(
      () =>
        planGlowEffect(
          validContext({
            bounds: { x: 0, y: 0, width: 10_000, height: 10_000 },
          }),
          validSettings(),
        ),
      (error) =>
        error instanceof GlowPlanError &&
        error.code === "memory_limit_exceeded",
    );
    const belowLimits = planGlowEffect(
      validContext({ bounds: { x: 0, y: 0, width: 10_000, height: 4_000 } }),
      validSettings(),
    );
    assert.equal(belowLimits.memory.pixelCount, 40_000_000);
    assert.throws(
      () =>
        planGlowEffect(
          validContext({ bounds: { x: 0, y: 0, width: 10_001, height: 10_000 } }),
          validSettings(),
        ),
      (error) =>
        error instanceof GlowPlanError &&
        error.code === "memory_limit_exceeded",
    );

    assert.doesNotThrow(() =>
      planGlowEffect(
        validContext({
          bitsPerChannel: 16,
          bounds: { x: 0, y: 0, width: 4096, height: 5461 },
        }),
        validSettings(),
      ),
    );
    assert.throws(
      () =>
        planGlowEffect(
          validContext({
            bitsPerChannel: 16,
            bounds: { x: 0, y: 0, width: 4096, height: 5462 },
          }),
          validSettings(),
        ),
      (error) =>
        error instanceof GlowPlanError &&
        error.code === "memory_limit_exceeded",
    );
  });
});
