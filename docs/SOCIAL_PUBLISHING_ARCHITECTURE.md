# Social Publishing Architecture (Proposal)

Status: design-only; no production publishing enabled by this document.

## Decision
The three studios will support automatic publishing to YouTube and TikTok after each platform app, channel authorization, permissions, and credentials are configured and validated. Until then, existing Telegram delivery remains the only active delivery path.

## Current topology
OpsHub receives `content.episode_ready` events from the studios. The studios render media inside their GitHub Actions production job and currently notify Telegram/OpsHub. The publisher must run in that same job after a successful render so it can use the local MP4 before the runner is destroyed.

## Target topology
1. Studio renders and validates a media file.
2. A shared publisher package validates metadata, file type, duration, size, aspect ratio, and target channel configuration.
3. The publisher obtains a platform access token from GitHub Actions secrets and refreshes it only through the documented OAuth flow.
4. YouTube upload uses resumable `videos.insert` with OAuth scope `youtube.upload`.
5. TikTok defaults to the Content Posting API upload-to-inbox flow (`video.upload`) until Direct Post is approved and the app/account is eligible. Automatic Direct Post can be enabled per channel only after TikTok review, required scopes, creator authorization, and posting UX requirements are satisfied.
6. The publisher reports each platform result to OpsHub using the existing HMAC-signed ingest pattern.
7. OpsHub stores each platform post independently and deduplicates by `episodeId + platform + channelId`.

## Proposed OpsHub data model
Add a `platformPosts` table rather than expanding the episode's single `publishedAt` field:
- `episodeId`, `studio`, `platform`, `channelKey`
- `status`: queued | uploading | processing | published | failed | needs_user_action
- `externalPostId`, `permalink`, `visibility`
- `idempotencyKey`, `attemptCount`, `lastError`
- `createdAt`, `updatedAt`, `publishedAt`

Add indexes for episode, platform/channel, and idempotency key. Never store access/refresh tokens in Convex documents or event payloads.

## Studio integration contract
A publisher invocation receives only:
- studio key and episode identifier
- local rendered video path
- title, description, tags, language, thumbnail path (optional)
- explicit channel profile key and intended visibility

The publisher emits a result event with platform, channel key, status, external ID, permalink, visibility, and sanitized error code. Never include tokens, secret values, or raw OAuth responses in logs/events.

## Automatic mode safeguards
- Automatic mode means unattended upload after all authorization gates pass; it does not bypass platform review or creator consent.
- YouTube starts as private (or unlisted only if explicitly configured); do not publish public by default until the channel owner selects that policy.
- TikTok Direct Post is disabled by default. Unaudited clients may be restricted to private visibility; use upload-to-inbox until the app is audited and approved.
- Validate account ownership and channel mapping before first upload.
- Per-platform idempotency prevents duplicate uploads on retries.
- Retry only transient network/5xx/rate-limit errors with bounded exponential backoff; never blindly retry an uncertain upload without checking its status.
- Fail open for existing Telegram notification, fail closed for social upload: a publisher failure must not fail or roll back the episode.
- Do not use a public media URL unless its domain is verified by the platform. Prefer file upload for initial TikTok integration.
- No publishing of content with unresolved copyright, likeness, or rights concerns.

## Secrets (names only; create after code and OAuth setup are ready)
YouTube:
- `YOUTUBE_CLIENT_ID`
- `YOUTUBE_CLIENT_SECRET`
- `YOUTUBE_REFRESH_TOKEN`

TikTok:
- `TIKTOK_CLIENT_KEY`
- `TIKTOK_CLIENT_SECRET`
- `TIKTOK_REFRESH_TOKEN`

Secrets belong in each studio's GitHub Actions secrets or a carefully scoped shared publishing environment. Do not place them in OpsHub Convex documents, repository files, issue comments, or logs. YouTube API key used for analytics is not a substitute for OAuth upload authorization.

## Rollout
1. Implement and test OpsHub schema + authenticated ingest events, without changing existing episode fields.
2. Implement the publisher as a standalone module with mocked platform clients and deterministic tests.
3. Integrate one studio first (English studio) behind `SOCIAL_PUBLISH_ENABLED=false`.
4. Validate private YouTube upload and TikTok inbox upload on a test channel/account.
5. Enable per-studio/channel only after credentials and consent are verified.
6. Expand to Turkish and Deep History studios.
7. Enable TikTok Direct Post only after app audit/eligibility and explicit channel policy.

## Acceptance criteria
- Existing Telegram and episode workflows pass unchanged when publishing is disabled or credentials are absent.
- Duplicate workflow reruns do not create duplicate posts.
- Each platform's result is independently visible in OpsHub.
- No secrets appear in logs, event payloads, or database rows.
- A platform outage never loses the rendered MP4 or blocks episode completion.
- Automated tests cover success, token expiry, timeout, uncertain upload, retry, duplicate event, unsupported media, and platform rejection.

## Explicit non-goals
No production secrets are created, no OAuth is initiated, no social upload is enabled, and no existing production workflow is changed by this design proposal.
