import { listen } from "../src/http.mjs";

const host = process.env.CINEVFX_MOCK_HOST ?? "127.0.0.1";
const port = Number(process.env.CINEVFX_MOCK_PORT ?? 8787);

const runtime = await listen({ host, port });
console.log(
  JSON.stringify({
    message: "CineVFX Mock API listening",
    baseUrl: runtime.baseUrl,
    endpoints: [
      "POST /v1/assets",
      "POST /v1/jobs",
      "GET /v1/jobs/{id}",
      "GET /v1/jobs/{id}/events",
      "POST /v1/jobs/{id}/cancel",
      "GET /v1/jobs/{id}/manifest",
    ],
  }),
);

function shutdown(signal) {
  console.log(JSON.stringify({ message: "shutting down", signal }));
  runtime.close().finally(() => process.exit(0));
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
