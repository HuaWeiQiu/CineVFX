import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { packageRoot } from "./catalog.mjs";
import { generateTypesArtifacts } from "./generate-types.mjs";

const result = await generateTypesArtifacts({ write: true });
if (result.wrote) {
  console.log(`Generated ${path.relative(packageRoot, result.typesPath)} and meta.json`);
} else {
  console.log("Generated artifacts already up to date");
}

const distDir = path.join(packageRoot, "dist");
await mkdir(distDir, { recursive: true });
const artifact = {
  package: "@cinevfx/contracts",
  schemaVersion: "1.0.0",
  artifacts: [
    "schemas",
    "examples",
    "generated/types.d.ts",
    "generated/meta.json",
    "../../openapi/openapi.json",
  ],
};
const distPath = path.join(distDir, "contracts-build.json");
const distText = `${JSON.stringify(artifact, null, 2)}\n`;
let existing = null;
try {
  existing = await readFile(distPath, "utf8");
} catch {
  existing = null;
}
if (existing !== distText) {
  await writeFile(distPath, distText);
}

await access(path.join(packageRoot, "generated/types.d.ts"));
console.log("Contracts build complete.");
