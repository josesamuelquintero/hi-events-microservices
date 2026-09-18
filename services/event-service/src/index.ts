import express from "express";
import cors from "cors";
import { pool, withRetry } from "./db";
import { requireAuth, AuthedRequest } from "./auth";

const app = express();
app.use(cors());
app.use(express.json());

async function init() {
  await withRetry(() =>
    pool.query(`
      CREATE TABLE IF NOT EXISTS events (
        id SERIAL PRIMARY KEY,
        organizer_id INTEGER NOT NULL,
        title TEXT NOT NULL,
        description TEXT,
        location TEXT,
        start_date TIMESTAMPTZ NOT NULL,
        end_date TIMESTAMPTZ,
        status TEXT NOT NULL DEFAULT 'draft',
        created_at TIMESTAMPTZ DEFAULT now()
      )
    `)
  );
}

app.get("/health", (_req, res) => res.json({ status: "ok" }));

app.post("/events", requireAuth, async (req: AuthedRequest, res) => {
  const { title, description, location, start_date, end_date } = req.body ?? {};
  if (!title || !start_date) return res.status(400).json({ error: "title and start_date required" });
  const { rows } = await pool.query(
    `INSERT INTO events (organizer_id, title, description, location, start_date, end_date, status)
     VALUES ($1,$2,$3,$4,$5,$6,'live') RETURNING *`,
    [req.user!.id, title, description ?? null, location ?? null, start_date, end_date ?? null]
  );
  res.status(201).json(rows[0]);
});

app.get("/events", async (req, res) => {
  const { rows } = await pool.query("SELECT * FROM events ORDER BY start_date");
  res.json(rows);
});

app.get("/events/:id", async (req, res) => {
  const { rows } = await pool.query("SELECT * FROM events WHERE id = $1", [req.params.id]);
  if (!rows[0]) return res.status(404).json({ error: "not found" });
  res.json(rows[0]);
});

app.patch("/events/:id", requireAuth, async (req: AuthedRequest, res) => {
  const { rows: existing } = await pool.query("SELECT * FROM events WHERE id = $1", [req.params.id]);
  if (!existing[0]) return res.status(404).json({ error: "not found" });
  if (existing[0].organizer_id !== req.user!.id) return res.status(403).json({ error: "forbidden" });

  const fields = ["title", "description", "location", "start_date", "end_date", "status"];
  const updates = fields.filter((f) => req.body?.[f] !== undefined);
  if (updates.length === 0) return res.json(existing[0]);

  const setClause = updates.map((f, i) => `${f} = $${i + 1}`).join(", ");
  const values = updates.map((f) => req.body[f]);
  const { rows } = await pool.query(
    `UPDATE events SET ${setClause} WHERE id = $${updates.length + 1} RETURNING *`,
    [...values, req.params.id]
  );
  res.json(rows[0]);
});

const PORT = process.env.PORT || 4002;
init().then(() => {
  app.listen(PORT, () => console.log(`event-service listening on ${PORT}`));
});
