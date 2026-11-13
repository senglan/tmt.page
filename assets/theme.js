// Theme: follows the system setting until the visitor picks one with the toggle.
// Loaded in <head> (not deferred) so the right theme is applied before first paint.
(() => {
  const root = document.documentElement;
  const media = matchMedia("(prefers-color-scheme: light)");
  const KEY = "tmt-theme";

  const saved = () => { try { return localStorage.getItem(KEY); } catch { return null; } };
  const resolved = () => saved() || (media.matches ? "light" : "dark");

  function apply() {
    const s = saved();
    if (s) root.setAttribute("data-theme", s); else root.removeAttribute("data-theme");
    const r = resolved();
    root.setAttribute("data-theme-resolved", r);
    const btn = document.getElementById("theme-toggle");
    if (btn) btn.setAttribute("aria-label", r === "dark" ? "Switch to light mode" : "Switch to dark mode");
  }

  apply();
  media.addEventListener?.("change", apply);

  document.addEventListener("DOMContentLoaded", () => {
    const btn = document.getElementById("theme-toggle");
    if (!btn) return;
    apply();
    btn.addEventListener("click", () => {
      const next = resolved() === "dark" ? "light" : "dark";
      try { localStorage.setItem(KEY, next); } catch {}
      apply();
    });
  });
})();
