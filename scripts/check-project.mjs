import { access, readFile } from "node:fs/promises";

const requiredFiles = [
  "AGENTS.md",
  "PROJECT_STATE.md",
  "agent-team.yaml",
  "docs/agent-pack/00_START_HERE.md",
  "docs/agent-pack/01_PRODUCT_REQUIREMENTS.md",
  "docs/agent-pack/02_SYSTEM_ARCHITECTURE.md",
  "docs/agent-pack/06_API_DATA_CONTRACTS.md",
  "docs/agent-pack/07_MULTI_AGENT_TEAM.md",
  "docs/agent-pack/TASKS.yaml",
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

console.log(`Validated ${requiredFiles.length} required project files.`);
