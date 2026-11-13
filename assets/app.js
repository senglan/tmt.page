(() => {
  const $ = (id) => document.getElementById(id);
  const SLUG_RE = /^[a-z0-9](?:[a-z0-9_-]{0,62}[a-z0-9])?$/;
  const post = (url, body) => fetch(url, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body || {}),
  });

  // /?slug=name (from a 404 "claim it" link) pre-fills the custom name once signed in.
  const pre = new URLSearchParams(location.search).get("slug");

  async function init() {
    let email = null;
    try { email = (await (await fetch("/api/auth?op=me")).json()).email; } catch {}
    if (email) showSignedIn(email); else showSignedOut();
  }

  // ---------- signed out ----------
  function showSignedOut() {
    $("signin").hidden = false;
    $("signin-form").addEventListener("submit", async (e) => {
      e.preventDefault();
      $("signin-error").textContent = "";
      $("signin-btn").disabled = true;
      try {
        const res = await post("/api/auth?op=start", { email: $("email").value });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || "Something went wrong.");
        $("sent-to").textContent = $("email").value.trim();
        $("signin-form").hidden = true;
        $("sent").hidden = false;
      } catch (ex) {
        $("signin-error").textContent = ex.message;
      } finally {
        $("signin-btn").disabled = false;
      }
    });
  }

  // ---------- signed in ----------
  function showSignedIn(email) {
    $("who").textContent = email;
    $("who").hidden = false;
    $("signout").hidden = false;
    $("create-wrap").hidden = false;
    $("signout").addEventListener("click", async () => {
      await post("/api/auth?op=logout");
      location.href = "/";
    });
    if (pre) { $("slug").value = pre; check(); $("url").focus(); }
    loadMine();
  }

  let timer, seq = 0;
  $("slug").addEventListener("input", () => { clearTimeout(timer); timer = setTimeout(check, 250); });

  async function check() {
    const hint = $("slug-hint");
    const v = $("slug").value.trim().toLowerCase();
    hint.className = "hint";
    if (!v) { hint.textContent = ""; return; }
    if (!SLUG_RE.test(v)) {
      hint.className = "hint bad";
      hint.textContent = "Letters, numbers, - and _ only; start and end with a letter or number.";
      return;
    }
    const mine = ++seq;
    try {
      const data = await (await fetch(`/api/links?slug=${encodeURIComponent(v)}`)).json();
      if (mine !== seq) return;
      if (data.available) { hint.className = "hint ok"; hint.textContent = `tmt.page/${v} is available`; }
      else { hint.className = "hint bad"; hint.textContent = data.error || `tmt.page/${v} is taken`; }
    } catch { hint.textContent = ""; }
  }

  $("create").addEventListener("submit", async (e) => {
    e.preventDefault();
    $("error").textContent = "";
    $("submit").disabled = true;
    $("submit").textContent = "Shortening…";
    try {
      const res = await post("/api/links", { url: $("url").value, slug: $("slug").value });
      const data = await res.json();
      if (res.status === 401) { location.reload(); return; }
      if (!res.ok) throw new Error(data.error || "Something went wrong.");
      $("short").href = data.short;
      $("short").textContent = data.short.replace(/^https?:\/\//, "");
      $("dest").textContent = data.url;
      $("result").hidden = false;
      $("copy").textContent = "Copy";
      $("slug").value = ""; $("slug-hint").textContent = ""; $("url").value = "";
      loadMine();
    } catch (ex) {
      $("error").textContent = ex.message;
    } finally {
      $("submit").disabled = false;
      $("submit").textContent = "Shorten";
    }
  });

  $("copy").addEventListener("click", async () => {
    try { await navigator.clipboard.writeText($("short").href); $("copy").textContent = "Copied"; }
    catch {
      const r = document.createRange(); r.selectNodeContents($("short"));
      getSelection().removeAllRanges(); getSelection().addRange(r);
    }
  });

  async function loadMine() {
    let data;
    try { data = await (await fetch("/api/links?mine=1")).json(); } catch { return; }
    const ul = $("mine");
    ul.textContent = "";
    const items = data.items || [];
    $("mine-empty").hidden = items.length > 0;
    for (const l of items) {
      const li = document.createElement("li");
      const top = document.createElement("div");
      top.className = "row";
      const a = document.createElement("a");
      a.href = l.short; a.target = "_blank"; a.rel = "noopener";
      a.textContent = l.short.replace(/^https?:\/\//, "");
      const meta = document.createElement("span");
      meta.className = "muted small";
      meta.textContent = `${l.clicks.toLocaleString()} visits${l.status === "disabled" ? " · disabled" : ""}`;
      const rm = document.createElement("button");
      rm.className = "link danger"; rm.type = "button"; rm.textContent = "Remove";
      rm.addEventListener("click", async () => {
        if (!confirm(`Remove tmt.page/${l.slug}? It will stop working and the name won't be reusable.`)) return;
        const res = await post("/api/links?op=remove", { slug: l.slug });
        if (res.ok) loadMine();
      });
      top.append(a, meta, rm);
      const dest = document.createElement("div");
      dest.className = "dest-sm"; dest.textContent = l.url;
      li.append(top, dest);
      ul.append(li);
    }
  }

  init();
})();
