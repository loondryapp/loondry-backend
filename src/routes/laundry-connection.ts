import { Router, type NextFunction, type Request, type Response } from "express";
import { z } from "zod";

import { requireUser, requireSuperAdmin } from "../lib/auth.js";
import { HttpError } from "../lib/http.js";
import { getSupabaseService } from "../lib/supabase.js";

export const laundryConnectionRouter = Router();

const requestStatusValues = [
  "pending_assignment",
  "sent_to_laundry",
  "under_review",
  "accepted_waiting_contract",
  "contract_uploaded",
  "contract_sent",
  "contract_signed",
  "active",
  "rejected",
  "changes_requested",
] as const;

const contractStatusValues = ["draft", "sent", "viewed", "signed", "already_signed", "expired", "cancelled"] as const;
const invitationStatusValues = ["draft", "sent", "viewed", "accepted", "active", "rejected", "expired"] as const;

laundryConnectionRouter.use(async (req, _res, next: NextFunction) => {
  const user = await requireUser(req);
  if (!user) return next(new HttpError(401, "Unauthorized"));
  req.userId = user.id;
  return next();
});

const apartmentSchema = z.object({
  property_id: z.string().uuid().nullable().optional(),
  property_name: z.string().min(1),
  address: z.string().min(1),
  city: z.string().min(1),
  zone: z.string().optional().default(""),
  square_meters: z.number().nonnegative().optional().default(0),
  bedrooms_count: z.number().int().nonnegative().optional().default(0),
  beds_count: z.number().int().nonnegative().optional().default(0),
  checkin_time: z.string().optional().default(""),
  checkout_time: z.string().optional().default(""),
  requested_service_ids: z.array(z.string()).optional().default([]),
  notes: z.string().optional(),
});

const contractSchema = z.object({
  file_url: z.string().min(1),
  file_name: z.string().min(1),
  contract_name: z.string().min(1),
  notes_for_host: z.string().optional(),
  requires_signature: z.boolean().optional().default(true),
  is_downloadable: z.boolean().optional().default(true),
  signature_due_date: z.string().nullable().optional(),
  is_already_signed: z.boolean().optional().default(false),
  signed_offline_at: z.string().nullable().optional(),
  offline_signature_name: z.string().nullable().optional(),
});

laundryConnectionRouter.post("/api/host/laundry-connection/request", async (req, res) => {
  const body = z
    .object({
      requested_services: z.array(z.string()).min(1),
      apartment_ids: z.array(z.string()).min(1),
      notes: z.string().optional(),
    })
    .safeParse(req.body);
  if (!body.success) throw new HttpError(400, "Invalid body", body.error.flatten());

  const supabase = getSupabaseService();
  const userId = req.userId!;
  const { data: apartments, error: apartmentsError } = await supabase
    .from("properties")
    .select("id,name,address,city,rooms,beds,check_in_time,check_out_time")
    .eq("user_id", userId)
    .in("id", body.data.apartment_ids);
  if (apartmentsError) throw new HttpError(400, apartmentsError.message);
  if (!apartments?.length) throw new HttpError(400, "No apartments found");

  const city = String((apartments[0] as { city?: string | null }).city ?? "");
  const assignedLaundry = await findCompatibleLaundry(city, body.data.requested_services);

  const { data: created, error } = await supabase
    .from("laundry_connection_requests")
    .insert({
      host_id: userId,
      assigned_laundry_id: assignedLaundry?.id ?? null,
      status: assignedLaundry?.id ? "sent_to_laundry" : "pending_assignment",
      requested_services: body.data.requested_services,
      apartment_ids: body.data.apartment_ids,
      city,
      zones: [],
      notes: body.data.notes ?? null,
    })
    .select("*")
    .maybeSingle();
  if (error) throw new HttpError(400, error.message);
  if (!created?.id) throw new HttpError(500, "Request not created");

  const requestId = String(created.id);
  const apartmentRows = apartments.map((apartment: any) => ({
    request_id: requestId,
    property_id: apartment.id,
    property_name: apartment.name ?? "Appartamento",
    address: apartment.address ?? "",
    city: apartment.city ?? "",
    zone: "",
    square_meters: 0,
    bedrooms_count: Number(apartment.rooms ?? 0),
    beds_count: Number(apartment.beds ?? 0),
    checkin_time: apartment.check_in_time ?? null,
    checkout_time: apartment.check_out_time ?? null,
    requested_service_ids: body.data.requested_services,
  }));
  const { error: apartmentInsertError } = await supabase
    .from("laundry_connection_request_apartments")
    .insert(apartmentRows);
  if (apartmentInsertError) throw new HttpError(400, apartmentInsertError.message);

  res.json(created);
});

