// Admin endpoint. Requires header:  Authorization: Bearer <ADMIN_TOKEN>
//
// GET  /api/admin?view=reports          → reported links, newest first
// GET  /api/admin?view=recent           → 50 newest links
// GET  /api/admin?slug=x                → one link + its reports
// POST /api/admin { slug, action }      → action: "disable" | "enable" | "delete"
import { redis, tx, toObject, redisConfigured } from "./_lib/redis.js";
import { SLUG_RE, json } from "./_lib/rules.js";

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
  const slug = String(body.slug || "").toLowerCase();
  if (!SLUG_RE.test(slug)) return json({ error: "Bad slug" }, 400);

  switch (body.action) {
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
      return json({ error: 'action must be "disable", "enable" or "delete"' }, 400);
  }
  return json({ ok: true, slug, action: body.action });
}
