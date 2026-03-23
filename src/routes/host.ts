import { Router, type Request, type Response, type NextFunction } from "express";
import { z } from "zod";

import { HttpError } from "../lib/http.js";
import { requireUser } from "../lib/auth.js";
import { getSupabaseService } from "../lib/supabase.js";
import { syncCalendar, syncPropertyCalendars } from "../lib/ical-sync.js";

export const hostRouter = Router();

function isArchivedAtMissing(error: unknown) {
  const msg = error && typeof error === "object" && "message" in error ? String((error as any).message) : "";
  return msg.includes("archived_at");
}

hostRouter.use(async (req, _res, next) => {
  const user = await requireUser(req);
  if (!user) return next(new HttpError(401, "Unauthorized"));
  req.userId = user.id;
  return next();
});

async function ensureClientForLaundry(supabase: ReturnType<typeof getSupabaseService>, laundryId: string, userId: string) {
  const { data: profile } = await supabase
    .from("profiles")
    .select("first_name,last_name,email,phone")
    .eq("id", userId)
    .maybeSingle();
  let profileEmail = profile?.email ?? null;
  if (!profileEmail) {
    try {
      const { data: authUser } = await supabase.auth.admin.getUserById(userId);
      profileEmail = authUser?.user?.email ?? null;
    } catch {
      // ignore admin lookup errors
    }
  }
  const profileName = `${profile?.first_name ?? ""} ${profile?.last_name ?? ""}`.trim();
  if (!profileEmail) return;

  const { data: existingClient, error: existingClientError } = await supabase
    .from("clients")
    .select("id")
    .eq("laundry_id", laundryId)
    .eq("email", profileEmail)
    .maybeSingle();
  if (existingClientError && !String(existingClientError.message || "").includes("Results contain 0 rows")) {
    throw new HttpError(400, existingClientError.message);
  }
  if (!existingClient?.id) {
    const { error: clientError } = await supabase.from("clients").insert({
      name: profileName || profileEmail,
      email: profileEmail,
      phone: profile?.phone ?? null,
      source: "loondry",
      is_active: true,
      laundry_id: laundryId,
    });
    if (clientError) throw new HttpError(400, clientError.message);
  }
}

async function createConnection(req: Request, res: Response, next: NextFunction) {
  try {
    const body = z
      .object({
        invite_code: z.string().min(1),
      })
      .safeParse(req.body);
    if (!body.success) return next(new HttpError(400, "Invalid body", body.error.flatten()));

    const supabase = getSupabaseService();
    const userId = req.userId!;
    const normalized = body.data.invite_code.trim().toUpperCase();

    const { data: laundry, error: laundryError } = await supabase
      .from("laundries")
      .select("id, company_name, host_invite_code")
      .eq("host_invite_code", normalized)
      .maybeSingle();
    if (laundryError) return next(new HttpError(400, laundryError.message));
    if (!laundry?.id) return next(new HttpError(404, "Laundry not found"));

    const { data: existing, error: existingError } = await supabase
      .from("laundry_host_links")
      .select("id,status")
      .eq("host_id", userId)
      .eq("laundry_id", laundry.id)
      .maybeSingle();
    if (existingError && !String(existingError.message || "").includes("Results contain 0 rows")) {
      return next(new HttpError(400, existingError.message));
    }
    if (existing?.id) {
      try {
        await ensureClientForLaundry(supabase, laundry.id, userId);
      } catch (err) {
        return next(err);
      }
      return res.status(200).json({
        laundry_id: laundry.id,
        status: existing.status ?? "active",
        is_primary: true,
        laundries: { id: laundry.id, company_name: laundry.company_name },
      });
    }

    await supabase.from("laundry_host_links").update({ is_primary: false }).eq("host_id", userId);

    const { data: created, error: createError } = await supabase
      .from("laundry_host_links")
      .insert({
        laundry_id: laundry.id,
        host_id: userId,
        status: "active",
        is_primary: true,
      })
      .select("laundry_id,status,is_primary")
      .maybeSingle();
    if (createError) return next(new HttpError(400, createError.message));

    await ensureClientForLaundry(supabase, laundry.id, userId);

    res.json({
      laundry_id: created?.laundry_id ?? laundry.id,
      status: created?.status ?? "active",
      is_primary: created?.is_primary ?? true,
      laundries: { id: laundry.id, company_name: laundry.company_name },
    });
  } catch (err) {
    return next(err);
  }
}

