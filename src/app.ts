import cors from "cors";
import express from "express";
import helmet from "helmet";

import { env } from "./lib/env.js";
import { errorHandler, notFound } from "./lib/http.js";
import { healthRouter } from "./routes/health.js";
import { opsRouter } from "./routes/ops.js";
import { hostRouter } from "./routes/host.js";

type OriginDecision = string | boolean;

function parseCorsOrigins(value: string): { any: boolean; origins: string[] } {
  const raw = value.trim();
  if (!raw || raw === "*") return { any: true, origins: [] };
  const origins = raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return { any: false, origins };
}

export function createApp() {
  const app = express();

  if (env.TRUST_PROXY) app.set("trust proxy", 1);

  app.use(helmet());

  const corsCfg = parseCorsOrigins(env.CORS_ORIGIN);
  app.use(
    cors({
      origin(origin, cb) {
        if (corsCfg.any) return cb(null, true);
        // Allow non-browser requests (no Origin header)
        if (!origin) return cb(null, true);
        const allowed = corsCfg.origins.includes(origin);
        const decision: OriginDecision = allowed;
        return cb(null, decision);
      },
      methods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
      allowedHeaders: ["Authorization", "Content-Type"],
      credentials: true,
    })
  );

  app.use(express.json({ limit: "1mb" }));

  app.use(healthRouter);
  app.use(opsRouter);
  app.use(hostRouter);

  app.use(notFound);
  app.use(errorHandler);

  return app;
}
