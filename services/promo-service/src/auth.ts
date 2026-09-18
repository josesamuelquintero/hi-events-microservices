import { Request, Response, NextFunction } from "express";
import { createRemoteJWKSet, jwtVerify } from "jose";

// Verifies the JWT Supabase Auth issued (Google sign-in or any other provider it
// handles) against Supabase's own public signing keys — no shared secret to manage
// on our side. jose caches the JWKS fetch internally, so this isn't a request-per-call.
const SUPABASE_URL = process.env.SUPABASE_URL || "";
const JWKS = createRemoteJWKSet(new URL(`${SUPABASE_URL}/auth/v1/.well-known/jwks.json`));

export interface AuthedRequest extends Request {
  user?: { id: string; email: string };
}

export async function requireAuth(req: AuthedRequest, res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) {
    return res.status(401).json({ error: "missing bearer token" });
  }
  try {
    const token = header.slice("Bearer ".length);
    const { payload } = await jwtVerify(token, JWKS);
    req.user = { id: payload.sub as string, email: (payload as any).email ?? "" };
    next();
  } catch {
    res.status(401).json({ error: "invalid token" });
  }
}
