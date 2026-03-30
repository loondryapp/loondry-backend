import { dateKey, normalizeDateString, parseDateKey, toRomeDateKey, type DateKey } from "./date.js";

export type IcalBookingRow = {
  id: string;
  property_id: string;
  start_date: string;
  end_date: string;
  source_name: string;
  summary: string | null;
  status?: string | null;
};

export type HistoryBookingRow = {
  id: number | string;
  property_id: string;
  start_at: string;
  end_at: string;
  calendar_source: string | null;
  summary: string | null;
  status?: string | null;
  cancelled?: boolean | null;
};

export type MergedBooking = {
  id: string;
  apartmentId: string;
  checkIn: DateKey;
  checkOut: DateKey;
  checkInTime: string;
  checkOutTime: string;
  cleaner: string;
  sourceName?: string;
  summary?: string | null;
};

export function mergeBookings(params: {
  icalRows: IcalBookingRow[];
  historyRows: HistoryBookingRow[];
  icalAuthoritative: boolean;
  today?: Date;
}): MergedBooking[] {
  const today = params.today ?? new Date();
  const todayKey = dateKey(today) as DateKey;

  const merged = new Map<string, { booking: MergedBooking; source: "ical" | "history" }>();
  const keyFor = (aptId: string, start: string, end: string) => `${aptId}:${start}:${end}`;

  params.icalRows.forEach((b) => {
    if (isCancelledEvent(b.summary, b.status)) return;
    const checkIn = toRomeDateKey(normalizeDateString(b.start_date)) as DateKey;
    const checkOut = toRomeDateKey(normalizeDateString(b.end_date)) as DateKey;
    const k = keyFor(b.property_id, checkIn, checkOut);
    merged.set(k, {
      source: "ical",
      booking: {
        id: b.id,
        apartmentId: b.property_id,
        checkIn,
        checkOut,
        checkInTime: "15:00",
        checkOutTime: "11:00",
        cleaner: "—",
        sourceName: b.source_name,
        summary: b.summary,
      },
    });
  });

  const isPast = (endAt: string) => {
    const endKey = dateKey(new Date(endAt)) as DateKey;
    return endKey < todayKey;
  };

  const overlaps = (a: MergedBooking, b: MergedBooking) => {
    const aStart = parseDateKey(a.checkIn).getTime();
    const aEnd = parseDateKey(a.checkOut).getTime();
    const bStart = parseDateKey(b.checkIn).getTime();
    const bEnd = parseDateKey(b.checkOut).getTime();
    return aStart < bEnd && aEnd > bStart;
  };

  params.historyRows.forEach((h) => {
    if (isCancelledEvent(h.summary, h.status)) return;
    if (params.icalAuthoritative && !isPast(h.end_at)) return;

    const checkIn = toRomeDateKey(normalizeDateString(h.start_at)) as DateKey;
    const checkOut = toRomeDateKey(normalizeDateString(h.end_at)) as DateKey;
    const k = keyFor(h.property_id, checkIn, checkOut);
    if (merged.has(k)) return;

    const candidate: MergedBooking = {
      id: `hist-${h.id}`,
      apartmentId: h.property_id,
      checkIn,
      checkOut,
      checkInTime: "15:00",
      checkOutTime: "11:00",
      cleaner: "—",
      sourceName: h.calendar_source
        ? `${h.calendar_source.charAt(0).toUpperCase()}${h.calendar_source.slice(1)}`
        : "iCal",
      summary: h.summary,
    };

    if (params.icalAuthoritative) {
      for (const entry of merged.values()) {
        if (entry.source !== "ical") continue;
        if (entry.booking.apartmentId !== candidate.apartmentId) continue;
        if (overlaps(entry.booking, candidate)) return;
      }
    }

    merged.set(k, { booking: candidate, source: "history" });
  });

  return Array.from(merged.values()).map((row) => row.booking);
}

function isCancelledEvent(summary?: string | null, status?: string | null) {
  const normalizedStatus = (status ?? "").toLowerCase();
  if (normalizedStatus.includes("cancel")) return true;
  if (normalizedStatus.includes("annull")) return true;
  const text = (summary ?? "").toLowerCase();
  return (
    text.includes("cancelled") ||
    text.includes("canceled") ||
    text.includes("annull") ||
    text.includes("cancellat")
  );
}
