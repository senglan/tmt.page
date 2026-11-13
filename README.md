# tmt.page

**Take me to…** — free, public short links (like `aka.ms`), plus small single-purpose tools.

| Path | What |
|---|---|
| `/` | Shortlink creator |
| `/<name>` | Redirects to the saved URL (case-insensitive) |
| `/<name>+` | Preview: shows the destination and visit count, with a report button |
| `/camping/` | Am I Warm? — camping sleep-system checker |

## How it works

- Hosted on **Vercel**. Static files are served first, so tool folders like `/camping/` work as-is with no build step.
- Anything else that looks like a slug is rewritten (`vercel.json`) to `api/go.js`, which looks it up in **Upstash Redis** and 302-redirects.
- Zero npm dependencies: functions call the Upstash REST API with `fetch`.

```
api/
  links.js     POST create link · GET availability check
  go.js        redirect / preview / 404
  report.js    public abuse reports (auto-disable at 3 distinct reporters)
  admin.js     moderation (Bearer ADMIN_TOKEN)
  _lib/        redis client, validation rules, page template
assets/        site.css, app.js, report.js
camping/       Am I Warm?
```

## Rules

- `http(s)` only. No localhost/private IPs, no embedded credentials, no links back to tmt.page, no other shorteners (prevents hidden redirect chains).
- Slugs: `a-z 0-9 - _`, 1–64 chars, stored lowercase. First come, first served — existing links can't be overwritten.
- Reserved slugs live in `api/_lib/rules.js` → `RESERVED`. **Adding a new tool folder? Add its name there.**
- Rate limits per hashed IP: 10/hour, 50/day; 5,000/day site-wide.

## Environment variables

| Var | Required | Notes |
|---|---|---|
| `KV_REST_API_URL`, `KV_REST_API_TOKEN` | yes | Injected by the Vercel ↔ Upstash integration |
| `ADMIN_TOKEN` | for admin | ≥16 chars |
| `IP_SALT` | recommended | Salt for hashing IPs |
| `SAFE_BROWSING_KEY` | optional | Google Safe Browsing v4 key; checks every new link |
| `BLOCKED_HOSTS` | optional | Comma-separated extra blocked domains |
| `LIMIT_PER_HOUR`, `LIMIT_PER_DAY`, `LIMIT_GLOBAL_PER_DAY`, `AUTO_DISABLE_REPORTS` | optional | Override defaults |

## Moderation

```sh
T=your-admin-token
curl -H "Authorization: Bearer $T" "https://tmt.page/api/admin?view=reports"
curl -H "Authorization: Bearer $T" "https://tmt.page/api/admin?view=recent"
curl -H "Authorization: Bearer $T" -X POST https://tmt.page/api/admin \
     -d '{"slug":"bad-link","action":"disable"}'   # or "enable" / "delete"
```

## Tests

```sh
npm test   # runs the API against an in-memory Redis mock
```

## License

MIT
