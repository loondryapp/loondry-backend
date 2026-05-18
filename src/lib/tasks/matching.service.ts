import type { Task, Cleaner, RankedCleaner, AvailabilitySlot, MatchingOptions } from "./types.js";
import { CleanerRepository } from "./cleaner.repository.js";

// ─── Matching Service ─────────────────────────────────────────────────────────
// Finds and ranks available cleaners for a given task.

const DEFAULT_RADIUS_KM = 15;
const DEFAULT_BUFFER_MINUTES = 60;

export const MatchingService = {
  /**
   * Returns an ordered list of cleaners eligible for the task.
   * Ranked by: distanza × carico × storico accettazioni
   */
  async getAvailableCleaners(
    task: Task,
    options: MatchingOptions = {}
  ): Promise<RankedCleaner[]> {
    const radiusKm = options.radiusKm ?? DEFAULT_RADIUS_KM;
    const bufferMinutes = options.bufferMinutes ?? DEFAULT_BUFFER_MINUTES;

    // 1. All active cleaners with today's load
    const cleaners = await CleanerRepository.findWithTaskLoad(task.date);

    const ranked: RankedCleaner[] = [];

    for (const cleaner of cleaners) {
      // 2. Capacity check
      if (cleaner.tasksToday >= cleaner.maxTasksPerDay) continue;

      // 3. Proximity check (haversine)
      const distanceKm = haversineKm(
        cleaner.lat,
        cleaner.lng,
        getTaskLat(task),
        getTaskLng(task)
      );
      if (distanceKm > Math.min(radiusKm, cleaner.radiusKm)) continue;

      // 4. Availability check
      if (!isAvailable(cleaner, task.checkinTime, task.checkoutTime)) continue;

      // 5. Buffer check (no overlapping tasks with buffer)
      const hasConflict = await hasScheduleConflict(cleaner.id, task.checkinTime, task.checkoutTime, bufferMinutes);
      if (hasConflict) continue;

      // 6. Score: lower = better candidate
      //    score = (distance / maxRadius) * 0.4
      //          + (load / maxTasks)     * 0.3
      //          + (1 - acceptanceRate)  * 0.3
      const score =
        (distanceKm / radiusKm) * 0.4 +
        (cleaner.tasksToday / cleaner.maxTasksPerDay) * 0.3 +
        (1 - cleaner.acceptanceRate) * 0.3;

      ranked.push({ cleaner, score, distanceKm, tasksToday: cleaner.tasksToday });
    }

    // Sort ascending by score (best first)
    return ranked.sort((a, b) => a.score - b.score);
  },
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Haversine formula — returns distance in km between two lat/lng points. */
function haversineKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function toRad(deg: number) {
  return (deg * Math.PI) / 180;
}

/** Checks if cleaner's availability slots cover the task window. */
function isAvailable(cleaner: Cleaner, checkin: Date, checkout: Date): boolean {
  const slots = (cleaner.availability as unknown) as AvailabilitySlot[];
  if (!slots || slots.length === 0) return true; // no constraint = always available

  const day = checkin.getDay();
  const taskStart = toMinutes(checkin);
  const taskEnd = toMinutes(checkout);

  return slots.some((slot) => {
    if (slot.day !== day) return false;
    const slotStart = parseTime(slot.startTime);
    const slotEnd = parseTime(slot.endTime);
    return taskStart >= slotStart && taskEnd <= slotEnd;
  });
}

function toMinutes(date: Date): number {
  return date.getHours() * 60 + date.getMinutes();
}

function parseTime(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
}

/** Checks for schedule conflict including travel buffer. */
async function hasScheduleConflict(
  cleanerId: string,
  checkin: Date,
  checkout: Date,
  bufferMinutes: number
): Promise<boolean> {
  const { prisma } = await import("../prisma.js");

  const bufferMs = bufferMinutes * 60 * 1000;
  const windowStart = new Date(checkin.getTime() - bufferMs);
  const windowEnd = new Date(checkout.getTime() + bufferMs);

  const conflict = await prisma.taskCandidate.findFirst({
    where: {
      cleanerId,
      status: "ACCEPTED",
      task: {
        checkinTime: { lt: windowEnd },
        checkoutTime: { gt: windowStart },
      },
    },
  });

  return conflict !== null;
}

// ── Apartment geo coordinates ──────────────────────────────────────────────────
// TODO: Store lat/lng on Task (or join Apartment table) for real geo matching.
// For now, return 0,0 as placeholder — override when apartment model is extended.
function getTaskLat(_task: Task): number { return 0; }
function getTaskLng(_task: Task): number { return 0; }
