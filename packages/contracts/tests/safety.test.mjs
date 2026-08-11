import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { forbiddenExamplePatterns } from "../scripts/catalog.mjs";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function readAllExamples() {
  const out = [];
  for (const kind of ["valid", "invalid"]) {
    const dir = path.join(packageRoot, "examples", kind);
    const files = await readdir(dir);
    for (const fileName of files.filter((name) => name.endsWith(".json"))) {
      out.push({
        fileName: `${kind}/${fileName}`,
        text: await readFile(path.join(dir, fileName), "utf8"),
      });
    }
  }
  return out;
}

test("examples contain no image bytes, prompts, credentials, or absolute paths", async () => {
  const examples = await readAllExamples();
  assert.ok(examples.length > 0);
  for (const example of examples) {
    for (const pattern of forbiddenExamplePatterns) {
      assert.equal(
        pattern.regex.test(example.text),
        false,
        `${example.fileName} matched forbidden pattern ${pattern.name}`,
      );
    }
  }
});

test("protected source operations are encoded on job requests", async () => {
  const request = JSON.parse(
    await readFile(
      path.join(packageRoot, "examples/valid/job-request.mock.json"),
      "utf8",
    ),
  );
  assert.equal(request.protectedSource.immutable, true);
  for (const op of ["modify_pixels", "move", "transform", "resize", "replace"]) {
    assert.ok(request.protectedSource.operationsForbidden.includes(op));
  }
});
