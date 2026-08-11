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
    "base-url",
    "effect-label",
  ]) {
    elements.set(id, {
      id,
      value: id === "base-url" ? "http://127.0.0.1:8787" : "effect",
      textContent: "",
      className: "",
      disabled: false,
      style: {},
      addEventListener(type, handler) {
        listeners.set(`${id}:${type}`, handler);
      },
    });
  }
  const context = createContext({
    AbortController,
    Date,
    Error,
    Headers,
    JSON,
    Math,
    Object,
    Promise,
    Set,
    String,
    TextEncoder,
    URL,
    clearTimeout,
    console,
    document: { getElementById: (id) => elements.get(id) ?? null },
    fetch: async () => { throw new Error("network must not run during initialization"); },
    setTimeout,
  });
  new Script(bundle, { filename: "cinevfx-uxp-bundle.js" }).runInContext(context);
  assert.equal(typeof context.cinevfxShell, "object");
  assert.equal(context.cinevfxShell.task.getSnapshot().state, "idle");
  for (const id of ["btn-plan-proxy", "btn-submit", "btn-cancel", "btn-import"]) {
    assert.equal(typeof listeners.get(`${id}:click`), "function");
  }
});
