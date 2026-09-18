import express from "express";
import cors from "cors";
import { pool, withRetry } from "./db";
import { publish } from "./mq";

const app = express();
app.use(cors());
app.use(express.json());

const PRODUCT_URL = process.env.PRODUCT_SERVICE_URL || "http://product-service:4003";
const PAYMENT_URL = process.env.PAYMENT_SERVICE_URL || "http://payment-service:4005";
const PROMO_URL = process.env.PROMO_SERVICE_URL || "http://promo-service:4007";

async function init() {
  await withRetry(() =>
    pool.query(`
      CREATE TABLE IF NOT EXISTS orders (
        id SERIAL PRIMARY KEY,
        event_id INTEGER NOT NULL,
        customer_email TEXT NOT NULL,
        total_cents INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        created_at TIMESTAMPTZ DEFAULT now()
      )
    `)
  );
  await withRetry(() =>
    pool.query(`
      CREATE TABLE IF NOT EXISTS order_items (
        id SERIAL PRIMARY KEY,
        order_id INTEGER NOT NULL REFERENCES orders(id),
        product_id INTEGER NOT NULL,
        quantity INTEGER NOT NULL,
        unit_price_cents INTEGER NOT NULL
      )
    `)
  );
}

app.get("/health", (_req, res) => res.json({ status: "ok" }));

// Orchestration saga: reserve stock -> charge payment -> publish order.paid (async
// fan-out to attendee-service + notification-service). Any sync step failing rolls
// back the reservations made so far, no distributed transaction / 2PC involved.
// ponytail: in-process saga orchestrator is enough for a course demo; swap for a
// durable workflow engine (Temporal/Step Functions) if steps ever need to survive
// an order-service crash mid-checkout.
app.post("/orders", async (req, res) => {
  const { event_id, customer_email, items, promo_code, card_token } = req.body ?? {};
  if (!event_id || !customer_email || !Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: "event_id, customer_email, items[] required" });
  }

  const reserved: { product_id: number; quantity: number }[] = [];
  let totalCents = 0;

  try {
    for (const item of items) {
      const productRes = await fetch(`${PRODUCT_URL}/products/${item.product_id}`);
      if (!productRes.ok) throw { status: 400, error: `unknown product ${item.product_id}` };
      const product = await productRes.json();

      const reserveRes = await fetch(`${PRODUCT_URL}/products/${item.product_id}/reserve`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ quantity: item.quantity }),
      });
      if (!reserveRes.ok) throw { status: 409, error: `insufficient stock for product ${item.product_id}` };
      reserved.push({ product_id: item.product_id, quantity: item.quantity });
      totalCents += product.price_cents * item.quantity;
    }

    if (promo_code) {
      const promoRes = await fetch(`${PROMO_URL}/promo-codes/${promo_code}/redeem`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ event_id }),
      });
      if (promoRes.ok) {
        const promo = await promoRes.json();
        totalCents = Math.round(totalCents * (1 - promo.discount_percent / 100));
      }
    }

    const { rows } = await pool.query(
      `INSERT INTO orders (event_id, customer_email, total_cents, status) VALUES ($1,$2,$3,'pending') RETURNING *`,
      [event_id, customer_email, totalCents]
    );
    const order = rows[0];
    for (const item of items) {
      await pool.query(
        `INSERT INTO order_items (order_id, product_id, quantity, unit_price_cents) VALUES ($1,$2,$3,$4)`,
        [order.id, item.product_id, item.quantity, 0]
      );
    }

    const chargeRes = await fetch(`${PAYMENT_URL}/charge`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ order_id: order.id, amount_cents: totalCents, card_token }),
    });

    if (!chargeRes.ok) {
      await pool.query(`UPDATE orders SET status = 'failed' WHERE id = $1`, [order.id]);
      await rollbackReservations(reserved);
      return res.status(402).json({ error: "payment declined", order_id: order.id });
    }

    const { rows: paidRows } = await pool.query(
      `UPDATE orders SET status = 'paid' WHERE id = $1 RETURNING *`,
      [order.id]
    );
    const paidOrder = paidRows[0];

    await publish("order.paid", {
      order_id: paidOrder.id,
      event_id,
      customer_email,
      items,
    });

    res.status(201).json(paidOrder);
  } catch (err: any) {
    await rollbackReservations(reserved);
    const status = err?.status ?? 500;
    res.status(status).json({ error: err?.error ?? "checkout failed" });
  }
});

async function rollbackReservations(reserved: { product_id: number; quantity: number }[]) {
  for (const r of reserved) {
    await fetch(`${PRODUCT_URL}/products/${r.product_id}/release`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ quantity: r.quantity }),
    }).catch((e) => console.error("rollback failed", e));
  }
}

app.get("/orders/:id", async (req, res) => {
  const { rows } = await pool.query("SELECT * FROM orders WHERE id = $1", [req.params.id]);
  if (!rows[0]) return res.status(404).json({ error: "not found" });
  const { rows: items } = await pool.query("SELECT * FROM order_items WHERE order_id = $1", [req.params.id]);
  res.json({ ...rows[0], items });
});

const PORT = process.env.PORT || 4004;
init().then(() => {
  app.listen(PORT, () => console.log(`order-service listening on ${PORT}`));
});
