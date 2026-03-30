function pad2(n: number) {
  return String(n).padStart(2, "0");
}

export type DateKey = `${number}-${string}-${string}`;

export function dateKey(d: Date): DateKey {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}` as DateKey;
}

export function parseDateKey(key: string): Date {
  const [y, m, d] = key.split("-").map((v) => Number(v));
  return new Date(y || 0, (m || 1) - 1, d || 1);
}

export function normalizeDateString(value: string) {
  const raw = String(value);
  return raw.includes("T") ? raw : raw.replace(" ", "T");
}

export function toRomeDateKey(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return dateKey(new Date(value)) as DateKey;
  }
  try {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: "Europe/Rome",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(date) as DateKey;
  } catch {
    return dateKey(date) as DateKey;
  }
}
