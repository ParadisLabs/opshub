import { internalAction } from "./_generated/server";
import { v } from "convex/values";
import { internal } from "./_generated/api";

const ENGINES = {
  icc: {
    repo: "landryparadis012-git/icc-engine",
    eventType: "icc.run",
    label: "ICC Free Engine",
  },
  flip: {
    repo: "landryparadis012-git/business-flip-",
    eventType: "opshub.flip",
    label: "Business Flip",
  },
  benji: {
    repo: "",
    eventType: "",
    label: "Free Benji",
  },
} as const;

export const dispatchEngine = internalAction({
  args: { engineKey: v.string(), reason: v.optional(v.string()) },
  handler: async (_ctx, args) => {
    const key = args.engineKey.trim().toLowerCase() as keyof typeof ENGINES;
    const engine = ENGINES[key];
    if (!engine) return { ok: false, error: `Unknown engine: ${args.engineKey}` };
    if (!engine.repo || !engine.eventType) {
      return { ok: false, engine: key, error: "no Free Benji repository or workflow is connected" };
    }
    const token = process.env.OPSHUB_GITHUB_TOKEN || process.env.GITHUB_DISPATCH_TOKEN;
    if (!token) return { ok: false, engine: key, error: "OPSHUB_GITHUB_TOKEN is not set" };
    try {
      const response = await fetch(`https://api.github.com/repos/${engine.repo}/dispatches`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
          "Content-Type": "application/json",
          "User-Agent": "opshub",
          "X-GitHub-Api-Version": "2022-11-28",
        },
        body: JSON.stringify({
          event_type: engine.eventType,
          client_payload: { source: "opshub", reason: args.reason ?? "telegram command" },
        }),
      });
      const detail = response.status === 204 || response.ok
        ? `${engine.label} dispatch accepted by GitHub`
        : (await response.text()).slice(0, 300);
      return { ok: response.status === 204 || response.ok, engine: key, repo: engine.repo, status: response.status, detail };
    } catch (error: any) {
      return { ok: false, engine: key, error: String(error?.message ?? error).slice(0, 300) };
    }
  },
});

export const runAll = internalAction({
  args: {},
  handler: async (ctx) => {
    const targets = [
      ctx.runAction(internal.dispatch.runStudio, { studioKey: "english", reason: "telegram /run all" }),
      ctx.runAction(internal.dispatch.runStudio, { studioKey: "turkce", reason: "telegram /run all" }),
      ctx.runAction(internal.dispatch.runStudio, { studioKey: "history", reason: "telegram /run all" }),
      ctx.runAction(internal.engineDispatch.dispatchEngine, { engineKey: "icc", reason: "telegram /run all" }),
      ctx.runAction(internal.engineDispatch.dispatchEngine, { engineKey: "flip", reason: "telegram /run all" }),
      ctx.runAction(internal.engineDispatch.dispatchEngine, { engineKey: "benji", reason: "telegram /run all" }),
    ];
    const results = await Promise.all(targets);
    return { ok: results.every((result: any) => result?.ok), results };
  },
});
