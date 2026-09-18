import { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";

const SECRET = process.env.JWT_SECRET || "dev-secret-change-me";

export interface AuthedRequest extends Request {
  user?: { id: number; email: string };
}

export function requireAuth(req: AuthedRequest, res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) {
    return res.status(401).json({ error: "missing bearer token" });
  }
  try {
    const token = header.slice("Bearer ".length);
    req.user = jwt.verify(token, SECRET) as { id: number; email: string };
    next();
  } catch {
    res.status(401).json({ error: "invalid token" });
  }
}

export { SECRET };
