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
      CREATE TABLE IF NOT EXISTS products (
        id SERIAL PRIMARY KEY,
        event_id INTEGER NOT NULL,
        title TEXT NOT NULL,
        price_cents INTEGER NOT NULL,
        quantity_available INTEGER NOT NULL,
        quantity_sold INTEGER NOT NULL DEFAULT 0,
        created_at TIMESTAMPTZ DEFAULT now()
      )
    `)
  );
}

app.get("/health", (_req, res) => res.json({ status: "ok" }));

app.post("/events/:eventId/products", requireAuth, async (req: AuthedRequest, res) => {
  const { title, price_cents, quantity_available } = req.body ?? {};
  if (!title || price_cents == null || quantity_available == null) {
    return res.status(400).json({ error: "title, price_cents, quantity_available required" });
  }
  const { rows } = await pool.query(
    `INSERT INTO products (event_id, title, price_cents, quantity_available) VALUES ($1,$2,$3,$4) RETURNING *`,
    [req.params.eventId, title, price_cents, quantity_available]
  );
  res.status(201).json(rows[0]);
});

app.get("/events/:eventId/products", async (req, res) => {
  const { rows } = await pool.query("SELECT * FROM products WHERE event_id = $1", [req.params.eventId]);
  res.json(rows);
});

app.get("/products/:id", async (req, res) => {
  const { rows } = await pool.query("SELECT * FROM products WHERE id = $1", [req.params.id]);
  if (!rows[0]) return res.status(404).json({ error: "not found" });
  res.json(rows[0]);
});

// Called synchronously by order-service during checkout. Atomic reservation:
// only succeeds if enough stock remains, avoiding overselling under concurrent orders.
app.post("/products/:id/reserve", async (req, res) => {
  const { quantity } = req.body ?? {};
  if (!quantity || quantity <= 0) return res.status(400).json({ error: "quantity required" });

  const { rows } = await pool.query(
    `UPDATE products
     SET quantity_sold = quantity_sold + $1
     WHERE id = $2 AND quantity_available - quantity_sold >= $1
     RETURNING *`,
    [quantity, req.params.id]
  );
  if (!rows[0]) return res.status(409).json({ error: "insufficient stock" });
  res.json(rows[0]);
});

app.post("/products/:id/release", async (req, res) => {
  const { quantity } = req.body ?? {};
  const { rows } = await pool.query(
    `UPDATE products SET quantity_sold = quantity_sold - $1 WHERE id = $2 RETURNING *`,
    [quantity, req.params.id]
  );
  res.json(rows[0]);
});

const PORT = process.env.PORT || 4003;
init().then(() => {
  app.listen(PORT, () => console.log(`product-service listening on ${PORT}`));
});
