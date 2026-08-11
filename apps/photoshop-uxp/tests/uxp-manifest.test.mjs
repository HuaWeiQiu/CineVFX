import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { validateUxpManifest } from "../scripts/validate-uxp-manifest.mjs";
import {
  ALLOWED_API_ORIGINS,
  DEFAULT_BASE_URL,
} from "../src/constants.mjs";

const manifestUrl = new URL("../manifest.json", import.meta.url);

test("manifest is the strict Photoshop 2026 UXP v5 development subset", async () => {
  const manifest = JSON.parse(await readFile(manifestUrl, "utf8"));
  assert.deepEqual(validateUxpManifest(manifest), []);
  assert.equal(DEFAULT_BASE_URL, "https://localhost:8787");
  assert.deepEqual(
    new Set(manifest.requiredPermissions.network.domains),
    new Set(ALLOWED_API_ORIGINS),
  );
});

test("manifest validator rejects v3 permissions, extra capabilities, and foreign origins", async () => {
  const manifest = JSON.parse(await readFile(manifestUrl, "utf8"));
  for (const mutate of [
    (copy) => { copy.manifestVersion = 3; },
    (copy) => { copy.requiredPermissions.localFileSystem = "plugin"; },
    (copy) => { copy.requiredPermissions.network.domains.push("https://example.com"); },
    (copy) => { copy.host.data.apiVersion = 1; },
    (copy) => { copy.entrypoints[0].minimumSize.width = 12.5; },
  ]) {
    const copy = structuredClone(manifest);
    mutate(copy);
    assert.notDeepEqual(validateUxpManifest(copy), []);
  }
});
