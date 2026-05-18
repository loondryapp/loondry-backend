import { prisma } from "../prisma.js";
import type { Task, TaskStatus, TaskWithCandidates, CreateTaskDto } from "./types.js";

// ─── Task Repository ──────────────────────────────────────────────────────────

export const TaskRepository = {
  // ── Read ───────────────────────────────────────────────────────────────────

  async findById(id: string): Promise<TaskWithCandidates | null> {
    return prisma.task.findUnique({
      where: { id },
      include: {
        candidates: {
          include: { cleaner: true },
          orderBy: { orderIndex: "asc" },
        },
      },
    });
  },

  async findAll(filters?: {
    status?: TaskStatus;
    laundryId?: string;
    date?: Date;
    dateFrom?: Date;
    dateTo?: Date;
  }): Promise<Task[]> {
    return prisma.task.findMany({
      where: {
        ...(filters?.status && { status: filters.status }),
        ...(filters?.laundryId && { laundryId: filters.laundryId }),
        ...(filters?.date && { date: filters.date }),
        ...(filters?.dateFrom || filters?.dateTo
          ? {
              date: {
                ...(filters.dateFrom && { gte: filters.dateFrom }),
                ...(filters.dateTo && { lte: filters.dateTo }),
              },
            }
          : {}),
      },
      orderBy: [{ date: "asc" }, { priority: "desc" }, { checkoutTime: "asc" }],
    });
  },

  /** Tasks scheduled for tomorrow with DA_ASSEGNARE status */
  async findTomorrowUnassigned(): Promise<Task[]> {
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    tomorrow.setHours(0, 0, 0, 0);
    const tomorrowEnd = new Date(tomorrow);
    tomorrowEnd.setHours(23, 59, 59, 999);

    return prisma.task.findMany({
      where: {
        date: { gte: tomorrow, lte: tomorrowEnd },
        status: "DA_ASSEGNARE",
      },
      orderBy: [{ priority: "desc" }, { checkoutTime: "asc" }],
    });
  },

  /** Tasks not ASSEGNATO or COMPLETATO — for deadline check at 18:00 */
  async findTodayUnresolved(): Promise<Task[]> {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const todayEnd = new Date(today);
    todayEnd.setHours(23, 59, 59, 999);

    return prisma.task.findMany({
      where: {
        date: { gte: today, lte: todayEnd },
        status: { notIn: ["ASSEGNATO", "COMPLETATO"] },
      },
    });
  },

  // ── Write ──────────────────────────────────────────────────────────────────

  async create(dto: CreateTaskDto): Promise<Task> {
    return prisma.task.create({
      data: {
        apartmentId: dto.apartmentId,
        hostId: dto.hostId,
        laundryId: dto.laundryId,
        date: new Date(dto.date),
        checkinTime: new Date(dto.checkinTime),
        checkoutTime: new Date(dto.checkoutTime),
        priority: dto.priority ?? 0,
        notes: dto.notes,
      },
    });
  },

  async updateStatus(
    id: string,
    status: TaskStatus,
    extra?: { cleanerId?: string | null; currentCandidateIndex?: number }
  ): Promise<Task> {
    return prisma.task.update({
      where: { id },
      data: { status, ...extra },
    });
  },

  async incrementCandidateIndex(id: string): Promise<Task> {
    return prisma.task.update({
      where: { id },
      data: { currentCandidateIndex: { increment: 1 } },
    });
  },

  // ── Logging ────────────────────────────────────────────────────────────────

  async log(taskId: string, event: string, payload?: Record<string, unknown>): Promise<void> {
    await prisma.taskLog.create({
      data: { taskId, event, payload: (payload ?? {}) as object },
    });
  },
};
