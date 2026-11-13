// Validation and abuse rules for tmt.page shortlinks.

export const SITE = process.env.SITE_ORIGIN || "https://tmt.page";
export const SITE_HOST = new URL(SITE).hostname;

export const SLUG_RE = /^[a-z0-9](?:[a-z0-9_-]{0,62}[a-z0-9])?$/;
export const MAX_URL_LENGTH = 2048;

// Paths that already exist on the site, or that we want to keep for ourselves.
export const RESERVED = new Set([
  "api", "admin", "about", "help", "terms", "privacy", "abuse", "report",
  "login", "logout", "signup", "account", "settings", "dashboard", "new",
  "create", "edit", "delete", "stats", "static", "assets", "public",
  "favicon.ico", "robots.txt", "sitemap.xml", "index", "index.html",
  "readme", "readme.md", "license", "cname", "www", "tmt", "app",
  // Existing tools on tmt.page — each tool folder must be listed here.
  "camping",
]);

// Other shorteners: block them to prevent redirect chains that hide the real destination.
const SHORTENER_HOSTS = [
  "bit.ly", "bitly.com", "tinyurl.com", "t.co", "goo.gl", "ow.ly", "is.gd",
  "buff.ly", "rebrand.ly", "cutt.ly", "shorturl.at", "rb.gy", "tiny.cc",
  "s.id", "t.ly", "v.gd", "lnkd.in", "bl.ink", "short.io", "aka.ms",
];

// Extra blocked hosts can be added without a deploy via the BLOCKED_HOSTS env var (comma-separated).
const EXTRA_BLOCKED = (process.env.BLOCKED_HOSTS || "")
  .split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);

function hostMatches(host, list) {
  return list.some((h) => host === h || host.endsWith(`.${h}`));
}

function isPrivateHost(host) {
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") ||
      host.endsWith(".internal") || host.endsWith(".lan") || host.endsWith(".home.arpa")) return true;
  // IPv4 literal
  const m = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (m) {
    const [a, b] = [Number(m[1]), Number(m[2])];
    if (a === 10 || a === 127 || a === 0) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    return false;
  }
  // IPv6 literal (URL hostnames keep the brackets)
  if (host.startsWith("[")) {
    const h = host.slice(1, -1);
    return h === "::1" || h === "::" || h.startsWith("fc") || h.startsWith("fd") || h.startsWith("fe80") || h.startsWith("::ffff:");
  }
  // Needs a dot and a plausible TLD
  return !/\.[a-z][a-z0-9-]*[a-z0-9]$|\.xn--[a-z0-9-]+$/.test(host);
}

/** Returns { url } with a normalized URL, or { error }. */
export function checkUrl(raw) {
  if (typeof raw !== "string" || !raw.trim()) return { error: "Enter a URL." };
  let input = raw.trim();
  if (!/^[a-z][a-z0-9+.-]*:/i.test(input)) input = `https://${input}`;
  if (input.length > MAX_URL_LENGTH) return { error: `URLs must be under ${MAX_URL_LENGTH} characters.` };

  let u;
  try { u = new URL(input); } catch { return { error: "That doesn't look like a valid URL." }; }

  if (u.protocol !== "https:" && u.protocol !== "http:") return { error: "Only http:// and https:// links are allowed." };
  if (u.username || u.password) return { error: "Links with embedded usernames or passwords aren't allowed." };

  const host = u.hostname.toLowerCase();
  if (isPrivateHost(host)) return { error: "That address isn't publicly reachable." };
  if (host === SITE_HOST || host.endsWith(`.${SITE_HOST}`)) return { error: "Links can't point back to tmt.page." };
  if (hostMatches(host, SHORTENER_HOSTS)) return { error: "Please use the final destination, not another short link." };
  if (hostMatches(host, EXTRA_BLOCKED)) return { error: "Links to that site aren't allowed." };

  return { url: u.toString() };
}

/** Returns { slug } (lowercased) or { error }. */
export function checkSlug(raw) {
  const slug = String(raw || "").trim().toLowerCase();
  if (!SLUG_RE.test(slug)) {
    return { error: "Slugs use letters, numbers, - and _, up to 64 characters, and must start and end with a letter or number." };
  }
  if (RESERVED.has(slug)) return { error: `"${slug}" is reserved.` };
  return { slug };
}

// No 0/o/1/l/i, so random slugs are easy to read aloud and type.
const ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";
export function randomSlug(len = 6) {
  const bytes = crypto.getRandomValues(new Uint8Array(len));
  let s = "";
  for (const b of bytes) s += ALPHABET[b % ALPHABET.length];
  return s;
}

export function clientIp(request) {
  const xff = request.headers.get("x-forwarded-for");
  return (xff ? xff.split(",")[0] : request.headers.get("x-real-ip") || "unknown").trim();
}

/** Salted SHA-256 so raw IPs are never stored. */
export async function hashIp(ip) {
  const salt = process.env.IP_SALT || "tmt.page";
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${salt}:${ip}`));
  return Array.from(new Uint8Array(buf)).slice(0, 12).map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Optional Google Safe Browsing check. Returns true if flagged. Skipped if no key is set. */
export async function flaggedBySafeBrowsing(url) {
  const key = process.env.SAFE_BROWSING_KEY;
  if (!key) return false;
  try {
    const res = await fetch(`https://safebrowsing.googleapis.com/v4/threatMatches:find?key=${key}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client: { clientId: "tmt.page", clientVersion: "1.0" },
        threatInfo: {
          threatTypes: ["MALWARE", "SOCIAL_ENGINEERING", "UNWANTED_SOFTWARE", "POTENTIALLY_HARMFUL_APPLICATION"],
          platformTypes: ["ANY_PLATFORM"],
          threatEntryTypes: ["URL"],
          threatEntries: [{ url }],
        },
      }),
    });
    if (!res.ok) return false;
    const data = await res.json();
    return Boolean(data.matches && data.matches.length);
  } catch {
    return false;
  }
}

export function json(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...headers },
  });
}
