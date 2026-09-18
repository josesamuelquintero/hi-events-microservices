import express from "express";
import cors from "cors";
import { pool, withRetry } from "./db";
import { subscribe } from "./mq";

const app = express();
app.use(cors());
app.use(express.json());

async function init() {
  await withRetry(() =>
    pool.query(`
      CREATE TABLE IF NOT EXISTS notification_log (
        id SERIAL PRIMARY KEY,
        routing_key TEXT NOT NULL,
        payload JSONB NOT NULL,
        created_at TIMESTAMPTZ DEFAULT now()
      )
    `)
  );
}

app.get("/health", (_req, res) => res.json({ status: "ok" }));

// Demo introspection only — lets you see in Postman/curl what this consumer received,
// since there's no real email provider wired up.
app.get("/notifications/logs", async (_req, res) => {
  const { rows } = await pool.query("SELECT * FROM notification_log ORDER BY created_at DESC LIMIT 50");
  res.json(rows);
});

const PORT = process.env.PORT || 4008;
init().then(async () => {
  await subscribe(
    "notification-service.all-events",
    ["order.paid", "attendee.created"],
    async (routingKey, payload) => {
      console.log(`[notification-service] would send email for ${routingKey}`, payload);
      await pool.query(
        "INSERT INTO notification_log (routing_key, payload) VALUES ($1, $2)",
        [routingKey, JSON.stringify(payload)]
      );
    }
  );
  app.listen(PORT, () => console.log(`notification-service listening on ${PORT}`));
});
