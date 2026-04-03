import { Router, type NextFunction, type Request, type Response } from "express";
import { z } from "zod";

import { requireUser } from "../lib/auth.js";
import { HttpError } from "../lib/http.js";
import { getSupabaseService } from "../lib/supabase.js";

export const propertyServicesRouter = Router();

type HostConnectionRow = {
  laundry_id: string;
  status?: string | null;
  is_primary?: boolean | null;
};

type PropertyRow = {
  id: string;
  user_id?: string | null;
  host_id?: string | null;
  name: string;
  bedrooms?: number | null;
  bathrooms?: number | null;
  beds?: number | null;
  guests?: number | null;
  default_guests?: number | null;
};

type ServiceRow = {
  id: string;
  name: string;
  description: string | null;
  price_min: number | null;
  price_max: number | null;
};

function isMissingRelation(error: unknown) {
  const message =
    error && typeof error === "object" && "message" in error
      ? String((error as { message?: string }).message ?? "")
      : "";
  return message.includes("does not exist");
}

function isMissingColumn(error: unknown, columnName: string) {
  const message =
    error && typeof error === "object" && "message" in error
      ? String((error as { message?: string }).message ?? "")
      : "";
  return message.includes(`column`) && message.includes(columnName) && message.includes("does not exist");
}

function isNoRows(error: unknown) {
  const message =
    error && typeof error === "object" && "message" in error
      ? String((error as { message?: string }).message ?? "")
      : "";
  return message.includes("0 rows") || message.includes("Results contain 0 rows");
}

async function resolveHostLaundryId(hostId: string): Promise<string | null> {
  const supabase = getSupabaseService();

  const preferred = await supabase
    .from("host_laundry_connections")
    .select("laundry_id,status")
    .eq("host_id", hostId)
    .eq("status", "active")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!preferred.error && preferred.data?.laundry_id) return preferred.data.laundry_id;
  if (preferred.error && !isMissingRelation(preferred.error) && !isNoRows(preferred.error)) {
    throw new HttpError(400, preferred.error.message);
  }

  const legacy = await supabase
    .from("laundry_host_links")
    .select("laundry_id,status,is_primary")
    .eq("host_id", hostId)
    .in("status", ["active", "accepted", "pending"])
    .order("is_primary", { ascending: false })
    .order("created_at", { ascending: false });

  if (legacy.error) throw new HttpError(400, legacy.error.message);
  const rows = (legacy.data as HostConnectionRow[] | null) ?? [];
  const active = rows.find((row) => row.status === "active" || row.status === "accepted") ?? rows[0];
  return active?.laundry_id ?? null;
}

async function ensureHostOwnsProperty(hostId: string, propertyId: string): Promise<PropertyRow> {
  const supabase = getSupabaseService();
  let selected = await supabase
    .from("properties")
    .select("id,user_id,host_id,name,bedrooms,bathrooms,beds,guests,default_guests")
    .eq("id", propertyId)
    .maybeSingle();
  if (selected.error && (isMissingColumn(selected.error, "host_id") || isMissingColumn(selected.error, "guests"))) {
    selected = await supabase
      .from("properties")
      .select("id,user_id,name,bedrooms,bathrooms,beds,default_guests")
      .eq("id", propertyId)
      .maybeSingle();
  }
  if (selected.error) throw new HttpError(400, selected.error.message);
  const property = selected.data as PropertyRow | null;
  if (!property) throw new HttpError(404, "Property not found");

  const ownerId = property.host_id ?? property.user_id ?? null;
  if (ownerId !== hostId) throw new HttpError(403, "Forbidden");
  return property;
}

propertyServicesRouter.use(async (req: Request, _res: Response, next: NextFunction) => {
  try {
    const user = await requireUser(req);
    if (!user) return next(new HttpError(401, "Unauthorized"));
    req.userId = user.id;
    return next();
  } catch (error) {
    return next(error);
  }
});

