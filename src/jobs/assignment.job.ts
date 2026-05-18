import cron from "node-cron";
import { AssignmentService } from "../lib/tasks/assignment.service.js";
import { TaskRepository } from "../lib/tasks/task.repository.js";
import { NotificationService } from "../lib/tasks/notification.service.js";

// ─── Job: Assignment automatico ───────────────────────────────────────────────
// Ogni giorno alle 15:00 — assegna i task di domani con DA_ASSEGNARE

export function startAssignmentJob() {
  cron.schedule(
    "0 15 * * *",            // ogni giorno alle 15:00
    async () => {
      console.log("[job:assignment] avvio assegnazione giornaliera...");
      try {
        const result = await AssignmentService.runDailyAssignment();
        console.log(
          `[job:assignment] completato — processati: ${result.processed}, notificati: ${result.notified}, a rischio: ${result.atRisk}`
        );
        if (result.errors.length > 0) {
          console.error("[job:assignment] errori:", result.errors);
        }
      } catch (err) {
        console.error("[job:assignment] errore critico:", err);
      }
    },
    { timezone: "Europe/Rome" }
  );

  console.log("[job:assignment] schedulato — ogni giorno alle 15:00 (Europe/Rome)");
}

// ─── Job: Alert deadline ──────────────────────────────────────────────────────
// Ogni giorno alle 18:00 — alert per task non risolti

export function startDeadlineAlertJob() {
  cron.schedule(
    "0 18 * * *",
    async () => {
      console.log("[job:deadline] controllo task non risolti...");
      try {
        const unresolved = await TaskRepository.findTodayUnresolved();

        if (unresolved.length === 0) {
          console.log("[job:deadline] tutti i task risolti ✓");
          return;
        }

        // Group by laundry
        const byLaundry = new Map<string, string[]>();
        for (const task of unresolved) {
          const key = task.laundryId ?? "unknown";
          const list = byLaundry.get(key) ?? [];
          list.push(task.id);
          byLaundry.set(key, list);
        }

        for (const [laundryId, taskIds] of byLaundry) {
          await NotificationService.alertLaundry({ laundryId, taskIds });
        }

        console.log(`[job:deadline] alert inviato per ${unresolved.length} task non risolti`);
      } catch (err) {
        console.error("[job:deadline] errore:", err);
      }
    },
    { timezone: "Europe/Rome" }
  );

  console.log("[job:deadline] schedulato — ogni giorno alle 18:00 (Europe/Rome)");
}
