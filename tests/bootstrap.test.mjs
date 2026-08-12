import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("product remains generic and contract-first", async () => {
  const readme = await readFile("README.md", "utf8");
  const requirements = await readFile(
    "docs/agent-pack/01_PRODUCT_REQUIREMENTS.md",
    "utf8",
  );
  assert.match(readme, /arbitrary effect image\/layer/i);
  assert.match(readme, /Mock end-to-end vertical slice/i);
  assert.match(requirements, /Golden magic is the first benchmark fixture/i);
  assert.match(requirements, /not a hard-coded feature boundary/i);
});

test("source preservation is stronger than a bounds-only check", async () => {
  const guidance = await readFile("AGENTS.md", "utf8");
  assert.match(guidance, /Never modify, move, transform, resize, or replace/i);
  assert.match(guidance, /Do not claim absolute subject preservation from layer bounds alone/i);
});

test("Chinese handoff keeps install, evidence, boundaries, and next work together", async () => {
  const handoff = await readFile("docs/HANDOFF.zh-CN.md", "utf8");
  assert.match(handoff, /github\.com\/HuaWeiQiu\/CineVFX/);
  assert.match(handoff, /通过 UXP Developer Tool 加载/);
  assert.match(handoff, /实机验收记录/);
  assert.match(handoff, /不可破坏的工程约束/);
  assert.match(handoff, /下一阶段建议/);
  assert.match(handoff, /Windows Photoshop[\s\S]*未验证/);
});
