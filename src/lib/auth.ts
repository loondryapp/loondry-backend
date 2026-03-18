import { Request } from "express";

import { getSupabaseAuthClient } from "./supabase.js";

export async function requireUser(req: Request) {
  const authHeader = req.headers.authorization;
  if (!authHeader) return null;
  const client = getSupabaseAuthClient(authHeader);
  const { data } = await client.auth.getUser();
  return data.user ?? null;
}
