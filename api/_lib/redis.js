// Minimal Upstash Redis REST client — no dependencies.
// Works with the env vars the Vercel Marketplace Upstash integration injects
// (KV_REST_API_URL / KV_REST_API_TOKEN) or Upstash's own names.

const URL_ = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;

export function redisConfigured() {
  return Boolean(URL_ && TOKEN);
}

async function call(path, body) {
  if (!redisConfigured()) throw new Error("Redis is not configured");
  const res = await fetch(`${URL_}${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok || data.error) throw new Error(`Redis error: ${data.error || res.status}`);
  return data;
}

/** Run one command: redis("GET", "key") */
export async function redis(...cmd) {
  const data = await call("", cmd.map(String));
  return data.result;
}

/** Run several commands in one round trip (atomic via MULTI/EXEC). */
export async function tx(cmds) {
  const data = await call("/multi-exec", cmds.map((c) => c.map(String)));
  return data.map((d) => {
    if (d.error) throw new Error(`Redis error: ${d.error}`);
    return d.result;
  });
}

/** HGETALL returns a flat array; turn it into an object. */
export function toObject(arr) {
  const o = {};
  if (!Array.isArray(arr)) return o;
  for (let i = 0; i < arr.length; i += 2) o[arr[i]] = arr[i + 1];
  return o;
}
