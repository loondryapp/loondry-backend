import { Router } from "express";
import { z } from "zod";

import { HttpError } from "../lib/http.js";
import { requireUser } from "../lib/auth.js";
import { getSupabaseService } from "../lib/supabase.js";
import { syncCalendar, syncPropertyCalendars } from "../lib/ical-sync.js";

export const hostRouter = Router();

hostRouter.use(async (req, _res, next) => {
  const user = await requireUser(req);
  if (!user) return next(new HttpError(401, "Unauthorized"));
  req.userId = user.id;
  return next();
});

hostRouter.get("/api/host/properties", async (req, res) => {
  const supabase = getSupabaseService();
  const userId = req.userId!;
  const { data, error } = await supabase
    .from("properties")
    .select("id, name, address, city, rooms, beds, created_at")
    .eq("user_id", userId)
    .order("created_at", { ascending: false });
  if (error) throw new HttpError(400, error.message);
  res.json(data ?? []);
});

hostRouter.get("/api/host/properties/:id", async (req, res) => {
  const id = String(req.params.id || "");
  if (!id) throw new HttpError(400, "Missing id");
  const supabase = getSupabaseService();
  const userId = req.userId!;
  const { data, error } = await supabase
    .from("properties")
    .select("id, name, address, city, rooms, beds, created_at")
    .eq("id", id)
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw new HttpError(400, error.message);
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
    })
    .safeParse(req.body);
  if (!body.success) throw new HttpError(400, "Invalid body", body.error.flatten());

  const supabase = getSupabaseService();
  const userId = req.userId!;
  const { data, error } = await supabase
    .from("properties")
    .insert({ ...body.data, user_id: userId })
    .select("id, name, address, city, rooms, beds, created_at")
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
    })
    .safeParse(req.body);
  if (!body.success) throw new HttpError(400, "Invalid body", body.error.flatten());

  const supabase = getSupabaseService();
  const userId = req.userId!;
  const { data, error } = await supabase
    .from("properties")
    .update(body.data)
    .eq("id", id)
    .eq("user_id", userId)
    .select("id, name, address, city, rooms, beds, created_at")
    .single();
  if (error) throw new HttpError(400, error.message);
  res.json(data);
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
      vat_number: z.string().optional(),
      legal_address: z.string().optional(),
      company_name: z.string().optional(),
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

  let propertiesQuery = supabase.from("properties").select("id").eq("user_id", userId);
  if (query.data.property_id) propertiesQuery = propertiesQuery.eq("id", query.data.property_id);
  const { data: properties, error: propError } = await propertiesQuery;
  if (propError) throw new HttpError(400, propError.message);
  const ids = (properties ?? []).map((p) => p.id);
  if (ids.length === 0) return res.json([]);

  const { data, error } = await supabase
    .from("bookings")
    .select("id, property_id, calendar_id, external_id, source_name, summary, start_date, end_date")
    .in("property_id", ids)
    .gte("start_date", query.data.from)
    .lte("end_date", query.data.to);
  if (error) throw new HttpError(400, error.message);
  res.json(data ?? []);
});

hostRouter.post("/api/host/calendars/:id/sync", async (req, res) => {
  const id = String(req.params.id || "");
  if (!id) throw new HttpError(400, "Missing id");
  const userId = req.userId!;
  const result = await syncCalendar(id, userId);
  if (!result.ok) throw new HttpError(400, result.error || "Sync failed");
  res.json(result);
});

hostRouter.post("/api/host/properties/:id/sync", async (req, res) => {
  const id = String(req.params.id || "");
  if (!id) throw new HttpError(400, "Missing id");
  const userId = req.userId!;
  const result = await syncPropertyCalendars(id, userId);
  if (!result.ok) throw new HttpError(400, result.error || "Sync failed");
  res.json(result);
});
