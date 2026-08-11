/**
 * Protected-source-safe import plan.
 * Real executeAsModal / history / placement is UNVERIFIED.
 * Guarantees planning invariants: one bounded transaction, rollback, no partial group.
 */

import { validateLayerManifest } from "../manifest/validate-manifest.mjs";
import { assertNetworkOutsideWrites } from "../safety/network-boundary.mjs";
import { cloneDataOnlyGraph } from "../safety/data-snapshot.mjs";
import {
  JOB_ID_RE,
  MANIFEST_ID_RE,
} from "../client/contract-shapes.mjs";

/**
 * @typedef {{
 *   layerStableId: string,
 *   documentStableId?: string,
 * }} ProtectedSourceRef
 */

/**
 * Build an import plan from a validated Layer Manifest.
 * Does not touch Photoshop DOM.
 *
 * @param {unknown} manifest
 * @param {ProtectedSourceRef} sessionProtectedSource
 * @param {{ expectedJobId?: string, expectedManifestId?: string }} [options]
 */
export function planManifestImport(manifest, sessionProtectedSource, options = {}) {
  let stableManifest;
  let stableSession;
  let stableOptions;
  try {
    stableManifest = cloneDataOnlyGraph(manifest);
    stableSession = cloneDataOnlyGraph(sessionProtectedSource);
    stableOptions = cloneDataOnlyGraph(options);
  } catch (error) {
    return {
      ok: false,
      errors: [
        {
          path: "#",
          message: `manifest must be stable JSON metadata: ${
            error instanceof Error ? error.message : String(error)
          }`,
        },
      ],
      plan: null,
    };
  }
  const session = /** @type {ProtectedSourceRef} */ (stableSession);
  const optionErrors = validateImportOptions(stableOptions);
  if (optionErrors.length > 0) {
    return { ok: false, errors: optionErrors, plan: null };
  }
  const expected = /** @type {Record<string, unknown>} */ (stableOptions);
  const hasExpectedJobId = Object.prototype.hasOwnProperty.call(
    expected,
    "expectedJobId",
  );
  const hasExpectedManifestId = Object.prototype.hasOwnProperty.call(
    expected,
    "expectedManifestId",
  );
  const validation = validateLayerManifest(stableManifest);
  if (!validation.valid) {
    return {
      ok: false,
      errors: validation.errors,
      plan: null,
    };
  }

  const m = /** @type {Record<string, unknown>} */ (stableManifest);
  const manifestProtected =
    /** @type {{ layerStableId: string, documentStableId?: string, immutable: true, untouched: true }} */ (
      m.protectedSource
    );

  /** @type {{ path: string, message: string }[]} */
  const errors = [];

  if (!session?.layerStableId) {
    errors.push({
      path: "#/session/protectedSource",
      message: "session protected source layerStableId is required",
    });
  } else if (
    session.layerStableId !== manifestProtected.layerStableId
  ) {
    errors.push({
      path: "#/protectedSource/layerStableId",
      message:
        "manifest protected source does not match the session protected layer",
    });
  }

  if (
    session?.documentStableId !==
    manifestProtected.documentStableId
  ) {
    errors.push({
      path: "#/protectedSource/documentStableId",
      message: "document stable id mismatch",
    });
  }

  if (hasExpectedJobId && expected.expectedJobId !== m.jobId) {
    errors.push({
      path: "#/jobId",
      message: "manifest jobId does not match expected job",
    });
  }

  if (
    hasExpectedManifestId &&
    expected.expectedManifestId !== m.manifestId
  ) {
    errors.push({
      path: "#/manifestId",
      message: "manifest manifestId does not match expected manifest",
    });
  }

  if (errors.length > 0) {
    return { ok: false, errors, plan: null };
  }

  const passes = /** @type {Array<Record<string, unknown>>} */ (m.passes);
  const groupName =
    typeof m.groupName === "string" && m.groupName.trim()
      ? m.groupName
      : "CineVFX Passes";

  const passSteps = [];
  for (let index = 0; index < passes.length; index += 1) {
    const pass = passes[index];
    passSteps.push({
      order: index,
      passId: pass.id,
      name: pass.name,
      kind: pass.kind,
      editable: true,
      visible: pass.visible,
      opacity: pass.opacity,
      blendMode: pass.blendMode,
      asset: pass.asset,
      mask: pass.mask ?? null,
      adjustments: pass.adjustments ?? null,
      /** Placeholder — real placement UNVERIFIED. */
      place: {
        mode: "raster_layer_in_group",
        aboveProtectedSource: true,
      },
    });
  }

  const plan = {
    kind: "manifest_import_plan",
    /** Real Photoshop execution remains UNVERIFIED. */
    execution: {
      status: "planned_only",
      verified: false,
      note: "UNVERIFIED: executeAsModal/history/undo, placement, and source preservation",
    },
    jobId: m.jobId,
    manifestId: m.manifestId,
    groupName,
    protectedSource: {
      layerStableId: manifestProtected.layerStableId,
      documentStableId: manifestProtected.documentStableId,
      immutable: true,
      untouched: true,
      operationsForbidden: [
        "modify_pixels",
        "move",
        "transform",
        "resize",
        "replace",
        "warp",
        "delete",
      ],
    },
    /**
     * One bounded transaction / single history state.
     * On any pass failure: rollback entire group; no partial result group.
     */
    transaction: {
      mode: "single_history_state",
      historyName: `CineVFX Import ${m.manifestId}`,
      bounded: true,
      maxPasses: passes.length,
      rollbackOnAnyFailure: true,
      noPartialGroup: true,
      suspendHistoryState: true,
    },
    phases: [
      {
        name: "validate",
        allowsNetwork: false,
        action: "validate_manifest_and_digests",
      },
      {
        name: "network_wait",
        allowsNetwork: true,
        action: "fetch_pass_bytes_if_needed",
        note: "must complete before modal write",
      },
      {
        name: "photoshop_write",
        allowsNetwork: false,
        action: "execute_as_modal_import",
        steps: [
          "assert_protected_source_untouched",
          "create_result_group",
          ...passSteps.map((s) => `place_pass:${s.passId}`),
          "commit_or_rollback",
        ],
      },
    ],
    passes: passSteps,
    rollback: {
      strategy: "delete_result_group_if_exists",
      leaveProtectedSourceUntouched: true,
      noPartialGroup: true,
    },
    importHints: {
      // Safe defaults always win over untrusted manifest hints.
      singleHistoryState: true,
      placeAboveProtectedSource: true,
      rollbackOnAnyFailure: true,
    },
  };

  assertNetworkOutsideWrites(plan);
  assertProtectedSourceSafety(plan);

  return { ok: true, errors: [], plan };
}

