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
