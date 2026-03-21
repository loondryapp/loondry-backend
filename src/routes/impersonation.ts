import { Router } from "express";
import { z } from "zod";

import { HttpError } from "../lib/http.js";
import { requireSuperAdmin, requireUser } from "../lib/auth.js";
import { getSupabaseService } from "../lib/supabase.js";

export const impersonationRouter = Router();

impersonationRouter.get("/api/impersonation/demo-user", async (req, res) => {
  try {
    const user = await requireUser(req);
    if (!user) return res.status(401).json({ error: "Unauthorized" });

    const query = z
      .object({
        role: z.enum(["host", "laundry", "cleaner"]),
      })
      .safeParse(req.query);
    if (!query.success) return res.status(400).json({ error: "Invalid query", details: query.error.flatten() });

    const isSuperAdmin = await requireSuperAdmin({ id: user.id, email: user.email });
    if (!isSuperAdmin) return res.status(403).json({ error: "Forbidden" });

    const supabase = getSupabaseService();
    const role = query.data.role;

    let result = await supabase
      .from("profiles")
      .select("id, role, email, onboarding_completed, onboarding_step, environment")
      .eq("role", role)
      .eq("environment", "demo")
      .limit(1)
      .maybeSingle();

    if (result.error && String(result.error.message || "").includes("environment")) {
      result = await supabase
        .from("profiles")
        .select("id, role, email, onboarding_completed, onboarding_step")
        .eq("role", role)
        .limit(1)
        .maybeSingle();
    }

    if (result.error) return res.status(400).json({ error: result.error.message });
    if (!result.data) return res.status(404).json({ error: "Demo user not found" });

    return res.json(result.data);
  } catch (err) {
    console.error("/api/impersonation/demo-user failed", err);
    return res.status(500).json({ error: "Impersonation failed" });
  }
});