/**
 * @param {unknown} options
 * @returns {{ path: string, message: string }[]}
 */
function validateImportOptions(options) {
  const errors = [];
  if (!options || typeof options !== "object" || Array.isArray(options)) {
    return [{ path: "#/options", message: "options must be an object" }];
  }
  const record = /** @type {Record<string, unknown>} */ (options);
  for (const key of Object.keys(record)) {
    if (key !== "expectedJobId" && key !== "expectedManifestId") {
      errors.push({
        path: `#/options/${key}`,
        message: `unexpected option ${key}`,
      });
    }
  }
  if (Object.prototype.hasOwnProperty.call(record, "expectedJobId")) {
    if (
      typeof record.expectedJobId !== "string" ||
      !JOB_ID_RE.test(record.expectedJobId)
    ) {
      errors.push({
        path: "#/options/expectedJobId",
        message: "expectedJobId must match the frozen job id format",
      });
    }
  }
  if (Object.prototype.hasOwnProperty.call(record, "expectedManifestId")) {
    if (
      typeof record.expectedManifestId !== "string" ||
      !MANIFEST_ID_RE.test(record.expectedManifestId)
    ) {
      errors.push({
        path: "#/options/expectedManifestId",
        message: "expectedManifestId must match the frozen manifest id format",
      });
    }
  }
  return errors;
}

/**
 * Simulate applying an import plan with optional mid-pass failure.
 * Pure planning helper used by tests — does not call Photoshop.
 *
 * @param {ReturnType<typeof planManifestImport> extends { plan: infer P } ? P : never} plan
 * @param {{ failAtPassId?: string }} [options]
 */
export function simulateImportPlanExecution(plan, options = {}) {
  if (!plan || plan.kind !== "manifest_import_plan") {
    throw new Error("valid import plan required");
  }

  const created = {
    groupCreated: false,
    placedPassIds: /** @type {string[]} */ ([]),
    protectedSourceMutations: 0,
  };

  try {
    created.groupCreated = true;
    for (const pass of plan.passes) {
      if (options.failAtPassId && pass.passId === options.failAtPassId) {
        throw new Error(`simulated failure at pass ${pass.passId}`);
      }
      created.placedPassIds.push(/** @type {string} */ (pass.passId));
    }
    return {
      status: "committed",
      groupPresent: true,
      placedPassIds: [...created.placedPassIds],
      protectedSourceMutations: 0,
      rolledBack: false,
    };
  } catch (err) {
    // Rollback: remove partial group entirely.
    created.groupCreated = false;
    created.placedPassIds = [];
    return {
      status: "rolled_back",
      groupPresent: false,
      placedPassIds: [],
      protectedSourceMutations: 0,
      rolledBack: true,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * @param {{ protectedSource: { immutable: boolean, operationsForbidden: string[] }, transaction: { rollbackOnAnyFailure: boolean, noPartialGroup: boolean }, phases: unknown[] }} plan
 */
function assertProtectedSourceSafety(plan) {
  if (plan.protectedSource.immutable !== true) {
    throw new Error("import plan must mark protected source immutable");
  }
  if (!plan.transaction.rollbackOnAnyFailure || !plan.transaction.noPartialGroup) {
    throw new Error("import plan must roll back with no partial group");
  }
  const forbidden = new Set(plan.protectedSource.operationsForbidden);
  for (const op of [
    "modify_pixels",
    "move",
    "transform",
    "resize",
    "replace",
  ]) {
    if (!forbidden.has(op)) {
      throw new Error(`import plan missing forbidden op ${op}`);
    }
  }
}
