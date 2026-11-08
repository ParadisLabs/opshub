#!/usr/bin/env node
/**
 * Provision the R2 bucket declared in wrangler.jsonc.
 *
 * Fails closed: without CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID it
 * prints what is missing and exits 2 without touching anything. It never
 * prints credential values, and it is safe to re-run (an existing bucket is
 * reported, not recreated).
 *
 *   CLOUDFLARE_API_TOKEN=... CLOUDFLARE_ACCOUNT_ID=... npm run provision:r2
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const need = ["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID"];
const missing = need.filter((name) => !process.env[name]);
if (missing.length) {
  console.error("Cannot provision R2: missing " + missing.join(", "));
  console.error("Set them in this shell or in Sites → Secrets, then re-run.");
  process.exit(2);
}

const config = readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8")
  .replace(/^\s*\/\/.*$/gm, "");
const bucket = (/\"bucket_name\"\s*:\s*\"([^\"]+)\"/.exec(config) || [])[1];
if (!bucket) {
  console.error("No bucket_name found in wrangler.jsonc");
  process.exit(1);
}
console.log("bucket from config:", bucket);

const wrangler = ["--yes", "wrangler@4"];
function run(args) {
  return execFileSync("npx", [...wrangler, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 120000,
  });
}

let created = false;
try {
  run(["r2", "bucket", "create", bucket]);
  created = true;
  console.log("created bucket", bucket);
} catch (e) {
  const out = String(e.stdout || "") + String(e.stderr || "");
  if (/already (exists|owned)|10004/i.test(out)) {
    console.log("bucket already exists:", bucket);
  } else {
    console.error("create failed:", out.split("\n").filter(Boolean).slice(-4).join("\n"));
    process.exit(1);
  }
}

try {
  const listed = run(["r2", "bucket", "list"]);
  const present = listed.split("\n").some((line) => line.includes(bucket));
  console.log(present ? "verified: bucket is listed" : "warning: bucket not visible in list yet");
} catch (e) {
  console.error("list failed:", String(e.stderr || e).split("\n")[0]);
  process.exit(1);
}

console.log(created ? "R2 provisioning complete" : "R2 provisioning already satisfied");
