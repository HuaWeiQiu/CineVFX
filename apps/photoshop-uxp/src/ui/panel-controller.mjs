/**
 * Panel controller wiring task state to DOM (when present).
 * Safe to import under Node without a document.
 */

import { TASK_STATES } from "../constants.mjs";
import { formatSafeLog } from "../log/redact.mjs";

const MAX_PANEL_LOG_LINES = 200;
const MAX_STAGE_TEXT_LENGTH = 128;

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
    const line = formatSafeLog(message, fields);
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
      badge.textContent = snapshot.state;
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
  if (typeof stage !== "string") return "ready";
  const normalized = stage
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return normalized.slice(0, MAX_STAGE_TEXT_LENGTH) || "ready";
}
