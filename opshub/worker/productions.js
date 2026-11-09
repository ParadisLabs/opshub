/**
 * Production job contract routes (schema_version 1.0).
 *
 * Registered onto the existing Hono app so the hub keeps one worker/one D1.
 * Contract rules:
 *  - creating a job is idempotent on job_id
 *  - a successful GitHub dispatch is NOT a production
 *  - approval never enables publishing by itself
 *  - cancelled is final
 */

const STUDIO_CANON = {
  english: "trendscope", trendscope: "trendscope", trend: "trendscope", faceless: "trendscope",
  turkce: "true-crime", "türkçe": "true-crime", truecrime: "true-crime",
  "true-crime": "true-crime", true_crime: "true-crime",
  history: "deep-history", "deep-history": "deep-history",
  deep_history: "deep-history", deephistory: "deep-history",
};

export const STUDIO_REPO = {
  trendscope: "faceless-studio",
  "true-crime": "faceless-turkce-studio",
  "deep-history": "deep-history-studio",
};

const JOB_STATUSES = new Set(["dispatched", "accepted", "running", "quality_review",
  "awaiting_approval", "approved", "blocked", "failed", "cancelled", "complete"]);
const JOB_STAGES = new Set(["research", "verification", "writing", "preproduction",
  "assets", "rendering", "qa", "approval", "publishing", "done"]);
export const TERMINAL_JOBS = new Set(["complete", "cancelled"]);

const nowSec = () => Math.floor(Date.now() / 1000);

export function canonStudio(value) {
  return STUDIO_CANON[String(value || "").trim().toLowerCase()] || null;
}

async function getProduction(db, jobId) {
  const row = await db.prepare("SELECT * FROM productions WHERE job_id = ?").bind(jobId).first();
  if (!row) return null;
  let qa = {};
  try { qa = JSON.parse(row.qa || "{}"); } catch (e) { qa = {}; }
  return { ...row, qa };
}

export async function createProduction(db, p) {
  const existing = await getProduction(db, p.job_id);
  if (existing) return { created: false, job: existing };
  const now = nowSec();
  await db.prepare(
    "INSERT INTO productions (job_id, studio, topic, status, stage, progress, detail, output, qa, approved_at, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)"
  ).bind(
    p.job_id,
    p.studio,
    String(p.topic || "").slice(0, 300),
    JOB_STATUSES.has(p.status) ? p.status : "dispatched",
    JOB_STAGES.has(p.stage) ? p.stage : "research",
    Math.max(0, Math.min(100, Number(p.progress) || 0)),
    String(p.detail || "").slice(0, 2000),
    String(p.output || "").slice(0, 500),
    JSON.stringify(p.qa || {}),
    null, now, now
  ).run();
  return { created: true, job: await getProduction(db, p.job_id) };
}

export async function updateProduction(db, jobId, patch) {
  const cur = await getProduction(db, jobId);
  if (!cur) return null;
  const status = JOB_STATUSES.has(patch.status) ? patch.status : cur.status;
  const stage = JOB_STAGES.has(patch.stage) ? patch.stage : cur.stage;
  const progress = patch.progress === undefined
    ? cur.progress
    : Math.max(0, Math.min(100, Number(patch.progress) || 0));
  await db.prepare(
    "UPDATE productions SET status=?, stage=?, progress=?, detail=?, output=?, qa=?, approved_at=?, updated_at=? WHERE job_id=?"
  ).bind(
    status, stage, progress,
    String(patch.detail === undefined ? cur.detail : patch.detail).slice(0, 2000),
    String(patch.output === undefined ? cur.output : patch.output).slice(0, 500),
    JSON.stringify(patch.qa === undefined ? cur.qa : patch.qa || {}),
    patch.approved_at === undefined ? cur.approved_at : patch.approved_at,
    nowSec(), jobId
  ).run();
  return getProduction(db, jobId);
}

export { getProduction };

