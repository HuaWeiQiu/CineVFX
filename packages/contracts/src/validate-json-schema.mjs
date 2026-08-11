import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCHEMA_DIR = path.join(PACKAGE_ROOT, "schemas");

const schemaCache = new Map();

/**
 * Minimal JSON Schema (draft 2020-12 subset) validator tailored to CineVFX contracts.
 * Supports: type, const, enum, required, properties, additionalProperties,
 * pattern, min/max Length/Items/Properties, minimum/maximum/exclusiveMinimum,
 * uniqueItems, oneOf/allOf/anyOf/not/if-then-else, contains, $ref, $defs.
 */
export async function loadSchema(schemaFileName) {
  const absolute = path.join(SCHEMA_DIR, schemaFileName);
  if (schemaCache.has(absolute)) {
    return schemaCache.get(absolute);
  }
  const raw = await readFile(absolute, "utf8");
  const schema = JSON.parse(raw);
  schemaCache.set(absolute, schema);
  return schema;
}

export async function validateAgainstSchema(instance, schemaFileName) {
  const schema = await loadSchema(schemaFileName);
  const ctx = {
    schemaDir: SCHEMA_DIR,
    cache: schemaCache,
    rootSchema: schema,
    rootFile: path.join(SCHEMA_DIR, schemaFileName),
  };
  const errors = [];
  await applySchema(instance, schema, "#", errors, ctx, schema, ctx.rootFile);
  return {
    valid: errors.length === 0,
    errors,
  };
}

async function resolveRef(ref, currentSchema, currentFile, ctx) {
  if (!ref.startsWith("#") && ref.includes("#")) {
    const [filePart, fragment = ""] = ref.split("#");
    const targetFile = path.resolve(path.dirname(currentFile), filePart);
    let targetSchema = ctx.cache.get(targetFile);
    if (!targetSchema) {
      const raw = await readFile(targetFile, "utf8");
      targetSchema = JSON.parse(raw);
      ctx.cache.set(targetFile, targetSchema);
    }
    const pointer = fragment.startsWith("/") ? fragment : fragment ? `/${fragment}` : "";
    return {
      schema: pointer ? getByPointer(targetSchema, pointer) : targetSchema,
      file: targetFile,
      root: targetSchema,
    };
  }

  if (ref.startsWith("#")) {
    const pointer = ref.slice(1);
    return {
      schema: pointer ? getByPointer(currentSchema, pointer) : currentSchema,
      file: currentFile,
      root: currentSchema,
    };
  }

  const targetFile = path.resolve(path.dirname(currentFile), ref);
  let targetSchema = ctx.cache.get(targetFile);
  if (!targetSchema) {
    const raw = await readFile(targetFile, "utf8");
    targetSchema = JSON.parse(raw);
    ctx.cache.set(targetFile, targetSchema);
  }
  return { schema: targetSchema, file: targetFile, root: targetSchema };
}

function getByPointer(document, pointer) {
  if (!pointer || pointer === "") {
    return document;
  }
  const parts = pointer.split("/").slice(1).map((part) =>
    part.replaceAll("~1", "/").replaceAll("~0", "~"),
  );
  let current = document;
  for (const part of parts) {
    if (current == null || typeof current !== "object" || !(part in current)) {
      throw new Error(`Unable to resolve JSON pointer ${pointer}`);
    }
    current = current[part];
  }
  return current;
}

