import express from "express";

const app = express();
const SUPABASE_URL = process.env.SUPABASE_URL || "";
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || "";

app.get("/health", (_req, res) => res.json({ status: "ok" }));

// ponytail: one static page, no bundler, no build step — supabase-js loaded straight
// from a CDN as an ESM module in the browser. Its only job is the OAuth handshake;
// it just displays the resulting JWT so you can paste it as a Bearer token when
// testing the other services with curl/Postman. Swap for a real SPA if this needs
// to become an actual product UI.
app.get("/", (_req, res) => {
  res.type("html").send(`<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<title>hi-events login</title>
<style>
  body { font-family: system-ui, sans-serif; max-width: 480px; margin: 4rem auto; padding: 0 1rem; }
  button { font-size: 1rem; padding: 0.6rem 1.2rem; cursor: pointer; }
  pre { white-space: pre-wrap; word-break: break-all; background: #f4f4f4; padding: 1rem; border-radius: 4px; }
</style>
</head>
<body>
  <h1>hi-events</h1>
  <button id="google-btn">Continuar con Google</button>
  <p id="status"></p>
  <pre id="token-box" style="display:none;"></pre>

  <script type="module">
    import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm";
    const supabase = createClient("${SUPABASE_URL}", "${SUPABASE_ANON_KEY}");

    document.getElementById("google-btn").onclick = async () => {
      await supabase.auth.signInWithOAuth({
        provider: "google",
        options: { redirectTo: window.location.origin + "/" },
      });
    };

    const { data: { session } } = await supabase.auth.getSession();
    if (session) {
      document.getElementById("status").textContent =
        "Sesión activa como " + session.user.email + ". Usa este token como Bearer:";
      const box = document.getElementById("token-box");
      box.style.display = "block";
      box.textContent = session.access_token;
    }
  </script>
</body>
</html>`);
});

const PORT = process.env.PORT || 8081;
app.listen(PORT, () => console.log(`web-login listening on ${PORT}`));
