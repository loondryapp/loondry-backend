import { env } from "../env.js";

// ─── Notification Service ─────────────────────────────────────────────────────
// Sends push notifications to cleaners via the frontend /api/send-push endpoint.
// Decoupled: the actual Web Push delivery lives in Next.js (web-push package).

export const NotificationService = {
  async notifyCleaner(params: {
    teamMemberId: string;
    assignmentId: string;
    taskId: string;
    propertyName?: string;
    dateLabel?: string;
    timeLabel?: string;
  }): Promise<boolean> {
    const appUrl = env.FRONTEND_URL ?? "http://localhost:3000";

    const body = [params.propertyName, params.dateLabel, params.timeLabel]
      .filter(Boolean)
      .join(" · ");

    try {
      const res = await fetch(`${appUrl}/api/send-push`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          teamMemberId: params.teamMemberId,
          assignmentId: params.assignmentId,
          taskId: params.taskId,
          title: "Nuovo task assegnato 🧹",
          body: body || "Hai un nuovo task. Confermi la disponibilità?",
        }),
      });

      if (!res.ok) {
        const text = await res.text();
        console.warn(`[notify] push failed for ${params.teamMemberId}: ${res.status} ${text}`);
        return false;
      }

      return true;
    } catch (err) {
      console.error("[notify] push error:", err);
      return false;
    }
  },

  async alertLaundry(params: {
    laundryId: string;
    taskIds: string[];
  }): Promise<void> {
    // Placeholder: extend with email / Slack / Telegram when needed
    console.warn(
      `[alert] Lavanderia ${params.laundryId} — ${params.taskIds.length} task non risolti alle 18:00:`,
      params.taskIds
    );
  },
};
