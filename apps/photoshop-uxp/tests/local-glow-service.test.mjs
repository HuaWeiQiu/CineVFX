import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createLocalGlowService } from "../src/effects/local-glow-service.mjs";
import { createWriteScopeGuard } from "../src/safety/network-boundary.mjs";

function hostContext(overrides = {}) {
  return {
    documentId: 7,
    sourceLayerId: 11,
    documentMode: "rgb",
    bitsPerChannel: 8,
    layerKind: "pixel",
    visible: true,
    bounds: { x: 10, y: 20, width: 100, height: 200 },
    sourceSnapshot: { documentId: 7, sourceLayerId: 11 },
    ...overrides,
  };
}

function settings(overrides = {}) {
  return {
    color: "#FFA020",
    intensity: 70,
    size: 28,
    blur: 12,
    blendMode: "screen",
    ...overrides,
  };
}

describe("createLocalGlowService", () => {
  it("inspects via the actual standard host contract", async () => {
    let inspectCalls = 0;
    const service = createLocalGlowService({
      host: {
        inspectActiveContext() {
          inspectCalls += 1;
          return hostContext();
        },
        applyGlow() {
          throw new Error("not called");
        },
      },
      writeGuard: createWriteScopeGuard(),
    });
    const context = await service.inspect();
    assert.equal(inspectCalls, 1);
    assert.equal(context.documentId, 7);
    assert.equal(context.sourceLayerId, 11);
    assert.equal(context.documentMode, "rgb");
    assert.equal(context.layerKind, "pixel");
    assert.equal(context.sourceSnapshot.documentId, 7);
    assert.equal(context.sourceSnapshot.sourceLayerId, 11);
    assert.equal(Object.isFrozen(context), true);
    assert.equal(Object.isFrozen(context.bounds), true);
  });

  it("passes a frozen plan to the Photoshop host inside write scope", async () => {
    const guard = createWriteScopeGuard();
    let received;
    const service = createLocalGlowService({
      host: {
        inspectActiveContext: () => hostContext(),
        applyGlow(plan) {
          assert.equal(guard.getScope(), "inside_modal");
          assert.throws(() => guard.assertNetworkAllowed(), /forbidden/);
          received = plan;
          return {
            committed: true,
            documentId: 7,
            sourceLayerId: 11,
            groupLayerId: 20,
            edgeLayerId: 21,
            bloomLayerId: 22,
          };
        },
      },
      writeGuard: guard,
    });

    const result = await service.apply(settings());
    assert.equal(guard.getScope(), "outside");
    assert.equal(received.kind, "local_glow_plan");
    assert.equal(received.source.sourceSnapshot.documentId, 7);
    assert.equal(received.source.sourceSnapshot.sourceLayerId, 11);
    assert.deepEqual(received.settings.rgb, { red: 255, green: 160, blue: 32 });
    assert.equal(received.settings.outerOpacity, 70);
    assert.equal(received.settings.bloomOpacity, 46);
    assert.equal(Object.isFrozen(received), true);
    assert.equal(Object.isFrozen(received.source.bounds), true);
    assert.equal(result.plan.source.sourceSnapshot.sourceLayerId, 11);
    assert.equal(result.hostResult.committed, true);
    assert.equal(Object.isFrozen(result), true);
    assert.equal(Object.isFrozen(result.hostResult), true);
  });

  it("snapshots settings before awaiting host inspection", async () => {
    let releaseInspect;
    const heldInspect = new Promise((resolve) => {
      releaseInspect = () => resolve(hostContext());
    });
    let received;
    const service = createLocalGlowService({
      host: {
        inspectActiveContext: () => heldInspect,
        applyGlow(plan) {
          received = plan;
          return { committed: true };
        },
      },
      writeGuard: createWriteScopeGuard(),
    });
    const callerSettings = settings({ intensity: 10 });

    const apply = service.apply(callerSettings);
    callerSettings.intensity = 99;
    callerSettings.extra = "late mutation";
    releaseInspect();
    await apply;

    assert.equal(received.settings.intensity, 10);
    assert.equal("extra" in received.settings, false);
  });

  it("fails before writes for malformed host context or invalid settings", async () => {
    for (const context of [
      { ...hostContext(), extra: true },
      hostContext({ documentMode: "cmyk" }),
      hostContext({ layerKind: "group" }),
    ]) {
      let applyCalls = 0;
      const service = createLocalGlowService({
        host: {
          inspectActiveContext: () => context,
          applyGlow() {
            applyCalls += 1;
          },
        },
        writeGuard: createWriteScopeGuard(),
      });
      await assert.rejects(() => service.apply(settings()));
      assert.equal(applyCalls, 0);
    }

    let applyCalls = 0;
    const service = createLocalGlowService({
      host: {
        inspectActiveContext: () => hostContext(),
        applyGlow() {
          applyCalls += 1;
        },
      },
      writeGuard: createWriteScopeGuard(),
    });
    await assert.rejects(
      () => service.apply(settings({ intensity: "70" })),
      /intensity/,
    );
    assert.equal(applyCalls, 0);
  });

  it("rejects concurrent apply calls with LOCAL_GLOW_BUSY and releases after failure", async () => {
    let release;
    const held = new Promise((resolve) => {
      release = resolve;
    });
    let attempts = 0;
    const service = createLocalGlowService({
      host: {
        inspectActiveContext: () => hostContext(),
        async applyGlow() {
          attempts += 1;
          if (attempts === 1) await held;
          if (attempts === 2) throw new Error("fixed host failure");
          return { committed: true };
        },
      },
      writeGuard: createWriteScopeGuard(),
    });

    const first = service.apply(settings());
    await assert.rejects(
      () => service.apply(settings()),
      (error) => error?.code === "LOCAL_GLOW_BUSY",
    );
    release();
    await first;

    await assert.rejects(() => service.apply(settings()), /fixed host failure/);
    const recovered = await service.apply(settings());
    assert.equal(recovered.hostResult.committed, true);
  });

  it("does not enter the host while a network phase is active", async () => {
    const guard = createWriteScopeGuard();
    let release;
    const held = new Promise((resolve) => {
      release = resolve;
    });
    const network = guard.runOutsideWrites(() => held);
    let applyCalls = 0;
    const service = createLocalGlowService({
      host: {
        inspectActiveContext: () => hostContext(),
        applyGlow() {
          applyCalls += 1;
        },
      },
      writeGuard: guard,
    });

    await assert.rejects(() => service.apply(settings()), /network wait is active/);
    assert.equal(applyCalls, 0);
    release();
    await network;
    await service.apply(settings());
    assert.equal(applyCalls, 1);
  });

  it("rejects network and nested modal planning during a real write callback", async () => {
    const guard = createWriteScopeGuard();
    await guard.runInsideWrites(async ({ assertNoNetwork }) => {
      assert.throws(() => assertNoNetwork(), /network waits are forbidden/);
      await assert.rejects(
        () => guard.runOutsideWrites(async () => true),
        /nested outside-write/,
      );
      await assert.rejects(
        () => guard.planModalTransaction(async () => true),
        /already active/,
      );
    });
    assert.equal(guard.getScope(), "outside");

    const planned = await guard.planModalTransaction(async () => "compatible");
    assert.deepEqual(planned, { planned: true, result: "compatible" });
  });

  it("rejects invalid dependencies synchronously", () => {
    assert.throws(() => createLocalGlowService(null), /dependencies/);
    assert.throws(
      () =>
        createLocalGlowService({
          host: { applyGlow() {} },
          writeGuard: createWriteScopeGuard(),
        }),
      /inspectActiveContext/,
    );
    assert.throws(
      () =>
        createLocalGlowService({
          host: { inspectActiveContext() {} },
          writeGuard: createWriteScopeGuard(),
        }),
      /applyGlow/,
    );
  });
});
