import ical from "node-ical";

import { getSupabaseService } from "./supabase.js";

type CalendarRow = {
  id: string;
  property_id: string;
  name: string;
  ical_url: string;
  properties?: { name?: string; user_id?: string };
};

export async function syncCalendar(calendarId: string, userId: string) {
  const supabase = getSupabaseService();

  const { data: calendar, error } = await supabase
    .from("property_calendars")
    .select("id, property_id, name, ical_url, properties!inner(user_id, name)")
    .eq("id", calendarId)
    .maybeSingle();

  if (error || !calendar) {
    return { ok: false, error: error?.message ?? "Calendar not found" };
  }

  const ownerId = (calendar as CalendarRow).properties?.user_id;
  if (!ownerId || ownerId !== userId) {
    return { ok: false, error: "Not authorized" };
  }

  await supabase.from("property_calendars").update({ status: "syncing" }).eq("id", calendarId);

  try {
    const events = await ical.async.fromURL(calendar.ical_url);
    const nowIso = new Date().toISOString();
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
      .filter(
        (row) =>
          row.external_id &&
          row.start_date &&
          row.end_date &&
          !String(row.external_id).toLowerCase().startsWith("hist:")
      );

    const historyRows = Object.values(events)
      .filter((e) => e.type === "VEVENT")
      .map((event) => ({
        property_id: calendar.property_id,
        property_name: (calendar as CalendarRow).properties?.name ?? null,
        calendar_source: calendar.name ?? null,
        calendar_url: calendar.ical_url,
        url_key: encodeURIComponent(String(calendar.ical_url)),
        uid: String(event.uid),
        start_at: event.start?.toISOString(),
        end_at: event.end?.toISOString(),
        summary: event.summary ?? null,
        status: event.status ?? null,
        last_seen_at: nowIso,
        updated_at: nowIso,
      }))
      .filter((row) => row.uid && row.start_at && row.end_at);

    if (rows.length > 0) {
      const { error: upsertError } = await supabase
        .from("bookings")
        .upsert(rows, { onConflict: "calendar_id,external_id" });
      if (upsertError) throw upsertError;
    }

    if (historyRows.length > 0) {
      const { error: histError } = await supabase
        .from("ical_events_history")
        .upsert(historyRows, { onConflict: "property_id,uid,start_at,end_at" });
      if (histError) throw histError;
    }

    // Immediately cancel history records whose UIDs are no longer in the current iCal feed.
    // This covers cancellation + re-booking scenarios without waiting for the 24h cleanup window.
    {
      const currentUids = new Set(historyRows.map((r) => r.uid));
      const urlKey = encodeURIComponent(String(calendar.ical_url));
      const todayStart = new Date();
      todayStart.setHours(0, 0, 0, 0);

      const { data: activeHistory } = await supabase
        .from("ical_events_history")
        .select("id, uid")
        .eq("property_id", calendar.property_id)
        .eq("url_key", urlKey)
        .eq("cancelled", false)
        .gte("end_at", todayStart.toISOString());

      if (activeHistory && activeHistory.length > 0) {
        const staleIds = activeHistory
          .filter((h) => !currentUids.has(h.uid))
          .map((h) => h.id);

        if (staleIds.length > 0) {
          await supabase
            .from("ical_events_history")
            .update({ cancelled: true, updated_at: nowIso })
            .in("id", staleIds);
          console.log("[ical-sync] cancelled stale history records", { calendarId, count: staleIds.length });
        }
      }
    }

    await supabase
      .from("property_calendars")
      .update({ status: "active", last_synced_at: new Date().toISOString() })
      .eq("id", calendarId);

    return { ok: true, count: rows.length };
  } catch (err) {
    console.error("[ical-sync] syncCalendar failed", {
      calendarId,
      error: err instanceof Error ? err.message : err,
    });
    await supabase.from("property_calendars").update({ status: "error" }).eq("id", calendarId);
    return { ok: false, error: err instanceof Error ? err.message : "Sync failed" };
  }
}

export async function syncPropertyCalendars(
  propertyId: string,
  userId: string,
  opts: { minMinutes?: number } = {}
) {
  const supabase = getSupabaseService();
  const minMinutes = Number.isFinite(opts.minMinutes) ? (opts.minMinutes as number) : 30;

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
    .select("id, last_synced_at, status")
    .eq("property_id", propertyId);

  const tasks: Array<Promise<unknown>> = [];
  for (const calendar of calendars ?? []) {
    const last = calendar.last_synced_at ? new Date(calendar.last_synced_at).getTime() : 0;
    const minutesSince = last ? (Date.now() - last) / 60000 : Infinity;
    if (calendar.status === "syncing") {
      tasks.push(Promise.resolve({ ok: true, id: calendar.id, skipped: true, reason: "already syncing" }));
      continue;
    }
    if (minutesSince < minMinutes) {
      tasks.push(Promise.resolve({ ok: true, id: calendar.id, skipped: true, reason: "recently synced" }));
      continue;
    }
    tasks.push(syncCalendar(calendar.id, userId));
  }

  const results = await Promise.all(tasks);
  return { ok: true, results };
}
