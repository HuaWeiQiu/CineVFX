import { mkdir, writeFile } from "node:fs/promises";

import {
  packageRelease,
  RELEASE_ARCHIVE,
  RELEASE_VERSION,
} from "./package-release.mjs";

await mkdir("dist", { recursive: true });
await writeFile(
  "dist/bootstrap.json",
  `${JSON.stringify(
    {
      project: "cinevfx",
      version: RELEASE_VERSION,
      phase: "P0-P5",
      artifact: "development-preview-handoff",
      photoshopRuntimeVerified: false,
    },
    null,
    2,
  )}\n`,
);
await packageRelease();
console.log(
  `Built dist/bootstrap.json and dist/release/${RELEASE_ARCHIVE}`,
);
