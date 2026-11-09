#!/usr/bin/env node
/**
 * Deploy the Cloudflare Worker with the D1 id and R2 bucket supplied at deploy
 * time. Committed wrangler.jsonc intentionally keeps database_id empty: no
 * resource id is invented or checked in.
 *
 * Required names: D1_DATABASE_ID, CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID
 * Optional:       R2_BUCKET_NAME (default: files)
 * Usage:          node scripts/deploy-worker.mjs [--dry-run]
 */
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

function readJsonc(file) {
  return JSON.parse(
    fs.readFileSync(file, "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|[^:])\/\/.*$/gm, "$1")
  );
}

const dryRun = process.argv.includes("--dry-run");
const databaseId = String(process.env.D1_DATABASE_ID || "").trim();
const bucket = String(process.env.R2_BUCKET_NAME || "files").trim();
if (!databaseId) {
  console.error("D1_DATABASE_ID is required. Create/select the database with: npx wrangler@4 d1 create opshub");
  process.exit(1);
}
if (!process.env.CLOUDFLARE_API_TOKEN || !process.env.CLOUDFLARE_ACCOUNT_ID) {
  console.error("CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID are required in the deploy environment.");
  process.exit(1);
}

const src = "wrangler.jsonc";
const out = ".wrangler.deploy.jsonc";
const cfg = readJsonc(src);
if (!cfg.d1_databases || !cfg.d1_databases[0]) throw new Error("wrangler.jsonc has no D1 binding");
cfg.d1_databases[0].database_id = databaseId;
if (!cfg.r2_buckets || !cfg.r2_buckets[0]) throw new Error("wrangler.jsonc has no R2 binding");
cfg.r2_buckets[0].bucket_name = bucket;
fs.writeFileSync(out, JSON.stringify(cfg, null, 2) + "\n", { mode: 0o600 });

try {
  const args = ["--yes", "wrangler@4", "deploy", "--config", path.resolve(out)];
  if (dryRun) args.push("--dry-run", "--outdir", "/tmp/opshub-worker-dry-run");
  const result = spawnSync("npx", args, { stdio: "inherit", env: process.env });
  process.exit(result.status === null ? 1 : result.status);
} finally {
  try { fs.unlinkSync(out); } catch { /* already removed */ }
}