hostRouter.post("/api/host/connections", (req, res, next) => createConnection(req, res, next));
hostRouter.post("/api/connections", (req, res, next) => createConnection(req, res, next));

hostRouter.get("/api/host/properties", async (req, res) => {
  const query = z
    .object({
      include_archived: z.coerce.number().int().optional(),
    })
    .safeParse(req.query);
  if (!query.success) throw new HttpError(400, "Invalid query", query.error.flatten());

  const supabase = getSupabaseService();
  const userId = req.userId!;
  const includeArchived = Boolean(query.data.include_archived);

  let propsQuery = supabase
    .from("properties")
    .select("id, name, address, city, rooms, beds, created_at, cover_url, use_laundry, management_type, archived_at, use_laundry, management_type")
    .eq("user_id", userId);
  if (!includeArchived) propsQuery = propsQuery.is("archived_at", null);
  const { data, error } = await propsQuery.order("created_at", { ascending: false });
  if (error) {
    if (isArchivedAtMissing(error)) {
      const fallback = await supabase
        .from("properties")
        .select("id, name, address, city, rooms, beds, created_at, cover_url, use_laundry, management_type")
        .eq("user_id", userId)
        .order("created_at", { ascending: false });
      if (fallback.error) throw new HttpError(400, fallback.error.message);
      return res.json(fallback.data ?? []);
    }
    throw new HttpError(400, error.message);
  }
  res.json(data ?? []);
});

hostRouter.get("/api/host/properties/:id", async (req, res) => {
  const id = String(req.params.id || "");
  if (!id) throw new HttpError(400, "Missing id");
  const supabase = getSupabaseService();
  const userId = req.userId!;
  const { data, error } = await supabase
    .from("properties")
    .select("id, name, address, city, rooms, beds, created_at, cover_url, use_laundry, management_type, archived_at, use_laundry, management_type")
    .eq("id", id)
    .eq("user_id", userId)
    .maybeSingle();
  if (error) {
    if (isArchivedAtMissing(error)) {
      const fallback = await supabase
        .from("properties")
        .select("id, name, address, city, rooms, beds, created_at, cover_url, use_laundry, management_type")
        .eq("id", id)
        .eq("user_id", userId)
        .maybeSingle();
      if (fallback.error) throw new HttpError(400, fallback.error.message);
      if (!fallback.data) throw new HttpError(404, "Property not found");
      return res.json(fallback.data);
    }
    throw new HttpError(400, error.message);
  }
  if (!data) throw new HttpError(404, "Property not found");
  res.json(data);
});

hostRouter.post("/api/host/properties", async (req, res) => {
  const body = z
    .object({
      name: z.string().min(1),
      address: z.string().min(1),
      city: z.string().min(1),
      rooms: z.number().int().min(1),
      beds: z.number().int().min(1).default(2),
      use_laundry: z.boolean().optional(),
      management_type: z.enum(["self", "linen", "full"]).optional(),
    })
    .safeParse(req.body);
  if (!body.success) throw new HttpError(400, "Invalid body", body.error.flatten());

  const supabase = getSupabaseService();
  const userId = req.userId!;
  const { data, error } = await supabase
    .from("properties")
    .insert({ ...body.data, user_id: userId })
    .select("id, name, address, city, rooms, beds, created_at, cover_url, use_laundry, management_type")
    .single();
  if (error) throw new HttpError(400, error.message);
  res.json(data);
});

