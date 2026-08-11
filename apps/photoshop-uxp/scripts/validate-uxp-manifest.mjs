/**
 * Strict CineVFX subset of Adobe UXP Manifest v5.
 * Reference: https://developer.adobe.com/photoshop/uxp/2022/guides/uxp_guide/uxp-misc/manifest-v5/
 */

const ROOT_KEYS = Object.freeze([
  "entrypoints",
  "host",
  "id",
  "main",
  "manifestVersion",
  "name",
  "requiredPermissions",
  "version",
]);
const ENTRYPOINT_KEYS = Object.freeze([
  "id",
  "label",
  "maximumSize",
  "minimumSize",
  "preferredDockedSize",
  "preferredFloatingSize",
  "type",
]);
const EXPECTED_DOMAINS = Object.freeze([
  "https://localhost:8787",
  "https://127.0.0.1:8787",
  "http://127.0.0.1:8787",
  "http://localhost:8787",
]);

export function validateUxpManifest(manifest) {
  const errors = [];
  if (!isRecord(manifest)) {
    return [{ path: "#", message: "manifest must be an object" }];
  }

  exactKeys(manifest, ROOT_KEYS, "#", errors);
  equal(manifest.manifestVersion, 5, "#/manifestVersion", errors);
  stringPattern(manifest.id, /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)+$/, "#/id", errors);
  nonEmptyString(manifest.name, "#/name", errors);
  stringPattern(manifest.version, /^\d+\.\d+\.\d+$/, "#/version", errors);
  equal(manifest.main, "index.html", "#/main", errors);

  validateHost(manifest.host, errors);
  validateEntrypoints(manifest.entrypoints, errors);
  validatePermissions(manifest.requiredPermissions, errors);
  return errors;
}

function validateHost(host, errors) {
  if (!isRecord(host)) {
    errors.push({ path: "#/host", message: "host must be an object" });
    return;
  }
  exactKeys(host, ["app", "data", "minVersion"], "#/host", errors);
  equal(host.app, "PS", "#/host/app", errors);
  stringPattern(host.minVersion, /^27\.\d+\.\d+$/, "#/host/minVersion", errors);
  if (!isRecord(host.data)) {
    errors.push({ path: "#/host/data", message: "host.data must be an object" });
  } else {
    exactKeys(host.data, ["apiVersion"], "#/host/data", errors);
    equal(host.data.apiVersion, 2, "#/host/data/apiVersion", errors);
  }
}

function validateEntrypoints(entrypoints, errors) {
  if (!Array.isArray(entrypoints) || entrypoints.length !== 1) {
    errors.push({ path: "#/entrypoints", message: "exactly one panel entrypoint is required" });
    return;
  }
  const entry = entrypoints[0];
  if (!isRecord(entry)) {
    errors.push({ path: "#/entrypoints/0", message: "entrypoint must be an object" });
    return;
  }
  exactKeys(entry, ENTRYPOINT_KEYS, "#/entrypoints/0", errors);
  equal(entry.type, "panel", "#/entrypoints/0/type", errors);
  equal(entry.id, "cinevfx.panel", "#/entrypoints/0/id", errors);
  if (!isRecord(entry.label)) {
    errors.push({ path: "#/entrypoints/0/label", message: "label must be an object" });
  } else {
    exactKeys(entry.label, ["default"], "#/entrypoints/0/label", errors);
    equal(entry.label.default, "CineVFX", "#/entrypoints/0/label/default", errors);
  }
  for (const key of [
    "minimumSize",
    "maximumSize",
    "preferredDockedSize",
    "preferredFloatingSize",
  ]) {
    validateSize(entry[key], `#/entrypoints/0/${key}`, errors);
  }
  if (
    isRecord(entry.minimumSize) &&
    isRecord(entry.maximumSize) &&
    (entry.minimumSize.width > entry.maximumSize.width ||
      entry.minimumSize.height > entry.maximumSize.height)
  ) {
    errors.push({ path: "#/entrypoints/0", message: "minimumSize must not exceed maximumSize" });
  }
}

function validateSize(size, path, errors) {
  if (!isRecord(size)) {
    errors.push({ path, message: "size must be an object" });
    return;
  }
  exactKeys(size, ["height", "width"], path, errors);
  for (const key of ["width", "height"]) {
    if (!Number.isInteger(size[key]) || size[key] < 100 || size[key] > 4096) {
      errors.push({ path: `${path}/${key}`, message: `${key} must be an integer in [100, 4096]` });
    }
  }
}

function validatePermissions(permissions, errors) {
  if (!isRecord(permissions)) {
    errors.push({ path: "#/requiredPermissions", message: "requiredPermissions must be an object" });
    return;
  }
  exactKeys(permissions, ["network"], "#/requiredPermissions", errors);
  const network = permissions.network;
  if (!isRecord(network)) {
    errors.push({ path: "#/requiredPermissions/network", message: "network must be an object" });
    return;
  }
  exactKeys(network, ["domains"], "#/requiredPermissions/network", errors);
  if (!Array.isArray(network.domains)) {
    errors.push({ path: "#/requiredPermissions/network/domains", message: "domains must be an array" });
    return;
  }
  const domains = network.domains;
  if (
    domains.length !== EXPECTED_DOMAINS.length ||
    [...domains].sort().join("\n") !== [...EXPECTED_DOMAINS].sort().join("\n")
  ) {
    errors.push({
      path: "#/requiredPermissions/network/domains",
      message: "network domains must be the four bounded local Mock API origins",
    });
  }
  for (const domain of domains) {
    if (typeof domain !== "string") continue;
    try {
      const url = new URL(domain);
      if (
        !["http:", "https:"].includes(url.protocol) ||
        !["127.0.0.1", "localhost"].includes(url.hostname) ||
        url.port !== "8787" ||
        url.pathname !== "/" ||
        url.search ||
        url.hash
      ) {
        errors.push({ path: "#/requiredPermissions/network/domains", message: `unsupported origin ${domain}` });
      }
    } catch {
      errors.push({ path: "#/requiredPermissions/network/domains", message: `invalid origin ${String(domain)}` });
    }
  }
}

function exactKeys(value, expected, path, errors) {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.join("\n") !== wanted.join("\n")) {
    errors.push({ path, message: `keys must be exactly: ${wanted.join(", ")}` });
  }
}

function equal(actual, expected, path, errors) {
  if (actual !== expected) errors.push({ path, message: `must equal ${JSON.stringify(expected)}` });
}

function nonEmptyString(value, path, errors) {
  if (typeof value !== "string" || value.trim() === "") {
    errors.push({ path, message: "must be a non-empty string" });
  }
}

function stringPattern(value, pattern, path, errors) {
  if (typeof value !== "string" || !pattern.test(value)) {
    errors.push({ path, message: `must match ${pattern}` });
  }
}

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export { EXPECTED_DOMAINS };
