import { Request } from "express";

import { getSupabaseAuthClient, getSupabaseService } from "./supabase.js";

const IMPERSONATE_USER_HEADER = "x-impersonate-user";
const IMPERSONATE_ROLE_HEADER = "x-impersonate-role";

type MinimalUser = { id: string; email?: string | null };

async function isSuperAdmin(user: MinimalUser) {
  const supabase = getSupabaseService();
  const { data: profile, error } = await supabase
    .from("profiles")
    .select("id,is_super_admin,email")
    .eq("id", user.id)
    .maybeSingle();
  if (!error && profile?.is_super_admin) return true;
  const email = profile?.email ?? user.email ?? null;
  if (!email) return false;
  const { data: allow } = await supabase.from("super_admin_allowlist").select("email").eq("email", email).maybeSingle();
  return Boolean(allow?.email);
}

async function resolveImpersonation(user: MinimalUser, role: string, userId: string) {
  const supabase = getSupabaseService();
  const baseQuery = supabase.from("profiles").select("id,role,environment").eq("id", userId).eq("role", role).maybeSingle();
  let { data, error } = await baseQuery;
  if (error && String(error.message || "").includes("environment")) {
    const fallback = await supabase.from("profiles").select("id,role").eq("id", userId).eq("role", role).maybeSingle();
    data = fallback.data as any;
    error = fallback.error as any;
  }
  if (error || !data?.id) return null;
  if ("environment" in data && data.environment && data.environment !== "demo") return null;
  return data.id as string;
}

export async function requireUser(req: Request) {
  const authHeader = req.headers.authorization;
  if (!authHeader) return null;
  const client = getSupabaseAuthClient(authHeader);
  const { data } = await client.auth.getUser();
  const user = data.user ?? null;
  if (!user) return null;

  const impersonateUser = String(req.headers[IMPERSONATE_USER_HEADER] || "").trim();
  const impersonateRole = String(req.headers[IMPERSONATE_ROLE_HEADER] || "").trim();

  if (impersonateUser && impersonateRole && ["host", "laundry", "cleaner"].includes(impersonateRole)) {
    const isAdmin = await isSuperAdmin({ id: user.id, email: user.email });
    if (isAdmin) {
      const targetId = await resolveImpersonation({ id: user.id, email: user.email }, impersonateRole, impersonateUser);
      if (targetId) return { ...user, id: targetId };
    }
  }

  return user;
}

export async function requireSuperAdmin(user: MinimalUser) {
  return isSuperAdmin(user);
}
