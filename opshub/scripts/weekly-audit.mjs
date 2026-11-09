#!/usr/bin/env node
/**
 * Read-only weekly ecosystem audit.
 *
 * It performs GET requests only: no dispatches, renders, deployments, trades,
 * publishing or repository writes. Reports are written under artifacts/audits
 * locally and uploaded as a workflow artifact.
 */
import fs from "node:fs";
import path from "node:path";

const OWNER = "landryparadis012-git";
export const REPOS = [
  "opshub",
  "faceless-studio",
  "faceless-turkce-studio",
  "deep-history-studio",
  "business-flip-",
  "icc-engine",
];

function apiHeaders(token) {
  return {
    accept: "application/vnd.github+json",
    authorization: "Bearer " + token,
    "user-agent": "opshub-weekly-audit",
    "x-github-api-version": "2022-11-28",
  };
}

async function getJson(fetchImpl, url, headers, timeoutMs = 15000) {
  const res = await fetchImpl(url, { method: "GET", headers, signal: AbortSignal.timeout(timeoutMs) });
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
  return body;
}

export async function audit({ env = process.env, fetchImpl = fetch, previous = null, now = new Date() } = {}) {
  const token = String(env.GITHUB_TOKEN || "").trim();
  if (!token) throw new Error("GITHUB_TOKEN is required");
  const headers = apiHeaders(token);
  const startedAt = Math.floor(now.getTime() / 1000);
  const repos = [];

  for (const repo of REPOS) {
    const base = `https://api.github.com/repos/${OWNER}/${repo}`;
    const entry = { repo, ok: false, default_branch: null, head: null, open_prs: 0,
      failed_runs: 0, skipped_runs: 0, latest_runs: [], error: null };
    try {
      const info = await getJson(fetchImpl, base, headers);
      entry.default_branch = info.default_branch;
      entry.open_prs = (await getJson(fetchImpl, base + "/pulls?state=open&per_page=100", headers))
        .filter((pr) => !pr.draft).length;
      const runs = await getJson(fetchImpl,
        `${base}/actions/runs?per_page=10&branch=${encodeURIComponent(info.default_branch || "main")}`,
        headers);
      const list = runs.workflow_runs || [];
      entry.latest_runs = list.slice(0, 5).map((r) => ({
        workflow: r.name, conclusion: r.conclusion, status: r.status,
        head_sha: r.head_sha?.slice(0, 7), created_at: r.created_at, url: r.html_url,
      }));
      entry.failed_runs = list.filter((r) => r.conclusion === "failure").length;
      entry.skipped_runs = list.filter((r) => r.conclusion === "skipped").length;
      const commit = await getJson(fetchImpl, base + "/commits?per_page=1", headers);
      entry.head = commit[0] ? { sha: commit[0].sha.slice(0, 12), message: commit[0].commit?.message?.split("\n")[0] } : null;
      entry.ok = true;
    } catch (e) {
      entry.error = String(e.message || e).slice(0, 200);
    }
    repos.push(entry);
  }

  const hub = { ok: false, health: null, readiness: null, dashboard: null, error: null };
  const hubUrl = String(env.HUB_URL || "").trim().replace(/\/$/, "");
  if (hubUrl) {
    try {
      hub.health = await getJson(fetchImpl, hubUrl + "/health", { accept: "application/json" });
      hub.readiness = await getJson(fetchImpl, hubUrl + "/api-readiness", { accept: "application/json" });
      hub.dashboard = await getJson(fetchImpl, hubUrl + "/dashboard/data", { accept: "application/json" });
      hub.ok = hub.health?.ok === true;
    } catch (e) {
      hub.error = String(e.message || e).slice(0, 200);
    }
  }

  const critical = [];
  for (const r of repos) {
    if (!r.ok) critical.push(`${r.repo}: repository audit failed — ${r.error}`);
    if (r.failed_runs) critical.push(`${r.repo}: ${r.failed_runs} recent failed workflow run(s)`);
  }
  if (hubUrl && !hub.ok) critical.push(`hub: health unavailable — ${hub.error || "ok=false"}`);
  if (hub.health?.telegram?.last_error) critical.push(`telegram: ${hub.health.telegram.last_error}`);

  const changes = [];
  if (previous?.repos) {
    const before = new Map(previous.repos.map((r) => [r.repo, r]));
    for (const r of repos) {
      const old = before.get(r.repo);
      if (old && old.head?.sha !== r.head?.sha) changes.push(`${r.repo}: ${old.head?.sha || "?"} -> ${r.head?.sha || "?"}`);
      if (old && old.open_prs !== r.open_prs) changes.push(`${r.repo}: open PRs ${old.open_prs} -> ${r.open_prs}`);
      if (old && old.failed_runs !== r.failed_runs) changes.push(`${r.repo}: failed runs ${old.failed_runs} -> ${r.failed_runs}`);
    }
  }

  return {
    schema_version: "1.0",
    kind: "weekly_read_only_audit",
    generated_at: new Date(startedAt * 1000).toISOString(),
    read_only: true,
    repos, hub, changes, critical_failures: critical,
    summary: {
      repos: repos.length,
      healthy_repos: repos.filter((r) => r.ok).length,
      open_prs: repos.reduce((n, r) => n + r.open_prs, 0),
      failed_runs: repos.reduce((n, r) => n + r.failed_runs, 0),
      hub_healthy: hub.ok,
      providers: (hub.readiness?.providers || []).map((p) => ({ name: p.name, state: p.state })),
      publishing_enabled: hub.readiness?.publishing_enabled ?? null,
      approval_required: hub.readiness?.approval_required ?? null,
    },
  };
}

