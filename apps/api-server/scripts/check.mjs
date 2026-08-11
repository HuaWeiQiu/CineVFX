import { access, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = path.resolve(packageRoot, "../..");

async function mustExist(relativePath) {
  const absolute = path.join(packageRoot, relativePath);
  await access(absolute);
  return absolute;
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

const requiredFiles = [
  "package.json",
  "README.md",
  "src/index.mjs",
  "src/http.mjs",
  "src/service.mjs",
  "src/lifecycle.mjs",
  "src/manifest-factory.mjs",
  "src/store.mjs",
  "src/redact.mjs",
  "src/errors.mjs",
  "src/util.mjs",
  "scripts/check.mjs",
  "scripts/build.mjs",
  "scripts/start.mjs",
];

const requiredScripts = ["check", "test", "build", "start"];

async function main() {
  const pkg = JSON.parse(await readFile(path.join(packageRoot, "package.json"), "utf8"));
  assert(pkg.name === "@cinevfx/api-server", "package name must be @cinevfx/api-server");
  assert(pkg.type === "module", "package must be ESM");
  assert(!pkg.dependencies && !pkg.devDependencies, "package must have no external dependencies");
  for (const script of requiredScripts) {
    assert(pkg.scripts?.[script], `missing script ${script}`);
  }

  for (const file of requiredFiles) {
    await mustExist(file);
  }

  // Ensure frozen contracts package is present for imports.
  const contractsPkg = path.join(repoRoot, "packages/contracts/package.json");
  await access(contractsPkg);

  const transportContract = JSON.parse(
    await readFile(
      path.join(repoRoot, "openapi/local-development-transport.json"),
      "utf8",
    ),
  );
  assert(
    transportContract.documentType ===
        "cinevfx-local-development-transport-contract" &&
      transportContract.contractId === "cinevfx-local-development-transport" &&
      transportContract.contractVersion === "1.0.0",
    "local transport contract identity must remain frozen",
  );
  assert(
    transportContract.canonicalOrigin === "https://localhost:8787" &&
      transportContract.health?.path === "/healthz" &&
      transportContract.health?.maxResponseBytes === 4096 &&
      transportContract.session?.headerName === "X-CineVFX-Session" &&
      transportContract.session?.corsEnabled === false &&
      transportContract.network?.cliPort === 8787 &&
      transportContract.network?.minimumTlsVersion === "TLSv1.2" &&
      transportContract.network?.defaultBodyTimeoutMs === 5000 &&
      transportContract.network?.defaultCloseGraceMs === 250 &&
      transportContract.network?.maxRequestBodyBytes === 262144,
    "local transport contract does not match runtime defaults",
  );
  const openapi = JSON.parse(
    await readFile(path.join(repoRoot, "openapi/openapi.json"), "utf8"),
  );
  assert(
    openapi.servers?.length === 1 &&
      openapi.servers[0]?.url === transportContract.canonicalOrigin,
    "OpenAPI server must match the canonical local transport origin",
  );
  const expectedTransportRoutes = [
    ["POST", "/v1/assets", "201", "400,409,413,500"],
    ["POST", "/v1/jobs", "200,201", "400,409,413,500"],
    ["GET", "/v1/jobs/{id}", "200", "400,404,500"],
    ["GET", "/v1/jobs/{id}/events", "200", "400,404,500"],
    ["POST", "/v1/jobs/{id}/cancel", "200", "400,404,409,413,500"],
    ["GET", "/v1/jobs/{id}/manifest", "200", "400,404,409,500"],
  ];
  assert(
    JSON.stringify(
      transportContract.routes?.map((route) => [
        route.method,
        route.path,
        route.successResponseStatuses.join(","),
        route.errorResponseStatuses.join(","),
      ]),
    ) === JSON.stringify(expectedTransportRoutes),
    "local transport route/status surface drifted",
  );
  for (const route of transportContract.routes) {
    const effectiveStatuses = [
      ...route.successResponseStatuses,
      ...route.errorResponseStatuses,
    ].sort((left, right) => left - right);
    assert(
      JSON.stringify(effectiveStatuses) ===
        JSON.stringify([...route.effectiveResponseStatuses].sort((left, right) => left - right)),
      `effective statuses must equal success plus error statuses for ${route.method} ${route.path}`,
    );
    assert(
      route.errorResponseSchema ===
        "openapi.json#/components/schemas/ErrorObject",
      `error responses must use ErrorObject for ${route.method} ${route.path}`,
    );
  }

  // Syntax/load check of public entrypoints.
  const indexUrl = pathToFileURL(path.join(packageRoot, "src/index.mjs")).href;
  const mod = await import(indexUrl);
  for (const exportName of [
    "createMockApi",
    "createServer",
    "listen",
    "createStore",
    "createLogger",
    "redactForLog",
    "buildFixedLayerManifest",
    "HttpError",
  ]) {
    assert(typeof mod[exportName] === "function" || typeof mod[exportName] === "object", `missing export ${exportName}`);
  }

  // Confirm six endpoints are documented in README.
  const readme = await readFile(path.join(packageRoot, "README.md"), "utf8");
  assert(
    readme.includes("openapi/local-development-transport.json"),
    "README must name the local transport authority",
  );
  for (const endpoint of [
    "POST /v1/assets",
    "POST /v1/jobs",
    "GET /v1/jobs/{id}",
    "GET /v1/jobs/{id}/events",
    "POST /v1/jobs/{id}/cancel",
    "GET /v1/jobs/{id}/manifest",
  ]) {
    assert(readme.includes(endpoint), `README must document ${endpoint}`);
  }

  // No accidental package-lock / node_modules dependency on network packages.
  const entries = await readdir(packageRoot);
  assert(!entries.includes("package-lock.json"), "package-lock.json is not allowed");

  // Source files must only import relative paths or node: built-ins.
  const srcDir = path.join(packageRoot, "src");
  const srcFiles = (await readdir(srcDir)).filter((name) => name.endsWith(".mjs"));
  for (const fileName of srcFiles) {
    const text = await readFile(path.join(srcDir, fileName), "utf8");
    const importMatches = text.matchAll(/from\s+["']([^"']+)["']/g);
    for (const match of importMatches) {
      const spec = match[1];
      if (spec.startsWith(".") || spec.startsWith("node:")) continue;
      throw new Error(`${fileName} imports disallowed specifier ${spec}`);
    }
  }

  await access(path.join(repoRoot, "packages/contracts/src/index.mjs"));

  console.log("api-server check passed");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
