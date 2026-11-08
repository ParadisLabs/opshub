/** Signed R2 routes: upload, read, checksum, list, delete, fail-closed. */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";

globalThis.fetch = async (url) => {
  throw new Error("network blocked in tests: " + url);
};

const app = (await import("../worker/index.js")).default;
const SECRET = "files-test-secret";

function fakeR2() {
  const store = new Map();
  return {
    async put(key, value, opts = {}) {
      const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
      store.set(key, { bytes: Uint8Array.from(bytes), opts });
      return { url: "mem://" + key };
    },
    async get(key) {
      const entry = store.get(key);
      if (!entry) return null;
      return {
        httpMetadata: entry.opts.httpMetadata,
        customMetadata: entry.opts.customMetadata,
        arrayBuffer: async () => entry.bytes.slice().buffer,
      };
    },
    async delete(key) {
      store.delete(key);
    },
    async list({ prefix = "", limit = 100 } = {}) {
      return {
        objects: [...store.keys()]
          .filter((k) => k.startsWith(prefix))
          .slice(0, limit)
          .map((k) => ({ key: k, size: store.get(k).bytes.byteLength, uploaded: null })),
      };
    },
    _size: () => store.size,
  };
}

const sha = (buf) => createHash("sha256").update(buf).digest("hex");
const sig = (method, key, body = Buffer.alloc(0)) =>
  "sha256=" + createHmac("sha256", SECRET)
    .update(method + "\n" + key + "\n" + sha(body)).digest("hex");

const bytes = Buffer.from("durable-bytes-" + "x".repeat(32));
const key = "media/demo/scene-1.bin";

async function call(method, path, env, { body, signature } = {}) {
  const headers = { "content-type": "application/octet-stream" };
  if (signature) headers["x-hub-signature-256"] = signature;
  return app.request(path, { method, headers, body }, env);
}

describe("R2 object routes", () => {
  test("unsigned upload is rejected", async () => {
    const env = { FILES: fakeR2(), HUB_WEBHOOK_SECRET: SECRET };
    const res = await call("POST", "/files/" + key, env, { body: bytes });
    assert.equal(res.status, 401);
  });

  test("missing secret fails closed", async () => {
    const env = { FILES: fakeR2(), HUB_WEBHOOK_SECRET: "" };
    const res = await call("POST", "/files/" + key, env, { body: bytes });
    assert.equal(res.status, 503);
    assert.deepEqual(await res.json(), { error: "hub misconfigured" });
  });

  test("upload stores checksummed bytes", async () => {
    const env = { FILES: fakeR2(), HUB_WEBHOOK_SECRET: SECRET };
    const res = await call("POST", "/files/" + key, env, {
      body: bytes, signature: sig("POST", key, bytes),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.stored, true);
    assert.equal(body.path, key);
    assert.equal(body.size, bytes.length);
    assert.equal(body.sha256, sha(bytes));
  });

  test("read returns bytes plus a verified checksum", async () => {
    const env = { FILES: fakeR2(), HUB_WEBHOOK_SECRET: SECRET };
    await call("POST", "/files/" + key, env, { body: bytes, signature: sig("POST", key, bytes) });
    const res = await call("GET", "/files/" + key, env, { signature: sig("GET", key) });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("x-content-sha256"), sha(bytes));
    assert.equal(res.headers.get("x-checksum-ok"), "true");
    const returned = Buffer.from(await res.arrayBuffer());
    assert.deepEqual(returned, bytes);
  });

  test("list only shows stored keys", async () => {
    const env = { FILES: fakeR2(), HUB_WEBHOOK_SECRET: SECRET };
    await call("POST", "/files/" + key, env, { body: bytes, signature: sig("POST", key, bytes) });
    const res = await call("GET", "/files?prefix=media/", env, { signature: sig("GET", "media/") });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.objects.length, 1);
    assert.equal(body.objects[0].key, key);
    assert.equal(body.objects[0].size, bytes.length);
  });

  test("delete removes the object and read then 404s", async () => {
    const env = { FILES: fakeR2(), HUB_WEBHOOK_SECRET: SECRET };
    await call("POST", "/files/" + key, env, { body: bytes, signature: sig("POST", key, bytes) });
    const del = await call("DELETE", "/files/" + key, env, { signature: sig("DELETE", key) });
    assert.equal(del.status, 200);
    assert.equal((await del.json()).deleted, true);
    const res = await call("GET", "/files/" + key, env, { signature: sig("GET", key) });
    assert.equal(res.status, 404);
  });

  test("deleting a missing object is a 404, not a silent success", async () => {
    const env = { FILES: fakeR2(), HUB_WEBHOOK_SECRET: SECRET };
    const res = await call("DELETE", "/files/media/none.bin", env, {
      signature: sig("DELETE", "media/none.bin"),
    });
    assert.equal(res.status, 404);
  });

  test("a wrong signature cannot overwrite an object", async () => {
    const env = { FILES: fakeR2(), HUB_WEBHOOK_SECRET: SECRET };
    const res = await call("POST", "/files/" + key, env, {
      body: bytes, signature: sig("POST", key, Buffer.from("other")),
    });
    assert.equal(res.status, 401);
    assert.equal(env.FILES._size(), 0);
  });
});