laundryConnectionRouter.get("/api/host/laundry-connection/request/current", async (req, res) => {
  const supabase = getSupabaseService();
  const { data, error } = await supabase
    .from("laundry_connection_requests")
    .select("*, laundry_connection_contracts(*)")
    .eq("host_id", req.userId!)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new HttpError(400, error.message);
  res.json(data ?? null);
});

laundryConnectionRouter.get("/api/host/laundry-connection/contracts/:contractId", async (req, res) => {
  const supabase = getSupabaseService();
  const { data, error } = await supabase
    .from("laundry_connection_contracts")
    .select("*")
    .eq("id", req.params.contractId)
    .eq("host_id", req.userId!)
    .maybeSingle();
  if (error) throw new HttpError(400, error.message);
  if (!data) throw new HttpError(404, "Contract not found");
  res.json(data);
});

laundryConnectionRouter.post("/api/host/laundry-connection/contracts/:contractId/sign", async (req, res) => {
  const body = z.object({ signature_name: z.string().min(2) }).safeParse(req.body);
  if (!body.success) throw new HttpError(400, "Invalid body", body.error.flatten());

  const supabase = getSupabaseService();
  const userId = req.userId!;
  const { data: contract, error: contractError } = await supabase
    .from("laundry_connection_contracts")
    .select("*")
    .eq("id", req.params.contractId)
    .eq("host_id", userId)
    .maybeSingle();
  if (contractError) throw new HttpError(400, contractError.message);
  if (!contract) throw new HttpError(404, "Contract not found");
  if ((contract as { status?: string }).status !== "sent") throw new HttpError(409, "Contract is not signable");

  const now = new Date().toISOString();
  const { error: updateContractError } = await supabase
    .from("laundry_connection_contracts")
    .update({
      status: "signed",
      signed_at: now,
      signed_by_user_id: userId,
      signature_name: body.data.signature_name,
      updated_at: now,
    })
    .eq("id", req.params.contractId);
  if (updateContractError) throw new HttpError(400, updateContractError.message);

  const requestId = (contract as { request_id?: string | null }).request_id;
  if (requestId) {
    await activateRequestConnection(supabase, requestId, req.params.contractId);
  }
  res.json({ success: true });
});

laundryConnectionRouter.get("/api/laundry/host-requests", async (req, res) => {
  const laundryId = await requireOwnedLaundryId(req);
  const supabase = getSupabaseService();
  const { data, error } = await supabase
    .from("laundry_connection_requests")
    .select("*")
    .eq("assigned_laundry_id", laundryId)
    .order("created_at", { ascending: false });
  if (error) throw new HttpError(400, error.message);
  res.json(data ?? []);
});

laundryConnectionRouter.get("/api/laundry/host-requests/:requestId", async (req, res) => {
  const laundryId = await requireOwnedLaundryId(req);
  const supabase = getSupabaseService();
  const { data, error } = await supabase
    .from("laundry_connection_requests")
    .select("*, laundry_connection_request_apartments(*), laundry_connection_contracts(*)")
    .eq("id", req.params.requestId)
    .eq("assigned_laundry_id", laundryId)
    .maybeSingle();
  if (error) throw new HttpError(400, error.message);
  if (!data) throw new HttpError(404, "Request not found");
  res.json(data);
});

