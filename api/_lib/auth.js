// Passwordless (magic link) auth: sessions live in Redis, the browser holds an opaque HttpOnly cookie.
import { redis } from "./redis.js";
import { SITE } from "./rules.js";

export const COOKIE = "tmt_session";
export const SESSION_TTL = 60 * 60 * 24 * 30; // 30 days
export const LOGIN_TTL = 60 * 15;              // magic links last 15 minutes

const EMAIL_RE = /^[^\s@"<>()[\],;:\\]+@[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}$/i;

export function normalizeEmail(raw) {
  const e = String(raw || "").trim().toLowerCase();
  if (e.length > 254 || !EMAIL_RE.test(e)) return null;
  return e;
}

export function randomToken(bytes = 32) {
  const b = crypto.getRandomValues(new Uint8Array(bytes));
  return btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export async function sha256(s) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return Array.from(new Uint8Array(buf)).map((x) => x.toString(16).padStart(2, "0")).join("");
}

function readCookie(request, name) {
  const header = request.headers.get("cookie") || "";
  for (const part of header.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return v.join("=");
  }
  return null;
}

/** Returns the signed-in email, or null. */
export async function currentUser(request) {
  const sid = readCookie(request, COOKIE);
  if (!sid || sid.length > 100) return null;
  const email = await redis("GET", `sess:${await sha256(sid)}`);
  if (!email) return null;
  if ((await redis("SISMEMBER", "banned", email)) === 1) return null;
  return email;
}

export async function createSession(email) {
  const sid = randomToken();
  await redis("SET", `sess:${await sha256(sid)}`, email, "EX", SESSION_TTL);
  return sid;
}

export async function destroySession(request) {
  const sid = readCookie(request, COOKIE);
  if (sid) await redis("DEL", `sess:${await sha256(sid)}`);
}

export function sessionCookie(sid, maxAge = SESSION_TTL) {
  const secure = SITE.startsWith("https:") ? "; Secure" : "";
  return `${COOKIE}=${sid}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`;
}

/** Cookie-authenticated writes must come from our own pages. */
export function sameOrigin(request) {
  const origin = request.headers.get("origin");
  if (!origin) return true; // same-origin fetch without Origin (older browsers); SameSite=Lax still applies
  try {
    const o = new URL(origin);
    const allowed = new Set([new URL(SITE).host, new URL(request.url).host]);
    return allowed.has(o.host);
  } catch { return false; }
}

export async function sendMagicLink(email, link) {
  const key = process.env.RESEND_API_KEY;
  if (!key) throw new Error("Email sending isn't configured");
  const from = process.env.MAIL_FROM || "tmt.page <signin@mail.tmt.page>";
  const text = `Sign in to tmt.page:\n\n${link}\n\nThis link works once and expires in 15 minutes. If you didn't ask for it, ignore this email.`;
  const html = `<div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;max-width:28rem;margin:0 auto;padding:1.5rem;color:#141a17">
<p style="font-size:1.1rem;font-weight:700;margin:0 0 1rem">tmt.page</p>
<p>Click the button to sign in. It works once and expires in 15 minutes.</p>
<p style="margin:1.5rem 0"><a href="${link}" style="background:#d98a2b;color:#141a17;padding:.7rem 1.1rem;border-radius:10px;text-decoration:none;font-weight:650">Sign in to tmt.page</a></p>
<p style="color:#666;font-size:.85rem">If you didn't ask for this, ignore this email — nobody can sign in without the link.</p>
</div>`;
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from, to: [email], subject: "Your tmt.page sign-in link", text, html }),
  });
  if (!res.ok) throw new Error(`Email send failed (${res.status})`);
}
