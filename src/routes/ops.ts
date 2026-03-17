import { Router } from "express";
import { z } from "zod";

import { HttpError } from "../lib/http.js";

export type Apartment = { id: string; name: string };
export type Booking = {
  id: string;
  apartmentId: string;
  checkIn: string; // YYYY-MM-DD
  checkOut: string; // YYYY-MM-DD
  checkInTime: string; // HH:mm
  checkOutTime: string; // HH:mm
  cleaner?: string;
};

export type Task = {
  id: string;
  apartmentId: string;
  apartmentName: string;
  date: string; // YYYY-MM-DD
  time: string; // HH:mm
  kind: "checkout" | "cleaning";
  cleaner?: string;
  status: "unassigned" | "ready" | "in_progress" | "completed";
};

const APARTMENTS: Apartment[] = [
  { id: "apt-montenero", name: "Casa Montenero" },
  { id: "apt-duomo", name: "Appartamento Duomo" },
  { id: "apt-navigli", name: "Loft Navigli" },
  { id: "apt-venezia", name: "Porta Venezia Suite" },
  { id: "apt-isola", name: "Isola Studio" },
  { id: "apt-brera", name: "Brera Loft" }
];

const BOOKINGS: Booking[] = [
  { id: "b1", apartmentId: "apt-montenero", checkIn: "2026-03-14", checkOut: "2026-03-19", checkInTime: "15:00", checkOutTime: "11:00", cleaner: "Giulia" },
  { id: "b2", apartmentId: "apt-duomo", checkIn: "2026-03-12", checkOut: "2026-03-17", checkInTime: "16:00", checkOutTime: "10:30", cleaner: "Sara" },
  { id: "b3", apartmentId: "apt-duomo", checkIn: "2026-03-17", checkOut: "2026-03-21", checkInTime: "15:30", checkOutTime: "11:00", cleaner: "Sara" },
  { id: "b4", apartmentId: "apt-navigli", checkIn: "2026-03-16", checkOut: "2026-03-18", checkInTime: "14:00", checkOutTime: "10:00", cleaner: "Marco" },
  { id: "b5", apartmentId: "apt-navigli", checkIn: "2026-03-18", checkOut: "2026-03-23", checkInTime: "15:00", checkOutTime: "11:00", cleaner: "Marco" },
  { id: "b6", apartmentId: "apt-venezia", checkIn: "2026-03-10", checkOut: "2026-03-15", checkInTime: "15:00", checkOutTime: "10:00", cleaner: "Elisa" },
  { id: "b7", apartmentId: "apt-venezia", checkIn: "2026-03-19", checkOut: "2026-03-22", checkInTime: "16:00", checkOutTime: "11:00", cleaner: "Elisa" },
  { id: "b8", apartmentId: "apt-isola", checkIn: "2026-03-17", checkOut: "2026-03-20", checkInTime: "15:00", checkOutTime: "10:30", cleaner: "Giulia" },
  { id: "b9", apartmentId: "apt-brera", checkIn: "2026-03-15", checkOut: "2026-03-17", checkInTime: "14:30", checkOutTime: "10:00", cleaner: "Giulia" },
  { id: "b10", apartmentId: "apt-brera", checkIn: "2026-03-17", checkOut: "2026-03-25", checkInTime: "16:00", checkOutTime: "11:00", cleaner: "Giulia" }
];

const taskState = new Map<string, Pick<Task, "status" | "cleaner">>();

function apartmentName(apartmentId: string) {
  return APARTMENTS.find((a) => a.id === apartmentId)?.name ?? "—";
}

function shiftTime(time: string, minutes: number) {
  const [hh, mm] = time.split(":").map((v) => Number(v));
  const total = (hh || 0) * 60 + (mm || 0) + minutes;
  const h = Math.floor((((total % (24 * 60)) + 24 * 60) % (24 * 60)) / 60);
  const m = (((total % 60) + 60) % 60);
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

function tasksForRange(from: string, to: string, propertyId?: string): Task[] {
  const bookings = propertyId ? BOOKINGS.filter((b) => b.apartmentId === propertyId) : BOOKINGS;

  const tasks: Task[] = [];
  for (const b of bookings) {
    if (b.checkOut < from || b.checkOut > to) continue;
    const baseId = `b-${b.id}`;

    const checkout: Task = {
      id: `${baseId}-checkout`,
      apartmentId: b.apartmentId,
      apartmentName: apartmentName(b.apartmentId),
      date: b.checkOut,
      time: b.checkOutTime,
      kind: "checkout",
      cleaner: b.cleaner,
      status: b.cleaner ? "ready" : "unassigned",
    };

    const cleaning: Task = {
      id: `${baseId}-cleaning`,
      apartmentId: b.apartmentId,
      apartmentName: apartmentName(b.apartmentId),
      date: b.checkOut,
      time: shiftTime(b.checkOutTime, 60),
      kind: "cleaning",
      cleaner: b.cleaner,
      status: b.cleaner ? "ready" : "unassigned",
    };

    for (const t of [checkout, cleaning]) {
      const s = taskState.get(t.id);
      tasks.push({ ...t, status: s?.status ?? t.status, cleaner: s?.cleaner ?? t.cleaner });
    }
  }

  return tasks.sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time));
}

export const opsRouter = Router();

opsRouter.get("/api/apartments", (_req, res) => {
  res.json(APARTMENTS);
});

opsRouter.get("/api/bookings", (req, res) => {
  const query = z
    .object({
      from: z.string().min(10),
      to: z.string().min(10),
      propertyId: z.string().optional(),
    })
    .safeParse(req.query);

  if (!query.success) throw new HttpError(400, "Invalid query", query.error.flatten());

  const { from, to, propertyId } = query.data;
  const list = (propertyId ? BOOKINGS.filter((b) => b.apartmentId === propertyId) : BOOKINGS).filter(
    (b) => !(b.checkOut < from || b.checkIn > to)
  );

  res.json(list);
});

opsRouter.get("/api/tasks", (req, res) => {
  const query = z
    .object({
      date: z.string().min(10),
      propertyId: z.string().optional(),
    })
    .safeParse(req.query);

  if (!query.success) throw new HttpError(400, "Invalid query", query.error.flatten());

  const { date, propertyId } = query.data;
  res.json(tasksForRange(date, date, propertyId));
});

opsRouter.post("/api/tasks/:id/start", (req, res) => {
  const id = String(req.params.id || "");
  if (!id) throw new HttpError(400, "Missing id");
  const prev = taskState.get(id) ?? {};
  taskState.set(id, { ...prev, status: "in_progress" });
  res.json({ ok: true });
});

opsRouter.post("/api/tasks/:id/complete", (req, res) => {
  const id = String(req.params.id || "");
  if (!id) throw new HttpError(400, "Missing id");
  const prev = taskState.get(id) ?? {};
  taskState.set(id, { ...prev, status: "completed" });
  res.json({ ok: true });
});

opsRouter.post("/api/tasks/:id/assign", (req, res) => {
  const id = String(req.params.id || "");
  if (!id) throw new HttpError(400, "Missing id");

  const body = z.object({ cleaner: z.string().min(1) }).safeParse(req.body);
  if (!body.success) throw new HttpError(400, "Invalid body", body.error.flatten());

  const prev = taskState.get(id);

  taskState.set(id, { ...(prev ?? {}), cleaner: body.data.cleaner, status: prev?.status ?? "ready" });
  res.json({ ok: true });
});
