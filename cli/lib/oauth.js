"use strict";
/*
 * The installer's ONE sign-in: OAuth 2.1 authorization code + PKCE (S256), discovered from the
 * connector's own protected-resource metadata and registered by DCR — the same lane every MCP
 * client uses at /mcp. The access token it yields is spent once, on POST /cli/key, and never
 * stored: what the machine keeps is the named reach key.
 *
 * WHERE THE BROWSER COMES BACK. To Unl's hosted handoff at <api>/cli/callback,
 * which this CLI polls with its state, so the consent screen names Unl's address and a CLI that has
 * stopped leaves the person on an Unl "that sign-in expired" page, never on "127.0.0.1 refused to
 * connect". Against an older server with no handoff it falls back to a loopback listener (RFC 8252).
 */
const crypto = require("crypto");
const fs = require("fs");
const http = require("http");
const os = require("os");
const { spawn } = require("child_process");

const SCOPE = "openid profile email";
const SIGN_IN_TIMEOUT_MS = 10 * 60 * 1000;
const POLL_MS = 1000;
const STILL_WAITING_MS = 60 * 1000;
// What the consent screen shows. Clerk reads these from the registration.
const CLIENT = { client_name: "Unl for your terminal", logo_uri: "https://unlimitless.ai/icon.png", client_uri: "https://unlimitless.ai" };

const b64url = (buf) => buf.toString("base64url");

async function getJson(url, init) {
  const res = await fetch(url, init);
  const text = await res.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {}
  if (!res.ok) {
    const why = body && (body.error_description || body.message || body.error);
    const e = new Error(`${init && init.method ? init.method : "GET"} ${new URL(url).host}${new URL(url).pathname} answered HTTP ${res.status}${why ? `: ${why}` : ""}`);
    e.status = res.status;
    throw e;
  }
  return body;
}

async function discover(apiBase) {
  const prm = await getJson(`${apiBase}/.well-known/oauth-protected-resource/mcp`);
  const issuer = (prm.authorization_servers || [])[0];
  if (!issuer) throw new Error("Unl did not name a sign-in server");
  const meta = await getJson(`${issuer.replace(/\/+$/, "")}/.well-known/oauth-authorization-server`);
  return { resource: prm.resource, meta };
}

/**
 * How this machine opens a web address, or null where none can. Pure.
 *
 *   Windows  rundll32 url.dll,FileProtocolHandler: no cmd.exe in between, so the & in a sign-in
 *            address is not read as "and then run", which cut `cmd /c start` off at the first &.
 *   WSL      the same rundll32, through WSL's interop: the browser a WSL user has is Windows's.
 *   Linux    xdg-open, but only with a display: over SSH or on a bare console it would start a text
 *            browser inside this terminal, so there the address is printed instead.
 */
function browserCommand(url, { platform = process.platform, env = process.env, release = os.release(), exists = fs.existsSync } = {}) {
  if (platform === "darwin") return { cmd: "open", args: [url] };
  if (platform === "win32") return { cmd: "rundll32", args: ["url.dll,FileProtocolHandler", url] };
  if (platform === "linux" && (/microsoft/i.test(release) || env.WSL_DISTRO_NAME)) {
    const abs = "/mnt/c/Windows/System32/rundll32.exe";
    return { cmd: exists(abs) ? abs : "rundll32.exe", args: ["url.dll,FileProtocolHandler", url] };
  }
  if (!env.DISPLAY && !env.WAYLAND_DISPLAY) return null;
  return { cmd: "xdg-open", args: [url] };
}

/** Open the address; false when this machine has no way to, so the caller says to open it by hand. */
function openBrowser(url) {
  const how = browserCommand(url);
  if (!how) return false;
  try {
    const p = spawn(how.cmd, how.args, { stdio: "ignore", detached: true });
    p.on("error", () => {});
    p.unref();
  } catch {}
  return true;
}

