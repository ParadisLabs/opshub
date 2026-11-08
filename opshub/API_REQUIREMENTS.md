# API & Credentials Requirements — API-Integration Checkpoint

Status: the offline build phase is complete for the shared infrastructure.
Nothing below is required to build, test, or run mock productions. These are the
exact values needed to leave mock mode. **Do not paste secrets into chat or code.**

## Where each value goes

| Location | Used by | Notes |
| --- | --- | --- |
| GitHub Actions secrets (per studio repo) | studio workflows | production pipelines |
| Sites → Secrets (OpsHub preview + production) | OpsHub worker | hub runtime |
| GitHub Actions secrets (`opshub` repo) | hub deploy workflow | deploy only |

`HUB_WEBHOOK_SECRET` must be the **same value** in OpsHub and in every studio.

## Required to run real productions

| Variable | Provider | Purpose / scope | Required by |
| --- | --- | --- | --- |
| `GROQ_API_KEY` | Groq | chat completions; no special scope | writing stage |
| `GEMINI_API_KEY` | Google AI | backup reasoning; generateContent | writing fallback |
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare | account id (not a secret, but keep private) | images |
| `CLOUDFLARE_API_TOKEN` | Cloudflare | Workers AI: Read + Edit (free tier) | images |
| `TELEGRAM_BOT_TOKEN` | Telegram (BotFather) | one bot may serve all studios | delivery |
| `TELEGRAM_CHAT_ID` | Telegram | numeric chat id | delivery |
| `HUB_URL` | OpsHub | `https://<hub-host>` | event feed + job status |
| `HUB_WEBHOOK_SECRET` | OpsHub | HMAC key for `/ingest`, `/jobs` | auth |
| `HUB_GITHUB_TOKEN` | GitHub | classic PAT with `repo` (or fine-grained: Contents read/write + Actions read/write) | dispatch + status |

## Required only for stock media

| Variable | Provider | Scope |
| --- | --- | --- |
| `PIXABAY_API_KEY` | Pixabay | read-only API key |

Wikipedia needs no key.

## Publishing (deliberately not wired)

| Variable | Provider | Scope | Gate |
| --- | --- | --- | --- |
| `YOUTUBE_CLIENT_ID` / `YOUTUBE_CLIENT_SECRET` / `YOUTUBE_REFRESH_TOKEN` | Google Cloud OAuth | `youtube.upload` | human approval + explicit enable |
| `TIKTOK_CLIENT_KEY` / `TIKTOK_CLIENT_SECRET` / `TIKTOK_REFRESH_TOKEN` | TikTok Developers | `video.publish` | human approval + explicit enable |
| `META_APP_ID` / `META_APP_SECRET` / `META_ACCESS_TOKEN` | Meta Graph | `instagram_content_publish` | human approval + explicit enable |

Publishing stays disabled in code regardless of credentials
(`publishing_enabled: false`, `MockPublisher` requires `authorized=True`).

## Setup sequence

1. Create/confirm the Telegram bot, send it one message, read `getUpdates` for the chat id.
2. Add `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` to each studio repo's Actions secrets.
3. Add `GROQ_API_KEY`, `GEMINI_API_KEY`, `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_API_TOKEN`
   to each studio repo (the Cloudflare free pool is shared).
4. Generate `HUB_WEBHOOK_SECRET` once (for example `openssl rand -hex 32`) and store it
   in OpsHub Sites secrets and every studio's Actions secrets.
5. Set `HUB_URL` in each studio to the deployed hub origin.
6. Add `HUB_GITHUB_TOKEN` to the OpsHub environment for dispatching.
7. Deploy OpsHub, then verify:

```bash
curl -s https://<hub>/api-readiness | python3 -m json.tool   # names only, no values
```

## Verification checklist (run after credentials exist)

- `GET /api-readiness` shows each provider `configured` (not yet `operational`).
- Run one provider check per adapter (Groq models list, Gemini models list,
  Cloudflare AI models search) before trusting a production run.
- Trigger one `short` production in `test` mode; confirm the studio reports
  `running` → `quality_review` → `awaiting_approval` on `/jobs`.
- Confirm Telegram delivery of the render.
- Confirm `/api-readiness` still reports `publishing_enabled: false`.

## Known limitations at this checkpoint

- No live AI generation has been executed in this workspace (no credentials).
- No public publishing path is enabled, by design.
- R2 (`FILES`) bucket is configured but not provisioned; renders currently live
  only in the studio workspace.

## Dashboard and verification tools

| Surface | Purpose |
| --- | --- |
| `GET /dashboard` | read-only operator view: studio cards, productions, API readiness, review queue |
| `npm run preflight` | deployment readiness: config, bindings, manifests, secret scan, env names |
| `python3 -m unittest discover -s opshub/shared/tests` | offline suites; render tests run only when ffmpeg/ffprobe are on PATH |

Dashboard writes are intentionally disabled: approvals remain signed actions via
Telegram `/approve <job_id>`, and publishing stays off even after approval.

FFmpeg without a system install (no root needed):

```bash
python3 -m venv /tmp/ffvenv
/tmp/ffvenv/bin/pip install static-ffmpeg
export PATH="$(/tmp/ffvenv/bin/python -c 'from static_ffmpeg import run; print(run.get_or_fetch_platform_executables_else_raise()[0].rsplit("/",1)[0])'):$PATH"
```
