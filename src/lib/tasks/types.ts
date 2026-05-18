import type { Task, Cleaner, TaskCandidate } from "@prisma/client";
import { TaskStatus, CandidateStatus } from "@prisma/client";

// ─── Re-exports ───────────────────────────────────────────────────────────────

export type { Task, Cleaner, TaskCandidate };
export { TaskStatus, CandidateStatus };

// ─── Enriched types ───────────────────────────────────────────────────────────

export type TaskWithCandidates = Task & {
  candidates: (TaskCandidate & { cleaner: Cleaner })[];
};

export type CleanerWithLoad = Cleaner & {
  tasksToday: number;
};

// ─── Availability ─────────────────────────────────────────────────────────────

export interface AvailabilitySlot {
  /** 0 = Sunday … 6 = Saturday */
  day: number;
  startTime: string; // "HH:MM"
  endTime: string;   // "HH:MM"
}

// ─── Service DTOs ─────────────────────────────────────────────────────────────

export interface CreateTaskDto {
  apartmentId: string;
  hostId: string;
  laundryId?: string;
  date: string;         // ISO date "YYYY-MM-DD"
  checkinTime: string;  // ISO datetime
  checkoutTime: string; // ISO datetime
  priority?: number;
  notes?: string;
}

export interface RespondDto {
  cleanerId: string;
  action: "ACCEPT" | "REJECT";
  rejectReason?: string;
}

export interface MatchingOptions {
  radiusKm?: number;
  bufferMinutes?: number;
}

// ─── Matching result ──────────────────────────────────────────────────────────

export interface RankedCleaner {
  cleaner: Cleaner;
  score: number;
  distanceKm: number;
  tasksToday: number;
}

// ─── Job result ───────────────────────────────────────────────────────────────

export interface AssignmentJobResult {
  processed: number;
  notified: number;
  atRisk: number;
  errors: string[];
}
