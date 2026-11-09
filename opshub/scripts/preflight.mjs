#!/usr/bin/env node
/**
 * Deployment preflight for OpsHub.
 *
 * Read-only: inspects config, bindings, tracked files and environment NAMES.
 * Never prints secret values. Exit code 1 only when a FAIL is recorded.
 *
 * Run from the opshub directory: npm run preflight
 */
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const results = [];
const add = (level, name, detail = "") =>
  results.push({ level, name, detail: String(detail).slice(0, 200) });
const pass = (n, d = "") => add("PASS", n, d);
const warn = (n, d = "") => add("WARN", n, d);
const fail = (n, d = "") => add("FAIL", n, d);

function readJsonc(file) {
  const raw = fs.readFileSync(file, "utf8");
  return JSON.parse(
    raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1")
  );
}

// ---- config ---------------------------------------------------------------
let cfg = null;
try {
  cfg = readJsonc("wrangler.jsonc");
  pass("wrangler.jsonc parses");
} catch (e) {
  fail("wrangler.jsonc parses", e.message);
}

if (cfg) {
  if (cfg.main && fs.existsSync(cfg.main)) pass("worker entry", cfg.main);
  else fail("worker entry", cfg.main || "missing");

  const d1 = (cfg.d1_databases || [])[0];
  if (d1 && d1.binding) {
    pass("D1 binding", d1.binding);
    if (!String(d1.database_id || "").trim()) {
      if (String(process.env.D1_DATABASE_ID || "").trim()) {
        pass("D1 database id", "injected from D1_DATABASE_ID at deploy time");
      } else {
        fail("D1 database id", "empty in wrangler.jsonc and D1_DATABASE_ID is not set");
      }
    } else {
      pass("D1 database id", "configured");
    }
  } else fail("D1 binding", "no d1_databases entry");

  const r2 = (cfg.r2_buckets || [])[0];
  if (r2 && r2.binding) {
    pass("R2 binding", `${r2.binding} → ${r2.bucket_name || "?"}`);
    if (!r2.bucket_name) warn("R2 bucket name", "binding present but bucket_name empty");
  } else {
    warn("R2 binding", "absent; renders will not be durable");
  }

  if (!cfg.compatibility_date) warn("compatibility_date", "missing");
  else pass("compatibility_date", cfg.compatibility_date);
}

for (const [file, label] of [["deploy.sites.json", "sites manifest"], ["manifest.json", "worker manifest"]]) {
  try {
    const m = JSON.parse(fs.readFileSync(file, "utf8"));
    const mod = (m.modules || [])[0];
    if (!mod || !mod.path) fail(label, "no module path");
    else if (fs.existsSync(mod.path)) pass(label, mod.path);
    else warn(label, `${mod.path} not built yet`);
  } catch (e) {
    warn(label, e.message);
  }
}

if (fs.existsSync("package-lock.json")) pass("lockfile present");
else fail("lockfile present", "npm ci requires package-lock.json");

for (const f of ["worker/index.js", "worker/productions.js", "worker/dashboard.js"]) {
  if (fs.existsSync(f)) pass("module", f);
  else fail("module", `${f} missing`);
}

// ---- secret hygiene -------------------------------------------------------
const SECRET_RE =
  /(sk-[A-Za-z0-9]{20,}|ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[0-9A-Z]{16}|\b\d{8,10}:AA[A-Za-z0-9_-]{30,})/;

let tracked = [];
try {
  tracked = execFileSync("git", ["ls-files"], { encoding: "utf8" })
    .split("\n")
    .filter(Boolean);
} catch {
  warn("secret scan", "git ls-files unavailable");
}

const skip = /(^|\/)(node_modules|dist|\.wrangler)\/|package-lock\.json$|\.(png|jpg|jpeg|gif|mp4|mp3|wav|zip|db)$|(^|\/)\.env/;
let scanned = 0;
const hits = [];
for (const rel of tracked) {
  if (skip.test(rel)) continue;
  let stat;
  try { stat = fs.statSync(rel); } catch { continue; }
  if (!stat.isFile() || stat.size > 1_000_000) continue;
  let text;
  try { text = fs.readFileSync(rel, "utf8"); } catch { continue; }
  scanned += 1;
  if (SECRET_RE.test(text)) hits.push(rel);
}
if (hits.length) fail("secret scan", `possible secrets in: ${hits.join(", ")}`);
else pass("secret scan", `${scanned} tracked files clean`);

// ---- environment (names only) --------------------------------------------
const REQUIRED = [
  "HUB_WEBHOOK_SECRET", "TELEGRAM_BOT_TOKEN", "TELEGRAM_CHAT_ID", "HUB_GITHUB_TOKEN",
  "GROQ_API_KEY", "GEMINI_API_KEY", "CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_API_TOKEN",
];
const missing = REQUIRED.filter((k) => !String(process.env[k] || "").trim());
if (missing.length) warn("environment", `not set here: ${missing.join(", ")}`);
else pass("environment", "all expected names present");

// ---- report ---------------------------------------------------------------
const width = Math.max(...results.map((r) => r.name.length));
for (const r of results) {
  const mark = r.level === "PASS" ? "✔" : r.level === "WARN" ? "!" : "✖";
  console.log(`${mark} ${r.level.padEnd(4)} ${r.name.padEnd(width)}  ${r.detail}`);
}
const counts = results.reduce((a, r) => ((a[r.level] = (a[r.level] || 0) + 1), a), {});
console.log(
  `\n${counts.PASS || 0} pass · ${counts.WARN || 0} warn · ${counts.FAIL || 0} fail` +
    `\nDeployment readiness: ${counts.FAIL ? "BLOCKED" : counts.WARN ? "READY WITH WARNINGS" : "READY"}`
);
process.exit(counts.FAIL ? 1 : 0);