hostRouter.patch("/api/host/properties/:id", async (req, res) => {
  const id = String(req.params.id || "");
  if (!id) throw new HttpError(400, "Missing id");
  const body = z
    .object({
      name: z.string().min(1).optional(),
      address: z.string().min(1).optional(),
      city: z.string().min(1).optional(),
      rooms: z.number().int().min(1).optional(),
      beds: z.number().int().min(1).optional(),
      cover_url: z.string().url().nullable().optional(),
      archived_at: z.string().datetime().nullable().optional(),
      use_laundry: z.boolean().optional(),
      management_type: z.enum(["self", "linen", "full"]).optional(),
    })
    .safeParse(req.body);
  if (!body.success) throw new HttpError(400, "Invalid body", body.error.flatten());

  const supabase = getSupabaseService();
  const userId = req.userId!;
  const baseUpdate = supabase.from("properties").update(body.data).eq("id", id).eq("user_id", userId);
  let { data, error } = await baseUpdate
    .select("id, name, address, city, rooms, beds, created_at, cover_url, use_laundry, management_type, archived_at")
    .single();
  if (error && isArchivedAtMissing(error)) {
    const fallback = await baseUpdate.select("id, name, address, city, rooms, beds, created_at, cover_url, use_laundry, management_type").single();
    if (fallback.error) throw new HttpError(400, fallback.error.message);
    return res.json(fallback.data);
  }
  if (error) throw new HttpError(400, error.message);
  res.json(data);
});

hostRouter.post("/api/host/properties/:id/archive", async (req, res) => {
  const id = String(req.params.id || "");
  if (!id) throw new HttpError(400, "Missing id");
  const supabase = getSupabaseService();
  const userId = req.userId!;
  const { data, error } = await supabase
    .from("properties")
    .update({ archived_at: new Date().toISOString() })
    .eq("id", id)
    .eq("user_id", userId)
    .select("id, archived_at")
    .single();
  if (error && isArchivedAtMissing(error)) {
    return res.status(400).json({ error: "archived_at column missing (run migration)" });
  }
  if (error) throw new HttpError(400, error.message);
  res.json(data);
});

hostRouter.delete("/api/host/properties/:id", async (req, res) => {
  const id = String(req.params.id || "");
  if (!id) throw new HttpError(400, "Missing id");
  const supabase = getSupabaseService();
  const userId = req.userId!;
  const { error } = await supabase.from("properties").delete().eq("id", id).eq("user_id", userId);
  if (error) throw new HttpError(400, error.message);
  res.json({ ok: true });
});

hostRouter.get("/api/host/calendars", async (req, res) => {
  const query = z
    .object({
      property_id: z.string().uuid(),
    })
    .safeParse(req.query);
  if (!query.success) throw new HttpError(400, "Invalid query", query.error.flatten());

  const supabase = getSupabaseService();
  const userId = req.userId!;

  const { data: property, error: propError } = await supabase
    .from("properties")
    .select("id, user_id")
    .eq("id", query.data.property_id)
    .maybeSingle();
  if (propError || !property) throw new HttpError(404, "Property not found");
  if (property.user_id !== userId) throw new HttpError(403, "Not authorized");

  const { data, error } = await supabase
    .from("property_calendars")
    .select("id, name, ical_url, source_type, status, last_synced_at")
    .eq("property_id", property.id)
    .order("created_at", { ascending: false });
  if (error) throw new HttpError(400, error.message);
  res.json(data ?? []);
});

hostRouter.post("/api/host/calendars", async (req, res) => {
  const body = z
    .object({
      property_id: z.string().uuid(),
      name: z.string().min(1),
      ical_url: z.string().url(),
      source_type: z.enum(["airbnb", "booking", "custom"]).default("custom"),
    })
    .safeParse(req.body);
  if (!body.success) throw new HttpError(400, "Invalid body", body.error.flatten());

  const supabase = getSupabaseService();
  const userId = req.userId!;

  const { data: property, error: propError } = await supabase
    .from("properties")
    .select("id, user_id")
    .eq("id", body.data.property_id)
    .maybeSingle();
  if (propError || !property) throw new HttpError(404, "Property not found");
  if (property.user_id !== userId) throw new HttpError(403, "Not authorized");

  const { data, error } = await supabase
    .from("property_calendars")
    .insert({ ...body.data, status: "syncing" })
    .select("id, name, ical_url, source_type, status, last_synced_at")
    .single();
  if (error) throw new HttpError(400, error.message);
  res.json(data);
});

