import { bindings, defineConfig } from "cf/config";
import * as entrypoint from "./worker/src/index.ts" with { type: "cf-worker" };

export default defineConfig({
  worker: {
    name: "pipe-calc-3d-cloud",
    compatibilityDate: "2026-11-17",
    entrypoint,
    assets: {
      notFoundHandling: "single-page-application",
      runWorkerFirst: ["/api/*"],
    },
    env: {
      PIPE_CALC_KV: bindings.kv({ id: "b784cad869d041acb65f6a4dd8d2a5de" }),
      RATE_LIMIT_KV: bindings.kv({ id: "881e01edca014d0c8236b3c61688a937" }),
      COMPUTE_BASE_URL: bindings.text(
        "https://ibalamayaka-debug--pipe-calc-3d-openfoam-fastapi-app.us-east.modal.run"
      ),
      COMPUTE_AUTH_TOKEN: bindings.secret(),
      ALLOWED_ORIGIN: bindings.text("*"),
      MAX_RUNS_PER_IP_PER_HOUR: bindings.text("30"),
      ASSETS: bindings.assets(),
    },
  },
});
