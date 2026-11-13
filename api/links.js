// POST /api/links  { url, slug? }  →  { slug, short, url }
import { redis, tx, redisConfigured } from "./_lib/redis.js";
import { SITE, checkUrl, checkSlug, randomSlug, clientIp, hashIp, flaggedBySafeBrowsing, json } from "./_lib/rules.js";

const PER_HOUR = Number(process.env.LIMIT_PER_HOUR || 10);
const PER_DAY = Number(process.env.LIMIT_PER_DAY || 50);
const GLOBAL_PER_DAY = Number(process.env.LIMIT_GLOBAL_PER_DAY || 5000);

async function overLimit(ipHash) {
  const now = Date.now();
  const hour = Math.floor(now / 3_600_000);
  const day = Math.floor(now / 86_400_000);
  const [h, , d, , g] = await tx([
    ["INCR", `rl:h:${ipHash}:${hour}`], ["EXPIRE", `rl:h:${ipHash}:${hour}`, 3600],
    ["INCR", `rl:d:${ipHash}:${day}`], ["EXPIRE", `rl:d:${ipHash}:${day}`, 86400],
    ["INCR", `rl:g:${day}`], ["EXPIRE", `rl:g:${day}`, 86400],
  ]);
  if (h > PER_HOUR) return "You've made a lot of links this hour. Try again later.";
  if (d > PER_DAY) return "You've hit today's limit. Try again tomorrow.";
  if (g > GLOBAL_PER_DAY) return "tmt.page has hit its daily limit. Try again tomorrow.";
  return null;
}

/** Atomically claim a slug. Returns true if it was free. */
async function claim(slug, record) {
  const won = await redis("HSETNX", `link:${slug}`, "url", record.url);
  if (won !== 1) return false;
  await redis("HSET", `link:${slug}`,
    "created", record.created, "by", record.by, "clicks", 0, "status", "active");
  return true;
}

export async function POST(request) {
  if (!redisConfigured()) return json({ error: "Storage isn't connected yet." }, 503);

  let body;
  try { body = await request.json(); } catch { return json({ error: "Send JSON: { url, slug? }" }, 400); }

  const u = checkUrl(body.url);
  if (u.error) return json({ error: u.error }, 400);

  let wanted = null;
  if (body.slug != null && String(body.slug).trim() !== "") {
    const s = checkSlug(body.slug);
    if (s.error) return json({ error: s.error }, 400);
    wanted = s.slug;
    if ((await redis("EXISTS", `link:${wanted}`)) === 1) {
      return json({ error: `tmt.page/${wanted} is already taken.` }, 409);
    }
  }

  const ipHash = await hashIp(clientIp(request));
  const limited = await overLimit(ipHash);
  if (limited) return json({ error: limited }, 429, { "Retry-After": "3600" });

  if (await flaggedBySafeBrowsing(u.url)) {
    return json({ error: "That URL is flagged as unsafe by Google Safe Browsing." }, 400);
  }

  const record = { url: u.url, created: new Date().toISOString(), by: ipHash };

  let slug = wanted;
  if (slug) {
    if (!(await claim(slug, record))) return json({ error: `tmt.page/${slug} is already taken.` }, 409);
  } else {
    for (let i = 0; i < 6 && !slug; i++) {
      const candidate = randomSlug(i < 3 ? 6 : 8);
      if (await claim(candidate, record)) slug = candidate;
    }
    if (!slug) return json({ error: "Couldn't find a free slug. Try again." }, 500);
  }

  await redis("ZADD", "links:recent", Date.now(), slug);
  return json({ slug, short: `${SITE}/${slug}`, url: u.url }, 201);
}

// GET /api/links?slug=x  → availability check for the custom-slug field
export async function GET(request) {
  if (!redisConfigured()) return json({ error: "Storage isn't connected yet." }, 503);
  const raw = new URL(request.url).searchParams.get("slug");
  const s = checkSlug(raw);
  if (s.error) return json({ available: false, error: s.error });
  const taken = (await redis("EXISTS", `link:${s.slug}`)) === 1;
  return json({ available: !taken, slug: s.slug });
}
