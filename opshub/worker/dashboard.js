/**
 * OpsHub dashboard — read-only control surface.
 *
 * Security decisions:
 *  - no secrets are ever sent to the browser
 *  - all writes (approve/cancel/retry) stay on signed Telegram/HTTP paths;
 *    the dashboard shows state and explains the next action instead
 *  - every value rendered through textContent, never innerHTML
 */

export function dashboardHtml(version = "3.3.0") {
  // NOTE: client code uses string concatenation, never template literals, so
  // no server-side interpolation happens inside the page script.
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>OpsHub Control</title>
<style>
  :root {
    --bg: #0b1016; --panel: #131b24; --panel2: #0f1720; --line: #223140;
    --text: #e6edf3; --muted: #8fa3b8; --accent: #3fb6a8; --warn: #e3b341;
    --bad: #f06b6b; --ok: #4cc38a; --idle: #7d8fa3;
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--text);
    font: 14px/1.5 ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
  header { display: flex; align-items: center; gap: 16px; padding: 18px 24px;
    border-bottom: 1px solid var(--line); position: sticky; top: 0; background: rgba(11,16,22,.94);
    backdrop-filter: blur(6px); z-index: 5; flex-wrap: wrap; }
  h1 { font-size: 17px; margin: 0; letter-spacing: .2px; }
  .ver { color: var(--muted); font-size: 12px; }
  .spacer { flex: 1; }
  button { background: var(--panel2); color: var(--text); border: 1px solid var(--line);
    border-radius: 8px; padding: 7px 12px; font-size: 13px; cursor: pointer; }
  button:hover { border-color: var(--accent); }
  main { padding: 20px 24px 60px; max-width: 1280px; margin: 0 auto; }
  .grid { display: grid; gap: 16px; }
  .studios { grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); }
  .card { background: var(--panel); border: 1px solid var(--line); border-radius: 12px; padding: 16px; }
  .card h2 { font-size: 13px; text-transform: uppercase; letter-spacing: .08em;
    color: var(--muted); margin: 0 0 12px; }
  .studio-name { font-size: 16px; font-weight: 600; margin: 0 0 2px; }
  .studio-lang { color: var(--muted); font-size: 12px; margin-bottom: 12px; }
  .pill { display: inline-block; padding: 2px 9px; border-radius: 999px; font-size: 12px;
    border: 1px solid var(--line); color: var(--muted); }
  .pill.running, .pill.running-stage { color: var(--accent); border-color: var(--accent); }
  .pill.awaiting_approval, .pill.quality_review { color: var(--warn); border-color: var(--warn); }
  .pill.failed, .pill.blocked { color: var(--bad); border-color: var(--bad); }
  .pill.complete, .pill.approved { color: var(--ok); border-color: var(--ok); }
  .bar { height: 6px; background: #0a1219; border-radius: 999px; overflow: hidden; margin: 10px 0 6px; }
  .bar > i { display: block; height: 100%; background: var(--accent); width: 0%; transition: width .4s; }
  .meta { color: var(--muted); font-size: 12px; display: flex; justify-content: space-between; gap: 8px; }
  .table-wrap { width: 100%; overflow-x: auto; -webkit-overflow-scrolling: touch; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th { text-align: left; color: var(--muted); font-weight: 500; font-size: 12px;
    text-transform: uppercase; letter-spacing: .06em; padding: 8px 10px; border-bottom: 1px solid var(--line); }
  td { padding: 9px 10px; border-bottom: 1px solid #1a2632; vertical-align: top; }
  td.mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; }
  .empty { color: var(--muted); padding: 18px 10px; }
  .providers { display: flex; flex-wrap: wrap; gap: 8px; }
  .provider { border: 1px solid var(--line); border-radius: 8px; padding: 7px 10px; font-size: 12px; }
  .provider.configured { border-color: var(--accent); color: var(--accent); }
  .provider.not_configured { color: var(--muted); }
  .note { color: var(--muted); font-size: 12px; margin-top: 10px; }
  .banner { border: 1px solid var(--warn); color: var(--warn); background: rgba(227,179,65,.07);
    border-radius: 10px; padding: 10px 14px; margin-bottom: 16px; font-size: 13px; display: none; }
  section { margin-top: 22px; }
  .row { display: flex; gap: 12px; align-items: baseline; flex-wrap: wrap; }
  .ok { color: var(--ok); } .bad { color: var(--bad); } .muted { color: var(--muted); }
  @media (max-width: 640px) {
    main { padding: 14px; }
    th.detail, td.detail { display: none; }
    th, td { padding: 8px 6px; }
    h1 { font-size: 16px; }
    .studios { grid-template-columns: 1fr; }
  }
</style>
</head>
<body>
<header>
  <h1>OpsHub Control</h1>
  <span class="ver">v${version}</span>
  <span class="spacer"></span>
  <span id="hub-state" class="pill">checking…</span>
  <button id="refresh" type="button">Refresh</button>
</header>
<main>
  <div class="banner" id="banner"></div>

  <div class="grid studios" id="studios" data-testid="studios"></div>

  <section>
    <div class="card">
      <h2>Productions</h2>
      <div class="table-wrap">
      <table>
        <thead><tr>
          <th>Job</th><th>Studio</th><th>Status</th><th>Stage</th><th>Progress</th>
          <th>Updated</th><th class="detail">Detail</th>
        </tr></thead>
        <tbody id="jobs" data-testid="jobs"><tr><td colspan="7" class="empty">Loading…</td></tr></tbody>
      </table>
      </div>
      <p class="note">Approvals are signed actions: use Telegram <span class="mono">/approve JOB_ID</span>.
        Publishing stays disabled even after approval.</p>
    </div>
  </section>

  <section>
    <div class="card">
      <h2>API readiness</h2>
      <div class="providers" id="providers" data-testid="providers"></div>
      <p class="note" id="readiness-note"></p>
    </div>
  </section>

  <section>
    <div class="card">
      <h2>Awaiting review</h2>
      <div id="review" data-testid="review" class="muted">Nothing waiting.</div>
    </div>
  </section>
</main>
<script>
(function () {
  var STUDIOS = [
    { id: "trendscope", label: "TrendScope", lang: "English · tech & AI" },
    { id: "true-crime", label: "True Crime", lang: "Turkish · investigations" },
    { id: "deep-history", label: "Deep History", lang: "English · documentaries" }
  ];

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined && text !== null) n.textContent = String(text);
    return n;
  }

  function ago(ts) {
    if (!ts) return "—";
    var s = Math.max(0, Math.floor(Date.now() / 1000 - Number(ts)));
    if (s < 60) return s + "s ago";
    if (s < 3600) return Math.floor(s / 60) + "m ago";
    if (s < 86400) return Math.floor(s / 3600) + "h ago";
    return Math.floor(s / 86400) + "d ago";
  }

  function getJson(url) {
    return fetch(url, { headers: { "accept": "application/json" } })
      .then(function (r) { if (!r.ok) throw new Error(url + " → " + r.status); return r.json(); });
  }

  function renderStudios(jobs) {
    var host = document.getElementById("studios");
    host.textContent = "";
    STUDIOS.forEach(function (s) {
      var mine = jobs.filter(function (j) { return j.studio === s.id; });
      var latest = mine[0];
      var card = el("div", "card");
      card.appendChild(el("p", "studio-name", s.label));
      card.appendChild(el("div", "studio-lang", s.lang));

      var status = latest ? latest.status : "idle";
      var pill = el("span", "pill " + status, status.replace(/_/g, " "));
      card.appendChild(pill);

      var bar = el("div", "bar");
      var fill = el("i");
      fill.style.width = Math.max(0, Math.min(100, latest ? Number(latest.progress) || 0 : 0)) + "%";
      bar.appendChild(fill);
      card.appendChild(bar);

      var meta = el("div", "meta");
      meta.appendChild(el("span", "", latest ? ("stage: " + (latest.stage || "—")) : "no production yet"));
      meta.appendChild(el("span", "", latest ? ago(latest.updated_at) : ""));
      card.appendChild(meta);
      host.appendChild(card);
    });
  }

  function renderJobs(jobs) {
    var body = document.getElementById("jobs");
    body.textContent = "";
    if (!jobs.length) {
      var tr = el("tr");
      var td = el("td", "empty", "No productions recorded. Dispatch one from Telegram with /run all.");
      td.colSpan = 7;
      tr.appendChild(td);
      body.appendChild(tr);
      return;
    }
    jobs.forEach(function (j) {
      var tr = el("tr");
      tr.appendChild(el("td", "mono", j.job_id));
      tr.appendChild(el("td", "", j.studio));
      tr.appendChild(el("td", "", (j.status || "").replace(/_/g, " ")));
      tr.appendChild(el("td", "", j.stage || "—"));
      tr.appendChild(el("td", "", (Number(j.progress) || 0) + "%"));
      tr.appendChild(el("td", "", ago(j.updated_at)));
      tr.appendChild(el("td", "detail muted", j.detail || ""));
      body.appendChild(tr);
    });
  }

  function renderProviders(data) {
    var host = document.getElementById("providers");
    host.textContent = "";
    (data.providers || []).forEach(function (p) {
      var chip = el("span", "provider " + p.state);
      chip.textContent = p.name + " · " + p.state.replace(/_/g, " ");
      if (p.missing_env && p.missing_env.length) chip.title = "missing: " + p.missing_env.join(", ");
      host.appendChild(chip);
    });
    var note = document.getElementById("readiness-note");
    var explain = String(data.note || "").trim().replace(/[.;:,]\s*$/, "");
    note.textContent = (explain ? explain + ". " : "") +
      "Publishing enabled: " + (data.publishing_enabled ? "yes" : "no") + ".";
  }

  function renderReview(jobs) {
    var host = document.getElementById("review");
    host.textContent = "";
    var waiting = jobs.filter(function (j) {
      return j.status === "awaiting_approval" || j.status === "quality_review";
    });
    if (!waiting.length) { host.className = "muted"; host.textContent = "Nothing waiting."; return; }
    host.className = "";
    waiting.forEach(function (j) {
      var row = el("div", "row");
      row.appendChild(el("span", "mono", j.job_id));
      row.appendChild(el("span", "pill " + j.status, j.status.replace(/_/g, " ")));
      var hint = el("span", "muted", "next: /approve " + j.job_id);
      row.appendChild(hint);
      host.appendChild(row);
    });
  }

  function load() {
    var banner = document.getElementById("banner");
    getJson("/health").then(function (h) {
      var st = document.getElementById("hub-state");
      st.className = "pill complete";
      st.textContent = "hub " + (h.version || "ok");
      banner.style.display = "none";
    }).catch(function (e) {
      var st = document.getElementById("hub-state");
      st.className = "pill failed";
      st.textContent = "hub unreachable";
      banner.style.display = "block";
      banner.textContent = "Cannot reach the hub API: " + e.message;
    });

    getJson("/jobs?limit=50").then(function (d) {
      var jobs = d.jobs || [];
      renderStudios(jobs);
      renderJobs(jobs);
      renderReview(jobs);
    }).catch(function () {
      renderStudios([]);
      renderJobs([]);
    });

    getJson("/api-readiness").then(renderProviders).catch(function () {
      var host = document.getElementById("providers");
      host.textContent = "";
      host.appendChild(el("span", "provider not_configured", "readiness unavailable"));
    });
  }

  document.getElementById("refresh").addEventListener("click", load);
  load();
  setInterval(load, 20000);
})();
</script>
</body>
</html>`;
}
