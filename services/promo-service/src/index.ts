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
      CREATE TABLE IF NOT EXISTS promo_codes (
        id SERIAL PRIMARY KEY,
        event_id INTEGER NOT NULL,
        code TEXT NOT NULL,
        discount_percent INTEGER NOT NULL,
        max_uses INTEGER,
        uses INTEGER NOT NULL DEFAULT 0,
        UNIQUE (event_id, code)
      )
    `)
  );
}

app.get("/health", (_req, res) => res.json({ status: "ok" }));

app.post("/events/:eventId/promo-codes", requireAuth, async (req: AuthedRequest, res) => {
  const { code, discount_percent, max_uses } = req.body ?? {};
  if (!code || !discount_percent) return res.status(400).json({ error: "code and discount_percent required" });
  const { rows } = await pool.query(
    `INSERT INTO promo_codes (event_id, code, discount_percent, max_uses) VALUES ($1,$2,$3,$4) RETURNING *`,
    [req.params.eventId, code.toUpperCase(), discount_percent, max_uses ?? null]
  );
  res.status(201).json(rows[0]);
});

// Called synchronously by order-service to validate + consume a code at checkout time.
app.post("/promo-codes/:code/redeem", async (req, res) => {
  const { event_id } = req.body ?? {};
  const { rows } = await pool.query(
    `UPDATE promo_codes
     SET uses = uses + 1
     WHERE code = $1 AND event_id = $2 AND (max_uses IS NULL OR uses < max_uses)
     RETURNING *`,
    [req.params.code.toUpperCase(), event_id]
  );
  if (!rows[0]) return res.status(404).json({ error: "invalid or exhausted promo code" });
  res.json(rows[0]);
});

const PORT = process.env.PORT || 4007;
init().then(() => {
  app.listen(PORT, () => console.log(`promo-service listening on ${PORT}`));
});
