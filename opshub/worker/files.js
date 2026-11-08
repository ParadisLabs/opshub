/**
 * Signed object storage routes on the FILES (R2) binding.
 *
 * Contract: every operation is HMAC-signed over
 *   "<METHOD>\n<path>\n<sha256(body)>"
 * so uploads, reads, listings and deletes all fail closed without
 * HUB_WEBHOOK_SECRET. Object bytes are returned as-is; checksums are verified
 * on read and surfaced in headers rather than hidden.
 */

async function sha256Hex(bytes) {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function objectPath(url) {
  const path = new URL(url).pathname.replace(/^\/files\/?/, "");
  try {
    return decodeURIComponent(path);
  } catch (e) {
    return path;
  }
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

export function registerFileRoutes(app, deps) {
  const { verifySignature, HTTP_UNAVAILABLE } = deps;

  async function authorize(ctx, bytes, key) {
    const secret = ctx.env.HUB_WEBHOOK_SECRET;
    if (!secret) return { error: json(HTTP_UNAVAILABLE, 503) };
    if (!ctx.env.FILES) return { error: json({ error: "FILES binding not configured" }, 503) };
    const bodyHash = await sha256Hex(bytes);
    const canonical = `${ctx.req.method}\n${key}\n${bodyHash}`;
    const header = ctx.req.header("x-hub-signature-256") || "";
    const ok = await verifySignature(canonical, header, secret);
    if (!ok) return { error: json({ error: "invalid signature" }, 401) };
    return { bodyHash };
  }

  async function upload(ctx) {
    const key = objectPath(ctx.req.url);
    if (!key) return json({ error: "object path required" }, 400);
    const bytes = new Uint8Array(await ctx.req.arrayBuffer());
    const auth = await authorize(ctx, bytes, key);
    if (auth.error) return auth.error;
    const contentType = ctx.req.header("content-type") || "application/octet-stream";
    try {
      await ctx.env.FILES.put(key, bytes, {
        httpMetadata: { contentType },
        customMetadata: { sha256: auth.bodyHash },
      });
      return json({ stored: true, path: key, sha256: auth.bodyHash, size: bytes.byteLength });
    } catch (e) {
      return json({ error: "store failed: " + String(e).slice(0, 160) }, 500);
    }
  }

  app.post("/files/*", upload);
  app.put("/files/*", upload);

  // Registered before the /files/* wildcard: otherwise a listing request can be
  // matched with an empty object path and answered as a 400.
  async function listObjects(ctx) {
    const prefix = ctx.req.query("prefix") || "";
    const auth = await authorize(ctx, new Uint8Array(0), prefix);
    if (auth.error) return auth.error;
    try {
      const listed = await ctx.env.FILES.list({ prefix, limit: 100 });
      return json({
        prefix,
        objects: (listed.objects || []).map((o) => ({
          key: o.key, size: o.size, uploaded: o.uploaded || null,
        })),
      });
    } catch (e) {
      return json({ error: "list failed: " + String(e).slice(0, 160) }, 500);
    }
  }

  app.get("/files", listObjects);

  app.get("/files/*", async (ctx) => {
    const key = objectPath(ctx.req.url);
    if (!key) return json({ error: "object path required" }, 400);
    const auth = await authorize(ctx, new Uint8Array(0), key);
    if (auth.error) return auth.error;
    try {
      const obj = await ctx.env.FILES.get(key);
      if (!obj) return json({ error: "not found" }, 404);
      const bytes = new Uint8Array(await obj.arrayBuffer());
      const actual = await sha256Hex(bytes);
      const expected = (obj.customMetadata && obj.customMetadata.sha256) || "";
      return new Response(bytes, {
        headers: {
          "content-type": (obj.httpMetadata && obj.httpMetadata.contentType) || "application/octet-stream",
          "content-length": String(bytes.byteLength),
          "x-content-sha256": actual,
          "x-checksum-ok": expected ? String(expected === actual) : "unknown",
          "cache-control": "no-store",
        },
      });
    } catch (e) {
      return json({ error: "read failed: " + String(e).slice(0, 160) }, 500);
    }
  });

  app.delete("/files/*", async (ctx) => {
    const key = objectPath(ctx.req.url);
    if (!key) return json({ error: "object path required" }, 400);
    const auth = await authorize(ctx, new Uint8Array(0), key);
    if (auth.error) return auth.error;
    try {
      const existing = await ctx.env.FILES.get(key);
      if (!existing) return json({ error: "not found" }, 404);
      await ctx.env.FILES.delete(key);
      return json({ deleted: true, path: key });
    } catch (e) {
      return json({ error: "delete failed: " + String(e).slice(0, 160) }, 500);
    }
  });

  app.get("/files/", listObjects);
}
