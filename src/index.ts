import { env } from "./lib/env.js";
import { createApp } from "./app.js";
import { getSupabaseService } from "./lib/supabase.js";

const app = createApp();

async function cleanupIcalHistory() {
  try {
    if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) return;
    const supabase = getSupabaseService();
    const cutoff = new Date(Date.now() - env.ICAL_HISTORY_CANCEL_WINDOW_HOURS * 60 * 60 * 1000).toISOString();
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const nowIso = new Date().toISOString();

    const { data, error } = await supabase
      .from("ical_events_history")
      .update({ cancelled: true, updated_at: nowIso })
      .eq("cancelled", false)
      .gte("end_at", todayStart.toISOString())
      .lt("last_seen_at", cutoff)
      .select("id");

    if (error) throw error;
    const count = Array.isArray(data) ? data.length : 0;
    if (count > 0) {
      console.log(`[loondry-backend] ical history cleanup: cancelled ${count} stale event(s)`);
    }
  } catch (err) {
    console.error("[loondry-backend] ical history cleanup error:", err);
  }
}

if (Number.isFinite(env.ICAL_HISTORY_CLEANUP_INTERVAL_MINUTES) && env.ICAL_HISTORY_CLEANUP_INTERVAL_MINUTES > 0) {
  cleanupIcalHistory();
  setInterval(() => {
    cleanupIcalHistory();
  }, env.ICAL_HISTORY_CLEANUP_INTERVAL_MINUTES * 60 * 1000);
}

// ── Keep-alive (anti cold start) ──────────────────────────────────────────────
// Su Render free tier il servizio si spegne dopo ~15 min di inattività e la
// richiesta successiva paga un cold start lento (~15-30s). Un auto-ping
// periodico al proprio /health conta come traffico in entrata e resetta il
// timer di Render, tenendo il servizio sveglio senza dipendere da servizi
// esterni come UptimeRobot.
function startKeepAlive() {
  if (env.NODE_ENV === "test") return;
  if (typeof fetch !== "function") return;
  // Attivo solo quando c'è un URL pubblico (su Render RENDER_EXTERNAL_URL è
  // impostata in automatico); in locale resta spento perché assente.
  const baseUrl = (env.KEEP_ALIVE_URL ?? env.RENDER_EXTERNAL_URL)?.replace(/\/$/, "");
  if (!baseUrl) return;
  if (!Number.isFinite(env.KEEP_ALIVE_INTERVAL_MINUTES) || env.KEEP_ALIVE_INTERVAL_MINUTES <= 0) return;

  const pingUrl = `${baseUrl}/health`;
  const intervalMs = env.KEEP_ALIVE_INTERVAL_MINUTES * 60 * 1000;
  console.log(`[loondry-backend] keep-alive attivo: ping ${pingUrl} ogni ${env.KEEP_ALIVE_INTERVAL_MINUTES} min`);
  setInterval(() => {
    fetch(pingUrl).catch((err) => console.error("[loondry-backend] keep-alive ping fallito:", err));
  }, intervalMs);
}

app.listen(env.PORT, () => {
  console.log(`[loondry-backend] listening on http://localhost:${env.PORT}`);
  startKeepAlive();
});
