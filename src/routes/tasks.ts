import { Router, type Request, type Response, type NextFunction } from "express";

import { TaskRepository } from "../lib/tasks/task.repository.js";
import { AssignmentService } from "../lib/tasks/assignment.service.js";
import { TaskStatus } from "../lib/tasks/types.js";

export const tasksRouter = Router();

// ── GET /tasks ────────────────────────────────────────────────────────────────
// Query: status, laundryId, date, dateFrom, dateTo

tasksRouter.get("/tasks", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { status, laundryId, date, dateFrom, dateTo } = req.query;

    const tasks = await TaskRepository.findAll({
      status: status as TaskStatus | undefined,
      laundryId: laundryId as string | undefined,
      date: date ? new Date(date as string) : undefined,
      dateFrom: dateFrom ? new Date(dateFrom as string) : undefined,
      dateTo: dateTo ? new Date(dateTo as string) : undefined,
    });

    res.json({ data: tasks, count: tasks.length });
  } catch (err) {
    next(err);
  }
});

// ── GET /tasks/:id ────────────────────────────────────────────────────────────

tasksRouter.get("/tasks/:id", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const task = await TaskRepository.findById(req.params.id!);
    if (!task) return res.status(404).json({ error: "Task non trovato" });
    res.json({ data: task });
  } catch (err) {
    next(err);
  }
});

// ── POST /tasks ───────────────────────────────────────────────────────────────
// Crea un task. Se è last-minute (data = oggi), avvia subito il matching.

tasksRouter.post("/tasks", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { apartmentId, hostId, laundryId, date, checkinTime, checkoutTime, priority, notes } = req.body;

    if (!apartmentId || !hostId || !date || !checkinTime || !checkoutTime) {
      return res.status(400).json({
        error: "Campi obbligatori: apartmentId, hostId, date, checkinTime, checkoutTime",
      });
    }

    const task = await TaskRepository.create({
      apartmentId,
      hostId,
      laundryId,
      date,
      checkinTime,
      checkoutTime,
      priority: priority ?? 0,
      notes,
    });

    await TaskRepository.log(task.id, "CREATED", { source: "api" });

    // Last-minute: se il task è per oggi → matching immediato
    const taskDate = new Date(date);
    const today = new Date();
    const isToday =
      taskDate.getFullYear() === today.getFullYear() &&
      taskDate.getMonth() === today.getMonth() &&
      taskDate.getDate() === today.getDate();

    if (isToday) {
      // Fire-and-forget: non bloccare la risposta
      AssignmentService.initializeAssignment(task).catch((err) =>
        console.error(`[tasks] errore last-minute assignment task ${task.id}:`, err)
      );
    }

    res.status(201).json({ data: task, autoAssignStarted: isToday });
  } catch (err) {
    next(err);
  }
});

// ── POST /tasks/auto-assign ───────────────────────────────────────────────────
// Avvia manualmente l'assegnazione per un task specifico o per tutti quelli di domani.

tasksRouter.post("/tasks/auto-assign", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { taskId } = req.body;

    if (taskId) {
      // Single task
      const task = await AssignmentService.autoAssignNow(taskId);
      return res.json({ data: task });
    }

    // All tomorrow's unassigned tasks
    const result = await AssignmentService.runDailyAssignment();
    res.json({ data: result });
  } catch (err) {
    next(err);
  }
});

// ── POST /tasks/:id/notify-cleaner ────────────────────────────────────────────
// Reinvia manualmente la notifica al candidato corrente.

tasksRouter.post("/tasks/:id/notify-cleaner", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const task = await TaskRepository.findById(req.params.id!);
    if (!task) return res.status(404).json({ error: "Task non trovato" });
    if (task.status !== "IN_ATTESA") {
      return res.status(400).json({ error: `Task non in stato IN_ATTESA (stato: ${task.status})` });
    }

    const sent = await (AssignmentService as { _notifyCandidate: (taskId: string, idx: number) => Promise<boolean> })
      ._notifyCandidate(task.id, task.currentCandidateIndex);

    res.json({ sent });
  } catch (err) {
    next(err);
  }
});

// ── POST /tasks/:id/respond ───────────────────────────────────────────────────
// La cleaner accetta o rifiuta il task.
// Body: { cleanerId, action: "ACCEPT" | "REJECT", rejectReason? }

tasksRouter.post("/tasks/:id/respond", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { cleanerId, action, rejectReason } = req.body;

    if (!cleanerId || !action || !["ACCEPT", "REJECT"].includes(action)) {
      return res.status(400).json({
        error: "Body: { cleanerId: string, action: 'ACCEPT' | 'REJECT', rejectReason?: string }",
      });
    }

    const task = await AssignmentService.handleResponse(req.params.id!, {
      cleanerId,
      action,
      rejectReason,
    });

    res.json({ data: task });
  } catch (err) {
    next(err);
  }
});
