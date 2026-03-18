import ical from "node-ical";

import { getSupabaseService } from "./supabase.js";

type CalendarRow = {
  id: string;
  property_id: string;
  name: string;
  ical_url: string;
};

export async function syncCalendar(calendarId: string, userId: string) {
  const supabase = getSupabaseService();

  const { data: calendar, error } = await supabase
    .from("property_calendars")
    .select("id, property_id, name, ical_url, properties!inner(user_id)")
    .eq("id", calendarId)
    .maybeSingle();

  if (error || !calendar) {
    return { ok: false, error: error?.message ?? "Calendar not found" };
  }

  const ownerId = (calendar as { properties?: { user_id?: string } }).properties?.user_id;
  if (!ownerId || ownerId !== userId) {
    return { ok: false, error: "Not authorized" };
  }

  await supabase.from("property_calendars").update({ status: "syncing" }).eq("id", calendarId);

  try {
    const events = await ical.async.fromURL(calendar.ical_url);
    const rows = Object.values(events)
      .filter((e) => e.type === "VEVENT")
      .map((event) => ({
        property_id: calendar.property_id,
        calendar_id: calendar.id,
        external_id: String(event.uid),
        source_name: calendar.name,
        summary: event.summary ?? null,
        start_date: event.start?.toISOString(),
        end_date: event.end?.toISOString(),
        raw_data: event,
      }))
      .filter((row) => row.external_id && row.start_date && row.end_date);

    if (rows.length > 0) {
      const { error: upsertError } = await supabase
        .from("bookings")
        .upsert(rows, { onConflict: "external_id" });
      if (upsertError) throw upsertError;
    }

    await supabase
      .from("property_calendars")
      .update({ status: "active", last_synced_at: new Date().toISOString() })
      .eq("id", calendarId);

    return { ok: true, count: rows.length };
  } catch (err) {
    await supabase.from("property_calendars").update({ status: "error" }).eq("id", calendarId);
    return { ok: false, error: err instanceof Error ? err.message : "Sync failed" };
  }
}

export async function syncPropertyCalendars(propertyId: string, userId: string) {
  const supabase = getSupabaseService();

  const { data: property, error } = await supabase
    .from("properties")
    .select("id, user_id")
    .eq("id", propertyId)
    .maybeSingle();

  if (error || !property) {
    return { ok: false, error: error?.message ?? "Property not found" };
  }

  if (property.user_id !== userId) {
    return { ok: false, error: "Not authorized" };
  }

  const { data: calendars } = await supabase
    .from("property_calendars")
    .select("id")
    .eq("property_id", propertyId);

  const results = [];
  for (const calendar of calendars ?? []) {
    results.push(await syncCalendar(calendar.id, userId));
  }

  return { ok: true, results };
}