hostRouter.patch("/api/host/calendars/:id", async (req, res) => {
  const id = String(req.params.id || "");
  if (!id) throw new HttpError(400, "Missing id");
  const body = z
    .object({
      name: z.string().min(1).optional(),
      ical_url: z.string().url().optional(),
      source_type: z.enum(["airbnb", "booking", "custom"]).optional(),
    })
    .safeParse(req.body);
  if (!body.success) throw new HttpError(400, "Invalid body", body.error.flatten());

  const supabase = getSupabaseService();
  const userId = req.userId!;

  const { data: calendar, error: calError } = await supabase
    .from("property_calendars")
    .select("id, property_id")
    .eq("id", id)
    .maybeSingle();
  if (calError || !calendar) throw new HttpError(404, "Calendar not found");

  const { data: property, error: propError } = await supabase
    .from("properties")
    .select("id, user_id")
    .eq("id", calendar.property_id)
    .maybeSingle();
  if (propError || !property) throw new HttpError(404, "Property not found");
  if (property.user_id !== userId) throw new HttpError(403, "Not authorized");

  const { data, error } = await supabase
    .from("property_calendars")
    .update(body.data)
    .eq("id", id)
    .select("id, name, ical_url, source_type, status, last_synced_at")
    .single();
  if (error) throw new HttpError(400, error.message);
  res.json(data);
});

hostRouter.delete("/api/host/calendars/:id", async (req, res) => {
  const id = String(req.params.id || "");
  if (!id) throw new HttpError(400, "Missing id");
  const supabase = getSupabaseService();
  const userId = req.userId!;

  const { data: calendar, error: calError } = await supabase
    .from("property_calendars")
    .select("id, property_id")
    .eq("id", id)
    .maybeSingle();
  if (calError || !calendar) throw new HttpError(404, "Calendar not found");

  const { data: property, error: propError } = await supabase
    .from("properties")
    .select("id, user_id")
    .eq("id", calendar.property_id)
    .maybeSingle();
  if (propError || !property) throw new HttpError(404, "Property not found");
  if (property.user_id !== userId) throw new HttpError(403, "Not authorized");

  const { error } = await supabase.from("property_calendars").delete().eq("id", id);
  if (error) throw new HttpError(400, error.message);
  res.json({ ok: true });
});

hostRouter.post("/api/host/billing", async (req, res) => {
  const body = z
    .object({
      type: z.enum(["private", "company"]),
      first_name: z.string().min(1),
      last_name: z.string().min(1),
      billing_address: z.string().min(1),
      tax_code: z.string().min(1),
      vat_number: z.string().nullable().optional(),
      legal_address: z.string().nullable().optional(),
      company_name: z.string().nullable().optional(),
    })
    .safeParse(req.body);
  if (!body.success) throw new HttpError(400, "Invalid body", body.error.flatten());

  const supabase = getSupabaseService();
  const userId = req.userId!;
  const { data, error } = await supabase
    .from("host_billings")
    .insert({ ...body.data, user_id: userId })
    .select("id")
    .single();
  if (error) throw new HttpError(400, error.message);
  res.json(data);
});

hostRouter.post("/api/host/seed-properties", async (req, res) => {
  const supabase = getSupabaseService();
  const userId = req.userId!;

  const seed = [
    { name: "Bocconi", address: "Viale Bligny 64, 20136 Milano MI", city: "Milano", rooms: 2, beds: 2 },
    { name: "Martini", address: "Via Pasquale Sottocorno 4, 20129 Milano MI", city: "Milano", rooms: 2, beds: 2 },
    { name: "Daiquiri", address: "Via Pasquale Sottocorno 4, 20129 Milano MI", city: "Milano", rooms: 2, beds: 2 },
    { name: "Cosmopolitan", address: "Via Pasquale Sottocorno 5, 20129 Milano MI", city: "Milano", rooms: 2, beds: 2 },
    { name: "Gramsci", address: "Piazza Gramsci 5, 20154 Milano MI", city: "Milano", rooms: 2, beds: 2 },
    { name: "Spritz", address: "Via Pasquale Sottocorno 4, 20129 Milano MI", city: "Milano", rooms: 2, beds: 2 },
    { name: "Sottocorno White", address: "Via Sottocorno 5 A, Milano", city: "Milano", rooms: 2, beds: 2 },
    { name: "Margarita", address: "Via Pasquale Sottocorno 4, 20129 Milano MI", city: "Milano", rooms: 2, beds: 2 },
  ];

  const { data: existing } = await supabase
    .from("properties")
    .select("name")
    .eq("user_id", userId);
  const existingNames = new Set((existing ?? []).map((p) => p.name));

  const rows = seed
    .filter((p) => !existingNames.has(p.name))
    .map((p) => ({ ...p, user_id: userId }));

  if (rows.length) {
    const { error } = await supabase.from("properties").insert(rows);
    if (error) throw new HttpError(400, error.message);
  }

  res.json({ ok: true, inserted: rows.length });
});

