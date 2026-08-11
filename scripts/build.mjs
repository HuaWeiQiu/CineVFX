import { mkdir, writeFile } from "node:fs/promises";

await mkdir("dist", { recursive: true });
await writeFile(
  "dist/bootstrap.json",
  `${JSON.stringify(
    {
      project: "cinevfx",
      phase: "P0",
      artifact: "contract-bootstrap",
    },
    null,
    2,
  )}\n`,
);
console.log("Built dist/bootstrap.json");