laundryConnectionRouter.post("/api/laundry/host-requests/:requestId/accept", async (req, res) => {
  await updateLaundryRequestStatus(req, res, "accepted_waiting_contract", { accepted_at: new Date().toISOString() });
});

laundryConnectionRouter.post("/api/laundry/host-requests/:requestId/reject", async (req, res) => {
  const body = z.object({ rejection_reason: z.string().min(1) }).safeParse(req.body);
  if (!body.success) throw new HttpError(400, "Invalid body", body.error.flatten());
  await updateLaundryRequestStatus(req, res, "rejected", {
    rejection_reason: body.data.rejection_reason,
    rejected_at: new Date().toISOString(),
  });
});

laundryConnectionRouter.post("/api/laundry/host-requests/:requestId/request-changes", async (req, res) => {
  const body = z.object({ message: z.string().min(1) }).safeParse(req.body);
  if (!body.success) throw new HttpError(400, "Invalid body", body.error.flatten());
  await updateLaundryRequestStatus(req, res, "changes_requested", { changes_requested_message: body.data.message });
});

laundryConnectionRouter.post("/api/laundry/host-requests/:requestId/contracts", async (req, res) => {
  const laundryId = await requireOwnedLaundryId(req);
  const body = contractSchema.safeParse(req.body);
  if (!body.success) throw new HttpError(400, "Invalid body", body.error.flatten());

  const supabase = getSupabaseService();
  const request = await requireLaundryRequest(supabase, req.params.requestId, laundryId);
  const { data, error } = await supabase
    .from("laundry_connection_contracts")
    .insert({
      request_id: request.id,
      host_id: request.host_id,
      laundry_id: laundryId,
      source_type: "request",
      status: "draft",
      uploaded_by_laundry_id: laundryId,
      ...body.data,
    })
    .select("*")
    .maybeSingle();
  if (error) throw new HttpError(400, error.message);
  await supabase.from("laundry_connection_requests").update({ status: "contract_uploaded" }).eq("id", request.id);
  res.json(data);
});

laundryConnectionRouter.post("/api/laundry/host-requests/:requestId/contracts/:contractId/send", async (req, res) => {
  const laundryId = await requireOwnedLaundryId(req);
  const supabase = getSupabaseService();
  const request = await requireLaundryRequest(supabase, req.params.requestId, laundryId);
  const now = new Date().toISOString();
  const { error } = await supabase
    .from("laundry_connection_contracts")
    .update({ status: "sent", sent_at: now, updated_at: now })
    .eq("id", req.params.contractId)
    .eq("request_id", request.id)
    .eq("laundry_id", laundryId);
  if (error) throw new HttpError(400, error.message);
  await supabase.from("laundry_connection_requests").update({ status: "contract_sent" }).eq("id", request.id);
  res.json({ success: true });
});

laundryConnectionRouter.post("/api/laundry/host-invitations", async (req, res) => {
  const laundryId = await requireOwnedLaundryId(req);
  const body = z
    .object({
      invited_email: z.string().email(),
      invited_first_name: z.string().min(1),
      invited_last_name: z.string().min(1),
      invited_phone: z.string().optional(),
      company_name: z.string().optional(),
      notes_internal: z.string().optional(),
      notes_for_host: z.string().optional(),
      apartments: z.array(apartmentSchema).min(1),
      send_now: z.boolean().optional().default(false),
    })
    .safeParse(req.body);
  if (!body.success) throw new HttpError(400, "Invalid body", body.error.flatten());

  const supabase = getSupabaseService();
  const now = new Date().toISOString();
  const { data: invitation, error } = await supabase
    .from("laundry_host_invitations")
    .insert({
      laundry_id: laundryId,
      invited_email: body.data.invited_email,
      invited_first_name: body.data.invited_first_name,
      invited_last_name: body.data.invited_last_name,
      invited_phone: body.data.invited_phone ?? null,
      company_name: body.data.company_name ?? null,
      notes_internal: body.data.notes_internal ?? null,
      notes_for_host: body.data.notes_for_host ?? null,
      status: body.data.send_now ? "sent" : "draft",
      sent_at: body.data.send_now ? now : null,
      invitation_token: crypto.randomUUID(),
    })
    .select("*")
    .maybeSingle();
  if (error) throw new HttpError(400, error.message);
  if (!invitation?.id) throw new HttpError(500, "Invitation not created");

  const apartmentRows = body.data.apartments.map((apartment) => ({
    invitation_id: invitation.id,
    ...apartment,
  }));
  const { error: apartmentError } = await supabase.from("laundry_host_invitation_apartments").insert(apartmentRows);
  if (apartmentError) throw new HttpError(400, apartmentError.message);
  res.json(invitation);
});

