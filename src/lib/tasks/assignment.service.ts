import { prisma } from "../prisma.js";
import { TaskRepository } from "./task.repository.js";
import { CandidateRepository } from "./candidate.repository.js";
import { MatchingService } from "./matching.service.js";
import { NotificationService } from "./notification.service.js";
import type { Task, TaskWithCandidates, RespondDto, AssignmentJobResult } from "./types.js";

// ─── Assignment Service ───────────────────────────────────────────────────────
// Core business logic: auto-assign, respond, fallback, timeout.

const TIMEOUT_MINUTES = 20;

export const AssignmentService = {

  // ── 1. Daily job: assign tomorrow's tasks ──────────────────────────────────

  async runDailyAssignment(): Promise<AssignmentJobResult> {
    const result: AssignmentJobResult = { processed: 0, notified: 0, atRisk: 0, errors: [] };

    const tasks = await TaskRepository.findTomorrowUnassigned();
    console.log(`[assignment] ${tasks.length} task da assegnare per domani`);

    for (const task of tasks) {
      try {
        const notified = await AssignmentService.initializeAssignment(task);
        result.processed++;
        if (notified) result.notified++;
        else result.atRisk++;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        result.errors.push(`Task ${task.id}: ${msg}`);
        console.error(`[assignment] errore task ${task.id}:`, err);
      }
    }

    return result;
  },

  // ── 2. Initialize a task: find candidates, notify first ───────────────────

  async initializeAssignment(task: Task): Promise<boolean> {
    // Find and rank all eligible cleaners
    const ranked = await MatchingService.getAvailableCleaners(task);

    if (ranked.length === 0) {
      await TaskRepository.updateStatus(task.id, "A_RISCHIO");
      await TaskRepository.log(task.id, "NO_CANDIDATES", { taskId: task.id });
      return false;
    }

    // Persist the ordered candidate list (inside a transaction)
    await prisma.$transaction(async (tx) => {
      await tx.taskCandidate.createMany({
        data: ranked.map((r, idx) => ({
          taskId: task.id,
          cleanerId: r.cleaner.id,
          orderIndex: idx,
        })),
        skipDuplicates: true,
      });

      await tx.task.update({
        where: { id: task.id },
        data: { status: "IN_ATTESA", currentCandidateIndex: 0 },
      });
    });

    await TaskRepository.log(task.id, "CANDIDATES_CREATED", {
      count: ranked.length,
      first: ranked[0]?.cleaner.id,
    });

    // Notify the first candidate
    return AssignmentService._notifyCandidate(task.id, 0);
  },

  // ── 3. Handle cleaner response ─────────────────────────────────────────────

  async handleResponse(taskId: string, dto: RespondDto): Promise<TaskWithCandidates> {
    const task = await TaskRepository.findById(taskId);
    if (!task) throw new Error(`Task ${taskId} non trovato`);

    if (task.status === "ASSEGNATO" || task.status === "COMPLETATO") {
      throw new Error(`Task ${taskId} già in stato ${task.status}`);
    }

    const candidate = task.candidates.find(
      (c) => c.cleanerId === dto.cleanerId && c.status === "PENDING"
    );
    if (!candidate) {
      throw new Error(`Nessuna richiesta PENDING per cleaner ${dto.cleanerId} su task ${taskId}`);
    }

    if (dto.action === "ACCEPT") {
      return AssignmentService._accept(task, candidate.id, dto.cleanerId);
    } else {
      return AssignmentService._reject(task, candidate.id, dto.rejectReason);
    }
  },

  // ── 4. Accept ──────────────────────────────────────────────────────────────

  async _accept(
    task: TaskWithCandidates,
    candidateId: string,
    cleanerId: string
  ): Promise<TaskWithCandidates> {
    await prisma.$transaction(async (tx) => {
      // Mark candidate as accepted
      await tx.taskCandidate.update({
        where: { id: candidateId },
        data: { status: "ACCEPTED", respondedAt: new Date() },
      });

      // Cancel all other pending candidates
      await tx.taskCandidate.updateMany({
        where: { taskId: task.id, id: { not: candidateId }, status: "PENDING" },
        data: { status: "CANCELLED" },
      });

      // Assign task
      await tx.task.update({
        where: { id: task.id },
        data: { status: "ASSEGNATO", cleanerId },
      });
    });

    await TaskRepository.log(task.id, "ACCEPTED", { cleanerId });

    // Update acceptance rate (fire-and-forget)
    void (await import("./cleaner.repository.js")).CleanerRepository
      .updateAcceptanceRate(cleanerId)
      .catch(() => {});

    return TaskRepository.findById(task.id) as Promise<TaskWithCandidates>;
  },

  // ── 5. Reject → fallback ───────────────────────────────────────────────────

  async _reject(
    task: TaskWithCandidates,
    candidateId: string,
    rejectReason?: string
  ): Promise<TaskWithCandidates> {
    const candidate = task.candidates.find((c) => c.id === candidateId)!;

    await CandidateRepository.updateStatus(candidateId, "REJECTED", {
      respondedAt: new Date(),
      rejectReason,
    });

    await TaskRepository.log(task.id, "REJECTED", {
      cleanerId: candidate.cleanerId,
      reason: rejectReason,
    });

    // Update acceptance rate (fire-and-forget)
    void (await import("./cleaner.repository.js")).CleanerRepository
      .updateAcceptanceRate(candidate.cleanerId)
      .catch(() => {});

    // Move to next candidate
    await AssignmentService._fallback(task.id);

    return TaskRepository.findById(task.id) as Promise<TaskWithCandidates>;
  },

  // ── 6. Fallback: try the next candidate ───────────────────────────────────

  async _fallback(taskId: string): Promise<void> {
    const task = await TaskRepository.findById(taskId);
    if (!task) return;

    const nextIndex = task.currentCandidateIndex + 1;
    await TaskRepository.updateStatus(taskId, "IN_ATTESA", {
      currentCandidateIndex: nextIndex,
    });

    const notified = await AssignmentService._notifyCandidate(taskId, nextIndex);

    if (!notified) {
      // No more candidates — mark at risk
      await TaskRepository.updateStatus(taskId, "A_RISCHIO");
      await TaskRepository.log(taskId, "A_RISCHIO", { reason: "Nessun altro candidato disponibile" });
      console.warn(`[assignment] Task ${taskId} → A_RISCHIO: candidati esauriti`);
    }
  },

  // ── 7. Timeout handling ───────────────────────────────────────────────────

  async handleTimeouts(): Promise<number> {
    const timedOut = await CandidateRepository.findTimedOut(TIMEOUT_MINUTES);
    let count = 0;

    for (const candidate of timedOut) {
      try {
        await CandidateRepository.updateStatus(candidate.id, "TIMEOUT", {
          respondedAt: new Date(),
        });
        await TaskRepository.log(candidate.taskId, "TIMEOUT", {
          cleanerId: candidate.cleanerId,
          minutesWaited: TIMEOUT_MINUTES,
        });
        await AssignmentService._fallback(candidate.taskId);
        count++;
      } catch (err) {
        console.error(`[timeout] errore candidate ${candidate.id}:`, err);
      }
    }

    return count;
  },

  // ── 8. Internal: notify a specific candidate by index ─────────────────────

  async _notifyCandidate(taskId: string, index: number): Promise<boolean> {
    const candidate = await CandidateRepository.findByTaskAndIndex(taskId, index);
    if (!candidate) return false;

    // Load task for notification body
    const task = await prisma.task.findUnique({ where: { id: taskId } });
    if (!task) return false;

    const cleaner = (candidate as { cleaner?: { id: string; teamMemberId?: string | null } }).cleaner;
    if (!cleaner?.teamMemberId) {
      // No push subscription linked — skip notification, still advance candidate
      await CandidateRepository.updateStatus(candidate.id, "PENDING", {
        notifiedAt: new Date(),
      });
      return true;
    }

    const sent = await NotificationService.notifyCleaner({
      teamMemberId: cleaner.teamMemberId,
      assignmentId: candidate.id,
      taskId,
      dateLabel: task.date.toLocaleDateString("it-IT", {
        weekday: "long",
        day: "2-digit",
        month: "long",
      }),
      timeLabel: `${fmt(task.checkinTime)} → ${fmt(task.checkoutTime)}`,
    });

    await CandidateRepository.updateStatus(candidate.id, "PENDING", {
      notifiedAt: new Date(),
    });

    await TaskRepository.log(taskId, "NOTIFIED", {
      cleanerId: cleaner.id,
      index,
      pushSent: sent,
    });

    return true;
  },

  // ── 9. Manual trigger: auto-assign a single task now ─────────────────────

  async autoAssignNow(taskId: string): Promise<TaskWithCandidates> {
    const task = await TaskRepository.findById(taskId);
    if (!task) throw new Error(`Task ${taskId} non trovato`);
    if (task.status !== "DA_ASSEGNARE" && task.status !== "A_RISCHIO") {
      throw new Error(`Task ${taskId} non può essere riassegnato (stato: ${task.status})`);
    }

    await AssignmentService.initializeAssignment(task);
    return TaskRepository.findById(taskId) as Promise<TaskWithCandidates>;
  },
};

function fmt(date: Date): string {
  return date.toLocaleTimeString("it-IT", { hour: "2-digit", minute: "2-digit" });
}
