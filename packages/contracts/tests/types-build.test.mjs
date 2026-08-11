import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { buildGeneratedTypesText } from "../scripts/generate-types.mjs";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("generated declarations match schema-derived output", async () => {
  const typesPath = path.join(packageRoot, "generated/types.d.ts");
  await access(typesPath);
  const text = await readFile(typesPath, "utf8");
  assert.equal(text, await buildGeneratedTypesText());
  for (const name of [
    "EffectSpec",
    "AssetDescriptor",
    "JobRequest",
    "LayerManifest",
  ]) {
    assert.match(text, new RegExp(`export interface ${name}`));
  }
  assert.match(text, /export type JobStatus =/);
  assert.match(text, /export type JobEvent =/);
  assert.match(text, /state: "SUCCEEDED";[\s\S]*manifestId: ManifestId;/);
  assert.match(text, /type: "manifest_ready";[\s\S]*state: "SUCCEEDED";/);
  assert.match(text, /export type JobState/);
  assert.match(text, /CREATED/);
  assert.match(text, /SUCCEEDED/);
});
