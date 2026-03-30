import { Router, type NextFunction } from "express";
import { z } from "zod";

import { requireUser } from "../lib/auth.js";
import { HttpError } from "../lib/http.js";
import { getSupabaseService } from "../lib/supabase.js";
import { mergeBookings, type HistoryBookingRow, type IcalBookingRow } from "../lib/bookings/merge.js";
import {
  bySourcePriority,
  dedupeBookingOverlaps,
  dedupeByRangeKeepPriority,
  isBlockedSummary,
} from "../lib/bookings/host-logic.js";
import { dateKey, normalizeDateString, parseDateKey } from "../lib/bookings/date.js";

export const laundryRouter = Router();

laundryRouter.use(async (req, _res, next: NextFunction) => {
  const user = await requireUser(req);
  if (!user) return next(new HttpError(401, "Unauthorized"));
  req.userId = user.id;
  return next();
});

type PropertyRow = {
  id: string;
  user_id: string;
  name: string;
  address: string;
  city: string;
  check_in_time?: string | null;
  check_out_time?: string | null;
};

function isActiveLinkStatus(status?: string | null) {
  if (!status) return true;
  const normalized = status.toLowerCase();
  return normalized === "active" || normalized === "accepted" || normalized === "assigned";
}

function isArchivedAtMissing(error: unknown) {
  const msg = error && typeof error === "object" && "message" in error ? String((error as any).message) : "";
  return msg.includes("archived_at");
}

function isBlockEvent(summary?: string | null, sourceName?: string) {
  const text = (summary ?? "").toLowerCase();
  const source = (sourceName ?? "").toLowerCase();
  const hasBlockText = text.includes("not available") || text.includes("closed") || text.includes("bloccat");
  if (source.includes("booking")) return false;
  if (source.includes("airbnb")) return hasBlockText;
  return hasBlockText;
}

function normalizeTime(value: string | null | undefined) {
  if (!value) return "";
  const raw = String(value);
  if (raw.includes("T")) {
    const date = new Date(raw);
    if (!Number.isNaN(date.getTime())) {
      return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
    }
  }
  return raw.slice(0, 5);
}

function toDateWithOptionalTime(dateStr: string, timeStr: string) {
  if (!timeStr) return dateStr;
  return `${dateStr}T${timeStr}:00`;
}

function addDays(base: Date, days: number) {
  const next = new Date(base);
  next.setDate(next.getDate() + days);
  return next;
}

function addMonths(base: Date, months: number) {
  const next = new Date(base);
  next.setMonth(next.getMonth() + months);
  return next;
}

function startOfMonth(base: Date) {
  return new Date(base.getFullYear(), base.getMonth(), 1);
}

function endOfMonth(base: Date) {
  return new Date(base.getFullYear(), base.getMonth() + 1, 0);
}

function parseGuestName(summary?: string | null) {
  const text = (summary ?? "").trim();
  if (!text) return "";
  const normalized = text.replace(/\s+/g, " ");
  const cleaned = normalized
    .replace(/^(reservation|prenotazione|booking)\s*[:\-]\s*/i, "")
    .replace(/\b(check-?in|check-?out|closed|blocked|not available)\b/gi, "")
    .trim();
  return cleaned || normalized;
}