hostRouter.get("/api/host/bookings", async (req, res) => {
  const query = z
    .object({
      property_id: z.string().uuid().optional(),
      from: z.string().min(10),
      to: z.string().min(10),
    })
    .safeParse(req.query);
  if (!query.success) throw new HttpError(400, "Invalid query", query.error.flatten());

  const supabase = getSupabaseService();
  const userId = req.userId!;

  let propertiesQuery = supabase.from("properties").select("id").eq("user_id", userId).is("archived_at", null);
  if (query.data.property_id) propertiesQuery = propertiesQuery.eq("id", query.data.property_id);
  let { data: properties, error: propError } = await propertiesQuery;
  if (propError && isArchivedAtMissing(propError)) {
    let fallback = supabase.from("properties").select("id").eq("user_id", userId);
    if (query.data.property_id) fallback = fallback.eq("id", query.data.property_id);
    const fb = await fallback;
    if (fb.error) throw new HttpError(400, fb.error.message);
    properties = fb.data;
    propError = null;
  }
  if (propError) throw new HttpError(400, propError.message);
  const ids = (properties ?? []).map((p) => p.id);
  if (ids.length === 0) return res.json([]);

  const { data, error } = await supabase
    .from("bookings")
    .select("id, property_id, calendar_id, external_id, source_name, summary, start_date, end_date")
    .in("property_id", ids)
    .lte("start_date", query.data.to)
    .gte("end_date", query.data.from);
  if (error) throw new HttpError(400, error.message);
  res.json(data ?? []);
});



hostRouter.get("/api/host/bookings-history", async (req, res) => {
  const query = z
    .object({
      property_id: z.string().uuid().optional(),
      from: z.string().min(10),
      to: z.string().min(10),
    })
    .safeParse(req.query);
  if (!query.success) throw new HttpError(400, "Invalid query", query.error.flatten());

  const supabase = getSupabaseService();
  const userId = req.userId!;

  let propertiesQuery = supabase
    .from("properties")
    .select("id")
    .eq("user_id", userId)
    .is("archived_at", null);
  if (query.data.property_id) propertiesQuery = propertiesQuery.eq("id", query.data.property_id);
  let { data: properties, error: propError } = await propertiesQuery;
  if (propError && isArchivedAtMissing(propError)) {
    let fallback = supabase.from("properties").select("id").eq("user_id", userId);
    if (query.data.property_id) fallback = fallback.eq("id", query.data.property_id);
    const fb = await fallback;
    if (fb.error) throw new HttpError(400, fb.error.message);
    properties = fb.data;
    propError = null;
  }
  if (propError) throw new HttpError(400, propError.message);
  const ids = (properties ?? []).map((p) => p.id);
  if (ids.length === 0) return res.json([]);

  const { data, error } = await supabase
    .from("ical_events_history")
    .select("id, property_id, start_at, end_at, calendar_source, summary, status, last_seen_at")
    .in("property_id", ids)
    .or("status.is.null,status.neq.cancelled")
    .lte("start_at", query.data.to)
    .gte("end_at", query.data.from)
    .order("start_at", { ascending: true });
  if (error) throw new HttpError(400, error.message);
  res.json(data ?? []);
});

