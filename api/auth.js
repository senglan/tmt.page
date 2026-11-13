// Magic-link sign-in.
//   POST /api/auth?op=start   { email }         → emails a one-time link
//   GET  /api/auth?op=verify&token=…           → confirm page (a button, so email scanners can't burn the link)
//   POST /api/auth?op=verify  (form: token)    → creates the session cookie, redirects home
//   GET  /api/auth?op=me                       → { email } or { email: null }
//   POST /api/auth?op=logout
import { redis, tx, redisConfigured } from "./_lib/redis.js";
import { SITE, clientIp, hashIp, json } from "./_lib/rules.js";
import { page, esc } from "./_lib/page.js";
import {
  LOGIN_TTL, normalizeEmail, randomToken, sha256, currentUser, createSession,
  destroySession, sessionCookie, sameOrigin, sendMagicLink,
} from "./_lib/auth.js";

const op = (request) => new URL(request.url).searchParams.get("op");

export async function GET(request) {
  if (!redisConfigured()) return json({ error: "Storage isn't connected yet." }, 503);
  const params = new URL(request.url).searchParams;

  if (op(request) === "me") return json({ email: await currentUser(request) });

  if (op(request) === "verify") {
    const token = String(params.get("token") || "");
    if (!/^[A-Za-z0-9_-]{20,100}$/.test(token)) return badLink();
    return page({
      title: "Sign in",
      body: `<h1>Sign in to tmt.page</h1>
<form method="POST" action="/api/auth?op=verify">
<input type="hidden" name="token" value="${esc(token)}" />
<button class="btn" type="submit" autofocus>Sign in</button>
</form>`,
    });
  }
  return json({ error: "Unknown op" }, 400);
}

export async function POST(request) {
  if (!redisConfigured()) return json({ error: "Storage isn't connected yet." }, 503);
  if (!sameOrigin(request)) return json({ error: "Bad origin" }, 403);

  switch (op(request)) {
    case "start": {
      let body;
      try { body = await request.json(); } catch { return json({ error: "Send JSON: { email }" }, 400); }
      const email = normalizeEmail(body.email);
      if (!email) return json({ error: "Enter a valid email address." }, 400);
      if ((await redis("SISMEMBER", "banned", email)) === 1) return json({ error: "This account is suspended." }, 403);

      const ipHash = await hashIp(clientIp(request));
      const emailHash = await sha256(email);
      const [ipCount, , mailCount] = await tx([
        ["INCR", `rl:login:ip:${ipHash}`], ["EXPIRE", `rl:login:ip:${ipHash}`, 3600, "NX"],
        ["INCR", `rl:login:em:${emailHash}`], ["EXPIRE", `rl:login:em:${emailHash}`, 3600, "NX"],
      ]);
      if (ipCount > 10 || mailCount > 5) {
        return json({ error: "Too many sign-in emails. Try again in an hour." }, 429, { "Retry-After": "3600" });
      }

      const token = randomToken();
      await redis("SET", `login:${await sha256(token)}`, email, "EX", LOGIN_TTL);
      try {
        await sendMagicLink(email, `${SITE}/api/auth?op=verify&token=${token}`);
      } catch (e) {
        return json({ error: "Couldn't send the email. Try again shortly." }, 502);
      }
      return json({ ok: true });
    }

    case "verify": {
      const form = await request.formData().catch(() => null);
      const token = String(form?.get("token") || "");
      if (!/^[A-Za-z0-9_-]{20,100}$/.test(token)) return badLink();
      const email = await redis("GETDEL", `login:${await sha256(token)}`);
      if (!email) return badLink();
      const sid = await createSession(email);
      return new Response(null, {
        status: 303,
        headers: { Location: "/", "Set-Cookie": sessionCookie(sid), "Cache-Control": "no-store" },
      });
    }

    case "logout":
      await destroySession(request);
      return json({ ok: true }, 200, { "Set-Cookie": sessionCookie("", 0) });

    default:
      return json({ error: "Unknown op" }, 400);
  }
}

function badLink() {
  return page({
    title: "Link expired",
    status: 400,
    body: `<h1>That sign-in link didn't work</h1><p>Links work once and expire after 15 minutes.</p>
<p class="actions"><a class="btn" href="/">Get a new link</a></p>`,
  });
}
