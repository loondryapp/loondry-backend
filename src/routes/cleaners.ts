import { Router, type Request, type Response, type NextFunction } from "express";

import { CleanerRepository } from "../lib/tasks/cleaner.repository.js";
import { MatchingService } from "../lib/tasks/matching.service.js";
import { TaskRepository } from "../lib/tasks/task.repository.js";

export const cleanersRouter = Router();

// ── GET /cleaners ─────────────────────────────────────────────────────────────

cleanersRouter.get("/cleaners", async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const cleaners = await CleanerRepository.findAll();
    res.json({ data: cleaners, count: cleaners.length });
  } catch (err) {
    next(err);
  }
});

// ── GET /cleaners/available ───────────────────────────────────────────────────
// Query: taskId — returns ranked available cleaners for a given task.

cleanersRouter.get("/cleaners/available", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { taskId } = req.query;
    if (!taskId) return res.status(400).json({ error: "taskId obbligatorio" });

    const task = await TaskRepository.findById(taskId as string);
    if (!task) return res.status(404).json({ error: "Task non trovato" });

    const ranked = await MatchingService.getAvailableCleaners(task);

    res.json({
      data: ranked.map((r) => ({
        id: r.cleaner.id,
        name: r.cleaner.name,
        distanceKm: r.distanceKm.toFixed(2),
        tasksToday: r.tasksToday,
        score: r.score.toFixed(3),
        acceptanceRate: r.cleaner.acceptanceRate,
      })),
      count: ranked.length,
    });
  } catch (err) {
    next(err);
  }
});

// ── POST /cleaners ────────────────────────────────────────────────────────────

cleanersRouter.post("/cleaners", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { name, lat, lng, maxTasksPerDay, bufferMinutes, availability, radiusKm, teamMemberId, email, phone } = req.body;

    if (!name || lat === undefined || lng === undefined) {
      return res.status(400).json({ error: "Campi obbligatori: name, lat, lng" });
    }

    const cleaner = await CleanerRepository.create({
      name,
      lat,
      lng,
      radiusKm: radiusKm ?? 10,
      maxTasksPerDay: maxTasksPerDay ?? 4,
      bufferMinutes: bufferMinutes ?? 60,
      availability: availability ?? [],
      isActive: true,
      acceptanceRate: 1.0,
      teamMemberId: teamMemberId ?? null,
      email: email ?? null,
      phone: phone ?? null,
    });

    res.status(201).json({ data: cleaner });
  } catch (err) {
    next(err);
  }
});
