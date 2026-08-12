import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  planManifestImport,
  simulateImportPlanExecution,
} from "../src/import/import-plan.mjs";
import { createWriteScopeGuard } from "../src/safety/network-boundary.mjs";
import { createCinevfxClient } from "../src/client/http-client.mjs";
import { createMockFetch, validManifest } from "./fixtures.mjs";

describe("planManifestImport", () => {
  const session = {
    layerStableId: "ps_layer_stable_source_01",
    documentStableId: "ps_doc_stable_01",
  };

  it("builds a single-history protected-source-safe plan", () => {
    const { ok, plan, errors } = planManifestImport(validManifest(), session, {
      expectedJobId: "job_mock_0001",
      expectedManifestId: "manifest_mock_0001",
    });
    assert.equal(ok, true, JSON.stringify(errors));
    assert.equal(plan.transaction.mode, "single_history_state");
    assert.equal(plan.transaction.bounded, true);
    assert.equal(plan.transaction.rollbackOnAnyFailure, true);
    assert.equal(plan.transaction.noPartialGroup, true);
    assert.equal(plan.protectedSource.immutable, true);
    assert.equal(plan.execution.verified, false);
    assert.equal(plan.importHints.placeAboveProtectedSource, true);

    const writePhase = plan.phases.find((p) => p.name === "photoshop_write");
    assert.equal(writePhase.allowsNetwork, false);
    const netPhase = plan.phases.find((p) => p.name === "network_wait");
    assert.equal(netPhase.allowsNetwork, true);
    assert.equal(plan.passes.length, 2);
    assert.ok(plan.passes.every((p) => p.editable === true));
  });

  it("keeps placeAboveProtectedSource true even if manifest hint is false", () => {
    const manifest = validManifest();
    manifest.importHints = {
      singleHistoryState: true,
      placeAboveProtectedSource: false,
      rollbackOnAnyFailure: true,
    };
    const { ok, plan } = planManifestImport(manifest, session);
    assert.equal(ok, true);
    assert.equal(plan.importHints.placeAboveProtectedSource, true);
  });

  it("uses a stable manifest snapshot and rejects unvalidated pass assets", () => {
    const overridden = validManifest();
    overridden.passes[0].asset = {
      assetId: "asset_foreign_01",
      digest: overridden.passes[0].asset.digest,
    };
    overridden.passes.forEach = () => {};
    overridden.passes.map = () => overridden.passes;
    const foreignResult = planManifestImport(overridden, session);
    assert.equal(foreignResult.ok, false);
    assert.equal(foreignResult.plan, null);

    const dynamic = validManifest();
    const firstPass = dynamic.passes[0];
    Object.defineProperty(dynamic.passes, "0", {
      enumerable: true,
      get() {
        return firstPass;
      },
    });
    const dynamicResult = planManifestImport(dynamic, session);
    assert.equal(dynamicResult.ok, false);
    assert.equal(dynamicResult.plan, null);

    const sparse = validManifest();
    sparse.passes.length += 1;
    const sparseResult = planManifestImport(sparse, session);
    assert.equal(sparseResult.ok, false);
    assert.equal(sparseResult.plan, null);

    const dynamicOptions = {};
    Object.defineProperty(dynamicOptions, "expectedJobId", {
      enumerable: true,
      get() {
        return "job_mock_0001";
      },
    });
    const dynamicOptionsResult = planManifestImport(
      validManifest(),
      session,
      dynamicOptions,
    );
    assert.equal(dynamicOptionsResult.ok, false);
    assert.equal(dynamicOptionsResult.plan, null);
  });

  it("rejects protected source mismatch", () => {
    const { ok, errors } = planManifestImport(validManifest(), {
      layerStableId: "other_layer",
    });
    assert.equal(ok, false);
    assert.ok(errors.some((e) => e.message.includes("does not match")));
  });

  it("requires exact document and manifest identity, including optional presence", () => {
    const missingDocument = validManifest();
    delete missingDocument.protectedSource.documentStableId;
    assert.equal(planManifestImport(missingDocument, session).ok, false);

    const sessionWithoutDocument = { layerStableId: session.layerStableId };
    assert.equal(planManifestImport(validManifest(), sessionWithoutDocument).ok, false);

    const wrongManifest = planManifestImport(validManifest(), session, {
      expectedJobId: "job_mock_0001",
      expectedManifestId: "manifest_other_0001",
    });
    assert.equal(wrongManifest.ok, false);
    assert.ok(wrongManifest.errors.some((error) => error.path === "#/manifestId"));

    for (const options of [
      { expectedJobId: "" },
      { expectedManifestId: "" },
      { expectedJobId: null },
      null,
    ]) {
      const invalid = planManifestImport(
        validManifest(),
        session,
        /** @type {any} */ (options),
      );
      assert.equal(invalid.ok, false);
      assert.equal(invalid.plan, null);
    }
  });

  it("rolls back with no partial group on simulated failure", () => {
    const { plan } = planManifestImport(validManifest(), session);
    const committed = simulateImportPlanExecution(plan);
    assert.equal(committed.status, "committed");
    assert.equal(committed.groupPresent, true);
    assert.equal(committed.protectedSourceMutations, 0);

    const failed = simulateImportPlanExecution(plan, {
      failAtPassId: "pass_relight",
    });
    assert.equal(failed.status, "rolled_back");
    assert.equal(failed.groupPresent, false);
    assert.deepEqual(failed.placedPassIds, []);
    assert.equal(failed.protectedSourceMutations, 0);
    assert.equal(failed.rolledBack, true);
  });

  it("forbids network inside modal write plan scope via assertNetworkAllowed", async () => {
    const guard = createWriteScopeGuard();
    await assert.rejects(
      () =>
        guard.planModalTransaction(async () => {
          // Exercise the guard path used by the HTTP client hook.
          guard.assertNetworkAllowed();
          return true;
        }),
      /network waits are forbidden/,
    );

    await guard.runOutsideWrites(async () => {
      guard.assertNetworkAllowed();
    });
  });

  it("rejects client requests invoked inside planModalTransaction", async () => {
    const guard = createWriteScopeGuard();
    const client = createCinevfxClient({
      fetchImpl: createMockFetch({
        "GET /v1/jobs/job_mock_0001": () => ({
          status: 200,
          body: { jobId: "job_mock_0001", state: "CREATED" },
        }),
      }),
      onBeforeNetwork: () => guard.assertNetworkAllowed(),
    });

    await assert.rejects(
      () =>
        guard.planModalTransaction(async () => {
          await client.getJob("job_mock_0001");
          return true;
        }),
      /network waits are forbidden/,
    );
  });

  it("rejects modal entry while a network wait is still active", async () => {
    const guard = createWriteScopeGuard();
    let release;
    const hold = new Promise((resolve) => {
      release = resolve;
    });

    const networkPromise = guard.runOutsideWrites(async () => {
      await hold;
      return "done";
    });

    // While network is outstanding, modal planning must fail.
    await assert.rejects(
      () => guard.planModalTransaction(async () => true),
      /network wait is active/,
    );

    release();
    await networkPromise;

    // After network settles, modal planning is allowed.
    const planned = await guard.planModalTransaction(async () => "ok");
    assert.equal(planned.result, "ok");
  });

  it("keeps runInsideWrites and planModalTransaction mutually exclusive", async () => {
    const guard = createWriteScopeGuard();
    await guard.runInsideWrites(async () => {
      assert.equal(guard.getScope(), "inside_modal");
      await assert.rejects(
        () => guard.planModalTransaction(async () => true),
        /already active/,
      );
    });
    assert.equal(guard.getScope(), "outside");
    const planned = await guard.planModalTransaction(async () => "ok");
    assert.equal(planned.result, "ok");
  });
});
