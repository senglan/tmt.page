// GET /<slug>   → redirect          (rewritten to /api/go?slug=<slug>)
// GET /<slug>+  → preview page      (rewritten to /api/go?slug=<slug>&preview=1)
import { redis, toObject, redisConfigured } from "./_lib/redis.js";
import { SLUG_RE } from "./_lib/rules.js";
import { page, esc } from "./_lib/page.js";

export async function GET(request) {
  const params = new URL(request.url).searchParams;
  const slug = String(params.get("slug") || "").toLowerCase();
  const preview = params.get("preview") === "1";

  if (!SLUG_RE.test(slug)) return notFound(slug);
  if (!redisConfigured()) return page({ title: "Unavailable", status: 503, body: `<h1>Back soon</h1><p>Storage isn't connected yet.</p>` });

  const link = toObject(await redis("HGETALL", `link:${slug}`));
  if (!link.url) return notFound(slug);

  if (link.status === "disabled") {
    return page({
      title: "Link disabled",
      status: 410,
      body: `<h1>This link has been disabled</h1><p><code>tmt.page/${esc(slug)}</code> was turned off after a report.</p>`,
    });
  }

  if (preview) {
    return page({
      title: `tmt.page/${slug}`,
      body: `
<h1>tmt.page/${esc(slug)}</h1>
<p class="muted">takes you to</p>
<p class="dest"><a href="${esc(link.url)}" rel="nofollow noopener">${esc(link.url)}</a></p>
<p class="muted">${Number(link.clicks || 0).toLocaleString("en-US")} visits · created ${esc((link.created || "").slice(0, 10))}</p>
<p class="actions"><a class="btn" href="${esc(link.url)}" rel="nofollow noopener">Continue</a>
<button class="btn ghost" id="report" data-slug="${esc(slug)}">Report this link</button></p>
<p id="report-msg" class="muted" role="status"></p>
<script src="/assets/report.js" defer></script>`,
    });
  }

  // Count the visit. Awaited because serverless functions can freeze right after responding.
  try { await redis("HINCRBY", `link:${slug}`, "clicks", 1); } catch { /* never block a redirect on stats */ }

  return new Response(null, {
    status: 302,
    headers: {
      Location: link.url,
      // Not cached, so visit counts stay accurate and disabling a link takes effect immediately.
      "Cache-Control": "private, no-store",
      "X-Robots-Tag": "noindex",
    },
  });
}

function notFound(slug) {
  const safe = esc(slug);
  const claim = SLUG_RE.test(slug)
    ? `<p class="actions"><a class="btn" href="/?slug=${encodeURIComponent(slug)}">Claim tmt.page/${safe}</a></p>`
    : "";
  return page({
    title: "Not found",
    status: 404,
    body: `<h1>Nothing here yet</h1><p><code>tmt.page/${safe}</code> doesn't go anywhere.</p>${claim}`,
  });
}
