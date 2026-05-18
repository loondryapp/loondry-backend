import { prisma } from "../prisma.js";
import type { Cleaner, CleanerWithLoad } from "./types.js";

// ─── Cleaner Repository ───────────────────────────────────────────────────────

export const CleanerRepository = {
  async findById(id: string): Promise<Cleaner | null> {
    return prisma.cleaner.findUnique({ where: { id } });
  },

  async findAll(onlyActive = true): Promise<Cleaner[]> {
    return prisma.cleaner.findMany({
      where: onlyActive ? { isActive: true } : undefined,
      orderBy: { name: "asc" },
    });
  },

  /** Returns all active cleaners with their task count for a specific date. */
  async findWithTaskLoad(date: Date): Promise<CleanerWithLoad[]> {
    const cleaners = await prisma.cleaner.findMany({
      where: { isActive: true },
      include: {
        candidates: {
          where: {
            status: "ACCEPTED",
            task: { date },
          },
        },
      },
    });

    return cleaners.map((c) => ({
      ...c,
      tasksToday: c.candidates.length,
      candidates: undefined as never,
    }));
  },

  async create(data: Omit<Cleaner, "id" | "createdAt" | "updatedAt">): Promise<Cleaner> {
    return prisma.cleaner.create({
      data: {
        ...data,
        availability: (data.availability ?? []) as object[],
      },
    });
  },

  async updateAcceptanceRate(id: string): Promise<void> {
    const [total, accepted] = await Promise.all([
      prisma.taskCandidate.count({
        where: { cleanerId: id, status: { in: ["ACCEPTED", "REJECTED", "TIMEOUT"] } },
      }),
      prisma.taskCandidate.count({
        where: { cleanerId: id, status: "ACCEPTED" },
      }),
    ]);

    if (total === 0) return;

    await prisma.cleaner.update({
      where: { id },
      data: { acceptanceRate: accepted / total },
    });
  },
};
