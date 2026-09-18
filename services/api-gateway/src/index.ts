import express from "express";
import cors from "cors";
import { createProxyMiddleware } from "http-proxy-middleware";

const app = express();
app.use(cors());

const targets = {
  auth: process.env.AUTH_SERVICE_URL || "http://auth-service:4001",
  event: process.env.EVENT_SERVICE_URL || "http://event-service:4002",
  product: process.env.PRODUCT_SERVICE_URL || "http://product-service:4003",
  order: process.env.ORDER_SERVICE_URL || "http://order-service:4004",
  payment: process.env.PAYMENT_SERVICE_URL || "http://payment-service:4005",
  attendee: process.env.ATTENDEE_SERVICE_URL || "http://attendee-service:4006",
  promo: process.env.PROMO_SERVICE_URL || "http://promo-service:4007",
  notification: process.env.NOTIFICATION_SERVICE_URL || "http://notification-service:4008",
};

function proxy(target: string) {
  return createProxyMiddleware({
    target,
    changeOrigin: true,
    pathRewrite: (path) => path.replace(/^\/api/, ""),
  });
}

// Order matters: nested routes registered before their more generic parents,
// otherwise Express would hand /events/:id/products off to event-service.
app.use(/^\/api\/events\/[^/]+\/products/, proxy(targets.product));
app.use(/^\/api\/events\/[^/]+\/promo-codes/, proxy(targets.promo));

app.use("/api/auth", proxy(targets.auth));
app.use("/api/events", proxy(targets.event));
app.use("/api/products", proxy(targets.product));
app.use("/api/orders", proxy(targets.order));
app.use("/api/attendees", proxy(targets.attendee));
app.use("/api/promo-codes", proxy(targets.promo));
app.use("/api/notifications", proxy(targets.notification));

app.get("/health", (_req, res) => res.json({ status: "ok" }));

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`api-gateway listening on ${PORT}`));
