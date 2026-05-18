import { prisma } from "../prisma.js";
import type { TaskCandidate, CandidateStatus } from "./types.js";

// ─── TaskCandidate Repository ─────────────────────────────────────────────────

export const CandidateRepository = {
  async findCurrentPending(taskId: string): Promise<TaskCandidate | null> {
    return prisma.taskCandidate.findFirst({
      where: { taskId, status: "PENDING" },
      orderBy: { orderIndex: "asc" },
    });
  },

  async findByTaskAndIndex(taskId: string, orderIndex: number): Promise<TaskCandidate | null> {
    return prisma.taskCandidate.findUnique({
      where: { taskId_orderIndex: { taskId, orderIndex } },
      include: { cleaner: true },
    });
  },

  /** All candidates in PENDING state notified more than `timeoutMinutes` ago. */
  async findTimedOut(timeoutMinutes: number): Promise<(TaskCandidate & { task: { id: string; currentCandidateIndex: number } })[]> {
    const cutoff = new Date(Date.now() - timeoutMinutes * 60 * 1000);
    return prisma.taskCandidate.findMany({
      where: {
        status: "PENDING",
        notifiedAt: { lte: cutoff },
      },
      include: {
        task: { select: { id: true, currentCandidateIndex: true } },
      },
    });
  },

  async bulkCreate(
    candidates: Array<{ taskId: string; cleanerId: string; orderIndex: number }>
  ): Promise<void> {
    await prisma.taskCandidate.createMany({ data: candidates, skipDuplicates: true });
  },

  async updateStatus(
    id: string,
    status: CandidateStatus,
    extra?: { notifiedAt?: Date; respondedAt?: Date; rejectReason?: string }
  ): Promise<TaskCandidate> {
    return prisma.taskCandidate.update({
      where: { id },
      data: { status, ...extra },
    });
  },

  /** Cancel all non-resolved candidates for a task (after acceptance). */
  async cancelOthers(taskId: string, acceptedId: string): Promise<void> {
    await prisma.taskCandidate.updateMany({
      where: {
        taskId,
        id: { not: acceptedId },
        status: { in: ["PENDING"] },
      },
      data: { status: "CANCELLED" },
    });
  },
};
