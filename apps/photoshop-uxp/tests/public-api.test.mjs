import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as api from "../src/public-api.mjs";
import { createPanelController } from "../src/ui/panel-controller.mjs";

describe("public API surface", () => {
  it("exports shell capabilities and marks runtime unverified", () => {
    assert.equal(typeof api.createCinevfxClient, "function");
    assert.equal(typeof api.createTaskController, "function");
    assert.equal(typeof api.planProxyExport, "function");
    assert.equal(typeof api.validateLayerManifest, "function");
    assert.equal(typeof api.planManifestImport, "function");
    assert.equal(typeof api.createWriteScopeGuard, "function");
    assert.equal(typeof api.createPanelWorkflow, "function");
    assert.equal(api.SCHEMA_VERSION, "1.0.0");
    assert.equal(api.MOCK_ENDPOINTS.length, 6);
    assert.equal(api.UNVERIFIED.photoshopProxyExport, true);
    assert.equal(api.UNVERIFIED.executeAsModalHistoryUndo, true);
    assert.equal(api.UNVERIFIED.layerPlacement, true);
    assert.equal(api.UNVERIFIED.sourcePreservationRuntime, true);
    assert.equal(api.UNVERIFIED.windowsRuntime, true);
    assert.equal(api.UNVERIFIED.oneClickSignedInstall, true);
    assert.equal(api.UNVERIFIED.realPluginId, true);
    assert.equal(api.UNVERIFIED.marketplaceCompatibility, true);
    assert.equal(api.UNVERIFIED.runtimeSuccess, true);
    assert.equal(api.DEV_PLUGIN_ID, "com.cinevfx.dev.shell");
  });

  it("validateLayerManifest exposes the declared public return shape", () => {
    const result = api.validateLayerManifest(null);
    assert.deepEqual(Object.keys(result).sort(), ["errors", "valid"]);
    assert.equal(result.valid, false);
    assert.ok(Array.isArray(result.errors));
  });

  it("panel controller renders without DOM and logs safely", () => {
    const task = api.createTaskController();
    const logs = [];
    const panel = createPanelController(task, {
      document: null,
      log: (line) => logs.push(line),
    });
    panel.appendLog("path probe", {
      filePath: "C:\\Users\\someone\\secret.psd",
      jobId: "job_1",
    });
    assert.equal(logs.length, 1);
    assert.equal(logs[0].includes("secret.psd"), false);
    for (let index = 0; index < 205; index += 1) {
      panel.appendLog(`line-${index}`);
    }
    assert.equal(logs.length, 206);
    assert.equal(panel.getLogLines().length, 200);
    assert.equal(panel.getLogLines()[0], "line-5");
    assert.equal(panel.getLogLines()[199], "line-204");
    panel.dispose();
  });

  it("panel controller updates badge, progress, and button disabled states", () => {
    const planBtn = { id: "btn-plan-proxy", disabled: false, textContent: "" };
    const submitBtn = { id: "btn-submit", disabled: false, textContent: "" };
    const cancelBtn = { id: "btn-cancel", disabled: false, textContent: "" };
    const importBtn = { id: "btn-import", disabled: true, textContent: "" };
    const badge = { id: "task-state-badge", textContent: "", className: "" };
    const bar = { id: "progress-bar", style: { width: "0%" }, textContent: "" };
    const stage = { id: "progress-stage", textContent: "" };
    const ratio = { id: "progress-ratio", textContent: "" };
    const log = { id: "status-log", textContent: "" };
    /** @type {Record<string, object>} */
    const byId = {
      "btn-plan-proxy": planBtn,
      "btn-submit": submitBtn,
      "btn-cancel": cancelBtn,
      "btn-import": importBtn,
      "task-state-badge": badge,
      "progress-bar": bar,
      "progress-stage": stage,
      "progress-ratio": ratio,
      "status-log": log,
    };
    const doc = {
      getElementById(id) {
        return byId[id] ?? null;
      },
    };

    const task = api.createTaskController();
    const panel = createPanelController(task, {
      document: /** @type {any} */ (doc),
    });
    assert.equal(badge.textContent, "空闲");
    assert.equal(planBtn.disabled, false);
    assert.equal(submitBtn.disabled, false);
    assert.equal(cancelBtn.disabled, true);
    assert.equal(importBtn.disabled, true);

    task.beginProxyPlanning({ kind: "proxy_export_plan" });
    assert.equal(badge.className, "badge badge--planning_proxy");
    assert.equal(planBtn.disabled, true);
    assert.equal(submitBtn.disabled, true);
    assert.equal(cancelBtn.disabled, true);
    task.finishProxyPlanning();
    assert.equal(planBtn.disabled, false);
    assert.equal(submitBtn.disabled, false);

    task.beginSubmit({ effectLabel: "x" });
    panel.render(task.getSnapshot());
    assert.equal(badge.textContent, "正在提交");
    assert.equal(planBtn.disabled, true);
    assert.equal(submitBtn.disabled, true);
    assert.equal(cancelBtn.disabled, false);

    task.markPolling({
      jobId: "job_mock_0001",
      progress: { ratio: 0.4, stage: "render" },
    });
    panel.render(task.getSnapshot());
    assert.equal(bar.style.width, "40%");
    assert.equal(stage.textContent, "渲染中");
    assert.equal(ratio.textContent, "40%");
    assert.equal(cancelBtn.disabled, false);
    assert.equal(importBtn.disabled, true);

    task.markSucceeded({
      jobId: "job_mock_0001",
      manifestId: "manifest_mock_0001",
    });
    panel.render(task.getSnapshot());
    assert.equal(badge.textContent, "已完成");
    assert.equal(cancelBtn.disabled, true);
    assert.equal(importBtn.disabled, false);
    assert.equal(planBtn.disabled, false);
    assert.equal(submitBtn.disabled, false);

    panel.render({
      ...task.getSnapshot(),
      progress: { ratio: 7, stage: `render\n${"x".repeat(200)}` },
    });
    assert.equal(bar.style.width, "100%");
    assert.equal(ratio.textContent, "100%");
    assert.equal(stage.textContent.includes("\n"), false);
    assert.equal(stage.textContent.length, 128);

    panel.render({
      ...task.getSnapshot(),
      progress: { ratio: -4, stage: /** @type {any} */ (null) },
    });
    assert.equal(bar.style.width, "0%");
    assert.equal(ratio.textContent, "0%");
    assert.equal(stage.textContent, "就绪");

    panel.render({
      ...task.getSnapshot(),
      progress: { ratio: Number.POSITIVE_INFINITY, stage: "render" },
    });
    assert.equal(bar.style.width, "0%");
    assert.equal(ratio.textContent, "0%");

    panel.dispose();
  });

  it("renders Simplified Chinese panel copy and localizes fixed workflow logs", async () => {
    const { readFile } = await import("node:fs/promises");
    const { join, dirname } = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const html = await readFile(
      join(dirname(fileURLToPath(import.meta.url)), "../index.html"),
      "utf8",
    );
    for (const copy of [
      'lang="zh-CN"',
      "分层特效工作流（开发预览）",
      "本地服务地址",
      "效果名称",
      "规划代理图",
      "提交任务",
      "取消任务",
      "规划导入",
    ]) {
      assert.ok(html.includes(copy), `missing Chinese panel copy: ${copy}`);
    }

    const task = api.createTaskController();
    const lines = [];
    const panel = createPanelController(task, {
      document: null,
      log: (line) => lines.push(line),
    });
    panel.appendLog("Proxy plan created (metadata only)");
    assert.equal(lines[0], "代理图方案已创建（仅元数据）");
    panel.dispose();
  });

  it("panel controller ignores non-button elements for every action control", () => {
    const doc = {
      getElementById(id) {
        if (id.startsWith("btn-")) return { id };
        return null;
      },
    };
    const task = api.createTaskController();
    const panel = createPanelController(task, {
      document: /** @type {any} */ (doc),
    });
    assert.doesNotThrow(() => panel.render(task.getSnapshot()));
    panel.dispose();
  });

  it("styles.css is compact and responsive for narrow docked panels", async () => {
    const { readFile } = await import("node:fs/promises");
    const { join, dirname } = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const css = await readFile(
      join(dirname(fileURLToPath(import.meta.url)), "../styles.css"),
      "utf8",
    );
    assert.match(css, /@media/);
    assert.match(css, /240px|min-width|flex-basis/);
    assert.match(css, /panel__section--actions/);
    assert.match(css, /#progress-stage\s*{[^}]*min-width:\s*0/s);
    assert.match(css, /#progress-stage\s*{[^}]*text-overflow:\s*ellipsis/s);
    assert.match(css, /#progress-ratio\s*{[^}]*flex:\s*0\s+0\s+auto/s);
    assert.match(css, /--uxp-host-background-color/);
    assert.match(css, /--uxp-host-text-color/);
    assert.doesNotMatch(css, /display:\s*grid|grid-template|\bgap\s*:/);
  });

});
