import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  GlowHostError,
  createPhotoshopGlowHost,
} from "../src/host/photoshop-glow-host.mjs";
import { planGlowEffect } from "../src/effects/glow-plan.mjs";

const constants = Object.freeze({
  DocumentMode: Object.freeze({ RGB: "RGBColorMode", CMYK: "CMYKColorMode" }),
  BitsPerChannelType: Object.freeze({ EIGHT: "eight", SIXTEEN: "sixteen", THIRTYTWO: "thirtyTwo" }),
  LayerKind: Object.freeze({ NORMAL: "pixel", SMARTOBJECT: "smartObject", GROUP: "group" }),
  ElementPlacement: Object.freeze({ PLACEBEFORE: "placeBefore", PLACEINSIDE: "placeInside" }),
  BlendMode: Object.freeze({ SCREEN: "screen", NORMAL: "normal" }),
});

function planFor(context) {
  return planGlowEffect(context, {
    recipeId: "soft_glow",
    color: "#FFA020",
    intensity: 65,
    size: 28,
    blur: 12,
    blendMode: "screen",
  });
}

describe("createPhotoshopGlowHost", () => {
  it("loads Photoshop lazily and returns frozen data-only active context", () => {
    const fake = createFakePhotoshop();
    let loads = 0;
    const defaultRuntimeHost = createPhotoshopGlowHost();
    assert.equal(typeof defaultRuntimeHost.inspectSelectedLayer, "function");
    const host = createPhotoshopGlowHost({
      loadPhotoshop: () => {
        loads += 1;
        return fake.photoshop;
      },
    });

    assert.equal(loads, 0);
    const context = host.inspectActiveContext();
    assert.equal(loads, 1);
    assert.deepEqual(context, {
      documentId: 7,
      sourceLayerId: 11,
      documentMode: "rgb",
      bitsPerChannel: 8,
      layerKind: "pixel",
      visible: true,
      bounds: { x: 10, y: 20, width: 100, height: 200 },
      sourceSnapshot: { documentId: 7, sourceLayerId: 11 },
    });
    assert.equal(Object.isFrozen(context), true);
    assert.equal(Object.isFrozen(context.bounds), true);
    assert.equal("duplicate" in context, false);
    host.inspectActiveContext();
    assert.equal(loads, 1);
  });

  it("strictly rejects absent, ambiguous, invisible, or unsupported selections", () => {
    const cases = [
      ["no_active_document", (f) => { f.photoshop.app.activeDocument = null; }],
      ["no_active_layer", (f) => { f.document.activeLayers = []; }],
      ["multiple_active_layers", (f) => { f.document.activeLayers = [f.source, f.source]; }],
      ["unsupported_document_mode", (f) => { f.document.mode = constants.DocumentMode.CMYK; }],
      ["unsupported_bit_depth", (f) => { f.document.bitsPerChannel = constants.BitsPerChannelType.THIRTYTWO; }],
      ["source_not_visible", (f) => { f.source.visible = false; }],
      ["unsupported_layer_kind", (f) => { f.source.kind = constants.LayerKind.GROUP; }],
    ];

    for (const [code, mutate] of cases) {
      const fake = createFakePhotoshop();
      mutate(fake);
      const host = createPhotoshopGlowHost({ loadPhotoshop: () => fake.photoshop });
      assert.throws(
        () => host.inspectActiveContext(),
        (error) => error instanceof GlowHostError && error.code === code,
        code,
      );
    }
  });

  it("creates an above-source group with edge and bloom derivatives and commits once", async () => {
    const fake = createFakePhotoshop();
    const host = createPhotoshopGlowHost({ loadPhotoshop: () => fake.photoshop });
    const context = host.inspectActiveContext();
    const result = await host.applyGlow(planFor(context));

    assert.equal(result.committed, true);
    assert.deepEqual(fake.modalOptions, {
      commandName: "CineVFX 发光",
      timeOut: 5000,
    });
    assert.deepEqual(fake.historyCalls, [
      ["suspend", { documentID: 7, name: "CineVFX 发光" }],
      ["resume", fake.suspension, true],
    ]);
    assert.equal(fake.document.layers.length, 2);
    const [group, source] = fake.document.layers;
    assert.equal(source, fake.source);
    assert.equal(group.name, "CineVFX 发光");
    assert.equal(group.layers.length, 2);
    assert.equal(fake.source.duplicateCalls.length, 2);
    assert.ok(fake.source.duplicateCalls.every((call) => call[0] === group));
    assert.ok(fake.source.duplicateCalls.every((call) => call[1] === "placeInside"));

    const edge = group.layers.find((layer) => layer.id === result.edgeLayerId);
    const bloom = group.layers.find((layer) => layer.id === result.bloomLayerId);
    assert.equal(edge.fillOpacity, 0);
    assert.equal(edge.allLocked, false);
    assert.equal(bloom.gaussianBlurRadius, 12);
    assert.equal(bloom.blendMode, constants.BlendMode.SCREEN);
    assert.equal(bloom.opacity, 42);
    assert.equal(fake.batchCalls.length, 2);
    assert.equal(fake.batchCalls[0][0][0].to.outerGlow._obj, "outerGlow");
    assert.equal(fake.batchCalls[0][0][0].to.outerGlow.color.grain, 160);
    assert.deepEqual(fake.batchCalls[0][0][0].to.outerGlow.chokeMatte, {
      _unit: "pixelsUnit",
      _value: 0,
    });
    assert.deepEqual(fake.batchCalls[0][0][0].to.outerGlow.inputRange, {
      _unit: "percentUnit",
      _value: 50,
    });
    assert.equal("spread" in fake.batchCalls[0][0][0].to.outerGlow, false);
    assert.equal("range" in fake.batchCalls[0][0][0].to.outerGlow, false);
    assert.equal(fake.batchCalls[1][0][0].to.solidFill._obj, "solidFill");
    assert.deepEqual(fake.batchCalls[0][1], {
      continueOnError: false,
      immediateRedraw: false,
    });
    assert.equal("digest" in result, false);
    assert.equal("sha256" in result, false);
    assert.equal("sourceIdentity" in result, false);
    assertSourcePristine(fake.source);
  });

  it("hashes source pixels through a fake Imaging API and disposes imageData", async () => {
    const fake = createFakePhotoshop({ imaging: true });
    const host = createPhotoshopGlowHost({ loadPhotoshop: () => fake.photoshop });
    const context = host.inspectActiveContext();
    const result = await host.applyGlow(planFor(context));

    assert.equal(result.committed, true);
    assert.equal(fake.imaging.calls.length, 2);
    assert.ok(fake.imaging.calls.every((call) => (
      call.documentID === 7 && call.layerID === 11
    )));
    assert.equal(fake.imaging.created, 2);
    assert.equal(fake.imaging.disposed, 2);
    assert.equal(fake.imaging.disposed, fake.imaging.created);
    assert.equal("digest" in result, false);
    assert.equal("sha256" in result, false);
    assertSourcePristine(fake.source);
  });

  it("disposes imageData when Imaging getData fails and leaves pixels unverified", async () => {
    const fake = createFakePhotoshop({
      imaging: { failGetData: true },
    });
    const host = createPhotoshopGlowHost({ loadPhotoshop: () => fake.photoshop });
    const context = host.inspectActiveContext();
    const result = await host.applyGlow(planFor(context));

    assert.equal(result.committed, true);
    assert.equal(fake.imaging.created, 2);
    assert.equal(fake.imaging.disposed, 2);
    assert.equal("digest" in result, false);
    assert.equal("sha256" in result, false);
    assertSourcePristine(fake.source);
  });

  it("rejects a source pixel digest mismatch after the write", async () => {
    const fake = createFakePhotoshop({
      imaging: { mutateAfterFirstRead: true },
    });
    const host = createPhotoshopGlowHost({ loadPhotoshop: () => fake.photoshop });
    const context = host.inspectActiveContext();

    await assert.rejects(
      () => host.applyGlow(planFor(context)),
      (error) =>
        error instanceof GlowHostError &&
        error.code === "source_changed" &&
        error.stage === "verify",
    );
    assert.equal(fake.imaging.created, 2);
    assert.equal(fake.imaging.disposed, 2);
    assert.deepEqual(fake.historyCalls.at(-1), ["resume", fake.suspension, false]);
    assertSourcePristine(fake.source);
  });

  it("rejects parent, bounds, visibility, opacity, blend, and lock races", async () => {
    const cases = [
      ["parent", (source) => {
        source.parent = { id: 99 };
      }, "source_changed"],
      ["bounds", (source) => {
        source.boundsNoEffects = { left: 11, top: 20, right: 110, bottom: 220 };
      }, "source_changed"],
      ["visibility", (source) => {
        source.visible = false;
      }, "source_not_visible"],
      ["opacity", (source) => {
        source.opacity = 90;
      }, "source_changed"],
      ["blend", (source) => {
        source.blendMode = "multiply";
      }, "source_changed"],
      ["locks", (source) => {
        source.pixelsLocked = false;
      }, "source_changed"],
    ];

    for (const [label, mutate, code] of cases) {
      const fake = createFakePhotoshop();
      const host = createPhotoshopGlowHost({ loadPhotoshop: () => fake.photoshop });
      const context = host.inspectActiveContext();
      mutate(fake.source);

      await assert.rejects(
        () => host.applyGlow(planFor(context)),
        (error) =>
          error instanceof GlowHostError &&
          error.code === code &&
          error.stage === "revalidate",
        label,
      );
      assert.deepEqual(fake.historyCalls, [], label);
      assert.equal(fake.document.createGroupCalls, 0, label);
      assert.equal(fake.source.duplicateCalls.length, 0, label);
    }
  });

  it("rejects source identity changes discovered after the write", async () => {
    const cases = [
      ["parent", (source) => {
        source.parent = { id: 99 };
      }],
      ["bounds", (source) => {
        source.boundsNoEffects = { left: 11, top: 20, right: 110, bottom: 220 };
      }],
      ["visibility", (source) => {
        source.visible = false;
      }],
      ["opacity", (source) => {
        source.opacity = 90;
      }],
      ["blend", (source) => {
        source.blendMode = "multiply";
      }],
      ["locks", (source) => {
        source.allLocked = false;
      }],
    ];

    for (const [label, mutate] of cases) {
      const fake = createFakePhotoshop({
        afterCreateGroup(source) {
          mutate(source);
        },
      });
      const host = createPhotoshopGlowHost({ loadPhotoshop: () => fake.photoshop });
      const context = host.inspectActiveContext();

      await assert.rejects(
        () => host.applyGlow(planFor(context)),
        (error) =>
          error instanceof GlowHostError &&
          error.code === "source_changed" &&
          error.stage === "verify",
        label,
      );
      assert.deepEqual(fake.historyCalls.at(-1), ["resume", fake.suspension, false], label);
    }
  });

  it("rejects selection races before history suspension or any write", async () => {
    const fake = createFakePhotoshop();
    const host = createPhotoshopGlowHost({ loadPhotoshop: () => fake.photoshop });
    const context = host.inspectActiveContext();
    fake.document.activeLayers = [makeLayer(fake.document, 12, "Other")];

    await assert.rejects(
      () => host.applyGlow(planFor(context)),
      (error) =>
        error instanceof GlowHostError &&
        error.code === "selection_changed" &&
        error.stage === "revalidate",
    );
    assert.deepEqual(fake.historyCalls, []);
    assert.equal(fake.document.createGroupCalls, 0);
    assert.equal(fake.source.duplicateCalls.length, 0);
    assert.equal(fake.batchCalls.length, 0);
    assertSourcePristine(fake.source);
  });

  it("rejects bit-depth changes before history suspension or any write", async () => {
    const fake = createFakePhotoshop();
    const host = createPhotoshopGlowHost({ loadPhotoshop: () => fake.photoshop });
    const context = host.inspectActiveContext();
    fake.document.bitsPerChannel = constants.BitsPerChannelType.SIXTEEN;

    await assert.rejects(
      () => host.applyGlow(planFor(context)),
      (error) =>
        error instanceof GlowHostError &&
        error.code === "selection_changed" &&
        error.stage === "revalidate",
    );
    assert.deepEqual(fake.historyCalls, []);
    assert.equal(fake.document.createGroupCalls, 0);
    assert.equal(fake.source.duplicateCalls.length, 0);
    assert.equal(fake.batchCalls.length, 0);
    assertSourcePristine(fake.source);
  });

  it("rolls back the whole history state on a batchPlay error without exposing host text", async () => {
    const secret = "/Users/private/image.psd host localized failure";
    const fake = createFakePhotoshop({
      batchResults: [[{ _obj: "error", result: -25922, message: secret }]],
    });
    const host = createPhotoshopGlowHost({ loadPhotoshop: () => fake.photoshop });
    const context = host.inspectActiveContext();

    let failure;
    try {
      await host.applyGlow(planFor(context));
    } catch (error) {
      failure = error;
    }
    assert.ok(failure instanceof GlowHostError);
    assert.equal(failure.code, "batchplay_failed");
    assert.equal(failure.stage, "edge_effect");
    assert.equal(failure.message.includes(secret), false);
    assert.deepEqual(fake.historyCalls, [
      ["suspend", { documentID: 7, name: "CineVFX 发光" }],
      ["resume", fake.suspension, false],
    ]);
    assert.deepEqual(fake.document.layers, [fake.source]);
    assertSourcePristine(fake.source);
  });

  it("rolls back when cancellation is observed after a host write", async () => {
    const fake = createFakePhotoshop({ cancelAfterCreateGroup: true });
    const host = createPhotoshopGlowHost({ loadPhotoshop: () => fake.photoshop });
    const context = host.inspectActiveContext();

    await assert.rejects(
      () => host.applyGlow(planFor(context)),
      (error) => error instanceof GlowHostError && error.code === "user_cancelled",
    );
    assert.deepEqual(fake.historyCalls.at(-1), ["resume", fake.suspension, false]);
    assert.deepEqual(fake.document.layers, [fake.source]);
    assertSourcePristine(fake.source);
  });

  it("fails closed on history sentinel before document writes", async () => {
    const fake = createFakePhotoshop({ suspension: 0xffffffff });
    const host = createPhotoshopGlowHost({ loadPhotoshop: () => fake.photoshop });
    const context = host.inspectActiveContext();

    await assert.rejects(
      () => host.applyGlow(planFor(context)),
      (error) =>
        error instanceof GlowHostError &&
        error.code === "history_owned_externally",
    );
    assert.equal(fake.document.createGroupCalls, 0);
    assert.equal(fake.source.duplicateCalls.length, 0);
  });

  it("maps unavailable or malformed host modules to fixed errors", async () => {
    for (const loadPhotoshop of [
      () => { throw new Error("private module error"); },
      () => ({}),
    ]) {
      const host = createPhotoshopGlowHost({ loadPhotoshop });
      assert.throws(
        () => host.inspectActiveContext(),
        (error) =>
          error instanceof GlowHostError &&
          error.code === "host_unavailable" &&
          !error.message.includes("private"),
      );
    }
  });
});

