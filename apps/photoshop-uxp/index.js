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
import { createPhotoshopGlowHost } from "./src/host/photoshop-glow-host.mjs";
import { createLocalGlowService } from "./src/effects/local-glow-service.mjs";

const task = createTaskController();
const writeGuard = createWriteScopeGuard();
const panel = createPanelController(task);

const workflow = createPanelWorkflow({
  task,
  writeGuard,
  log: (message, fields) => panel.appendLog(message, fields),
});
const glowHost = createPhotoshopGlowHost();
const localGlow = createLocalGlowService({ host: glowHost, writeGuard });

let localGlowBusy = false;
let localGlowReady = false;

panel.appendLog("CineVFX 开发预览已就绪", {
  unverifiedCount: Object.keys(UNVERIFIED).length,
});

function qs(id) {
  return document.getElementById(id);
}

const LOCAL_ERROR_MESSAGES = Object.freeze({
  host_unavailable: "Photoshop 宿主暂不可用",
  no_active_document: "请先打开一个 Photoshop 文档",
  no_active_layer: "请先选择一个图层",
  multiple_active_layers: "请只选择一个图层",
  unsupported_document_mode: "仅支持 RGB 文档",
  unsupported_bit_depth: "仅支持 8 位或 16 位文档",
  unsupported_layer_kind: "请选择像素图层或智能对象",
  source_not_visible: "所选图层必须可见",
  invalid_layer_bounds: "无法读取所选图层范围",
  context_required: "请先刷新当前图层",
  context_mismatch: "当前图层已变化，请刷新后重试",
  selection_changed: "当前图层已变化，请重新操作",
  source_changed: "源图层状态已变化，操作已取消",
  history_owned_externally: "当前历史记录正被其他操作占用",
  user_cancelled: "操作已取消",
  rollback_failed: "回滚失败，请立即检查图层面板",
  modal_unavailable: "Photoshop 当前无法执行该操作",
  LOCAL_GLOW_BUSY: "正在创建发光，请稍候",
  memory_limit_exceeded: "当前图层超过 1 GiB 本地效果内存上限",
  invalid_settings: "效果参数无效",
  invalid_color: "颜色格式应为 #RRGGBB",
  invalid_context: "当前图层信息无效",
  memory_limit_exceeded: "当前图层超过本地效果内存上限",
});

function errorCode(error, fallback) {
  const value =
    error && typeof error === "object" && "code" in error
      ? String(error.code)
      : fallback;
  return /^[A-Za-z0-9_-]{1,64}$/.test(value) ? value : fallback;
}

function localErrorMessage(code) {
  return LOCAL_ERROR_MESSAGES[code] ?? "本地效果未完成，请检查当前图层";
}

function setText(id, value) {
  const element = qs(id);
  if (element) element.textContent = value;
}

function setLocalBusy(busy) {
  localGlowBusy = busy;
  const refresh = qs("btn-refresh-layer");
  const create = qs("btn-create-glow");
  if (refresh && "disabled" in refresh) refresh.disabled = busy;
  if (create && "disabled" in create) {
    create.disabled = busy || !localGlowReady;
  }
}

function rangeValue(id, fallback) {
  const input = qs(id);
  const value = Number(input?.value);
  return Number.isFinite(value) ? value : fallback;
}

function glowSettings() {
  const colorInput = qs("glow-color");
  const color =
    colorInput && typeof colorInput.value === "string"
      ? colorInput.value.trim().toUpperCase()
      : "";
  if (!/^#[0-9A-F]{6}$/.test(color)) {
    const error = new Error("invalid color");
    error.code = "invalid_color";
    throw error;
  }
  return {
    recipeId: "soft_glow",
    color,
    intensity: rangeValue("glow-intensity", 70),
    size: rangeValue("glow-spread", 36),
    blur: rangeValue("glow-blur-radius", 18),
    blendMode: "screen",
  };
}

function updateRangeOutput(inputId, outputId, suffix) {
  setText(outputId, `${rangeValue(inputId, 0)}${suffix}`);
}