laundryRouter.get("/api/laundry/team-members/:id/details", async (req, res) => {
  const params = z
    .object({
      id: z.string().uuid(),
    })
    .safeParse(req.params);
  if (!params.success) throw new HttpError(400, "Invalid params", params.error.flatten());

  const supabase = getSupabaseService();
  const userId = req.userId!;
  const memberId = params.data.id;

  const { data: memberRow, error: memberErr } = await supabase
    .from("team_members")
    .select("*")
    .eq("id", memberId)
    .maybeSingle();
  if (memberErr) throw new HttpError(400, memberErr.message);
  if (!memberRow) throw new HttpError(404, "Team member not found");

  const laundryId = (memberRow as { laundry_id?: string | null }).laundry_id ?? null;
  if (!laundryId) throw new HttpError(400, "Team member without laundry_id");

  const { data: laundry, error: laundryErr } = await supabase
    .from("laundries")
    .select("id,owner_id")
    .eq("id", laundryId)
    .maybeSingle();
  if (laundryErr) throw new HttpError(400, laundryErr.message);
  if (!laundry?.id) throw new HttpError(404, "Laundry not found");
  if (laundry.owner_id !== userId) throw new HttpError(403, "Not authorized");

  const roleId = (memberRow as { role_id?: string | null }).role_id ?? null;
  let roleName: string | null = null;
  if (roleId) {
    const { data: roleRow } = await supabase.from("roles").select("name").eq("id", roleId).maybeSingle();
    roleName = (roleRow as { name?: string | null } | null)?.name ?? null;
  }

  const memberEmail = ((memberRow as { email?: string | null }).email ?? "").trim();
  let profile: Record<string, unknown> | null = null;
  let cleaner: Record<string, unknown> | null = null;
  let availability: Array<Record<string, unknown>> = [];
  if (memberEmail) {
    const { data: profileRow } = await supabase
      .from("profiles")
      .select("id,first_name,last_name,email,phone")
      .ilike("email", memberEmail)
      .maybeSingle();
    profile = (profileRow as Record<string, unknown> | null) ?? null;

    const profileId = (profileRow as { id?: string } | null)?.id;
    if (profileId) {
      const [{ data: cleanerRow }, { data: availabilityRows }] = await Promise.all([
        supabase.from("cleaners").select("*").eq("user_id", profileId).maybeSingle(),
        supabase
          .from("cleaner_availability")
          .select("day_of_week,time_slot,flexible")
          .eq("user_id", profileId)
          .order("day_of_week", { ascending: true })
          .order("time_slot", { ascending: true }),
      ]);
      cleaner = (cleanerRow as Record<string, unknown> | null) ?? null;
      availability = (availabilityRows as Array<Record<string, unknown>> | null) ?? [];
    }
  }

  return res.json({
    member: memberRow,
    role_name: roleName,
    profile,
    cleaner,
    availability,
  });
});