/**
 * ★ A SEAT NEVER STARTS A LIVE SIGN-IN. Opening a browser from an agent's
 * shell lands on the person's own browser, signed in as them, with a consent screen they did not
 * ask for. Pure: returns the reason to refuse, or null. UNL_NO_BROWSER stays allowed, because it
 * only prints the address (SSH, and the end-to-end proofs that drive their own isolated browser).
 */
function seatRefusal({ env = process.env, interactive = !!(process.stdin && process.stdin.isTTY) } = {}) {
  if (env.UNL_NO_BROWSER) return null;
  const who = env.CLAUDECODE === "1" ? "an AI agent's shell" : env.CI ? "a CI job" : !interactive ? "a non-interactive shell" : null;
  if (!who) return null;
  return `Signing in opens your browser, so it only starts from your own terminal, and this is ${who}. Run \`unl\` in a terminal of your own to sign in.`;
}

// The page the CLI's own loopback listener shows. Used only against an Unl server that predates the
// hosted handoff at /cli/callback; a current server answers every ending itself.
const DONE_PAGE = (ok, msg) => `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Unl</title>
<body style="margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#1A1B26;color:#E8EAED;font-family:ui-sans-serif,system-ui,sans-serif;padding:24px 16px">
<main style="max-width:440px;line-height:1.6"><h1 style="font-size:1.3rem;color:#f4f5f7">${ok ? "You're signed in" : "Sign-in did not finish"}</h1>
<p style="color:#bcc1c8">${msg}</p></main></body>`;

function listen() {
  return new Promise((resolve, reject) => {
    const server = http.createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

const minutesLeft = (ms) => Math.max(1, Math.ceil(ms / 60000));
const expired = () => new Error("The sign-in expired after 10 minutes without an approval. Run `npx unlimitless login` again to start a fresh one.");

/** The hosted handoff: poll Unl with our state until the browser has come back through it. */
function waitViaUnl({ apiBase, state, say, timeoutMs, pollMs, firstPoll }) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    let lastNote = started;
    let busy = false;
    const handle = (out) => {
      if (out.status === "ready") return finish(null, out.code);
      if (out.status === "declined") return finish(new Error(`The sign-in was cancelled in the browser (${out.error}). Run \`unl\` again whenever you are ready.`));
    };
    const tick = async () => {
      if (busy) return;
      busy = true;
      try {
        const now = Date.now();
        if (now - started >= timeoutMs) return finish(expired());
        if (now - lastNote >= STILL_WAITING_MS) {
          lastNote = now;
          say(`Still waiting for you to approve in the browser (${minutesLeft(timeoutMs - (now - started))} min left).`);
        }
        handle(await getJson(`${apiBase}/cli/signin/poll`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ state }) }));
      } catch {
        // A blip in the network or a connector restart: keep polling until the deadline.
      } finally {
        busy = false;
      }
    };
    const timer = setInterval(tick, pollMs);
    let done = false;
    function finish(err, code) {
      if (done) return;
      done = true;
      clearInterval(timer);
      err ? reject(err) : resolve(code);
    }
    handle(firstPoll);
  });
}

/** The fallback for an older Unl server: the browser returns to a listener on this machine. */
function waitViaLoopback({ server, redirectUri, state, say, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const note = setInterval(() => say(`Still waiting for you to approve in the browser (${minutesLeft(timeoutMs - (Date.now() - started))} min left).`), STILL_WAITING_MS);
    const timer = setTimeout(() => { clearInterval(note); reject(expired()); }, timeoutMs);
    server.on("request", (req, res) => {
      const u = new URL(req.url, redirectUri);
      if (u.pathname !== "/callback") {
        res.writeHead(404).end();
        return;
      }
      const err = u.searchParams.get("error");
      const code = u.searchParams.get("code");
      const ok = !err && code && u.searchParams.get("state") === state;
      res.writeHead(ok ? 200 : 400, { "content-type": "text/html; charset=utf-8" });
      res.end(DONE_PAGE(ok, ok ? "Return to your terminal. You can close this tab." : "Return to your terminal and run npx unlimitless login again."));
      clearTimeout(timer);
      clearInterval(note);
      if (ok) resolve(code);
      else reject(new Error(err ? `The sign-in was cancelled in the browser (${err}).` : "The sign-in reply did not match this request."));
    });
  });
}

