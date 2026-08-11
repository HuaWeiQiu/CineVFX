import { validateAgainstSchema } from "./validate-json-schema.mjs";
import { validateManifestSemantics } from "./manifest.mjs";
import { validateJobRequestSemantics } from "./job-request.mjs";
import { validateJobEventSemantics } from "./job-event.mjs";

const SCHEMA_BY_KIND = Object.freeze({
  EffectSpec: "effect-spec.schema.json",
  AssetDescriptor: "asset-descriptor.schema.json",
  JobRequest: "job-request.schema.json",
  JobStatus: "job-status.schema.json",
  JobEvent: "job-event.schema.json",
  LayerManifest: "layer-manifest.schema.json",
});

/**
 * Structural schema validation plus document-kind semantic rules.
 */
export async function validateDocument(kind, instance) {
  const schemaFile = SCHEMA_BY_KIND[kind];
  if (!schemaFile) {
    return {
      valid: false,
      errors: [{ path: "#", message: `unknown document kind ${kind}` }],
    };
  }

  const schemaResult = await validateAgainstSchema(instance, schemaFile);
  const errors = [...schemaResult.errors];

  if (kind === "JobRequest") {
    const semantic = validateJobRequestSemantics(instance);
    errors.push(...semantic.errors);
  } else if (kind === "JobEvent") {
    const semantic = validateJobEventSemantics(instance);
    errors.push(...semantic.errors);
  } else if (kind === "LayerManifest") {
    const semantic = validateManifestSemantics(instance);
    errors.push(...semantic.errors);
  }

  return { valid: errors.length === 0, errors };
}
