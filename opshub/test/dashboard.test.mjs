/** Dashboard route: serves HTML, no secrets, no network. */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";

globalThis.fetch = async (url) => {
  throw new Error("network blocked in tests: " + url);
};

const app = (await import("../worker/index.js")).default;

function d1(sqlite) {
  return {
    prepare(sql) {
      const stmt = sqlite.prepare(sql);
      const make = (params) => ({
        bind: (...more) => make([...params, ...more]),
        run: async () => ({ meta: { changes: Number(stmt.run(...params).changes) } }),
        first: async () => {
          const row = stmt.get(...params);
          return row === undefined ? null : row;
        },
        all: async () => ({ results: stmt.all(...params) }),
      });
      return make([]);
    },
  };
}

describe("dashboard", () => {
  test("serves an HTML control surface with no secret values", async () => {
    const env = {
      DB: d1(new DatabaseSync(":memory:")),
      HUB_WEBHOOK_SECRET: "s3cret-value-must-not-appear",
      GROQ_API_KEY: "sk-also-must-not-appear",
    };
    const res = await app.request("/dashboard", {}, env);
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") || "", /text\/html/);
    const html = await res.text();
    for (const marker of ["OpsHub Control", "TrendScope", "True Crime", "Deep History",
                          "API readiness", "Awaiting review"]) {
      assert.ok(html.includes(marker), "missing marker: " + marker);
    }
    assert.ok(!html.includes("s3cret-value-must-not-appear"));
    assert.ok(!html.includes("sk-also-must-not-appear"));
  });

  test("dashboard performs no server-side fetches", async () => {
    const env = { DB: d1(new DatabaseSync(":memory:")), HUB_WEBHOOK_SECRET: "x" };
    const res = await app.request("/dashboard", {}, env);
    assert.equal(res.status, 200);
    await res.text();
  });
});
