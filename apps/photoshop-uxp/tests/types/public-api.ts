import {
  createCinevfxClient,
  createPanelWorkflow,
  createTaskController,
  createWriteScopeGuard,
  validateLayerManifest,
  type CinevfxHttpClient,
} from "../../src/public-api.mjs";

const validation = validateLayerManifest({});
validation.valid satisfies boolean;
validation.errors satisfies Array<{ path: string; message: string }>;
// @ts-expect-error The runtime result deliberately has no value field.
validation.value;

const client: CinevfxHttpClient = createCinevfxClient();
client.baseUrl satisfies string;

const workflow = createPanelWorkflow({
  task: createTaskController(),
  writeGuard: createWriteScopeGuard(),
});
// @ts-expect-error Submit requires endpoint, label, and protected source identity.
workflow.submitJob({});