function createFakePhotoshop(options = {}) {
  let nextLayerId = 20;
  const historyCalls = [];
  const batchCalls = [];
  const suspension = options.suspension ?? { id: "history-1" };
  const document = {
    id: 7,
    mode: constants.DocumentMode.RGB,
    bitsPerChannel: constants.BitsPerChannelType.EIGHT,
    layers: [],
    activeLayers: [],
    createGroupCalls: 0,
    async createLayerGroup({ name }) {
      this.createGroupCalls += 1;
      const group = makeLayer(this, nextLayerId++, name, constants.LayerKind.GROUP);
      group.layers = [];
      group.move = async (relative, placement) => {
        assert.equal(placement, constants.ElementPlacement.PLACEBEFORE);
        removeLayer(this.layers, group);
        const location = findContainer(this.layers, relative);
        assert.ok(location);
        group.parent = location.parent;
        location.collection.splice(location.index, 0, group);
      };
      this.layers.unshift(group);
      if (options.cancelAfterCreateGroup) executionContext.isCancelled = true;
      if (typeof options.afterCreateGroup === "function") {
        options.afterCreateGroup(source);
      }
      return group;
    },
  };
  const source = makeLayer(document, 11, "Portrait");
  document.layers.push(source);
  document.activeLayers = [source];

  const executionContext = {
    isCancelled: false,
    hostControl: {
      async suspendHistory(details) {
        historyCalls.push(["suspend", details]);
        return suspension;
      },
      async resumeHistory(token, commit) {
        historyCalls.push(["resume", token, commit]);
        if (!commit) {
          document.layers = [source];
          source.parent = null;
          document.activeLayers = [source];
        }
      },
    },
  };
  let modalOptions;
  let batchIndex = 0;
  const imaging = options.imaging
    ? createFakeImaging(options.imaging === true ? {} : options.imaging)
    : null;
  const photoshop = {
    app: { activeDocument: document },
    constants,
    core: {
      async executeAsModal(callback, passedOptions) {
        modalOptions = passedOptions;
        return callback(executionContext);
      },
    },
    action: {
      async batchPlay(descriptors, passedOptions) {
        batchCalls.push([descriptors, passedOptions]);
        const result = options.batchResults?.[batchIndex] ?? [{}];
        batchIndex += 1;
        return result;
      },
    },
  };
  if (imaging) photoshop.imaging = imaging.api;
  const fake = {
    photoshop,
    document,
    source,
    historyCalls,
    batchCalls,
    suspension,
    executionContext,
    imaging,
  };
  Object.defineProperty(fake, "modalOptions", { get: () => modalOptions });
  return fake;

  function makeDuplicate(owner, group, name) {
    const copy = makeLayer(document, nextLayerId++, name, owner.kind);
    copy.parent = group;
    group.layers.push(copy);
    return copy;
  }

  function makeLayer(doc, id, name, kind = constants.LayerKind.NORMAL) {
    const layer = {
      id,
      document: doc,
      parent: null,
      name,
      kind,
      visible: true,
      opacity: 100,
      fillOpacity: 100,
      blendMode: constants.BlendMode.NORMAL,
      allLocked: id === 11,
      pixelsLocked: id === 11,
      positionLocked: id === 11,
      transparentPixelsLocked: id === 11,
      isBackgroundLayer: id === 11,
      boundsNoEffects: { left: 10, top: 20, right: 110, bottom: 220 },
      duplicateCalls: [],
      async duplicate(relative, placement, duplicateName) {
        this.duplicateCalls.push([relative, placement, duplicateName]);
        assert.equal(placement, constants.ElementPlacement.PLACEINSIDE);
        return makeDuplicate(this, relative, duplicateName);
      },
      async applyGaussianBlur(radius) {
        this.gaussianBlurRadius = radius;
      },
    };
    return layer;
  }
}

