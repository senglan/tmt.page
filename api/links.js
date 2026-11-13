// POST /api/links  { url, slug? }  →  { slug, short, url }      (signed-in users only)
// GET  /api/links?slug=x            →  availability check
// GET  /api/links?mine=1            →  the signed-in user's links
// POST /api/links?op=remove { slug } →  retire one of your own links (the name is not released)
import { redis, tx, toObject, redisConfigured } from "./_lib/redis.js";
import { SITE, SLUG_RE, checkUrl, checkSlug, randomSlug, clientIp, hashIp, flaggedBySafeBrowsing, json } from "./_lib/rules.js";
import { currentUser, sameOrigin, sha256 } from "./_lib/auth.js";

const PER_HOUR = Number(process.env.LIMIT_PER_HOUR || 10);
const PER_DAY = Number(process.env.LIMIT_PER_DAY || 50);
const GLOBAL_PER_DAY = Number(process.env.LIMIT_GLOBAL_PER_DAY || 5000);

async function overLimit(keys) {
  const now = Date.now();
  const hour = Math.floor(now / 3_600_000);
  const day = Math.floor(now / 86_400_000);
  const cmds = [];
  for (const k of keys) {
    cmds.push(["INCR", `rl:h:${k}:${hour}`], ["EXPIRE", `rl:h:${k}:${hour}`, 3600]);
    cmds.push(["INCR", `rl:d:${k}:${day}`], ["EXPIRE", `rl:d:${k}:${day}`, 86400]);
  }
  cmds.push(["INCR", `rl:g:${day}`], ["EXPIRE", `rl:g:${day}`, 86400]);
  const r = await tx(cmds);
  for (let i = 0; i < keys.length; i++) {
    if (r[i * 4] > PER_HOUR) return "You've made a lot of links this hour. Try again later.";
    if (r[i * 4 + 2] > PER_DAY) return "You've hit today's limit. Try again tomorrow.";
  }
  if (r[keys.length * 4] > GLOBAL_PER_DAY) return "tmt.page has hit its daily limit. Try again tomorrow.";
  return null;
}

/** Atomically claim a slug. Returns true if it was free. */
async function claim(slug, record) {
  const won = await redis("HSETNX", `link:${slug}`, "url", record.url);
  if (won !== 1) return false;
  await redis("HSET", `link:${slug}`,
    "created", record.created, "by", record.by, "ip", record.ip, "clicks", 0, "status", "active");
  return true;
}

export async function POST(request) {
  if (!redisConfigured()) return json({ error: "Storage isn't connected yet." }, 503);
  if (!sameOrigin(request)) return json({ error: "Bad origin" }, 403);
  const user = await currentUser(request);
  if (!user) return json({ error: "Sign in to create links." }, 401);

  let body;
  try { body = await request.json(); } catch { return json({ error: "Send JSON." }, 400); }

  if (new URL(request.url).searchParams.get("op") === "remove") {
    const slug = String(body.slug || "").toLowerCase();
    if (!SLUG_RE.test(slug)) return json({ error: "Bad slug" }, 400);
    const by = await redis("HGET", `link:${slug}`, "by");
    if (by !== user) return json({ error: "That isn't your link." }, 403);
    // The name stays retired so nobody else can take over a link people already shared.
    await redis("HSET", `link:${slug}`, "status", "removed");
    return json({ ok: true, slug });
  }

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
  const limited = await overLimit([`u:${await sha256(user)}`, `ip:${ipHash}`]);
  if (limited) return json({ error: limited }, 429, { "Retry-After": "3600" });

  if (await flaggedBySafeBrowsing(u.url)) {
    return json({ error: "That URL is flagged as unsafe by Google Safe Browsing." }, 400);
  }

  const record = { url: u.url, created: new Date().toISOString(), by: user, ip: ipHash };

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

  await tx([
    ["ZADD", "links:recent", Date.now(), slug],
    ["ZADD", `user:${user}:links`, Date.now(), slug],
  ]);
  return json({ slug, short: `${SITE}/${slug}`, url: u.url }, 201);
}

export async function GET(request) {
  if (!redisConfigured()) return json({ error: "Storage isn't connected yet." }, 503);
  const params = new URL(request.url).searchParams;

  if (params.get("mine")) {
    const user = await currentUser(request);
    if (!user) return json({ error: "Sign in first." }, 401);
    const slugs = await redis("ZRANGE", `user:${user}:links`, 0, 199, "REV");
    const items = [];
    for (const slug of slugs) {
      const l = toObject(await redis("HGETALL", `link:${slug}`));
      if (!l.url || l.status === "removed") continue;
      items.push({ slug, short: `${SITE}/${slug}`, url: l.url, clicks: Number(l.clicks || 0), created: l.created, status: l.status });
    }
    return json({ email: user, items });
  }

  const s = checkSlug(params.get("slug"));
  if (s.error) return json({ available: false, error: s.error });
  const taken = (await redis("EXISTS", `link:${s.slug}`)) === 1;
  return json({ available: !taken, slug: s.slug });
}
