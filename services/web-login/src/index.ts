import express from "express";
import fs from "fs";
import path from "path";

const app = express();
const SUPABASE_URL = process.env.SUPABASE_URL || "";
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || "";

// ponytail: static HTML file (not a template literal in this file) so the client-side
// JS can use its own backticks/quotes freely. Two placeholders get swapped for the
// real Supabase project values once at boot — nothing sensitive, both are meant to be
// public/client-side (anon/publishable key).
const html = fs
  .readFileSync(path.join(__dirname, "..", "public", "index.html"), "utf8")
  .replace("__SUPABASE_URL__", SUPABASE_URL)
  .replace("__SUPABASE_ANON_KEY__", SUPABASE_ANON_KEY);

app.get("/health", (_req, res) => res.json({ status: "ok" }));
app.get("/", (_req, res) => res.type("html").send(html));

const PORT = process.env.PORT || 8081;
app.listen(PORT, () => console.log(`web-login listening on ${PORT}`));
