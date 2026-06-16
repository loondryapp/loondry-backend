import dotenv from "dotenv";
import { z } from "zod";

dotenv.config();

const EnvSchema = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  PORT: z.coerce.number().default(8080),
  // Comma-separated list or "*".
  CORS_ORIGIN: z.string().default("http://localhost:5173"),
  TRUST_PROXY: z
    .enum(["true", "false"])
    .default("true")
    .transform((v) => v === "true"),
  LOG_LEVEL: z.string().default("info"),

  // Supabase (optional for now; enable when you wire persistence/auth)
  SUPABASE_URL: z.string().url().optional(),
  SUPABASE_ANON_KEY: z.string().optional(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().optional(),
  ICAL_HISTORY_CLEANUP_INTERVAL_MINUTES: z.coerce.number().default(360),
  ICAL_HISTORY_CANCEL_WINDOW_HOURS: z.coerce.number().default(24),

  // Prisma / direct DB connection (Supabase → Settings → Database → Connection string)
  DATABASE_URL: z.string().url().optional(),

  // Frontend URL for push notification delivery
  FRONTEND_URL: z.string().url().optional(),

  // Keep-alive: il free tier di Render spegne il servizio dopo ~15 min di
  // inattività (poi la prima richiesta paga un cold start lento, ~15-30s). Un
  // auto-ping periodico tiene il servizio sveglio. RENDER_EXTERNAL_URL è
  // impostata automaticamente da Render; KEEP_ALIVE_URL permette un override.
  RENDER_EXTERNAL_URL: z.string().url().optional(),
  KEEP_ALIVE_URL: z.string().url().optional(),
  KEEP_ALIVE_INTERVAL_MINUTES: z.coerce.number().default(10),
});

export const env = EnvSchema.parse(process.env);
