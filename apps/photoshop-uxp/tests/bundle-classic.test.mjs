import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createContext, Script } from "node:vm";
import { bundleClassicEntry } from "../scripts/bundle-classic.mjs";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

test("classic UXP bundle parses and initializes the panel entry", async () => {
  const bundle = await bundleClassicEntry({ rootDir: packageRoot });
  const listeners = new Map();
  const elements = new Map();
  let inspectCalls = 0;
  let modalCalls = 0;
  let batchPlayCalls = 0;
  let networkCalls = 0;
  for (const id of [
    "task-state-badge",
    "progress-bar",
    "progress-stage",
    "progress-ratio",
    "status-log",
    "btn-plan-proxy",
    "btn-submit",
    "btn-cancel",
    "btn-import",
    "btn-refresh-layer",
    "btn-create-glow",
    "base-url",
    "effect-label",
    "glow-color",
    "glow-intensity",
    "glow-intensity-value",
    "glow-spread",
    "glow-spread-value",
    "glow-blur-radius",
    "glow-blur-radius-value",
    "local-layer-status",
    "local-layer-meta",
    "local-glow-status",
  ]) {
    const values = {
      "base-url": "http://127.0.0.1:8787",
      "effect-label": "effect",
      "glow-color": "#FFD36A",
      "glow-intensity": "70",
      "glow-spread": "36",
      "glow-blur-radius": "18",
    };
    elements.set(id, {
      id,
      value: values[id] ?? "",
      textContent: "",
      className: "",
      disabled: false,
      style: {},
      addEventListener(type, handler) {
        listeners.set(`${id}:${type}`, handler);
      },
    });
  }
  const document = {
    id: 7,
    mode: "rgb",
    bitsPerChannel: 8,
    activeLayers: [],
  };
  const source = {
    id: 11,
    document,
    parent: null,
    name: "fixture",
    kind: "pixel",
    visible: true,
    opacity: 100,
    fillOpacity: 100,
    allLocked: false,
    pixelsLocked: false,
    positionLocked: false,
    transparentPixelsLocked: false,
    boundsNoEffects: { left: 0, top: 0, right: 640, bottom: 480 },
  };
  document.activeLayers = [source];
  const photoshop = {
    app: {
      get activeDocument() {
        inspectCalls += 1;
        return document;
      },
    },
    core: {
      async executeAsModal() {
        modalCalls += 1;
        throw new Error("initialization must not enter a modal scope");
      },
    },
    action: {
      async batchPlay() {
        batchPlayCalls += 1;
        throw new Error("initialization must not call batchPlay");
      },
    },
    constants: {
      DocumentMode: { RGB: "rgb" },
      BitsPerChannelType: { EIGHT: 8, SIXTEEN: 16 },
      LayerKind: { NORMAL: "pixel", SMARTOBJECT: "smartObject" },
    },
  };
  const context = createContext({
    AbortController,
    Date,
    Error,
    Headers,
    JSON,
    Math,
    Promise,
    Set,
    String,
    TextEncoder,
    URL,
    clearTimeout,
    console,
    document: { getElementById: (id) => elements.get(id) ?? null },
    fetch: async () => {
      networkCalls += 1;
      throw new Error("network must not run during initialization");
    },
    require(specifier) {
      if (specifier === "photoshop") return photoshop;
      throw new Error(`unexpected UXP require: ${String(specifier)}`);
    },
    setTimeout,
  });
  new Script(bundle, { filename: "cinevfx-uxp-bundle.js" }).runInContext(context);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(typeof context.cinevfxShell, "object");
  assert.equal(typeof context.cinevfxShell.localGlow, "object");
  assert.equal(context.cinevfxShell.task.getSnapshot().state, "idle");
  assert.equal(elements.get("local-layer-status").textContent, "像素图层 · RGB 8 位");
  assert.equal(elements.get("local-layer-meta").textContent.includes("fixture"), false);
  for (const id of [
    "btn-plan-proxy",
    "btn-submit",
    "btn-cancel",
    "btn-import",
    "btn-refresh-layer",
    "btn-create-glow",
  ]) {
    assert.equal(typeof listeners.get(`${id}:click`), "function");
  }
  for (const id of ["glow-intensity", "glow-spread", "glow-blur-radius"]) {
    assert.equal(typeof listeners.get(`${id}:input`), "function");
  }
  assert.equal(inspectCalls, 1);
  assert.equal(modalCalls, 0);
  assert.equal(batchPlayCalls, 0);
  assert.equal(networkCalls, 0);
});
