// Small server-rendered pages (preview, not found, disabled). Same look as the homepage.

export function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

export function page({ title, body, status = 200, cache = "no-store" }) {
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<meta name="robots" content="noindex" />
<title>${esc(title)} · tmt.page</title>
<meta name="theme-color" content="#141a17" />
<link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>%E2%9E%A1%EF%B8%8F</text></svg>" />
<link rel="stylesheet" href="/assets/site.css" />
</head>
<body>
<main>
<p class="brand"><a href="/">tmt.page</a></p>
${body}
</main>
</body>
</html>`;
  return new Response(html, {
    status,
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": cache },
  });
}
