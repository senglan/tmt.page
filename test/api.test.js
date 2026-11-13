// End-to-end tests for the API handlers against an in-memory Upstash-compatible REST server.
// Run: npm test
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";

const db = new Map();
const cmds = {
  GET: (k) => db.get(k) ?? null,
  EXISTS: (...ks) => ks.filter((k) => db.has(k)).length,
  DEL: (...ks) => ks.filter((k) => db.delete(k)).length,
  INCR: (k) => { const v = Number(db.get(k) || 0) + 1; db.set(k, String(v)); return v; },
  EXPIRE: () => 1,
  HSETNX: (k, f, v) => { const h = db.get(k) || new Map(); if (h.has(f)) return 0; h.set(f, v); db.set(k, h); return 1; },
  HSET: (k, ...fv) => { const h = db.get(k) || new Map(); let n = 0; for (let i = 0; i < fv.length; i += 2) { if (!h.has(fv[i])) n++; h.set(fv[i], fv[i + 1]); } db.set(k, h); return n; },
  HGETALL: (k) => { const h = db.get(k); return h ? [...h].flat() : []; },
  HINCRBY: (k, f, by) => { const h = db.get(k) || new Map(); const v = Number(h.get(f) || 0) + Number(by); h.set(f, String(v)); db.set(k, h); return v; },
  ZADD: (k, score, m) => { const z = db.get(k) || new Map(); const n = z.has(m) ? 0 : 1; z.set(m, Number(score)); db.set(k, z); return n; },
  ZREM: (k, m) => { const z = db.get(k); return z && z.delete(m) ? 1 : 0; },
  ZRANGE: (k, a, b) => { const z = db.get(k); if (!z) return []; return [...z].sort((x, y) => y[1] - x[1]).map((e) => e[0]).slice(Number(a), Number(b) + 1); },
  SADD: (k, m) => { const s = db.get(k) || new Set(); const n = s.has(m) ? 0 : 1; s.add(m); db.set(k, s); return n; },
  SCARD: (k) => (db.get(k)?.size ?? 0),
  LPUSH: (k, v) => { const l = db.get(k) || []; l.unshift(v); db.set(k, l); return l.length; },
  LTRIM: (k, a, b) => { const l = db.get(k) || []; db.set(k, l.slice(Number(a), Number(b) + 1)); return "OK"; },
  LRANGE: (k, a, b) => (db.get(k) || []).slice(Number(a), Number(b) + 1),
};
const run = ([c, ...args]) => {
  const fn = cmds[c.toUpperCase()];
  if (!fn) return { error: `unknown command ${c}` };
  return { result: fn(...args) };
};

let server, links, go, report, admin;
before(async () => {
  server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      if (req.headers.authorization !== "Bearer test-token") { res.statusCode = 401; return res.end('{"error":"unauthorized"}'); }
      const parsed = JSON.parse(body);
      const out = req.url === "/multi-exec" ? parsed.map(run) : run(parsed);
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify(out));
    });
  });
  await new Promise((r) => server.listen(0, r));
  process.env.KV_REST_API_URL = `http://127.0.0.1:${server.address().port}`;
  process.env.KV_REST_API_TOKEN = "test-token";
  process.env.ADMIN_TOKEN = "admin-token-0123456789";
  process.env.LIMIT_PER_HOUR = "5";
  links = await import("../api/links.js");
  go = await import("../api/go.js");
  report = await import("../api/report.js");
  admin = await import("../api/admin.js");
});
after(() => server.close());

const post = (body, ip = "1.2.3.4") =>
  new Request("https://tmt.page/api/links", {
    method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": ip }, body: JSON.stringify(body),
  });
const create = async (body, ip) => { const r = await links.POST(post(body, ip)); return { status: r.status, data: await r.json() }; };
const visit = (slug, preview) => go.GET(new Request(`https://tmt.page/api/go?slug=${encodeURIComponent(slug)}${preview ? "&preview=1" : ""}`));

test("creates a custom slug and redirects, case-insensitively", async () => {
  const { status, data } = await create({ url: "example.com/some/long/path?q=1", slug: "MyLink" });
  assert.equal(status, 201);
  assert.equal(data.slug, "mylink");
  assert.equal(data.short, "https://tmt.page/mylink");
  assert.equal(data.url, "https://example.com/some/long/path?q=1");

  const r = await visit("MYLINK");
  assert.equal(r.status, 302);
  assert.equal(r.headers.get("location"), "https://example.com/some/long/path?q=1");
});

test("random slug when none given", async () => {
  const { status, data } = await create({ url: "https://example.org" }, "5.5.5.5");
  assert.equal(status, 201);
  assert.match(data.slug, /^[a-z2-9]{6}$/);
});

test("refuses to overwrite an existing slug", async () => {
  const { status } = await create({ url: "https://evil.example", slug: "mylink" }, "9.9.9.9");
  assert.equal(status, 409);
  const r = await visit("mylink");
  assert.equal(r.headers.get("location"), "https://example.com/some/long/path?q=1");
});

test("availability check", async () => {
  const taken = await (await links.GET(new Request("https://tmt.page/api/links?slug=mylink"))).json();
  assert.equal(taken.available, false);
  const free = await (await links.GET(new Request("https://tmt.page/api/links?slug=free-one"))).json();
  assert.equal(free.available, true);
  const reserved = await (await links.GET(new Request("https://tmt.page/api/links?slug=camping"))).json();
  assert.equal(reserved.available, false);
});

