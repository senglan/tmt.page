// Admin endpoint. Requires header:  Authorization: Bearer <ADMIN_TOKEN>
//
// GET  /api/admin?view=reports          → reported links, newest first
// GET  /api/admin?view=recent           → 50 newest links
// GET  /api/admin?slug=x                → one link + its reports
// POST /api/admin { slug, action }      → action: "assign" | "hold-one" | "disable" | "enable" | "delete"
// POST /api/admin { action: "hold", slugs: [...] }
// POST /api/admin { action: "ban" | "unban", email }
import { redis, tx, toObject, redisConfigured } from "./_lib/redis.js";
import { SLUG_RE, RESERVED, checkUrl, json } from "./_lib/rules.js";

function authorized(request) {
  const token = process.env.ADMIN_TOKEN;
  if (!token || token.length < 16) return false;
  const given = (request.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  if (given.length !== token.length) return false;
  let diff = 0;
  for (let i = 0; i < token.length; i++) diff |= token.charCodeAt(i) ^ given.charCodeAt(i);
  return diff === 0;
}

async function describe(slug) {
  const [link, reasons, reporters] = await tx([
    ["HGETALL", `link:${slug}`],
    ["LRANGE", `reports:${slug}:reasons`, 0, 49],
    ["SCARD", `reports:${slug}`],
  ]);
  return { slug, ...toObject(link), reports: reporters, reasons: reasons.map((r) => JSON.parse(r)) };
}

export async function GET(request) {
  if (!authorized(request)) return json({ error: "Unauthorized" }, 401);
  if (!redisConfigured()) return json({ error: "Storage isn't connected yet." }, 503);
  const p = new URL(request.url).searchParams;

  if (p.get("slug")) {
    const slug = p.get("slug").toLowerCase();
    if (!SLUG_RE.test(slug)) return json({ error: "Bad slug" }, 400);
    return json(await describe(slug));
  }
  const key = p.get("view") === "recent" ? "links:recent" : "reports:queue";
  const slugs = await redis("ZRANGE", key, 0, 49, "REV");
  return json({ view: key, items: await Promise.all(slugs.map(describe)) });
}

export async function POST(request) {
  if (!authorized(request)) return json({ error: "Unauthorized" }, 401);
  if (!redisConfigured()) return json({ error: "Storage isn't connected yet." }, 503);
  let body;
  try { body = await request.json(); } catch { return json({ error: "Send JSON: { slug, action }" }, 400); }

  // Bulk-hold names for the owner: { action: "hold", slugs: [...] }
  if (body.action === "hold") {
    if (!Array.isArray(body.slugs) || body.slugs.length > 1000) return json({ error: "slugs must be an array of up to 1000 names" }, 400);
    const held = [], taken = [], invalid = [];
    const now = new Date().toISOString();
    for (const raw of body.slugs) {
      const slug = String(raw).trim().toLowerCase();
      if (!SLUG_RE.test(slug) || RESERVED.has(slug)) { invalid.push(raw); continue; }
      const won = await redis("HSETNX", `link:${slug}`, "url", "");
      if (won !== 1) { taken.push(slug); continue; }
      await redis("HSET", `link:${slug}`, "created", now, "by", "owner", "clicks", 0, "status", "held");
      held.push(slug);
    }
    return json({ ok: true, held: held.length, taken, invalid });
  }

  // Suspend an account and disable all its links: { action: "ban", email }   (or "unban")
  if (body.action === "ban" || body.action === "unban") {
    const email = String(body.email || "").trim().toLowerCase();
    if (!email.includes("@")) return json({ error: "email required" }, 400);
    const slugs = await redis("ZRANGE", `user:${email}:links`, 0, -1);
    if (body.action === "ban") {
      await redis("SADD", "banned", email);
      for (const s of slugs) await redis("HSET", `link:${s}`, "status", "disabled");
    } else {
      await redis("SREM", "banned", email);
    }
    return json({ ok: true, email, action: body.action, links: slugs.length });
  }

  const slug = String(body.slug || "").toLowerCase();
  if (!SLUG_RE.test(slug)) return json({ error: "Bad slug" }, 400);

  switch (body.action) {
    // Point a name (held or not) at a destination: { slug, action: "assign", url }
    // Owner links may point back into tmt.page (e.g. warm → /camping/).
    case "assign": {
      const u = checkUrl(body.url, { allowSelf: true });
      if (u.error) return json({ error: u.error }, 400);
      await redis("HSET", `link:${slug}`, "url", u.url, "status", "active", "by", "owner",
        "created", new Date().toISOString());
      await redis("HSETNX", `link:${slug}`, "clicks", 0);
      break;
    }
    // Put an assigned name back on hold.
    case "hold-one":
      await redis("HSET", `link:${slug}`, "url", "", "status", "held", "by", "owner");
      break;
    case "disable":
      await redis("HSET", `link:${slug}`, "status", "disabled");
      break;
    case "enable":
      await tx([
        ["HSET", `link:${slug}`, "status", "active"],
        ["DEL", `reports:${slug}`],
        ["ZREM", "reports:queue", slug],
      ]);
      break;
    case "delete":
      await tx([
        ["DEL", `link:${slug}`, `reports:${slug}`, `reports:${slug}:reasons`],
        ["ZREM", "reports:queue", slug],
        ["ZREM", "links:recent", slug],
      ]);
      break;
    default:
      return json({ error: 'action must be "hold", "assign", "hold-one", "disable", "enable" or "delete"' }, 400);
  }
  return json({ ok: true, slug, action: body.action });
}
