import { access, readFile } from "node:fs/promises";

const requiredFiles = [
  ".gitattributes",
  ".github/workflows/ci.yml",
  "AGENTS.md",
  "LICENSE",
  "PROJECT_STATE.md",
  "agent-team.yaml",
  "docs/agent-pack/00_START_HERE.md",
  "docs/agent-pack/01_PRODUCT_REQUIREMENTS.md",
  "docs/agent-pack/02_SYSTEM_ARCHITECTURE.md",
  "docs/agent-pack/06_API_DATA_CONTRACTS.md",
  "docs/agent-pack/07_MULTI_AGENT_TEAM.md",
  "docs/agent-pack/TASKS.yaml",
  "docs/RELEASE.md",
  "apps/photoshop-uxp/scripts/plugin-artifact.mjs",
  "scripts/package-release.mjs",
  "scripts/run-all.mjs",
  "tests/package-release.test.mjs",
  "tests/run-all.test.mjs",
];

await Promise.all(requiredFiles.map((file) => access(file)));

const requirements = await readFile(
  "docs/agent-pack/01_PRODUCT_REQUIREMENTS.md",
  "utf8",
);
if (!requirements.includes("arbitrary effect image/layer")) {
  throw new Error("Product requirements must keep the generic effect-layer boundary");
}
if (!requirements.includes("protected source")) {
  throw new Error("Product requirements must state source protection");
}

const state = await readFile("PROJECT_STATE.md", "utf8");
if (!state.includes("Unverified")) {
  throw new Error("PROJECT_STATE.md must track unverified work");
}

const license = await readFile("LICENSE", "utf8");
if (!license.startsWith("MIT License\n")) {
  throw new Error("LICENSE must contain the MIT license text");
}

const pkg = JSON.parse(await readFile("package.json", "utf8"));
const uxpPkg = JSON.parse(
  await readFile("apps/photoshop-uxp/package.json", "utf8"),
);
const uxpManifest = JSON.parse(
  await readFile("apps/photoshop-uxp/manifest.json", "utf8"),
);
if (
  !/^\d+\.\d+\.\d+$/.test(pkg.version) ||
  uxpPkg.version !== pkg.version ||
  uxpManifest.version !== pkg.version ||
  pkg.license !== "MIT" ||
  pkg.scripts?.verify !== "node scripts/run-all.mjs verify" ||
  pkg.scripts?.["release:dev"] !== "node scripts/package-release.mjs"
) {
  throw new Error(
    "root/UXP release versions and delivery scripts must remain aligned",
  );
}

const workflow = await readFile(".github/workflows/ci.yml", "utf8");
for (const requiredToken of [
  "ubuntu-latest",
  "windows-latest",
  "macos-latest",
  "node-version: 24",
  "pnpm verify",
]) {
  if (!workflow.includes(requiredToken)) {
    throw new Error(`CI workflow must include ${requiredToken}`);
  }
}

console.log(`Validated ${requiredFiles.length} required project files.`);
