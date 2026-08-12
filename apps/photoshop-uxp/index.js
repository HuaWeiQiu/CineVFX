/**
 * UXP panel entry. Photoshop host APIs are optional; planning works without them.
 * Real proxy export / executeAsModal / placement: UNVERIFIED.
 */

import { createTaskController } from "./src/task/task-state.mjs";
import { createWriteScopeGuard } from "./src/safety/network-boundary.mjs";
import { createPanelController } from "./src/ui/panel-controller.mjs";
import { createPanelWorkflow } from "./src/ui/panel-workflow.mjs";
import { planProxyExport } from "./src/proxy/proxy-plan.mjs";
import { planManifestImport } from "./src/import/import-plan.mjs";
import { DEFAULT_BASE_URL, UNVERIFIED } from "./src/constants.mjs";

const task = createTaskController();
const writeGuard = createWriteScopeGuard();
const panel = createPanelController(task);

const workflow = createPanelWorkflow({
  task,
  writeGuard,
  log: (message, fields) => panel.appendLog(message, fields),
});

panel.appendLog("CineVFX 开发预览已就绪", {
  unverifiedCount: Object.keys(UNVERIFIED).length,
});

function qs(id) {
  return document.getElementById(id);
}

function baseUrl() {
  const input = qs("base-url");
  if (input && typeof input.value === "string" && input.value.trim()) {
    return input.value.trim();
  }
  return DEFAULT_BASE_URL;
}

function effectLabel() {
  const input = qs("effect-label");
  if (input && typeof input.value === "string" && input.value.trim()) {
    return input.value.trim();
  }
  return "effect";
}

/**
 * Placeholder protected source ids for panel demos without live DOM selection.
 * Real layer resolution is UNVERIFIED.
 */
function sessionProtectedSource() {
  return {
    layerStableId: "ps_layer_stable_source_01",
    documentStableId: "ps_doc_stable_01",
    bounds: { x: 0, y: 0, width: 1024, height: 1024 },
  };
}

qs("btn-plan-proxy")?.addEventListener("click", () => {
  try {
    workflow.planProxy(sessionProtectedSource(), {
      effectLabel: effectLabel(),
      maxEdge: 1024,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    panel.appendLog("代理图规划失败", { message });
  }
});

qs("btn-submit")?.addEventListener("click", async () => {
  try {
    const proxyPlan =
      task.getSnapshot().proxyPlan &&
      typeof task.getSnapshot().proxyPlan === "object"
        ? /** @type {any} */ (task.getSnapshot().proxyPlan)
        : planProxyExport(sessionProtectedSource(), {
            effectLabel: effectLabel(),
          });
    await workflow.submitJob({
      baseUrl: baseUrl(),
      effectLabel: effectLabel(),
      protectedSource: sessionProtectedSource(),
      proxyPlan,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    panel.appendLog("任务提交失败", { message });
  }
});

qs("btn-cancel")?.addEventListener("click", async () => {
  try {
    await workflow.cancelActiveJob({ baseUrl: baseUrl() });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    panel.appendLog("取消任务失败", { message });
  }
});

qs("btn-import")?.addEventListener("click", async () => {
  try {
    const result = await workflow.planImport({
      baseUrl: baseUrl(),
      protectedSource: sessionProtectedSource(),
    });
    if (!result.ok) {
      panel.appendLog("导入规划失败", {
        errorCount: result.errors?.length ?? 0,
      });
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    panel.appendLog("导入规划失败", { message });
  }
});

// Export for host debugging consoles.
// eslint-disable-next-line no-undef
globalThis.cinevfxShell = {
  task,
  writeGuard,
  workflow,
  planProxyExport,
  planManifestImport,
  UNVERIFIED,
};