function safeContextSummary(context) {
  const kind = context?.layerKind === "smartObject" ? "智能对象" : "像素图层";
  const bits = context?.bitsPerChannel === 16 ? 16 : 8;
  const width = finiteDimension(context?.bounds?.width);
  const height = finiteDimension(context?.bounds?.height);
  const estimate = estimateWorkingBytes(width, height, bits);
  return {
    status: `${kind} · RGB ${bits} 位`,
    meta: `${width} × ${height} px · 预计工作内存 ${formatBytes(estimate)}`,
  };
}

function finiteDimension(value) {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : 0;
}

function estimateWorkingBytes(width, height, bits) {
  return width * height * 4 * (bits / 8) * 6;
}

function formatBytes(bytes) {
  const mib = 1024 * 1024;
  if (bytes < mib) return `${Math.ceil(bytes / 1024)} KB`;
  return `${Math.ceil(bytes / mib)} MB`;
}

async function refreshLocalContext(options = {}) {
  if (localGlowBusy && !options.allowWhileBusy) return null;
  if (!options.allowWhileBusy) setLocalBusy(true);
  try {
    const context = await localGlow.inspect();
    const summary = safeContextSummary(context);
    localGlowReady = true;
    setText("local-layer-status", summary.status);
    setText("local-layer-meta", summary.meta);
    setText("local-glow-status", "可以创建非破坏性柔和发光");
    return context;
  } catch (error) {
    const code = errorCode(error, "host_unavailable");
    localGlowReady = false;
    setText("local-layer-status", "当前图层不可用");
    setText("local-layer-meta", localErrorMessage(code));
    setText("local-glow-status", localErrorMessage(code));
    if (!options.quiet) panel.appendLog("本地图层检查失败", { code });
    return null;
  } finally {
    if (!options.allowWhileBusy) setLocalBusy(false);
  }
}

qs("btn-refresh-layer")?.addEventListener("click", async () => {
  await refreshLocalContext();
});

for (const [inputId, outputId, suffix] of [
  ["glow-intensity", "glow-intensity-value", "%"],
  ["glow-spread", "glow-spread-value", " px"],
  ["glow-blur-radius", "glow-blur-radius-value", " px"],
]) {
  qs(inputId)?.addEventListener("input", () => {
    updateRangeOutput(inputId, outputId, suffix);
  });
}

qs("btn-create-glow")?.addEventListener("click", async () => {
  if (localGlowBusy) return;
  setLocalBusy(true);
  setText("local-glow-status", "正在创建柔和发光...");
  try {
    const context = await refreshLocalContext({ quiet: true, allowWhileBusy: true });
    if (!context) return;
    const result = await localGlow.apply(glowSettings());
    const recipeId = result?.plan?.recipeId === "soft_glow" ? "soft_glow" : "local_glow";
    setText("local-glow-status", "已创建柔和发光，可在图层面板继续编辑");
    panel.appendLog("本地效果已创建", {
      code: "LOCAL_GLOW_COMMITTED",
      recipeId,
    });
  } catch (error) {
    const code = errorCode(error, "local_glow_failed");
    setText("local-glow-status", localErrorMessage(code));
    panel.appendLog("本地效果创建失败", { code });
  } finally {
    setLocalBusy(false);
  }
});

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
    panel.appendLog("代理图规划失败", {
      code: errorCode(err, "proxy_plan_failed"),
    });
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
    panel.appendLog("任务提交失败", {
      code: errorCode(err, "submit_failed"),
    });
  }
});

qs("btn-cancel")?.addEventListener("click", async () => {
  try {
    await workflow.cancelActiveJob({ baseUrl: baseUrl() });
  } catch (err) {
    panel.appendLog("取消任务失败", {
      code: errorCode(err, "cancel_failed"),
    });
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
    panel.appendLog("导入规划失败", {
      code: errorCode(err, "import_plan_failed"),
    });
  }
});

// Initialization reads safe selection metadata only; it never writes or starts network IO.
void refreshLocalContext({ quiet: true });

// Export for host debugging consoles.
// eslint-disable-next-line no-undef
globalThis.cinevfxShell = {
  task,
  writeGuard,
  workflow,
  localGlow,
  planProxyExport,
  planManifestImport,
  UNVERIFIED,
};
