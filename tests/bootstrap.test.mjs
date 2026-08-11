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
