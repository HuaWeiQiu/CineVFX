import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  schemaForExampleFileName,
} from "../scripts/catalog.mjs";
import { validateAgainstSchema } from "../src/validate-json-schema.mjs";
import { validateManifestSemantics } from "../src/manifest.mjs";
import { validateJobRequestSemantics } from "../src/job-request.mjs";
import {
  validateJobEventSemantics,
  validateJobEventStream,
} from "../src/job-event.mjs";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function loadExamples(kind) {
  const dir = path.join(packageRoot, "examples", kind);
  const files = (await readdir(dir)).filter((name) => name.endsWith(".json")).sort();
  const items = [];
  for (const fileName of files) {
    const data = JSON.parse(await readFile(path.join(dir, fileName), "utf8"));
    const schema = fileName.startsWith("job-event-stream.")
      ? null
      : schemaForExampleFileName(fileName);
    items.push({ fileName, data, schema });
  }
  return items;
}

test("all valid examples satisfy their schemas", async () => {
  const examples = await loadExamples("valid");
  assert.ok(examples.length >= 10);
  for (const example of examples) {
    const result = await validateAgainstSchema(example.data, example.schema);
    assert.equal(
      result.valid,
      true,
      `${example.fileName} should be valid: ${JSON.stringify(result.errors)}`,
    );
  }
});

test("all invalid examples are rejected by schema or semantic rules", async () => {
  const examples = await loadExamples("invalid");
  assert.ok(examples.length >= 8);
  for (const example of examples) {
    if (example.fileName.startsWith("job-event-stream.")) {
      const stream = validateJobEventStream(example.data.events);
      assert.equal(stream.valid, false, `${example.fileName} should be rejected`);
      continue;
    }
    const result = await validateAgainstSchema(example.data, example.schema);
    let rejected = !result.valid;
    if (!rejected && example.fileName.startsWith("layer-manifest.")) {
      rejected = !validateManifestSemantics(example.data).valid;
    }
    if (!rejected && example.fileName.startsWith("job-request.")) {
      rejected = !validateJobRequestSemantics(example.data).valid;
    }
    if (!rejected && example.fileName.startsWith("job-event.")) {
      rejected = !validateJobEventSemantics(example.data).valid;
    }
    assert.equal(rejected, true, `${example.fileName} should be rejected`);
  }
});

test("successful manifest example has editable passes and verified digests", async () => {
  const absolute = path.join(
    packageRoot,
    "examples/valid/layer-manifest.succeeded.json",
  );
  const manifest = JSON.parse(await readFile(absolute, "utf8"));
  const schemaResult = await validateAgainstSchema(manifest, "layer-manifest.schema.json");
  assert.equal(schemaResult.valid, true, JSON.stringify(schemaResult.errors));
  const semantic = validateManifestSemantics(manifest);
  assert.equal(semantic.valid, true, JSON.stringify(semantic.errors));
  assert.ok(manifest.passes.length >= 5);
  assert.ok(manifest.passes.every((pass) => pass.editable === true));
  assert.ok(manifest.assets.every((asset) => asset.verified === true));
  assert.equal(manifest.protectedSource.immutable, true);
  assert.equal(manifest.protectedSource.untouched, true);
});

test("golden magic appears only as a labeled benchmark fixture", async () => {
  const absolute = path.join(
    packageRoot,
    "examples/valid/effect-spec.golden-magic-benchmark.json",
  );
  const text = await readFile(absolute, "utf8");
  const data = JSON.parse(text);
  assert.match(data.label, /golden-magic-benchmark/);
  assert.equal(data.benchmark.fixtureId, "bench_golden_magic");
  assert.match(data.benchmark.description, /not a product mode/i);
  assert.equal(Object.hasOwn(data, "mode"), false);
  assert.equal(Object.hasOwn(data, "effectMode"), false);
});

test("arbitrary effect-layer example validates without magic fields", async () => {
  const absolute = path.join(
    packageRoot,
    "examples/valid/effect-spec.arbitrary-fire.json",
  );
  const data = JSON.parse(await readFile(absolute, "utf8"));
  const result = await validateAgainstSchema(data, "effect-spec.schema.json");
  assert.equal(result.valid, true, JSON.stringify(result.errors));
  assert.equal(data.benchmark, undefined);
  assert.ok(data.references.some((ref) => ref.role === "effect"));
});