hostRouter.post("/api/host/bookings-history", async (req, res) => {
  const body = z
    .object({
      events: z
        .array(
          z.object({
            property_id: z.string().uuid(),
            property_name: z.string().optional(),
            calendar_source: z.string().optional(),
            calendar_url: z.string().optional(),
            url_key: z.string().optional(),
            uid: z.string().min(1),
            start_at: z.string().min(10),
            end_at: z.string().min(10),
            summary: z.string().optional().nullable(),
          })
        )
        .default([]),
    })
    .safeParse(req.body);
  if (!body.success) throw new HttpError(400, "Invalid body", body.error.flatten());

  const events = body.data.events ?? [];
  if (!events.length) return res.json({ ok: true, upserted: 0 });

  const supabase = getSupabaseService();
  const userId = req.userId!;

  const { data: props, error: propErr } = await supabase
    .from("properties")
    .select("id, name")
    .eq("user_id", userId);
  if (propErr) throw new HttpError(400, propErr.message);
  const allowed = new Map((props ?? []).map((p) => [p.id, p.name]));

  const now = new Date().toISOString();
  const payload = events
    .filter((e) => allowed.has(e.property_id))
    .map((e) => ({
      property_id: e.property_id,
      property_name: e.property_name ?? allowed.get(e.property_id) ?? null,
      calendar_source: e.calendar_source ?? null,
      calendar_url: e.calendar_url ?? null,
      url_key: e.url_key ?? null,
      uid: e.uid,
      start_at: e.start_at,
      end_at: e.end_at,
      summary: e.summary ?? null,
      status: null,
      last_seen_at: now,
      updated_at: now,
    }));

  if (!payload.length) return res.json({ ok: true, upserted: 0 });

  const { data, error } = await supabase
    .from("ical_events_history")
    .upsert(payload, { onConflict: "property_id,uid,start_at,end_at" })
    .select("property_id");
  if (error) throw new HttpError(400, error.message);

  res.json({ ok: true, upserted: (data ?? []).length });
});

hostRouter.post("/api/host/bookings-history/cleanup", async (req, res) => {
  const supabase = getSupabaseService();
  const userId = req.userId!;

  let { data: properties, error: propError } = await supabase
    .from("properties")
    .select("id")
    .eq("user_id", userId);
  if (propError && isArchivedAtMissing(propError)) {
    const fb = await supabase.from("properties").select("id").eq("user_id", userId);
    if (fb.error) throw new HttpError(400, fb.error.message);
    properties = fb.data;
    propError = null;
  }
  if (propError) throw new HttpError(400, propError.message);
  const ids = (properties ?? []).map((p) => p.id);
  if (!ids.length) return res.json({ ok: true, updated: 0 });

  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const today = new Date().toISOString().slice(0, 10);

  const { data, error } = await supabase
    .from("ical_events_history")
    .update({ status: "cancelled", updated_at: new Date().toISOString() })
    .in("property_id", ids)
    .gte("end_at", today)
    .lt("last_seen_at", cutoff)
    .is("status", null)
    .select("id");
  if (error) throw new HttpError(400, error.message);

  res.json({ ok: true, updated: (data ?? []).length });
});

hostRouter.post("/api/host/calendars/:id/sync", async (req, res) => {
  try {
    const id = String(req.params.id || "");
    if (!id) return res.status(400).json({ error: "Missing id" });
    const userId = req.userId!;
    const result = await syncCalendar(id, userId);
    if (!result.ok) return res.status(400).json({ error: result.error || "Sync failed" });
    return res.json(result);
  } catch (err) {
    console.error("/api/host/calendars/:id/sync failed", err);
    return res.status(500).json({ error: "Sync failed" });
  }
});

hostRouter.post("/api/host/properties/:id/sync", async (req, res) => {
  try {
    const id = String(req.params.id || "");
    if (!id) return res.status(400).json({ error: "Missing id" });
    const userId = req.userId!;
    const query = z
      .object({
        min_minutes: z.coerce.number().int().min(0).optional(),
      })
      .safeParse(req.query);
    if (!query.success) return res.status(400).json({ error: "Invalid query", details: query.error.flatten() });

    const result = await syncPropertyCalendars(id, userId, { minMinutes: query.data.min_minutes });
    if (!result.ok) return res.status(400).json({ error: result.error || "Sync failed" });
    return res.json(result);
  } catch (err) {
    console.error("/api/host/properties/:id/sync failed", err);
    return res.status(500).json({ error: "Sync failed" });
  }
});
