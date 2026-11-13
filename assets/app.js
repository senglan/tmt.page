(() => {
  const $ = (id) => document.getElementById(id);
  const form = $("create"), urlIn = $("url"), slugIn = $("slug"), hint = $("slug-hint");
  const err = $("error"), submit = $("submit"), result = $("result");
  const SLUG_RE = /^[a-z0-9](?:[a-z0-9_-]{0,62}[a-z0-9])?$/;

  // /?slug=name (from a 404 "claim it" link) pre-fills the custom name.
  const pre = new URLSearchParams(location.search).get("slug");
  if (pre) { slugIn.value = pre; check(); urlIn.focus(); }

  let timer, seq = 0;
  slugIn.addEventListener("input", () => { clearTimeout(timer); timer = setTimeout(check, 250); });

  async function check() {
    const v = slugIn.value.trim().toLowerCase();
    hint.className = "hint";
    if (!v) { hint.textContent = ""; return; }
    if (!SLUG_RE.test(v)) {
      hint.className = "hint bad";
      hint.textContent = "Letters, numbers, - and _ only; start and end with a letter or number.";
      return;
    }
    const mine = ++seq;
    try {
      const res = await fetch(`/api/links?slug=${encodeURIComponent(v)}`);
      const data = await res.json();
      if (mine !== seq) return;
      if (data.available) { hint.className = "hint ok"; hint.textContent = `tmt.page/${v} is available`; }
      else { hint.className = "hint bad"; hint.textContent = data.error || `tmt.page/${v} is taken`; }
    } catch { hint.textContent = ""; }
  }

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    err.textContent = "";
    submit.disabled = true;
    submit.textContent = "Shortening…";
    try {
      const res = await fetch("/api/links", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: urlIn.value, slug: slugIn.value }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Something went wrong.");
      $("short").href = data.short;
      $("short").textContent = data.short.replace(/^https?:\/\//, "");
      $("dest").textContent = data.url;
      result.hidden = false;
      $("copy").textContent = "Copy";
      slugIn.value = ""; hint.textContent = "";
    } catch (ex) {
      err.textContent = ex.message;
    } finally {
      submit.disabled = false;
      submit.textContent = "Shorten";
    }
  });

  $("copy").addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText($("short").href);
      $("copy").textContent = "Copied";
    } catch {
      const r = document.createRange(); r.selectNodeContents($("short"));
      getSelection().removeAllRanges(); getSelection().addRange(r);
    }
  });
})();
