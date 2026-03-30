import { parseDateKey } from "./date.js";

export function isBlockedSummary(summary?: string | null) {
  const text = String(summary || "").toLowerCase();
  const patterns = [
    /blocked/,
    /unavailable/,
    /auto\s*block/,
    /gap\s*block/,
    /not\s*available/,
    /not\s*avaible/,
    /blocc/,
    /chius/,
    /non\s*disponibile/,
  ];
  return patterns.some((pattern) => pattern.test(text));
}

function sourcePriority(sourceName?: string) {
  const src = (sourceName ?? "").toLowerCase();
  if (src.includes("airbnb")) return 2;
  if (src.includes("booking")) return 1;
  if (src.includes("hostaway")) return 0;
  return 0;
}

export function bySourcePriority(a: { sourceName?: string }, b: { sourceName?: string }) {
  return sourcePriority(b.sourceName) - sourcePriority(a.sourceName);
}

export function dedupeByRangeKeepPriority<
  T extends { apartmentId: string; checkIn: string; checkOut: string; sourceName?: string; summary?: string | null }
>(list: T[]) {
  const map = new Map<string, { best?: T; bestBlocked?: T }>();
  for (const item of list) {
    const key = `${item.apartmentId}:${item.checkIn}:${item.checkOut}`;
    const slot = map.get(key) ?? {};
    const src = (item.sourceName ?? "").toLowerCase();
    const isBlocked = src.includes("booking") && isBlockedSummary(item.summary);
    if (!isBlocked) {
      if (!slot.best || sourcePriority(item.sourceName) > sourcePriority(slot.best.sourceName)) {
        slot.best = item;
      }
    } else {
      if (!slot.bestBlocked || sourcePriority(item.sourceName) > sourcePriority(slot.bestBlocked.sourceName)) {
        slot.bestBlocked = item;
      }
    }
    map.set(key, slot);
  }
  return Array.from(map.values()).map((slot) => slot.best ?? slot.bestBlocked!).filter(Boolean);
}

export function dedupeBookingOverlaps<
  T extends { apartmentId: string; checkIn: string; checkOut: string; sourceName?: string; summary?: string | null }
>(list: T[]) {
  const bookings: T[] = [];
  const others: T[] = [];
  for (const item of list) {
    const src = (item.sourceName ?? "").toLowerCase();
    if (src.includes("booking")) bookings.push(item);
    else others.push(item);
  }

  const overlaps = (a: T, b: T) => {
    if (a.apartmentId !== b.apartmentId) return false;
    const aStart = parseDateKey(a.checkIn).getTime();
    const aEnd = parseDateKey(a.checkOut).getTime();
    const bStart = parseDateKey(b.checkIn).getTime();
    const bEnd = parseDateKey(b.checkOut).getTime();
    return aStart < bEnd && aEnd > bStart;
  };

  const nonBlocked = bookings.filter((b) => !isBlockedSummary(b.summary));
  const blocked = bookings.filter((b) => isBlockedSummary(b.summary));
  const keptBlocked = blocked.filter((b) => !nonBlocked.some((n) => overlaps(n, b)));

  return [...others, ...nonBlocked, ...keptBlocked];
}
