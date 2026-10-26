#!/usr/bin/env node
import { createServer } from "node:http";

const HOST = "127.0.0.1";
const PORT = 48765;
const BASE = "/pi-firefox-test";
const COOKIE_NAME = "pi_firefox_test";
const COOKIE_VALUE = "synthetic_fixture";
const phase0ProbePage = { path: "/phase0-probe/", title: "Phase 0 HTML probe", side: "work" };

const pages = [
  { path: `${BASE}/work/`, title: "Work test route", side: "work" },
  { path: `${BASE}/personal/`, title: "Personal test route", side: "personal" },
  { path: `${BASE}/shared/`, title: "Shared test route", side: null },
];
const observations = new Map();

function send(response, status, body, contentType = "text/html; charset=utf-8", extraHeaders = {}) {
  response.writeHead(status, {
    "Content-Type": contentType,
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
    ...extraHeaders,
  });
  response.end(body);
}

function html(title, body) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${title}</title>
</head>
<body>
  <main>
    <h1>${title}</h1>
    ${body}
  </main>
</body>
</html>`;
}

function pageFor(page) {
  const links = pages
    .map((item) => `<li><a href="${item.path}">${item.title}</a></li>`)
    .join("\n");
  const observeForm = page.side
    ? `<form action="?action=cookie-observe" method="post">
        <button type="submit">Record cookie presence for this route</button>
      </form>`
    : "<p>Use a work or personal route to record cookie presence.</p>";

  return html(
    page.title,
    `<p>This page contains synthetic test content only.</p>
    <form action="?action=form" method="post">
      <label>Test text
        <input name="synthetic-note" maxlength="200" autocomplete="off">
      </label>
      <button type="submit">Submit test text</button>
    </form>
    <section aria-labelledby="cookie-test">
      <h2 id="cookie-test">Synthetic cookie test</h2>
      <form action="?action=cookie-set" method="post">
        <button type="submit">Set one synthetic test cookie in this container</button>
      </form>
      <form action="?action=cookie-clear" method="post">
        <button type="submit">Clear the synthetic test cookie in this container</button>
      </form>
      <form action="?action=cookie-reset" method="post">
        <button type="submit">Reset server-side comparison state</button>
      </form>
      ${observeForm}
      <p>The comparison endpoint returns only aggregate equality.</p>
    </section>
    <nav aria-label="Test routes">
      <h2>Routes</h2>
      <ul>${links}</ul>
    </nav>`,
  );
}

function hasSyntheticCookie(header) {
  if (!header) return false;
  return header.split(";").some((part) => {
    const separator = part.indexOf("=");
    if (separator < 0) return false;
    return part.slice(0, separator).trim() === COOKIE_NAME
      && part.slice(separator + 1).trim() === COOKIE_VALUE;
  });
}

function aggregateEquality() {
  if (!observations.has("work") || !observations.has("personal")) {
    return null;
  }
  return observations.get("work") === observations.get("personal");
}

async function discardSmallBody(request) {
  let byteCount = 0;
  for await (const chunk of request) {
    byteCount += chunk.length;
  }
  return byteCount <= 4096;
}

function aggregatePage(title, equal) {
  return html(title, `<pre id="aggregate">${JSON.stringify({ equal })}</pre>`);
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? "/", `http://${HOST}:${PORT}`);

  if (request.method === "GET" && url.pathname === "/phase0-probe/") {
    const body = html(
      "Phase 0 HTML probe",
      `<p id="boolean">false</p>
      <form action="?action=cookie-reset" method="post">
        <button type="submit">Reset synthetic comparison state</button>
      </form>
      <form action="?action=cookie-observe" method="post">
        <button type="submit">Record synthetic cookie presence</button>
      </form>
      <iframe title="same-origin fixture" src="/phase0-frame/"></iframe>
      <iframe title="localhost cross-origin fixture" src="http://localhost:${PORT}/phase0-frame/"></iframe>`,
    );
    send(response, 200, body, "text/html; charset=utf-8", {
      "Content-Security-Policy": `default-src 'none'; style-src 'unsafe-inline'; frame-src http://${HOST}:${PORT}/phase0-frame/ http://localhost:${PORT}/phase0-frame/; form-action 'self'; base-uri 'none'; frame-ancestors 'none'`,
    });
    return;
  }

  if (request.method === "GET" && url.pathname === "/phase0-frame/") {
    send(response, 200, html("Phase 0 frame", '<p id="frame-content">synthetic frame fixture</p>'));
    return;
  }

  if (request.method === "GET" && url.pathname === "/phase0-json/") {
    send(response, 200, JSON.stringify({ equal: false }), "application/json; charset=utf-8");
    return;
  }

  const page = pages.find((item) => item.path === url.pathname)
    ?? (url.pathname === phase0ProbePage.path ? phase0ProbePage : undefined);

  if (!page) {
    send(response, 404, html("Not found", "<p>No fixture route exists here.</p>"));
    return;
  }

  if (request.method === "GET") {
    send(response, 200, pageFor(page));
    return;
  }

  if (request.method !== "POST") {
    send(response, 405, html("Method not allowed", "<p>Use a fixture form.</p>"), "text/html; charset=utf-8", {
      Allow: "GET, POST",
    });
    return;
  }

  const action = url.searchParams.get("action");
  const validActions = new Set([
    "form",
    "cookie-set",
    "cookie-clear",
    "cookie-reset",
    "cookie-observe",
  ]);
  if (!validActions.has(action) || (action === "cookie-observe" && !page.side)) {
    send(response, 400, html("Invalid test action", "<p>Use a form on a fixture route.</p>"));
    return;
  }

  if (Number(request.headers["content-length"]) > 4096) {
    send(response, 413, html("Request too large", "<p>Test form data is limited to 4096 bytes.</p>"));
    return;
  }

  const bodyIsSmall = await discardSmallBody(request);
  if (!bodyIsSmall) {
    send(response, 413, html("Request too large", "<p>Test form data is limited to 4096 bytes.</p>"));
    return;
  }

  if (action === "form") {
    send(response, 200, html("Form received", "<p>Test text was discarded and was not stored.</p>"));
    return;
  }

  if (action === "cookie-set") {
    send(response, 200, html("Synthetic cookie set", "<p>One synthetic test cookie was set for this local test path.</p>"), "text/html; charset=utf-8", {
      "Set-Cookie": `${COOKIE_NAME}=${COOKIE_VALUE}; Path=${BASE}/; HttpOnly; SameSite=Lax; Max-Age=600`,
    });
    return;
  }

  if (action === "cookie-clear") {
    send(response, 200, html("Synthetic cookie cleared", "<p>The synthetic test cookie was cleared for this local test path.</p>"), "text/html; charset=utf-8", {
      "Set-Cookie": `${COOKIE_NAME}=; Path=${BASE}/; HttpOnly; SameSite=Lax; Max-Age=0`,
    });
    return;
  }

  if (action === "cookie-reset") {
    observations.clear();
    send(response, 200, aggregatePage("Cookie comparison reset", null));
    return;
  }

  observations.set(page.side, hasSyntheticCookie(request.headers.cookie));
  send(response, 200, aggregatePage("Cookie observation", aggregateEquality()));
});

server.on("error", (error) => {
  if (error.code === "EADDRINUSE") {
    console.error(`Cannot bind ${HOST}:${PORT}: the port is already in use. No process was stopped.`);
  } else {
    console.error(`Cannot start fixture server: ${error.message}`);
  }
  process.exitCode = 1;
});

let stopping = false;
function stop() {
  if (stopping) return;
  stopping = true;
  server.close(() => process.exit(0));
}

process.on("SIGINT", stop);
process.on("SIGTERM", stop);

server.listen(PORT, HOST, () => {
  console.log(`Firefox container fixture listening at http://${HOST}:${PORT}`);
});