async function listServices(req: Request, res: Response) {
  const hostId = req.userId!;
  const laundryId = await resolveHostLaundryId(hostId);
  if (!laundryId) throw new HttpError(409, "No active laundry connected to this host");

  const supabase = getSupabaseService();
  const { data, error } = await supabase
    .from("services")
    .select("id,name,description,price_min,price_max,laundry_id,is_active")
    .eq("laundry_id", laundryId)
    .eq("is_active", true)
    .order("name", { ascending: true });
  if (error) {
    if (isMissingColumn(error, "laundry_id") || isMissingColumn(error, "price_min") || isMissingColumn(error, "price_max")) {
      throw new HttpError(
        500,
        "Services schema is outdated. Apply latest migration for services.laundry_id, services.price_min, services.price_max."
      );
    }
    throw new HttpError(400, error.message);
  }

  return res.json(
    ((data as ServiceRow[] | null) ?? []).map((row) => ({
      id: row.id,
      name: row.name,
      description: row.description,
      price_min: row.price_min,
      price_max: row.price_max,
    }))
  );
}

propertyServicesRouter.get("/api/services", (req, res, next) => {
  listServices(req, res).catch(next);
});
propertyServicesRouter.get("/services", (req, res, next) => {
  listServices(req, res).catch(next);
});

async function getPropertyWithService(req: Request, res: Response) {
  const propertyId = String(req.params.id ?? "");
  if (!propertyId) throw new HttpError(400, "Missing property id");

  const property = await ensureHostOwnsProperty(req.userId!, propertyId);
  const supabase = getSupabaseService();
  const { data: propertyService, error } = await supabase
    .from("property_services")
    .select("service_id")
    .eq("property_id", propertyId)
    .maybeSingle();
  if (error && !isNoRows(error)) throw new HttpError(400, error.message);

  return res.json({
    id: property.id,
    name: property.name,
    bedrooms: property.bedrooms ?? null,
    bathrooms: property.bathrooms ?? null,
    beds: property.beds ?? null,
    guests: property.guests ?? property.default_guests ?? null,
    selected_service_id: propertyService?.service_id ?? null,
  });
}

propertyServicesRouter.get("/api/property/:id", (req, res, next) => {
  getPropertyWithService(req, res).catch(next);
});
propertyServicesRouter.get("/property/:id", (req, res, next) => {
  getPropertyWithService(req, res).catch(next);
});

const assignServiceBody = z.object({
  service_id: z.string().uuid(),
});

async function assignService(req: Request, res: Response) {
  const propertyId = String(req.params.id ?? "");
  if (!propertyId) throw new HttpError(400, "Missing property id");

  const payload = assignServiceBody.safeParse(req.body);
  if (!payload.success) throw new HttpError(400, "Invalid body", payload.error.flatten());

  const hostId = req.userId!;
  await ensureHostOwnsProperty(hostId, propertyId);
  const laundryId = await resolveHostLaundryId(hostId);
  if (!laundryId) throw new HttpError(409, "No active laundry connected to this host");

  const supabase = getSupabaseService();
  const { data: service, error: serviceError } = await supabase
    .from("services")
    .select("id,laundry_id,is_active")
    .eq("id", payload.data.service_id)
    .eq("laundry_id", laundryId)
    .eq("is_active", true)
    .maybeSingle();
  if (serviceError) {
    if (isMissingColumn(serviceError, "laundry_id")) {
      throw new HttpError(500, "Services schema is outdated. Apply latest migration for services.laundry_id.");
    }
    throw new HttpError(400, serviceError.message);
  }
  if (!service?.id) throw new HttpError(400, "Service is not available for this host");

  const upsertResult = await supabase
    .from("property_services")
    .upsert(
      {
        property_id: propertyId,
        service_id: payload.data.service_id,
      },
      { onConflict: "property_id" }
    )
    .select("property_id,service_id")
    .maybeSingle();
  if (upsertResult.error) throw new HttpError(400, upsertResult.error.message);

  return res.json({
    property_id: upsertResult.data?.property_id ?? propertyId,
    service_id: upsertResult.data?.service_id ?? payload.data.service_id,
    status: "ok",
  });
}

propertyServicesRouter.post("/api/property/:id/service", (req, res, next) => {
  assignService(req, res).catch(next);
});
propertyServicesRouter.post("/property/:id/service", (req, res, next) => {
  assignService(req, res).catch(next);
});
