#!/usr/bin/env bash
# ponytail: generates the identical boilerplate (package.json/tsconfig/Dockerfile/db.ts/mq.ts)
# for every service instead of hand-copying it 9 times. Business logic (src/index.ts) is
# written separately per service since that's the only part that actually differs.
set -euo pipefail
cd "$(dirname "$0")/.."

SERVICES=(
  "auth-service:4001:authdb:yes"
  "event-service:4002:eventdb:yes"
  "product-service:4003:productdb:yes"
  "order-service:4004:orderdb:yes"
  "payment-service:4005:paymentdb:yes"
  "attendee-service:4006:attendeedb:yes"
  "promo-service:4007:promodb:yes"
  "notification-service:4008:notifdb:yes"
  "api-gateway:8080:none:no"
)

for entry in "${SERVICES[@]}"; do
  IFS=':' read -r NAME PORT DB NEEDS_DB <<< "$entry"
  DIR="services/$NAME"
  mkdir -p "$DIR/src"

  cat > "$DIR/package.json" <<JSON
{
  "name": "$NAME",
  "version": "1.0.0",
  "private": true,
  "type": "commonjs",
  "scripts": {
    "build": "tsc -p .",
    "start": "node dist/index.js",
    "dev": "ts-node-dev --respawn src/index.ts"
  },
  "dependencies": {
    "express": "^4.19.2",
    "cors": "^2.8.5",
    "dotenv": "^16.4.5",
    "jsonwebtoken": "^9.0.2",
    "pg": "^8.12.0",
    "amqplib": "^0.10.4",
    "http-proxy-middleware": "^3.0.3",
    "bcryptjs": "^2.4.3"
  },
  "devDependencies": {
    "typescript": "^5.5.4",
    "ts-node-dev": "^2.0.0",
    "@types/express": "^4.17.21",
    "@types/cors": "^2.8.17",
    "@types/node": "^20.14.9",
    "@types/pg": "^8.11.6",
    "@types/jsonwebtoken": "^9.0.6",
    "@types/bcryptjs": "^2.4.6",
    "@types/amqplib": "^0.10.5"
  }
}
JSON

  cat > "$DIR/tsconfig.json" <<'JSON'
{
  "compilerOptions": {
    "target": "ES2020",
    "module": "commonjs",
    "outDir": "dist",
    "rootDir": "src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "resolveJsonModule": true
  },
  "include": ["src"]
}
JSON

  cat > "$DIR/.dockerignore" <<'EOF'
node_modules
dist
EOF

  cat > "$DIR/Dockerfile" <<EOF
FROM node:20-alpine AS build
WORKDIR /app
COPY package.json ./
RUN npm install
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package.json ./
RUN npm install --omit=dev
COPY --from=build /app/dist ./dist
EXPOSE $PORT
CMD ["node", "dist/index.js"]
EOF

  if [ "$NEEDS_DB" = "yes" ]; then
    cat > "$DIR/src/db.ts" <<'TS'
import { Pool } from "pg";

export const pool = new Pool({
  host: process.env.PGHOST || "postgres",
  port: Number(process.env.PGPORT || 5432),
  user: process.env.PGUSER || "hievents",
  password: process.env.PGPASSWORD || "hievents",
  database: process.env.PGDATABASE,
});

export async function withRetry<T>(fn: () => Promise<T>, tries = 10): Promise<T> {
  // ponytail: crude connect-retry loop, k8s pods race postgres readiness on first boot.
  // upgrade to a readiness probe + init container if this ever gets flaky.
  for (let i = 1; i <= tries; i++) {
    try {
      return await fn();
    } catch (err) {
      if (i === tries) throw err;
      await new Promise((r) => setTimeout(r, 1000 * i));
    }
  }
  throw new Error("unreachable");
}
TS

    cat > "$DIR/src/mq.ts" <<'TS'
import amqplib, { Channel, ChannelModel, ConsumeMessage } from "amqplib";

const EXCHANGE = "hievents";
let channel: Channel | null = null;

export async function getChannel(): Promise<Channel> {
  if (channel) return channel;
  const url = process.env.RABBITMQ_URL || "amqp://guest:guest@rabbitmq:5672";
  let conn: ChannelModel | null = null;
  for (let i = 1; i <= 10; i++) {
    try {
      conn = await amqplib.connect(url);
      break;
    } catch (err) {
      if (i === 10) throw err;
      await new Promise((r) => setTimeout(r, 1000 * i));
    }
  }
  channel = await conn!.createChannel();
  await channel.assertExchange(EXCHANGE, "topic", { durable: true });
  return channel;
}

export async function publish(routingKey: string, payload: unknown) {
  const ch = await getChannel();
  ch.publish(EXCHANGE, routingKey, Buffer.from(JSON.stringify(payload)), {
    contentType: "application/json",
    persistent: true,
  });
}

export async function subscribe(
  queueName: string,
  routingKeys: string[],
  handler: (routingKey: string, payload: any) => Promise<void>
) {
  const ch = await getChannel();
  await ch.assertQueue(queueName, { durable: true });
  for (const key of routingKeys) {
    await ch.bindQueue(queueName, EXCHANGE, key);
  }
  ch.consume(queueName, async (msg: ConsumeMessage | null) => {
    if (!msg) return;
    try {
      const payload = JSON.parse(msg.content.toString());
      await handler(msg.fields.routingKey, payload);
      ch.ack(msg);
    } catch (err) {
      console.error(`[${queueName}] handler failed, requeueing`, err);
      ch.nack(msg, false, true);
    }
  });
}
TS

    cat > "$DIR/src/auth.ts" <<'TS'
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
TS
  fi

  echo "scaffolded $DIR"
done
