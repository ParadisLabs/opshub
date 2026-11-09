import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { audit, renderMarkdown, REPOS } from "../scripts/weekly-audit.mjs";

const now = new Date("2026-11-09T06:00:00Z");

function fakeFetch({ failRepo = null } = {}) {
  const calls = [];
  const fn = async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method || "GET" });
    if (String(url).includes("/hub.example/health")) {
      return { ok: true, status: 200, json: async () => ({
        ok: true, telegram: { url: "https://hub.example/telegram", pending: 0, last_error: null },
      }) };
    }
    if (String(url).includes("/hub.example/api-readiness")) {
      return { ok: true, status: 200, json: async () => ({
        publishing_enabled: false, approval_required: true,
        providers: [{ name: "gemini", state: "configured" }, { name: "pixabay", state: "not_configured" }],
      }) };
    }
    if (String(url).includes("/hub.example/dashboard/data")) {
      return { ok: true, status: 200, json: async () => ({ jobs: [] }) };
    }
    const repo = REPOS.find((r) => String(url).includes(`/repos/landryparadis012-git/${r}`));
    if (!repo) throw new Error("unexpected url " + url);
    if (repo === failRepo) throw new Error("simulated API outage");
    if (String(url).endsWith(`/${repo}`)) {
      return { ok: true, status: 200, json: async () => ({ default_branch: "main" }) };
    }
    if (String(url).includes("/pulls?")) {
      return { ok: true, status: 200, json: async () => (repo === "opshub" ? [{ draft: false }, { draft: true }] : []) };
    }
    if (String(url).includes("/actions/runs?")) {
      return { ok: true, status: 200, json: async () => ({ workflow_runs: [
        { name: "CI", conclusion: repo === "opshub" ? "failure" : "success", status: "completed", head_sha: "abcdef123456", html_url: "u" },
        { name: "Old", conclusion: "skipped", status: "completed", head_sha: "abcdef123456" },
      ] }) };
    }
    if (String(url).includes("/commits?")) {
      return { ok: true, status: 200, json: async () => [{ sha: "abcdef1234567890", commit: { message: "head\nbody" } }] };
    }
    throw new Error("unhandled " + url);
  };
  return { fn, calls };
}

describe("weekly read-only audit", () => {
  test("covers six repos, uses GET only and flags failures", async () => {
    const { fn, calls } = fakeFetch();
    const report = await audit({
      env: { GITHUB_TOKEN: "t", HUB_URL: "https://hub.example" },
      fetchImpl: fn, now,
    });
    assert.equal(report.repos.length, 6);
    assert.equal(report.read_only, true);
    assert.ok(calls.every((c) => c.method === "GET"));
    assert.equal(report.summary.hub_healthy, true);
    assert.equal(report.summary.publishing_enabled, false);
    assert.equal(report.summary.approval_required, true);
    assert.equal(report.summary.providers.find((p) => p.name === "pixabay").state, "not_configured");
    assert.equal(report.summary.open_prs, 1, "draft PRs do not count");
    assert.ok(report.critical_failures.some((c) => c.includes("opshub") && c.includes("failed")));
    assert.match(renderMarkdown(report), /publishing_enabled: false/);
  });

  test("isolates a repository API failure and still reports the rest", async () => {
    const { fn } = fakeFetch({ failRepo: "icc-engine" });
    const report = await audit({
      env: { GITHUB_TOKEN: "t", HUB_URL: "https://hub.example" },
      fetchImpl: fn, now,
    });
    assert.equal(report.summary.healthy_repos, 5);
    const icc = report.repos.find((r) => r.repo === "icc-engine");
    assert.equal(icc.ok, false);
    assert.match(icc.error, /outage/);
  });

  test("compares against the previous report", async () => {
    const { fn } = fakeFetch();
    const previous = { repos: [
      { repo: "opshub", head: { sha: "000000000000" }, open_prs: 0, failed_runs: 0 },
    ] };
    const report = await audit({
      env: { GITHUB_TOKEN: "t", HUB_URL: "https://hub.example" },
      fetchImpl: fn, previous, now,
    });
    assert.ok(report.changes.some((c) => c.startsWith("opshub:")));
  });

  test("requires a GitHub token", async () => {
    await assert.rejects(audit({ env: {}, fetchImpl: fakeFetch().fn, now }), /GITHUB_TOKEN/);
  });
});