laundryConnectionRouter.get("/api/laundry/host-invitations", async (req, res) => {
  const laundryId = await requireOwnedLaundryId(req);
  const supabase = getSupabaseService();
  const { data, error } = await supabase
    .from("laundry_host_invitations")
    .select("*")
    .eq("laundry_id", laundryId)
    .order("created_at", { ascending: false });
  if (error) throw new HttpError(400, error.message);
  res.json(data ?? []);
});

laundryConnectionRouter.get("/api/laundry/host-invitations/:invitationId", async (req, res) => {
  const laundryId = await requireOwnedLaundryId(req);
  const supabase = getSupabaseService();
  const { data, error } = await supabase
    .from("laundry_host_invitations")
    .select("*, laundry_host_invitation_apartments(*), laundry_connection_contracts(*)")
    .eq("id", req.params.invitationId)
    .eq("laundry_id", laundryId)
    .maybeSingle();
  if (error) throw new HttpError(400, error.message);
  if (!data) throw new HttpError(404, "Invitation not found");
  res.json(data);
});

laundryConnectionRouter.post("/api/laundry/host-invitations/:invitationId/send", async (req, res) => {
  const laundryId = await requireOwnedLaundryId(req);
  const supabase = getSupabaseService();
  const now = new Date().toISOString();
  const { data, error } = await supabase
    .from("laundry_host_invitations")
    .update({ status: "sent", sent_at: now, updated_at: now })
    .eq("id", req.params.invitationId)
    .eq("laundry_id", laundryId)
    .select("*")
    .maybeSingle();
  if (error) throw new HttpError(400, error.message);
  if (!data) throw new HttpError(404, "Invitation not found");
  res.json(data);
});

laundryConnectionRouter.post("/api/laundry/host-invitations/:invitationId/contracts", async (req, res) => {
  const laundryId = await requireOwnedLaundryId(req);
  const body = contractSchema.safeParse(req.body);
  if (!body.success) throw new HttpError(400, "Invalid body", body.error.flatten());

  const supabase = getSupabaseService();
  const { data: invitation, error: invitationError } = await supabase
    .from("laundry_host_invitations")
    .select("*")
    .eq("id", req.params.invitationId)
    .eq("laundry_id", laundryId)
    .maybeSingle();
  if (invitationError) throw new HttpError(400, invitationError.message);
  if (!invitation?.id) throw new HttpError(404, "Invitation not found");

  const alreadySigned = Boolean(body.data.is_already_signed);
  const { data, error } = await supabase
    .from("laundry_connection_contracts")
    .insert({
      ...body.data,
      invitation_id: invitation.id,
      host_id: invitation.host_id ?? null,
      laundry_id: laundryId,
      source_type: "invitation",
      status: alreadySigned ? "already_signed" : "draft",
      requires_signature: alreadySigned ? false : body.data.requires_signature,
      uploaded_by_laundry_id: laundryId,
    })
    .select("*")
    .maybeSingle();
  if (error) throw new HttpError(400, error.message);
  res.json(data);
});

laundryConnectionRouter.get("/api/host/laundry-invitations", async (req, res) => {
  const supabase = getSupabaseService();
  const { data: profile } = await supabase.from("profiles").select("email").eq("id", req.userId!).maybeSingle();
  const email = String((profile as { email?: string | null } | null)?.email ?? "");
  const { data, error } = await supabase
    .from("laundry_host_invitations")
    .select("*, laundry_connection_contracts(*)")
    .or(`host_id.eq.${req.userId!},invited_email.eq.${email}`)
    .order("created_at", { ascending: false });
  if (error) throw new HttpError(400, error.message);
  res.json(data ?? []);
});

