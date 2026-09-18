import express from "express";
import cors from "cors";
import crypto from "crypto";
import { pool, withRetry } from "./db";
import { subscribe, publish } from "./mq";

const app = express();
app.use(cors());
app.use(express.json());

async function init() {
  await withRetry(() =>
    pool.query(`
      CREATE TABLE IF NOT EXISTS attendees (
        id SERIAL PRIMARY KEY,
        order_id INTEGER NOT NULL,
        event_id INTEGER NOT NULL,
        product_id INTEGER NOT NULL,
        email TEXT NOT NULL,
        ticket_code TEXT UNIQUE NOT NULL,
        checked_in BOOLEAN NOT NULL DEFAULT false,
        created_at TIMESTAMPTZ DEFAULT now()
      )
    `)
  );
}

app.get("/health", (_req, res) => res.json({ status: "ok" }));

app.get("/attendees", async (req, res) => {
  const { event_id } = req.query;
  const { rows } = event_id
    ? await pool.query("SELECT * FROM attendees WHERE event_id = $1", [event_id])
    : await pool.query("SELECT * FROM attendees");
  res.json(rows);
});

app.post("/attendees/:id/check-in", async (req, res) => {
  const { rows } = await pool.query(
    "UPDATE attendees SET checked_in = true WHERE id = $1 RETURNING *",
    [req.params.id]
  );
  if (!rows[0]) return res.status(404).json({ error: "not found" });
  res.json(rows[0]);
});

app.get("/attendees/ticket/:code", async (req, res) => {
  const { rows } = await pool.query("SELECT * FROM attendees WHERE ticket_code = $1", [req.params.code]);
  if (!rows[0]) return res.status(404).json({ error: "not found" });
  res.json(rows[0]);
});

// One attendee row (= one ticket) per unit purchased, driven asynchronously by the
// order.paid event published from order-service — this is the async side of the saga.
async function handleOrderPaid(payload: any) {
  for (const item of payload.items) {
    for (let i = 0; i < item.quantity; i++) {
      const ticketCode = crypto.randomBytes(8).toString("hex");
      const { rows } = await pool.query(
        `INSERT INTO attendees (order_id, event_id, product_id, email, ticket_code) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
        [payload.order_id, payload.event_id, item.product_id, payload.customer_email, ticketCode]
      );
      await publish("attendee.created", rows[0]);
    }
  }
}

const PORT = process.env.PORT || 4006;
init().then(async () => {
  await subscribe("attendee-service.order-paid", ["order.paid"], async (_key, payload) => {
    await handleOrderPaid(payload);
  });
  app.listen(PORT, () => console.log(`attendee-service listening on ${PORT}`));
});
