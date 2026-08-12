import {
  createCinevfxClient,
  createLocalGlowService,
  createPanelWorkflow,
  createPhotoshopGlowHost,
  createTaskController,
  createWriteScopeGuard,
  planGlowEffect,
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

const glowContext = {
  documentId: 1,
  sourceLayerId: 2,
  documentMode: "rgb" as const,
  bitsPerChannel: 8 as const,
  layerKind: "pixel" as const,
  visible: true as const,
  bounds: { x: 0, y: 0, width: 100, height: 100 },
  sourceSnapshot: { documentId: 1, sourceLayerId: 2 },
};
const glowPlan = planGlowEffect(glowContext, {
  color: "#FFD36A",
  intensity: 70,
  size: 36,
  blur: 18,
  blendMode: "screen",
});
glowPlan.kind satisfies "local_glow_plan";
glowPlan.memory.estimatedPeakBytes satisfies number;

const glowHost = createPhotoshopGlowHost();
const localGlow = createLocalGlowService({
  host: glowHost,
  writeGuard: createWriteScopeGuard(),
});
localGlow.apply({
  color: "#FFD36A",
  intensity: 70,
  size: 36,
  blur: 18,
  blendMode: "screen",
});
// @ts-expect-error A glow apply requires every numeric control.
localGlow.apply({ color: "#FFD36A", blendMode: "screen" });