function makeLayer(document, id, name) {
  return {
    id,
    document,
    parent: null,
    name,
    kind: constants.LayerKind.NORMAL,
    visible: true,
    opacity: 100,
    fillOpacity: 100,
    blendMode: constants.BlendMode.NORMAL,
    allLocked: false,
    pixelsLocked: false,
    positionLocked: false,
    transparentPixelsLocked: false,
    boundsNoEffects: { left: 0, top: 0, right: 10, bottom: 10 },
  };
}

function findContainer(collection, target, parent = null) {
  const index = collection.indexOf(target);
  if (index >= 0) return { collection, index, parent };
  for (const layer of collection) {
    if (Array.isArray(layer.layers)) {
      const nested = findContainer(layer.layers, target, layer);
      if (nested) return nested;
    }
  }
  return null;
}

function removeLayer(collection, target) {
  const found = findContainer(collection, target);
  if (found) found.collection.splice(found.index, 1);
}

function createFakeImaging(options = {}) {
  const calls = [];
  let created = 0;
  let disposed = 0;
  let reads = 0;
  let pixels = new Uint8Array([10, 20, 30, 255, 40, 50, 60, 255]);

  return {
    api: {
      async getPixels(request) {
        calls.push(request);
        created += 1;
        reads += 1;
        if (options.mutateAfterFirstRead && reads > 1) {
          pixels = new Uint8Array([11, 20, 30, 255, 40, 50, 60, 255]);
        }
        const snapshot = new Uint8Array(pixels);
        let disposedOnce = false;
        return {
          imageData: {
            async getData() {
              if (options.failGetData) {
                throw new Error("private imaging buffer path /Users/secret.psd");
              }
              return snapshot;
            },
            async dispose() {
              if (disposedOnce) return;
              disposedOnce = true;
              disposed += 1;
            },
          },
        };
      },
    },
    get calls() {
      return calls;
    },
    get created() {
      return created;
    },
    get disposed() {
      return disposed;
    },
  };
}

function assertSourcePristine(source) {
  assert.equal(source.id, 11);
  assert.equal(source.name, "Portrait");
  assert.equal(source.parent, null);
  assert.equal(source.visible, true);
  assert.equal(source.opacity, 100);
  assert.equal(source.fillOpacity, 100);
  assert.equal(source.blendMode, constants.BlendMode.NORMAL);
  assert.equal(source.allLocked, true);
  assert.equal(source.pixelsLocked, true);
  assert.equal(source.positionLocked, true);
  assert.equal(source.transparentPixelsLocked, true);
  assert.deepEqual(source.boundsNoEffects, {
    left: 10,
    top: 20,
    right: 110,
    bottom: 220,
  });
}
