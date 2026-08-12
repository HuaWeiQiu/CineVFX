/**
 * Panel controller wiring task state to DOM (when present).
 * Safe to import under Node without a document.
 */

import { TASK_STATES } from "../constants.mjs";
import { formatSafeLog } from "../log/redact.mjs";

const MAX_PANEL_LOG_LINES = 200;
const MAX_STAGE_TEXT_LENGTH = 128;

const STATE_LABELS = Object.freeze({
  [TASK_STATES.IDLE]: "空闲",
  [TASK_STATES.PLANNING_PROXY]: "正在规划",
  [TASK_STATES.SUBMITTING]: "正在提交",
  [TASK_STATES.POLLING]: "处理中",
  [TASK_STATES.SUCCEEDED]: "已完成",
  [TASK_STATES.FAILED]: "失败",
  [TASK_STATES.CANCELLED]: "已取消",
  [TASK_STATES.IMPORT_PLANNED]: "已规划导入",
});

const STAGE_LABELS = Object.freeze({
  ready: "就绪",
  submit: "正在提交",
  created: "已创建",
  validating: "正在校验",
  queued: "已排队",
  preprocessing: "预处理中",
  render: "渲染中",
  rendering: "渲染中",
  postprocessing: "后处理中",
  exporting: "导出中",
  done: "完成",
  succeeded: "已完成",
  failed: "失败",
  cancelled: "已取消",
});

const LOG_MESSAGE_LABELS = Object.freeze({
  "Proxy plan created (metadata only)": "代理图方案已创建（仅元数据）",
  "Fetching manifest": "正在获取图层清单",
  "Manifest identity/binding failed": "图层清单身份校验失败",
  "Job succeeded; manifest validated": "任务已完成，图层清单校验通过",
  "Network phase (outside writes)": "正在访问本地服务",
  "Submit aborted before job create": "任务创建前已取消提交",
  "Job created": "任务已创建",
  "Cancel after abort failed": "提交中止后的取消操作失败",
  "Submit aborted": "提交已取消",
  "Submit failed": "任务提交失败",
  "Cancel ignored after server-confirmed success": "任务已完成，忽略取消操作",
  "Cancel requested (no job id yet; will abort submit if in flight)":
    "已请求取消，正在中止提交",
  "Cancel requested during active network phase": "已请求取消当前网络任务",
  "Import planning failed: unstable input": "导入规划失败：输入不稳定",
  "Import planning failed": "导入规划失败",
  "Import plan ready (execution UNVERIFIED)": "导入方案已就绪（尚未执行）",
  "Cancel reconciled": "取消状态已同步",
  "Cancel raced with success; manifest validated":
    "取消时任务已完成，图层清单校验通过",
});

/**
 * @param {ReturnType<import('../task/task-state.mjs').createTaskController>} task
 * @param {{
 *   document?: Document,
 *   log?: (line: string) => void,
 * }} [options]
 */
export function createPanelController(task, options = {}) {
  const doc = options.document ?? (typeof document !== "undefined" ? document : null);
  const externalLog = options.log;

  /** @type {string[]} */
  const logLines = [];

  function appendLog(message, fields) {
    const line = formatSafeLog(localizeLogMessage(message), fields);
    logLines.push(line);
    if (logLines.length > MAX_PANEL_LOG_LINES) {
      logLines.splice(0, logLines.length - MAX_PANEL_LOG_LINES);
    }
    if (externalLog) externalLog(line);
    if (!doc) return;
    const el = doc.getElementById("status-log");
    if (el) {
      el.textContent = logLines.slice(-40).join("\n");
    }
  }

  function render(snapshot) {
    if (!doc) return;
    const progressRatio = normalizeProgressRatio(snapshot?.progress?.ratio);
    const progressPercent = Math.round(progressRatio * 100);
    const progressStage = normalizeStageText(snapshot?.progress?.stage);
    const badge = doc.getElementById("task-state-badge");
    if (badge) {
      badge.textContent = STATE_LABELS[snapshot.state] ?? snapshot.state;
      badge.className = `badge badge--${snapshot.state}`;
    }
    const bar = doc.getElementById("progress-bar");
    if (bar) {
      bar.style.width = `${progressPercent}%`;
    }
    const stage = doc.getElementById("progress-stage");
    if (stage) stage.textContent = progressStage;
    const ratio = doc.getElementById("progress-ratio");
    if (ratio) {
      ratio.textContent = `${progressPercent}%`;
    }

    const busy =
      snapshot.state === TASK_STATES.PLANNING_PROXY ||
      snapshot.state === TASK_STATES.SUBMITTING ||
      snapshot.state === TASK_STATES.POLLING;
    setControlDisabled(doc.getElementById("btn-plan-proxy"), busy);
    setControlDisabled(doc.getElementById("btn-submit"), busy);

    const cancelBtn = doc.getElementById("btn-cancel");
    setControlDisabled(
      cancelBtn,
      !(
        snapshot.state === TASK_STATES.POLLING ||
        snapshot.state === TASK_STATES.SUBMITTING
      ),
    );
    const importBtn = doc.getElementById("btn-import");
    setControlDisabled(
      importBtn,
      !(
        snapshot.state === TASK_STATES.SUCCEEDED ||
        snapshot.state === TASK_STATES.IMPORT_PLANNED
      ),
    );
  }

  const unsubscribe = task.subscribe(render);
  render(task.getSnapshot());

  return {
    appendLog,
    render,
    getLogLines() {
      return [...logLines];
    },
    dispose() {
      unsubscribe();
    },
  };
}

/**
 * Portable button-like control check (works under Node DOM stubs).
 * @param {unknown} el
 * @returns {el is { disabled: boolean }}
 */
function isDisableableControl(el) {
  return (
    !!el &&
    typeof el === "object" &&
    "disabled" in /** @type {object} */ (el)
  );
}

/**
 * @param {unknown} el
 * @param {boolean} disabled
 */
function setControlDisabled(el, disabled) {
  if (isDisableableControl(el)) {
    el.disabled = disabled;
  }
}

/**
 * @param {unknown} ratio
 */
function normalizeProgressRatio(ratio) {
  if (typeof ratio !== "number" || !Number.isFinite(ratio)) return 0;
  return Math.min(1, Math.max(0, ratio));
}

/**
 * @param {unknown} stage
 */
function normalizeStageText(stage) {
  if (typeof stage !== "string") return STAGE_LABELS.ready;
  const normalized = stage
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!normalized) return STAGE_LABELS.ready;
  return (
    STAGE_LABELS[normalized.toLowerCase()] ??
    normalized.slice(0, MAX_STAGE_TEXT_LENGTH)
  );
}

/**
 * Translate only fixed product copy. Arbitrary server text remains redacted and
 * visible verbatim so diagnostics do not lose technical meaning.
 * @param {unknown} message
 */
function localizeLogMessage(message) {
  if (typeof message !== "string") return message;
  return LOG_MESSAGE_LABELS[message] ?? message;
}