function typeOf(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function matchesType(value, typeName) {
  if (typeName === "integer") {
    return typeof value === "number" && Number.isInteger(value);
  }
  if (typeName === "number") {
    return typeof value === "number" && Number.isFinite(value);
  }
  return typeOf(value) === typeName;
}

async function applySchema(instance, schema, instancePath, errors, ctx, rootSchema, rootFile) {
  if (schema === true) return;
  if (schema === false) {
    errors.push({ path: instancePath, message: "schema is false" });
    return;
  }
  if (typeof schema !== "object" || schema === null) {
    throw new Error(`Invalid schema at ${instancePath}`);
  }

  if (schema.$ref) {
    const resolved = await resolveRef(schema.$ref, rootSchema, rootFile, ctx);
    await applySchema(
      instance,
      resolved.schema,
      instancePath,
      errors,
      ctx,
      resolved.root,
      resolved.file,
    );
    // Sibling keywords beside $ref are ignored in this subset.
    return;
  }

  if (Object.hasOwn(schema, "const") && !deepEqual(instance, schema.const)) {
    errors.push({
      path: instancePath,
      message: `expected const ${JSON.stringify(schema.const)}`,
    });
  }

  if (schema.enum && !schema.enum.some((item) => deepEqual(item, instance))) {
    errors.push({
      path: instancePath,
      message: `expected one of ${JSON.stringify(schema.enum)}`,
    });
  }

  if (schema.type) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((typeName) => matchesType(instance, typeName))) {
      errors.push({
        path: instancePath,
        message: `expected type ${types.join("|")}, got ${typeOf(instance)}`,
      });
      return;
    }
  }

  if (typeof instance === "string") {
    if (schema.minLength !== undefined && instance.length < schema.minLength) {
      errors.push({ path: instancePath, message: `string shorter than ${schema.minLength}` });
    }
    if (schema.maxLength !== undefined && instance.length > schema.maxLength) {
      errors.push({ path: instancePath, message: `string longer than ${schema.maxLength}` });
    }
    if (schema.pattern) {
      const re = new RegExp(schema.pattern);
      if (!re.test(instance)) {
        errors.push({ path: instancePath, message: `string does not match pattern ${schema.pattern}` });
      }
    }
  }

  if (typeof instance === "number") {
    if (schema.minimum !== undefined && instance < schema.minimum) {
      errors.push({ path: instancePath, message: `number < minimum ${schema.minimum}` });
    }
    if (schema.maximum !== undefined && instance > schema.maximum) {
      errors.push({ path: instancePath, message: `number > maximum ${schema.maximum}` });
    }
    if (schema.exclusiveMinimum !== undefined && instance <= schema.exclusiveMinimum) {
      errors.push({
        path: instancePath,
        message: `number <= exclusiveMinimum ${schema.exclusiveMinimum}`,
      });
    }
    if (schema.exclusiveMaximum !== undefined && instance >= schema.exclusiveMaximum) {
      errors.push({
        path: instancePath,
        message: `number >= exclusiveMaximum ${schema.exclusiveMaximum}`,
      });
    }
  }

  if (Array.isArray(instance)) {
    if (schema.minItems !== undefined && instance.length < schema.minItems) {
      errors.push({ path: instancePath, message: `array shorter than ${schema.minItems}` });
    }
    if (schema.maxItems !== undefined && instance.length > schema.maxItems) {
      errors.push({ path: instancePath, message: `array longer than ${schema.maxItems}` });
    }
    if (schema.uniqueItems) {
      for (let i = 0; i < instance.length; i += 1) {
        for (let j = i + 1; j < instance.length; j += 1) {
          if (deepEqual(instance[i], instance[j])) {
            errors.push({ path: instancePath, message: "array items are not unique" });
            i = instance.length;
            break;
          }
        }
      }
    }
    if (schema.items !== undefined) {
      for (let i = 0; i < instance.length; i += 1) {
        await applySchema(
          instance[i],
          schema.items,
          `${instancePath}/${i}`,
          errors,
          ctx,
          rootSchema,
          rootFile,
        );
      }
    }
    if (schema.contains !== undefined) {
      let matched = false;
      for (const item of instance) {
        const nested = [];
        await applySchema(item, schema.contains, instancePath, nested, ctx, rootSchema, rootFile);
        if (nested.length === 0) {
          matched = true;
          break;
        }
      }
      if (!matched) {
        errors.push({ path: instancePath, message: "array does not contain required item" });
      }
    }
  }

  if (instance && typeof instance === "object" && !Array.isArray(instance)) {
    const keys = Object.keys(instance);
    if (schema.minProperties !== undefined && keys.length < schema.minProperties) {
      errors.push({
        path: instancePath,
        message: `object has fewer than ${schema.minProperties} properties`,
      });
    }
    if (schema.maxProperties !== undefined && keys.length > schema.maxProperties) {
      errors.push({
        path: instancePath,
        message: `object has more than ${schema.maxProperties} properties`,
      });
    }
    if (Array.isArray(schema.required)) {
      for (const key of schema.required) {
        if (!Object.hasOwn(instance, key)) {
          errors.push({ path: instancePath, message: `missing required property ${key}` });
        }
      }
    }
    if (schema.propertyNames) {
      for (const key of keys) {
        await applySchema(
          key,
          schema.propertyNames,
          `${instancePath}/${key}`,
          errors,
          ctx,
          rootSchema,
          rootFile,
        );
      }
    }
    if (schema.properties) {
      for (const [key, subschema] of Object.entries(schema.properties)) {
        if (Object.hasOwn(instance, key)) {
          await applySchema(
            instance[key],
            subschema,
            `${instancePath}/${key}`,
            errors,
            ctx,
            rootSchema,
            rootFile,
          );
        }
      }
    }
    if (schema.additionalProperties === false) {
      const allowed = new Set(Object.keys(schema.properties ?? {}));
      for (const key of keys) {
        if (!allowed.has(key)) {
          errors.push({
            path: `${instancePath}/${key}`,
            message: "additional property not allowed",
          });
        }
      }
    } else if (schema.additionalProperties && typeof schema.additionalProperties === "object") {
      const known = new Set(Object.keys(schema.properties ?? {}));
      for (const key of keys) {
        if (!known.has(key)) {
          await applySchema(
            instance[key],
            schema.additionalProperties,
            `${instancePath}/${key}`,
            errors,
            ctx,
            rootSchema,
            rootFile,
          );
        }
      }
    }
  }

  if (schema.allOf) {
    for (const sub of schema.allOf) {
      await applySchema(instance, sub, instancePath, errors, ctx, rootSchema, rootFile);
    }
  }

  if (schema.anyOf) {
    const ok = [];
    for (const sub of schema.anyOf) {
      const nested = [];
      await applySchema(instance, sub, instancePath, nested, ctx, rootSchema, rootFile);
      if (nested.length === 0) ok.push(true);
    }
    if (ok.length === 0) {
      errors.push({ path: instancePath, message: "anyOf failed" });
    }
  }

  if (schema.oneOf) {
    let matches = 0;
    for (const sub of schema.oneOf) {
      const nested = [];
      await applySchema(instance, sub, instancePath, nested, ctx, rootSchema, rootFile);
      if (nested.length === 0) matches += 1;
    }
    if (matches !== 1) {
      errors.push({ path: instancePath, message: `oneOf matched ${matches} schemas` });
    }
  }

  if (schema.not) {
    const nested = [];
    await applySchema(instance, schema.not, instancePath, nested, ctx, rootSchema, rootFile);
    if (nested.length === 0) {
      errors.push({ path: instancePath, message: "not schema matched" });
    }
  }

  if (schema.if !== undefined) {
    const nested = [];
    await applySchema(instance, schema.if, instancePath, nested, ctx, rootSchema, rootFile);
    if (nested.length === 0) {
      if (schema.then !== undefined) {
        await applySchema(instance, schema.then, instancePath, errors, ctx, rootSchema, rootFile);
      }
    } else if (schema.else !== undefined) {
      await applySchema(instance, schema.else, instancePath, errors, ctx, rootSchema, rootFile);
    }
  }
}

function deepEqual(a, b) {
  if (Object.is(a, b)) return true;
  if (typeof a !== typeof b) return false;
  if (a && b && typeof a === "object") {
    if (Array.isArray(a) !== Array.isArray(b)) return false;
    if (Array.isArray(a)) {
      if (a.length !== b.length) return false;
      return a.every((value, index) => deepEqual(value, b[index]));
    }
    const aKeys = Object.keys(a);
    const bKeys = Object.keys(b);
    if (aKeys.length !== bKeys.length) return false;
    return aKeys.every((key) => Object.hasOwn(b, key) && deepEqual(a[key], b[key]));
  }
  return false;
}

export function clearSchemaCache() {
  schemaCache.clear();
}
