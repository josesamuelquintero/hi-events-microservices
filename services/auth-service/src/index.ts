import express from "express";
import cors from "cors";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { pool, withRetry } from "./db";
import { requireAuth, AuthedRequest, SECRET } from "./auth";

const app = express();
app.use(cors());
app.use(express.json());

async function init() {
  await withRetry(() =>
    pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        email TEXT UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        created_at TIMESTAMPTZ DEFAULT now()
      )
    `)
  );
}

app.get("/health", (_req, res) => res.json({ status: "ok" }));

app.post("/auth/register", async (req, res) => {
  const { name, email, password } = req.body ?? {};
  if (!name || !email || !password) {
    return res.status(400).json({ error: "name, email, password required" });
  }
  const hash = await bcrypt.hash(password, 10);
  try {
    const { rows } = await pool.query(
      "INSERT INTO users (name, email, password_hash) VALUES ($1,$2,$3) RETURNING id, name, email",
      [name, email, hash]
    );
    const user = rows[0];
    const token = jwt.sign({ id: user.id, email: user.email }, SECRET, { expiresIn: "12h" });
    res.status(201).json({ user, token });
  } catch (err: any) {
    if (err.code === "23505") return res.status(409).json({ error: "email already registered" });
    console.error(err);
    res.status(500).json({ error: "internal error" });
  }
});

app.post("/auth/login", async (req, res) => {
  const { email, password } = req.body ?? {};
  const { rows } = await pool.query("SELECT * FROM users WHERE email = $1", [email]);
  const user = rows[0];
  if (!user || !(await bcrypt.compare(password ?? "", user.password_hash))) {
    return res.status(401).json({ error: "invalid credentials" });
  }
  const token = jwt.sign({ id: user.id, email: user.email }, SECRET, { expiresIn: "12h" });
  res.json({ user: { id: user.id, name: user.name, email: user.email }, token });
});

app.get("/auth/me", requireAuth, async (req: AuthedRequest, res) => {
  const { rows } = await pool.query("SELECT id, name, email FROM users WHERE id = $1", [req.user!.id]);
  res.json(rows[0] ?? null);
});

const PORT = process.env.PORT || 4001;
init().then(() => {
  app.listen(PORT, () => console.log(`auth-service listening on ${PORT}`));
});