laundryRouter.get("/api/laundry/host-tasks", async (req, res) => {
  const query = z
    .object({
      laundry_id: z.string().uuid(),
      date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    })
    .safeParse(req.query);
  if (!query.success) throw new HttpError(400, "Invalid query", query.error.flatten());

  const supabase = getSupabaseService();
  const userId = req.userId!;
  const laundryId = query.data.laundry_id;
  const fromDateKey = query.data.date;

  const { data: laundry, error: laundryErr } = await supabase
    .from("laundries")
    .select("id,owner_id")
    .eq("id", laundryId)
    .maybeSingle();
  if (laundryErr) throw new HttpError(400, laundryErr.message);
  if (!laundry?.id) throw new HttpError(404, "Laundry not found");
  if (laundry.owner_id !== userId) throw new HttpError(403, "Not authorized");

  const { data: linkRows, error: linkErr } = await supabase
    .from("laundry_host_links")
    .select("host_id,status")
    .eq("laundry_id", laundryId);
  if (linkErr) throw new HttpError(400, linkErr.message);

  let hostIds = (linkRows ?? []).filter((row) => isActiveLinkStatus(row.status)).map((row) => row.host_id);
  if (hostIds.length === 0) {
    const { data: fallbackHosts, error: fallbackErr } = await supabase
      .from("laundry_hosts")
      .select("host_id,status")
      .eq("laundry_id", laundryId);
    if (fallbackErr) throw new HttpError(400, fallbackErr.message);
    hostIds = (fallbackHosts ?? []).filter((row) => isActiveLinkStatus(row.status)).map((row) => row.host_id);
  }

  let managedPropertyIds: string[] = [];
  const { data: managementRows, error: managementErr } = await supabase
    .from("property_management")
    .select("property_id")
    .eq("laundry_id", laundryId)
    .eq("active", true);
  if (managementErr) throw new HttpError(400, managementErr.message);
  managedPropertyIds = (managementRows ?? []).map((row) => row.property_id);
  const managedPropertySet = new Set(managedPropertyIds);

  hostIds = Array.from(new Set(hostIds));

  const fetchPropertiesByHostIds = async (ids: string[]) => {
    const withTimes = await supabase
      .from("properties")
      .select("id,user_id,name,address,city,check_in_time,check_out_time,archived_at")
      .in("user_id", ids)
      .is("archived_at", null);
    if (!withTimes.error) return (withTimes.data ?? []) as PropertyRow[];
    if (isArchivedAtMissing(withTimes.error)) {
      const fallbackWithTimes = await supabase
        .from("properties")
        .select("id,user_id,name,address,city,check_in_time,check_out_time")
        .in("user_id", ids);
      if (!fallbackWithTimes.error) return (fallbackWithTimes.data ?? []) as PropertyRow[];
    }
    const fallbackBase = await supabase.from("properties").select("id,user_id,name,address,city").in("user_id", ids);
    if (fallbackBase.error) throw new HttpError(400, fallbackBase.error.message);
    return (fallbackBase.data ?? []) as PropertyRow[];
  };

  const fetchPropertiesByIds = async (ids: string[]) => {
    const withTimes = await supabase
      .from("properties")
      .select("id,user_id,name,address,city,check_in_time,check_out_time,archived_at")
      .in("id", ids)
      .is("archived_at", null);
    if (!withTimes.error) return (withTimes.data ?? []) as PropertyRow[];
    if (isArchivedAtMissing(withTimes.error)) {
      const fallbackWithTimes = await supabase
        .from("properties")
        .select("id,user_id,name,address,city,check_in_time,check_out_time")
        .in("id", ids);
      if (!fallbackWithTimes.error) return (fallbackWithTimes.data ?? []) as PropertyRow[];
    }
    const fallbackBase = await supabase.from("properties").select("id,user_id,name,address,city").in("id", ids);
    if (fallbackBase.error) throw new HttpError(400, fallbackBase.error.message);
    return (fallbackBase.data ?? []) as PropertyRow[];
  };

  let propertyRows: PropertyRow[] = [];
  if (hostIds.length > 0) propertyRows = await fetchPropertiesByHostIds(hostIds);
  if (propertyRows.length === 0 && managedPropertyIds.length > 0) propertyRows = await fetchPropertiesByIds(managedPropertyIds);

  if (propertyRows.length === 0) return res.json({ tasks: [], hosts: [] });

  const propertyRowsFiltered =
    managedPropertySet.size > 0
      ? propertyRows.filter((row) => managedPropertySet.has(row.id))
      : propertyRows;
  const propertyIds = propertyRowsFiltered.map((row) => row.id);
  if (propertyIds.length === 0) return res.json({ tasks: [], hosts: [] });

  const selectedDate = parseDateKey(fromDateKey);
  const bookingsFrom = dateKey(startOfMonth(selectedDate));
  const bookingsTo = dateKey(endOfMonth(addMonths(selectedDate, 2)));
  const historyFrom = dateKey(addDays(selectedDate, -400));
  const historyTo = dateKey(addDays(selectedDate, 401));

  const { data: bookingRows, error: bookingErr } = await supabase
    .from("bookings")
    .select("id,property_id,start_date,end_date,source_name,summary,external_id")
    .in("property_id", propertyIds)
    .lte("start_date", bookingsTo)
    .gte("end_date", bookingsFrom);
  if (bookingErr) throw new HttpError(400, bookingErr.message);

  const { data: historyRows, error: historyErr } = await supabase
    .from("ical_events_history")
    .select("id,property_id,start_at,end_at,calendar_source,summary,status,cancelled")
    .in("property_id", propertyIds)
    .eq("cancelled", false)
    .lte("start_at", historyTo)
    .gte("end_at", historyFrom)
    .order("start_at", { ascending: true });
  if (historyErr) throw new HttpError(400, historyErr.message);

  const normalizedBookingRows = ((bookingRows ?? []) as Array<IcalBookingRow & { external_id?: string | null }>)
    .filter((row) => {
      const src = (row.source_name ?? "").toLowerCase();
      const ext = (row.external_id ?? "").toString().toLowerCase();
      if (src.includes("booking") && ext.startsWith("hist:")) return false;
      return true;
    })
    .map((row) => ({
      ...row,
      start_date: normalizeDateString(row.start_date),
      end_date: normalizeDateString(row.end_date),
    }));

  const merged = mergeBookings({
    icalRows: normalizedBookingRows as IcalBookingRow[],
    historyRows: (historyRows ?? []) as HistoryBookingRow[],
    icalAuthoritative: true,
    today: new Date(),
  })
    .filter((b) => !isBlockEvent(b.summary, b.sourceName))
    .filter((b) => {
      const src = (b.sourceName ?? "").toLowerCase();
      if (src.includes("airbnb") && isBlockedSummary(b.summary)) return false;
      return true;
    })
    .sort(bySourcePriority);

  const deduped = dedupeBookingOverlaps(dedupeByRangeKeepPriority(merged));

  const propertyById = new Map(propertyRowsFiltered.map((row) => [row.id, row]));
  const hostIdsForProfiles = Array.from(new Set(propertyRowsFiltered.map((row) => row.user_id)));
  let hostNameById = new Map<string, string>();
  if (hostIdsForProfiles.length > 0) {
    const { data: hostProfiles } = await supabase
      .from("profiles")
      .select("id,first_name,last_name,email")
      .in("id", hostIdsForProfiles);
    hostNameById = new Map(
      (hostProfiles ?? []).map((profile) => {
        const fullName = `${profile.first_name ?? ""} ${profile.last_name ?? ""}`.trim();
        return [profile.id, fullName || profile.email || profile.id];
      })
    );
  }

  const tasks = deduped.flatMap((booking) => {
    const property = propertyById.get(booking.apartmentId);
    if (!property) return [];
    const checkInTime = normalizeTime(property.check_in_time);
    const checkOutTime = normalizeTime(property.check_out_time);
    const checkInDateTime = toDateWithOptionalTime(booking.checkIn, checkInTime);
    const checkOutDateTime = toDateWithOptionalTime(booking.checkOut, checkOutTime);
    const guestName = parseGuestName(booking.summary);

    const rows = [
      {
        id: `${booking.id}-checkin`,
        property_name: property.name,
        address: [property.address, property.city].filter(Boolean).join(" · "),
        guest_name: guestName,
        check_in: checkInDateTime,
        check_out: checkOutDateTime,
        type: "checkin" as const,
        host_id: property.user_id,
        host_name: hostNameById.get(property.user_id) ?? property.user_id,
      },
      {
        id: `${booking.id}-checkout`,
        property_name: property.name,
        address: [property.address, property.city].filter(Boolean).join(" · "),
        guest_name: guestName,
        check_in: checkInDateTime,
        check_out: checkOutDateTime,
        type: "checkout" as const,
        host_id: property.user_id,
        host_name: hostNameById.get(property.user_id) ?? property.user_id,
      },
    ];
    return rows.filter((row) => {
      const refDate = row.type === "checkin" ? booking.checkIn : booking.checkOut;
      return refDate >= fromDateKey;
    });
  });

  const hosts = Array.from(new Set(tasks.map((task) => task.host_id))).map((id) => ({
    id,
    name: hostNameById.get(id) ?? id,
  }));

  return res.json({ tasks, hosts });
});
