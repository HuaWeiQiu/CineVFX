import { readFile } from "node:fs/promises";
import { posix, resolve } from "node:path";
import { Script } from "node:vm";

const IMPORT_RE = /^[ \t]*import\s*\{([\s\S]*?)\}\s*from\s*["']([^"']+)["'];?[ \t]*$/gm;
const LOCAL_EXPORT_RE = /^[ \t]*export\s*\{([\s\S]*?)\};?[ \t]*$/gm;

export async function bundleClassicEntry({ rootDir, entry = "index.js" }) {
  const modules = new Map();

  async function load(moduleId) {
    if (modules.has(moduleId)) return;
    const source = await readFile(resolve(rootDir, moduleId), "utf8");
    const imports = collectImports(source, moduleId);
    modules.set(moduleId, { source, imports });
    for (const item of imports) await load(item.moduleId);
  }

  const entryId = normalizeModuleId("", entry);
  await load(entryId);

  const factories = [];
  for (const [moduleId, module] of modules) {
    const transformed = transformModule(module.source, moduleId);
    factories.push(
      `${JSON.stringify(moduleId)}: function(module, exports, __require) {\n${transformed}\n}`,
    );
  }

  const bundle = `(function () {\n"use strict";\nconst __modules = {\n${factories.join(",\n")}\n};\nconst __cache = Object.create(null);\nfunction __require(id) {\n  if (__cache[id]) return __cache[id].exports;\n  const factory = __modules[id];\n  if (!factory) throw new Error("CineVFX bundle module not found: " + id);\n  const module = { exports: {} };\n  __cache[id] = module;\n  factory(module, module.exports, __require);\n  return module.exports;\n}\n__require(${JSON.stringify(entryId)});\n})();\n`;
  new Script(bundle, { filename: "cinevfx-uxp-bundle.js" });
  return bundle;
}

function collectImports(source, parentId) {
  const imports = [];
  for (const match of source.matchAll(IMPORT_RE)) {
    imports.push({
      clause: match[1],
      specifier: match[2],
      moduleId: normalizeModuleId(parentId, match[2]),
    });
  }
  return imports;
}

function transformModule(source, moduleId) {
  const exported = [];
  let out = source.replace(IMPORT_RE, (_whole, clause, specifier) => {
    const destructuring = clause
      .split(",")
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => part.replace(/\s+as\s+/, ": "))
      .join(", ");
    return `const { ${destructuring} } = __require(${JSON.stringify(normalizeModuleId(moduleId, specifier))});`;
  });

  out = out.replace(
    /\bexport\s+(const|let|var|function|class)\s+([A-Za-z_$][A-Za-z0-9_$]*)/g,
    (_whole, kind, name) => {
      exported.push({ publicName: name, localName: name });
      return `${kind} ${name}`;
    },
  );

  out = out.replace(LOCAL_EXPORT_RE, (_whole, clause) => {
    for (const item of clause.split(",").map((part) => part.trim()).filter(Boolean)) {
      const [localName, publicName = localName] = item.split(/\s+as\s+/);
      exported.push({ publicName, localName });
    }
    return "";
  });

  if (/^[ \t]*(?:import|export)\b/m.test(out)) {
    throw new Error(`unsupported ESM syntax remains in ${moduleId}`);
  }
  if (exported.length > 0) {
    const properties = exported.map(({ publicName, localName }) => `${JSON.stringify(publicName)}: ${localName}`);
    out += `\nObject.assign(exports, { ${properties.join(", ")} });`;
  }
  return `${out}\n//# sourceURL=${moduleId}`;
}

function normalizeModuleId(parentId, specifier) {
  if (typeof specifier !== "string" || (!specifier.startsWith("./") && !specifier.startsWith("../") && parentId)) {
    throw new Error(`only relative local imports are supported: ${String(specifier)}`);
  }
  const base = parentId ? posix.dirname(parentId) : ".";
  const normalized = posix.normalize(posix.join(base, specifier));
  if (normalized === ".." || normalized.startsWith("../") || posix.isAbsolute(normalized)) {
    throw new Error(`module escapes package root: ${specifier}`);
  }
  if (!/\.(?:js|mjs)$/.test(normalized)) {
    throw new Error(`module must use an explicit .js or .mjs extension: ${specifier}`);
  }
  return normalized.replace(/^\.\//, "");
}

export { transformModule };
