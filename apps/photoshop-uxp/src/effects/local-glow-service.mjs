/** Local orchestration for inspect -> plan -> bounded Photoshop write. */

import { cloneDataOnlyGraph } from "../safety/data-snapshot.mjs";
import { planGlowEffect } from "./glow-plan.mjs";

/**
 * @param {{
 *   host: {
 *     inspectActiveContext: () => unknown | Promise<unknown>,
 *     applyGlow: (plan: unknown) => unknown | Promise<unknown>,
 *   },
 *   writeGuard: {
 *     runInsideWrites: <T>(fn: () => T | Promise<T>) => Promise<T>,
 *   },
 * }} dependencies
 */
export function createLocalGlowService(dependencies) {
  if (!dependencies || typeof dependencies !== "object") {
    throw new Error("local glow service dependencies are required");
  }
  const { host, writeGuard } = dependencies;
  if (!host || typeof host.inspectActiveContext !== "function") {
    throw new Error("host.inspectActiveContext is required");
  }
  if (typeof host.applyGlow !== "function") {
    throw new Error("host.applyGlow is required");
  }
  if (!writeGuard || typeof writeGuard.runInsideWrites !== "function") {
    throw new Error("writeGuard.runInsideWrites is required");
  }

  let applyActive = false;

  async function inspect() {
    const stableContext = await inspectContext();
    const validationPlan = planGlowEffect(stableContext, {
      recipeId: "soft_glow",
      color: "#FFD36A",
      intensity: 70,
      size: 36,
      blur: 18,
      blendMode: "screen",
    });
    return validationPlan.source;
  }

  async function apply(settings) {
    if (applyActive) throw busyError();
    applyActive = true;
    try {
      const stableSettings = deepFreeze(
        snapshotHostValue(settings, "glow settings"),
      );
      const stableContext = await inspectContext();
      const plan = planGlowEffect(stableContext, stableSettings);
      const rawHostResult = await writeGuard.runInsideWrites(() =>
        host.applyGlow(plan),
      );
      const hostResult =
        rawHostResult === undefined
          ? null
          : deepFreeze(snapshotHostValue(rawHostResult, "host result"));
      return deepFreeze({ plan, hostResult });
    } finally {
      applyActive = false;
    }
  }

  return Object.freeze({ inspect, apply });

  async function inspectContext() {
    const inspected = await host.inspectActiveContext();
    return deepFreeze(snapshotHostValue(inspected, "active layer context"));
  }
}

function busyError() {
  const error = new Error("a local glow apply is already active");
  Object.defineProperty(error, "code", {
    value: "LOCAL_GLOW_BUSY",
    enumerable: true,
  });
  return error;
}

/** @param {unknown} value @param {string} label */
function snapshotHostValue(value, label) {
  try {
    return cloneDataOnlyGraph(value);
  } catch (error) {
    throw new Error(
      `${label} must be stable data-only metadata: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

/** @template T @param {T} value @returns {T} */
function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const key of Object.keys(value)) {
    deepFreeze(/** @type {Record<string, unknown>} */ (value)[key]);
  }
  return Object.freeze(value);
}