export function renderMarkdown(report) {
  const lines = [
    `# Weekly ecosystem audit — ${report.generated_at.slice(0, 10)}`,
    "",
    "Read-only: no dispatches, renders, deployments, trades or publishing.",
    "",
    "## Summary",
    `- Healthy repositories: ${report.summary.healthy_repos}/${report.summary.repos}`,
    `- Open PRs: ${report.summary.open_prs}`,
    `- Recent failed runs: ${report.summary.failed_runs}`,
    `- Hub healthy: ${report.summary.hub_healthy}`,
    `- publishing_enabled: ${report.summary.publishing_enabled}`,
    `- approval_required: ${report.summary.approval_required}`,
    "",
    "## Repositories",
    "| Repo | Branch | Head | Open PRs | Failed | Error |",
    "|---|---|---|---|---|---|",
    ...report.repos.map((r) => `| ${r.repo} | ${r.default_branch || "?"} | ${r.head?.sha || "?"} | ${r.open_prs} | ${r.failed_runs} | ${r.error || ""} |`),
    "",
    "## Changes since previous report",
    ...(report.changes.length ? report.changes.map((c) => `- ${c}`) : ["- No previous report or no changes."]),
    "",
    "## Critical failures",
    ...(report.critical_failures.length ? report.critical_failures.map((c) => `- ${c}`) : ["- None detected."]),
    "",
    "## Provider readiness",
    ...(report.summary.providers.length
      ? report.summary.providers.map((p) => `- ${p.name}: ${p.state}`)
      : ["- Hub readiness unavailable."]),
  ];
  return lines.join("\n") + "\n";
}

async function main() {
  const outDir = path.resolve("artifacts/audits");
  fs.mkdirSync(outDir, { recursive: true });
  const latestPath = path.join(outDir, "latest.json");
  let previous = null;
  try { previous = JSON.parse(fs.readFileSync(latestPath, "utf8")); } catch { /* first run */ }
  const report = await audit({ previous });
  const day = report.generated_at.slice(0, 10);
  fs.writeFileSync(path.join(outDir, `${day}.json`), JSON.stringify(report, null, 2) + "\n");
  fs.writeFileSync(latestPath, JSON.stringify(report, null, 2) + "\n");
  fs.writeFileSync(path.join(outDir, `${day}.md`), renderMarkdown(report));
  console.log(`audit complete: ${report.summary.healthy_repos}/${report.summary.repos} repos healthy, ` +
    `${report.critical_failures.length} critical finding(s)`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => { console.error("audit failed:", String(e.message || e).slice(0, 300)); process.exit(1); });
}
