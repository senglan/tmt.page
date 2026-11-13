(() => {
  const btn = document.getElementById("report");
  const msg = document.getElementById("report-msg");
  if (!btn) return;
  btn.addEventListener("click", async () => {
    const reason = prompt("What's wrong with this link? (phishing, malware, spam…)");
    if (reason === null) return;
    btn.disabled = true;
    try {
      const res = await fetch("/api/report", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ slug: btn.dataset.slug, reason }),
      });
      msg.textContent = res.ok ? "Thanks — this link has been flagged for review." : "Couldn't send the report. Try again.";
    } catch {
      msg.textContent = "Couldn't send the report. Try again.";
      btn.disabled = false;
    }
  });
})();
