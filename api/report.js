// POST /api/report { slug, reason? } — anyone can flag a link for review.
// A link is auto-disabled once it collects AUTO_DISABLE_REPORTS reports from distinct IPs.
import { redis, tx, redisConfigured } from "./_lib/redis.js";
import { SLUG_RE, clientIp, hashIp, json } from "./_lib/rules.js";

const AUTO_DISABLE = Number(process.env.AUTO_DISABLE_REPORTS || 3);

export async function POST(request) {
  if (!redisConfigured()) return json({ error: "Storage isn't connected yet." }, 503);
  let body;
  try { body = await request.json(); } catch { return json({ error: "Send JSON: { slug, reason? }" }, 400); }

  const slug = String(body.slug || "").toLowerCase();
  if (!SLUG_RE.test(slug) || (await redis("EXISTS", `link:${slug}`)) !== 1) {
    return json({ error: "No such link." }, 404);
  }
  const reason = String(body.reason || "").slice(0, 500);
  const ipHash = await hashIp(clientIp(request));

  const [added, count] = await tx([
    ["SADD", `reports:${slug}`, ipHash],
    ["SCARD", `reports:${slug}`],
    ["ZADD", "reports:queue", Date.now(), slug],
    ["LPUSH", `reports:${slug}:reasons`, JSON.stringify({ at: new Date().toISOString(), by: ipHash, reason })],
    ["LTRIM", `reports:${slug}:reasons`, 0, 49],
  ]);

  if (count >= AUTO_DISABLE) await redis("HSET", `link:${slug}`, "status", "disabled");
  return json({ ok: true, duplicate: added === 0 });
}