async function signIn({ apiBase, say, env = process.env, interactive, timeoutMs = SIGN_IN_TIMEOUT_MS, pollMs = POLL_MS, open = openBrowser }) {
  const refusal = seatRefusal({ env, ...(interactive === undefined ? {} : { interactive }) });
  if (refusal) throw new Error(refusal);
  const { resource, meta } = await discover(apiBase);
  const state = b64url(crypto.randomBytes(24));

  // The hosted handoff when this Unl has it (every current server), else the loopback listener.
  let firstPoll = null;
  try {
    firstPoll = await getJson(`${apiBase}/cli/signin/poll`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ state }) });
  } catch (e) {
    if (e.status !== 404) throw e;
  }
  const server = firstPoll ? null : await listen();
  const redirectUri = firstPoll ? `${apiBase}/cli/callback` : `http://127.0.0.1:${server.address().port}/callback`;
  try {
    const reg = await getJson(meta.registration_endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ...CLIENT,
        redirect_uris: [redirectUri],
        grant_types: ["authorization_code"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
        scope: SCOPE,
      }),
    });
    const verifier = b64url(crypto.randomBytes(32));
    const challenge = b64url(crypto.createHash("sha256").update(verifier).digest());
    const auth = new URL(meta.authorization_endpoint);
    auth.search = new URLSearchParams({
      response_type: "code",
      client_id: reg.client_id,
      redirect_uri: redirectUri,
      scope: SCOPE,
      state,
      code_challenge: challenge,
      code_challenge_method: "S256",
      ...(resource ? { resource } : {}),
    }).toString();

    const codeP = firstPoll
      ? waitViaUnl({ apiBase, state, say, timeoutMs, pollMs, firstPoll })
      : waitViaLoopback({ server, redirectUri, state, say, timeoutMs });

    // SAY IT FIRST (part 2): what happens next, before anything opens. UNL_NO_BROWSER prints the
    // address and opens nothing: a machine with no browser (SSH) and the end-to-end proofs.
    if (env.UNL_NO_BROWSER || !browserCommand(auth.toString(), { env })) {
      say(`To sign in to Unl, open this address in a browser, approve it there, then come back here:\n  ${auth.toString()}`);
    } else {
      say(`Opening your browser to sign in to Unl. Approve it there, then come back here.\nIf it does not open, visit:\n  ${auth.toString()}`);
      open(auth.toString());
    }
    const code = await codeP;

    const tok = await getJson(meta.token_endpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: redirectUri,
        client_id: reg.client_id,
        code_verifier: verifier,
        ...(resource ? { resource } : {}),
      }).toString(),
    });
    if (!tok || !tok.access_token) throw new Error("the sign-in server returned no access token");
    return tok.access_token;
  } finally {
    if (server) server.close();
  }
}

/** Trade the one-time access token for this machine's named reach key. */
async function mintKey({ apiBase, accessToken, surface, from }) {
  const out = await getJson(`${apiBase}/cli/key`, {
    method: "POST",
    headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json" },
    // `from`: where the person came from, when the page that gave them this command knew (e.g. chatgpt).
    // The server keeps only a tag from its own closed list, once, on the account.
    body: JSON.stringify({ label: os.hostname().replace(/\.local$/, ""), surface, ...(from ? { from } : {}) }),
  });
  if (!out || typeof out.key !== "string" || !out.key.startsWith("unl_rk_")) throw new Error("Unl did not return a key");
  return out;
}

module.exports = { signIn, mintKey, discover, browserCommand, seatRefusal };