const READINESS_PROVIDERS = [
  ["groq", ["GROQ_API_KEY"]],
  ["gemini", ["GEMINI_API_KEY"]],
  ["cloudflare-ai", ["CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_API_TOKEN"]],
  ["pixabay", ["PIXABAY_API_KEY"]],
  ["wikimedia", []],
  ["internet-archive", []],
  ["wikipedia", []],
  ["youtube", ["YOUTUBE_CLIENT_ID", "YOUTUBE_CLIENT_SECRET", "YOUTUBE_REFRESH_TOKEN"]],
  ["tiktok", ["TIKTOK_CLIENT_KEY", "TIKTOK_CLIENT_SECRET", "TIKTOK_REFRESH_TOKEN"]],
  ["meta", ["META_APP_ID", "META_APP_SECRET", "META_ACCESS_TOKEN"]],
  ["opshub", ["HUB_URL", "HUB_WEBHOOK_SECRET"]],
];

const EMPTY_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

export function registerProductionRoutes(app, deps) {
  const { ensureTables, recordJob, verifySignature, dispatchGitHub, HTTP_UNAVAILABLE } = deps;

  // Read routes are signed over GET + path + sha256(empty body); the detail
  // fields (output paths, if any) must not be public.
  async function readSignedGet(ctx, key) {
    const secret = ctx.env.HUB_WEBHOOK_SECRET;
    if (!secret) return ctx.json(HTTP_UNAVAILABLE, 503);
    const canonical = `GET\n${key}\n${EMPTY_SHA256}`;
    const ok = await verifySignature(canonical, ctx.req.header("x-hub-signature-256") || "", secret);
    return ok ? null : ctx.json({ error: "invalid signature" }, 401);
  }

  async function readSigned(ctx) {
    const raw = await ctx.req.text();
    const secret = ctx.env.HUB_WEBHOOK_SECRET;
    if (!secret) return { error: ctx.json(HTTP_UNAVAILABLE, 503) };
    const ok = await verifySignature(raw, ctx.req.header("x-hub-signature-256") || "", secret);
    if (!ok) return { error: ctx.json({ error: "invalid signature" }, 401) };
    try {
      return { body: JSON.parse(raw) };
    } catch (e) {
      return { error: ctx.json({ error: "bad json" }, 400) };
    }
  }

  app.get("/jobs", async (ctx) => {
    if (!ctx.env.DB) return ctx.json({ jobs: [] });
    const auth = await readSignedGet(ctx, "/jobs");
    if (auth) return auth;
    try {
      await ensureTables(ctx.env.DB);
      const limit = Math.min(Number(ctx.req.query("limit")) || 25, 100);
      const r = await ctx.env.DB
        .prepare("SELECT job_id, studio, topic, status, stage, progress, detail, output, created_at, updated_at FROM productions ORDER BY updated_at DESC LIMIT ?")
        .bind(limit)
        .all();
      return ctx.json({ jobs: r.results || [] });
    } catch (e) {
      return ctx.json({ error: String(e).slice(0, 200) }, 500);
    }
  });

  app.get("/jobs/:id", async (ctx) => {
    if (!ctx.env.DB) return ctx.json({ error: "No DB" }, 500);
    const auth = await readSignedGet(ctx, `/jobs/${ctx.req.param("id")}`);
    if (auth) return auth;
    try {
      await ensureTables(ctx.env.DB);
      const job = await getProduction(ctx.env.DB, ctx.req.param("id"));
      if (!job) return ctx.json({ error: "unknown job" }, 404);
      return ctx.json({ job });
    } catch (e) {
      return ctx.json({ error: String(e).slice(0, 200) }, 500);
    }
  });

  app.post("/jobs", async (ctx) => {
    if (!ctx.env.DB) return ctx.json({ error: "No DB" }, 500);
    const signed = await readSigned(ctx);
    if (signed.error) return signed.error;
    const body = signed.body || {};
    const jobId = String(body.job_id || "").trim();
    const studio = canonStudio(body.studio);
    if (!jobId) return ctx.json({ error: "job_id required" }, 400);
    if (!studio) return ctx.json({ error: "unknown studio" }, 400);
    if (body.schema_version && String(body.schema_version) !== "1.0")
      return ctx.json({ error: "unsupported schema_version" }, 400);
    try {
      await ensureTables(ctx.env.DB);
      const r = await createProduction(ctx.env.DB, {
        job_id: jobId, studio, topic: body.topic, status: body.status || "dispatched",
        stage: body.stage, progress: body.progress, detail: body.detail,
        qa: body.qa, output: body.output,
      });
      return ctx.json({ status: r.created ? "accepted" : "duplicate", created: r.created, job: r.job });
    } catch (e) {
      return ctx.json({ error: String(e).slice(0, 200) }, 500);
    }
  });

  app.post("/jobs/:id/status", async (ctx) => {
    if (!ctx.env.DB) return ctx.json({ error: "No DB" }, 500);
    const signed = await readSigned(ctx);
    if (signed.error) return signed.error;
    const body = signed.body || {};
    const jobId = ctx.req.param("id");
    try {
      await ensureTables(ctx.env.DB);
      const cur = await getProduction(ctx.env.DB, jobId);
      if (!cur) return ctx.json({ error: "unknown job" }, 404);
      const next = String(body.status || cur.status);
      if (cur.status === "cancelled" && next !== "cancelled")
        return ctx.json({ error: "cancelled jobs are final" }, 409);
      if (body.status && !JOB_STATUSES.has(next))
        return ctx.json({ error: "unknown status" }, 400);
      if (body.stage && !JOB_STAGES.has(String(body.stage)))
        return ctx.json({ error: "unknown stage" }, 400);
      const job = await updateProduction(ctx.env.DB, jobId, {
        status: next, stage: body.stage, progress: body.progress,
        detail: body.detail, output: body.output, qa: body.qa,
      });
      await recordJob(ctx.env.DB, {
        job_id: `production:${jobId}:${next}`, service: job.studio,
        kind: "production_status", status: next,
        detail: `stage=${job.stage} progress=${job.progress}% ${String(body.detail || "").slice(0, 200)}`,
      });
      return ctx.json({ status: "ok", job });
    } catch (e) {
      return ctx.json({ error: String(e).slice(0, 200) }, 500);
    }
  });

  app.post("/jobs/:id/approve", async (ctx) => {
    if (!ctx.env.DB) return ctx.json({ error: "No DB" }, 500);
    const signed = await readSigned(ctx);
    if (signed.error) return signed.error;
    try {
      await ensureTables(ctx.env.DB);
      const cur = await getProduction(ctx.env.DB, ctx.req.param("id"));
      if (!cur) return ctx.json({ error: "unknown job" }, 404);
      if (!["quality_review", "awaiting_approval"].includes(cur.status))
        return ctx.json({ error: `cannot approve while ${cur.status}` }, 409);
      const qa = cur.qa || {};
      if (qa.verdict !== "pass" || (Array.isArray(qa.blocking_failures) && qa.blocking_failures.length)) {
        return ctx.json({ error: `QA is ${qa.verdict || "missing"}; empty or blocked QA cannot pass` }, 409);
      }
      if (qa.synthetic === true || qa.publishable === false) {
        return ctx.json({ error: "synthetic fixtures cannot be approved for publishing" }, 409);
      }
      const job = await updateProduction(ctx.env.DB, cur.job_id, {
        status: "approved", approved_at: nowSec(), detail: "approved",
      });
      return ctx.json({ status: "approved", job, publishing_enabled: false });
    } catch (e) {
      return ctx.json({ error: String(e).slice(0, 200) }, 500);
    }
  });

  app.post("/jobs/:id/cancel", async (ctx) => {
    if (!ctx.env.DB) return ctx.json({ error: "No DB" }, 500);
    const signed = await readSigned(ctx);
    if (signed.error) return signed.error;
    try {
      await ensureTables(ctx.env.DB);
      const cur = await getProduction(ctx.env.DB, ctx.req.param("id"));
      if (!cur) return ctx.json({ error: "unknown job" }, 404);
      if (cur.status === "complete") return ctx.json({ error: "already complete" }, 409);
      const job = await updateProduction(ctx.env.DB, cur.job_id, {
        status: "cancelled", detail: "cancelled",
      });
      return ctx.json({ status: "cancelled", job });
    } catch (e) {
      return ctx.json({ error: String(e).slice(0, 200) }, 500);
    }
  });

  app.post("/jobs/:id/retry", async (ctx) => {
    if (!ctx.env.DB) return ctx.json({ error: "No DB" }, 500);
    const signed = await readSigned(ctx);
    if (signed.error) return signed.error;
    try {
      await ensureTables(ctx.env.DB);
      const cur = await getProduction(ctx.env.DB, ctx.req.param("id"));
      if (!cur) return ctx.json({ error: "unknown job" }, 404);
      if (TERMINAL_JOBS.has(cur.status))
        return ctx.json({ error: `cannot retry while ${cur.status}` }, 409);
      const job = await updateProduction(ctx.env.DB, cur.job_id, {
        status: "accepted", stage: "research", progress: 0,
        detail: "retry requested",
      });
      return ctx.json({ status: "retry_requested", job });
    } catch (e) {
      return ctx.json({ error: String(e).slice(0, 200) }, 500);
    }
  });

  app.post("/dispatch", async (ctx) => {
    if (!ctx.env.DB) return ctx.json({ error: "No DB" }, 500);
    const signed = await readSigned(ctx);
    if (signed.error) return signed.error;
    const body = signed.body || {};
    const studio = canonStudio(body.studio);
    const jobId = String(body.job_id || "").trim();
    if (!studio) return ctx.json({ error: "unknown studio" }, 400);
    if (!jobId) return ctx.json({ error: "job_id required" }, 400);
    if (body.format && !["short", "documentary"].includes(body.format))
      return ctx.json({ error: "unknown format" }, 400);
    const token = ctx.env.HUB_GITHUB_TOKEN;
    if (!token) return ctx.json({ error: "HUB_GITHUB_TOKEN not configured" }, 400);
    try {
      await ensureTables(ctx.env.DB);
      const created = await createProduction(ctx.env.DB, {
        job_id: jobId, studio, topic: body.topic, status: "dispatched", stage: "research",
        detail: `dispatch requested by ${body.requested_by || "api"}`,
      });
      let ok = false;
      try {
        ok = await dispatchGitHub(token, STUDIO_REPO[studio], "opshub.produce", {
          schema_version: "1.0", event: "opshub.produce", job_id: jobId, studio,
          topic: body.topic || "", language: studio === "true-crime" ? "tr" : "en",
          format: body.format || "short", requested_by: body.requested_by || "api",
          production_mode: body.production_mode || "test", approval_required: true,
        });
      } catch (e) { ok = false; }
      await recordJob(ctx.env.DB, {
        job_id: `dispatch:${jobId}`, service: STUDIO_REPO[studio],
        kind: "repository_dispatch", status: ok ? "dispatched" : "dispatch_failed",
        detail: `${jobId} (${created.created ? "new" : "duplicate"})`,
      });
      return ctx.json({
        status: ok ? "dispatched" : "dispatch_failed", created: created.created,
        job_id: jobId, accepted: false,
        note: "dispatch is not a production; wait for studio status updates",
      });
    } catch (e) {
      return ctx.json({ error: String(e).slice(0, 200) }, 500);
    }
  });

  app.get("/api-readiness", async (ctx) => {
    const providers = READINESS_PROVIDERS.map(([name, keys]) => {
      const missing = keys.filter((k) => !String(ctx.env[k] || "").trim());
      return {
        name,
        required_env: keys,
        missing_env: missing,
        state: missing.length ? "not_configured" : "configured",
      };
    });
    return ctx.json({
      verified: false,
      providers,
      configured: providers.filter((p) => p.state === "configured").map((p) => p.name),
      operational: [],
      publishing_enabled: false,
      approval_required: true,
      storage: { d1: Boolean(ctx.env.DB), r2: Boolean(ctx.env.FILES) },
      retention: { days: Number(ctx.env.RETENTION_DAYS || 90), preserve_approved: true },
      note: "state reflects credential presence only; run provider checks to verify connectivity",
    });
  });
}