laundryConnectionRouter.get("/api/host/laundry-invitations/:invitationId", async (req, res) => {
  const supabase = getSupabaseService();
  const invitation = await requireHostInvitation(supabase, req.params.invitationId, req.userId!);
  const { data, error } = await supabase
    .from("laundry_host_invitations")
    .select("*, laundry_host_invitation_apartments(*), laundry_connection_contracts(*)")
    .eq("id", invitation.id)
    .maybeSingle();
  if (error) throw new HttpError(400, error.message);
  res.json(data);
});

laundryConnectionRouter.post("/api/host/laundry-invitations/:invitationId/accept", async (req, res) => {
  const supabase = getSupabaseService();
  const invitation = await requireHostInvitation(supabase, req.params.invitationId, req.userId!);
  const now = new Date().toISOString();
  const { error } = await supabase
    .from("laundry_host_invitations")
    .update({ status: "active", accepted_at: now, host_id: req.userId!, updated_at: now })
    .eq("id", invitation.id);
  if (error) throw new HttpError(400, error.message);
  await upsertHostLaundryConnection(supabase, req.userId!, invitation.laundry_id, null, null);
  res.json({ success: true });
});

laundryConnectionRouter.post("/api/host/laundry-invitations/:invitationId/reject", async (req, res) => {
  const supabase = getSupabaseService();
  const invitation = await requireHostInvitation(supabase, req.params.invitationId, req.userId!);
  const now = new Date().toISOString();
  const { error } = await supabase
    .from("laundry_host_invitations")
    .update({ status: "rejected", rejected_at: now, updated_at: now })
    .eq("id", invitation.id);
  if (error) throw new HttpError(400, error.message);
  res.json({ success: true });
});

laundryConnectionRouter.get("/api/invite/laundry/:token", async (req, res) => {
  const supabase = getSupabaseService();
  const { data, error } = await supabase
    .from("laundry_host_invitations")
    .select("*, laundry_host_invitation_apartments(*), laundry_connection_contracts(*)")
    .eq("invitation_token", req.params.token)
    .maybeSingle();
  if (error) throw new HttpError(400, error.message);
  if (!data) throw new HttpError(404, "Invitation not found");
  res.json(data);
});

laundryConnectionRouter.get("/api/admin/laundry-connection-requests", async (req, res) => {
  const user = await requireUser(req);
  if (!user || !(await requireSuperAdmin({ id: user.id, email: user.email }))) throw new HttpError(403, "Forbidden");
  const supabase = getSupabaseService();
  const { data, error } = await supabase
    .from("laundry_connection_requests")
    .select("*")
    .order("created_at", { ascending: false });
  if (error) throw new HttpError(400, error.message);
  res.json(data ?? []);
});

laundryConnectionRouter.post("/api/admin/laundry-connection-requests/:requestId/assign-laundry", async (req, res) => {
  const user = await requireUser(req);
  if (!user || !(await requireSuperAdmin({ id: user.id, email: user.email }))) throw new HttpError(403, "Forbidden");
  const body = z.object({ laundry_id: z.string().uuid() }).safeParse(req.body);
  if (!body.success) throw new HttpError(400, "Invalid body", body.error.flatten());
  const supabase = getSupabaseService();
  const { data, error } = await supabase
    .from("laundry_connection_requests")
    .update({ assigned_laundry_id: body.data.laundry_id, status: "sent_to_laundry" })
    .eq("id", req.params.requestId)
    .select("*")
    .maybeSingle();
  if (error) throw new HttpError(400, error.message);
  res.json(data);
});

