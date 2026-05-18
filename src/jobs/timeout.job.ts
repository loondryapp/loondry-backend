import cron from "node-cron";
import { AssignmentService } from "../lib/tasks/assignment.service.js";

// ─── Job: Timeout automatico ──────────────────────────────────────────────────
// Ogni 5 minuti — trova candidature PENDING scadute e passa al prossimo

export function startTimeoutJob() {
  cron.schedule(
    "*/5 * * * *",           // ogni 5 minuti
    async () => {
      try {
        const count = await AssignmentService.handleTimeouts();
        if (count > 0) {
          console.log(`[job:timeout] ${count} candidature scadute → fallback avviato`);
        }
      } catch (err) {
        console.error("[job:timeout] errore:", err);
      }
    }
  );

  console.log("[job:timeout] schedulato — ogni 5 minuti");
}
