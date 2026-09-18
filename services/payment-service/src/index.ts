import express from "express";
import cors from "cors";
import { pool, withRetry } from "./db";

const app = express();
app.use(cors());
app.use(express.json());

async function init() {
  await withRetry(() =>
    pool.query(`
      CREATE TABLE IF NOT EXISTS payments (
        id SERIAL PRIMARY KEY,
        order_id INTEGER NOT NULL,
        amount_cents INTEGER NOT NULL,
        status TEXT NOT NULL,
        card_token TEXT,
        created_at TIMESTAMPTZ DEFAULT now()
      )
    `)
  );
}

app.get("/health", (_req, res) => res.json({ status: "ok" }));

// ponytail: mock gateway, no real card processing. card_token "fail" simulates
// a decline so order-service's saga rollback path is exercisable in the demo.
// Swap for Stripe/real PSP before this touches real money.
app.post("/charge", async (req, res) => {
  const { order_id, amount_cents, card_token } = req.body ?? {};
  if (!order_id || !amount_cents) return res.status(400).json({ error: "order_id and amount_cents required" });

  const declined = card_token === "fail";
  const { rows } = await pool.query(
    `INSERT INTO payments (order_id, amount_cents, status, card_token) VALUES ($1,$2,$3,$4) RETURNING *`,
    [order_id, amount_cents, declined ? "declined" : "captured", card_token ?? null]
  );

  if (declined) return res.status(402).json({ error: "card declined", payment: rows[0] });
  res.status(201).json(rows[0]);
});

app.get("/payments/order/:orderId", async (req, res) => {
  const { rows } = await pool.query("SELECT * FROM payments WHERE order_id = $1", [req.params.orderId]);
  res.json(rows);
});

const PORT = process.env.PORT || 4005;
init().then(() => {
  app.listen(PORT, () => console.log(`payment-service listening on ${PORT}`));
});