async function findCompatibleLaundry(city: string, requestedServiceIds: string[]) {
  const supabase = getSupabaseService();
  const { data: laundries } = await supabase
    .from("laundries")
    .select("id,company_name,city,is_active,priority")
    .eq("is_active", true)
    .ilike("city", city || "%");
  const candidates = laundries ?? [];
  if (!candidates.length) return null;

  const candidateIds = candidates.map((laundry: any) => laundry.id).filter(Boolean);
  const { data: services } = await supabase
    .from("services")
    .select("id,laundry_id,is_active")
    .in("laundry_id", candidateIds)
    .in("id", requestedServiceIds)
    .eq("is_active", true);
  const activeLaundryIds = new Set((services ?? []).map((service: any) => service.laundry_id));
  return candidates
    .filter((laundry: any) => activeLaundryIds.has(laundry.id))
    .sort((a: any, b: any) => Number(b.priority ?? 0) - Number(a.priority ?? 0))[0] ?? null;
}

async function requireOwnedLaundryId(req: Request) {
  const supabase = getSupabaseService();
  const { data, error } = await supabase
    .from("laundries")
    .select("id")
    .eq("owner_id", req.userId!)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new HttpError(400, error.message);
  if (!data?.id) throw new HttpError(403, "Laundry not found");
  return String(data.id);
}

async function requireLaundryRequest(supabase: ReturnType<typeof getSupabaseService>, requestId: string, laundryId: string) {
  const { data, error } = await supabase
    .from("laundry_connection_requests")
    .select("*")
    .eq("id", requestId)
    .eq("assigned_laundry_id", laundryId)
    .maybeSingle();
  if (error) throw new HttpError(400, error.message);
  if (!data?.id) throw new HttpError(404, "Request not found");
  return data as any;
}

async function updateLaundryRequestStatus(req: Request, res: Response, status: (typeof requestStatusValues)[number], patch: Record<string, unknown>) {
  const laundryId = await requireOwnedLaundryId(req);
  const supabase = getSupabaseService();
  await requireLaundryRequest(supabase, req.params.requestId, laundryId);
  const { data, error } = await supabase
    .from("laundry_connection_requests")
    .update({ status, ...patch, updated_at: new Date().toISOString() })
    .eq("id", req.params.requestId)
    .eq("assigned_laundry_id", laundryId)
    .select("*")
    .maybeSingle();
  if (error) throw new HttpError(400, error.message);
  res.json(data);
}

async function activateRequestConnection(supabase: ReturnType<typeof getSupabaseService>, requestId: string, contractId: string) {
  const { data: request, error } = await supabase
    .from("laundry_connection_requests")
    .select("*")
    .eq("id", requestId)
    .maybeSingle();
  if (error || !request) throw new HttpError(400, error?.message ?? "Request not found");
  await supabase.from("laundry_connection_requests").update({ status: "active" }).eq("id", requestId);
  await upsertHostLaundryConnection(supabase, request.host_id, request.assigned_laundry_id, requestId, contractId);
}

async function upsertHostLaundryConnection(
  supabase: ReturnType<typeof getSupabaseService>,
  hostId: string,
  laundryId: string,
  requestId: string | null,
  contractId: string | null
) {
  await supabase.from("host_laundry_connections").upsert({
    host_id: hostId,
    laundry_id: laundryId,
    request_id: requestId,
    contract_id: contractId,
    status: "active",
    activated_at: new Date().toISOString(),
  });
  await supabase.from("laundry_host_links").upsert({
    host_id: hostId,
    laundry_id: laundryId,
    status: "active",
    is_primary: true,
  });
}

async function requireHostInvitation(supabase: ReturnType<typeof getSupabaseService>, invitationId: string, userId: string) {
  const { data: profile } = await supabase.from("profiles").select("email").eq("id", userId).maybeSingle();
  const email = String((profile as { email?: string | null } | null)?.email ?? "");
  const { data, error } = await supabase
    .from("laundry_host_invitations")
    .select("*")
    .eq("id", invitationId)
    .or(`host_id.eq.${userId},invited_email.eq.${email}`)
    .maybeSingle();
  if (error) throw new HttpError(400, error.message);
  if (!data?.id) throw new HttpError(404, "Invitation not found");
  return data as any;
}

void contractStatusValues;
void invitationStatusValues;