test("rejects bad URLs and slugs", async () => {
  const bad = [
    [{ url: "javascript:alert(1)" }, /http/],
    [{ url: "ftp://example.com" }, /http/],
    [{ url: "http://localhost:3000" }, /publicly/],
    [{ url: "http://192.168.1.1/admin" }, /publicly/],
    [{ url: "http://10.0.0.5" }, /publicly/],
    [{ url: "http://[::1]/" }, /publicly/],
    [{ url: "http://intranet/" }, /publicly/],
    [{ url: "https://tmt.page/mylink" }, /back to tmt/],
    [{ url: "https://bit.ly/abc" }, /final destination/],
    [{ url: "https://user:pass@example.com" }, /passwords/],
    [{ url: "https://example.com", slug: "camping" }, /reserved/],
    [{ url: "https://example.com", slug: "api" }, /reserved/],
    [{ url: "https://example.com", slug: "-bad" }, /Slugs/],
    [{ url: "https://example.com", slug: "has space" }, /Slugs/],
    [{ url: "https://example.com", slug: "a".repeat(65) }, /Slugs/],
    [{ url: "" }, /Enter a URL/],
  ];
  for (const [body, re] of bad) {
    const { status, data } = await create(body, "7.7.7.7");
    assert.equal(status, 400, JSON.stringify(body));
    assert.match(data.error, re, JSON.stringify(body));
  }
});

test("rate limits per IP", async () => {
  const ip = "8.8.4.4";
  for (let i = 0; i < 5; i++) assert.equal((await create({ url: `https://example.com/${i}` }, ip)).status, 201);
  assert.equal((await create({ url: "https://example.com/6" }, ip)).status, 429);
  assert.equal((await create({ url: "https://example.com/6" }, "8.8.8.8")).status, 201);
});

test("counts visits and shows preview", async () => {
  await visit("mylink");
  const r = await visit("mylink", true);
  assert.equal(r.status, 200);
  const html = await r.text();
  assert.match(html, /https:\/\/example\.com\/some\/long\/path\?q=1/);
  assert.match(html, /3 visits/);
});

test("unknown slug → 404 with claim link; escapes input", async () => {
  const r = await visit("nothing-here");
  assert.equal(r.status, 404);
  assert.match(await r.text(), /\/\?slug=nothing-here/);
  const x = await visit("<script>");
  assert.equal(x.status, 404);
  assert.doesNotMatch(await x.text(), /<script>/);
});

test("reports auto-disable after 3 distinct reporters", async () => {
  await create({ url: "https://sketchy.example", slug: "sketchy" }, "6.6.6.6");
  for (const ip of ["11.0.0.1", "11.0.0.1", "11.0.0.2"]) {
    const r = await report.POST(new Request("https://tmt.page/api/report", {
      method: "POST", headers: { "x-forwarded-for": ip }, body: JSON.stringify({ slug: "sketchy", reason: "phish" }),
    }));
    assert.equal(r.status, 200);
  }
  assert.equal((await visit("sketchy")).status, 302, "two distinct reporters is not enough");
  await report.POST(new Request("https://tmt.page/api/report", {
    method: "POST", headers: { "x-forwarded-for": "11.0.0.3" }, body: JSON.stringify({ slug: "sketchy" }),
  }));
  assert.equal((await visit("sketchy")).status, 410);
});

test("owner can hold names in bulk, then assign one", async () => {
  const auth = { authorization: "Bearer admin-token-0123456789" };
  const call = (body) => admin.POST(new Request("https://tmt.page/api/admin", { method: "POST", headers: auth, body: JSON.stringify(body) }));
  const res = await (await call({ action: "hold", slugs: ["Home", "docs", "mylink", "camping", "bad name"] })).json();
  assert.equal(res.held, 2);
  assert.deepEqual(res.taken, ["mylink"]);
  assert.deepEqual(res.invalid, ["camping", "bad name"]);

  const held = await visit("home");
  assert.equal(held.status, 404);
  assert.match(await held.text(), /Reserved/);
  assert.equal((await create({ url: "https://example.com", slug: "home" }, "3.3.3.3")).status, 409);

  await call({ slug: "home", action: "assign", url: "https://tmt.page/camping/" });
  const r = await visit("home");
  assert.equal(r.status, 302);
  assert.equal(r.headers.get("location"), "https://tmt.page/camping/");
});

test("admin requires token; can list, enable, delete", async () => {
  const unauth = await admin.GET(new Request("https://tmt.page/api/admin?view=reports"));
  assert.equal(unauth.status, 401);
  const auth = { authorization: "Bearer admin-token-0123456789" };
  const q = await (await admin.GET(new Request("https://tmt.page/api/admin?view=reports", { headers: auth }))).json();
  assert.equal(q.items[0].slug, "sketchy");
  assert.equal(q.items[0].reports, 3);

  await admin.POST(new Request("https://tmt.page/api/admin", { method: "POST", headers: auth, body: JSON.stringify({ slug: "sketchy", action: "enable" }) }));
  assert.equal((await visit("sketchy")).status, 302);
  await admin.POST(new Request("https://tmt.page/api/admin", { method: "POST", headers: auth, body: JSON.stringify({ slug: "sketchy", action: "delete" }) }));
  assert.equal((await visit("sketchy")).status, 404);
});
