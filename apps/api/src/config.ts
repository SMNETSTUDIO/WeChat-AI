import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadDotenv } from "dotenv";
import { parseAdminIds } from "./oauth-linuxdo.js";

/**
 * Levels pino accepts. Validated rather than passed through: pino throws at
 * construction on an unknown level, so a typo in LOG_LEVEL would take the whole
 * process down at boot.
 */
export const LOG_LEVELS = [
  "silent",
  "fatal",
  "error",
  "warn",
  "info",
  "debug",
  "trace",
] as const;

export type LogLevel = (typeof LOG_LEVELS)[number];

export const VISION_MODES = ["caption", "direct"] as const;
export type VisionMode = (typeof VISION_MODES)[number];

export function resolveVisionMode(raw: string | undefined): VisionMode {
  const v = (raw ?? "").trim().toLowerCase();
  // Default to caption: it is the only mode that works when the roleplay model
  // is text-only, which is the common case.
  return v === "direct" ? "direct" : "caption";
}

export function resolveLogLevel(raw: string | undefined): LogLevel {
  const v = (raw ?? "").trim().toLowerCase();
  return (LOG_LEVELS as readonly string[]).includes(v)
    ? (v as LogLevel)
    : "info";
}

export function resolveRepoRoot(start = process.cwd()): string {
  let dir = path.resolve(start);
  for (let i = 0; i < 10; i++) {
    if (fs.existsSync(path.join(dir, "pnpm-workspace.yaml"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  const fromFile = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../../..",
  );
  if (fs.existsSync(path.join(fromFile, "pnpm-workspace.yaml"))) {
    return fromFile;
  }
  return path.resolve(start);
}

const repoRootEarly = resolveRepoRoot();
loadDotenv({ path: path.join(repoRootEarly, ".env") });
loadDotenv({ path: path.resolve(process.cwd(), ".env") });

export interface AppConfig {
  host: string;
  port: number;
  /** legacy bearer for scripts; optional when OAuth enabled */
  token: string;
  redisUrl: string;
  /** Admin platform LLM (main site connects directly) */
  llmBaseUrl: string;
  llmApiKey: string;
  llmModel: string;
  /**
   * HF / tools gateway (user custom LLM egress + web search).
   * Main site never dials user custom base_url; only this host.
   */
  toolsBaseUrl: string;
  toolsApiKey: string;
  toolsTimeoutMs: number;
  /** Global switch: allow personas to use web_search via tools gateway */
  webSearchEnabled: boolean;
  webSearchMaxResults: number;
  /** Encrypt user-stored custom LLM API keys at rest */
  llmProviderSecret: string;
  /**
   * Extra hosts for chatflow http nodes (comma-separated).
   * Tools gateway host is always allowed; private IPs still blocked unless tools itself.
   */
  chatflowHttpAllowlist: string[];
  chatflowMaxSteps: number;
  chatflowMaxNodes: number;
  defaultPersonaSlug: string;
  allowUnapproved: boolean;
  shortHistoryLimit: number;
  memoryExtractEveryN: number;
  workerEnabled: boolean;
  /** Max concurrent iLink long-poll loops in this process */
  maxBotsPerWorker: number;
  leaseTtlSec: number;
  leaseRenewSec: number;
  /**
   * Multi-node: overloaded workers shed leases so idle nodes can claim.
   * Default on. Set REBALANCE_ENABLED=false to keep sticky leases.
   */
  rebalanceEnabled: boolean;
  /** Min seconds between rebalance shed attempts on this process */
  rebalanceIntervalSec: number;
  /** Allow this many bots above fair share before shedding */
  rebalanceSlack: number;
  /** Max leases to release per rebalance tick */
  rebalanceMaxPerTick: number;
  /**
   * Seconds an admin load-weight override survives after its node stops
   * heartbeating, before the fleet deletes it automatically. Must outlast a
   * restart / OTA apply, or every deploy would reset the tuning.
   */
  workerWeightTtlSec: number;
  /** Concurrent LLM/reply jobs */
  replyConcurrency: number;
  /** Retained Redis inbound jobs per bot, including failed jobs. */
  inboxMaxLen: number;
  logLevel: LogLevel;
  /** Requests slower than this are logged at warn even when they succeed */
  logSlowRequestMs: number;
  peerRatePerMinute: number;
  repoRoot: string;
  publicBaseUrl: string;
  /**
   * Shared secret the LB Worker stamps as `X-WeChat-AI-Proxy-Secret`. Proves a
   * request really came through the proxy, so its forwarded client IP can be
   * trusted for rate limiting. Empty = unverified (see client-ip.ts).
   */
  originProxySecret: string;
  sessionCookieName: string;
  adminIds: Set<string>;
  cookieSecure: boolean;
  /**
   * Allowed browser Origins for credentialed CORS on /api/v1.
   * Defaults to PUBLIC_BASE_URL origin. Empty list = same-origin only (no ACAO).
   */
  corsOrigins: Set<string>;
  /** Split AI reply into multiple WeChat bubbles */
  splitReply: boolean;
  maxReplyChunks: number;
  maxChunkChars: number;
  /** Ask model to return {"messages":[...]} JSON bubbles */
  multiBubbleJson: boolean;
  /**
   * Second-pass AI filter: reformat primary reply into multi-bubble JSON before send.
   * Extra LLM cost/latency. Off by default — primary model emits JSON via MULTI_BUBBLE_JSON.
   * Enable with REPLY_FILTER_ENABLED=true only if format quality needs a dedicated pass.
   */
  replyFilterEnabled: boolean;
  /** Human-like delay between WeChat bubbles */
  replyDelayMsPerChar: number;
  replyDelayMinMs: number;
  replyDelayMaxMs: number;
  replyDelayFirstMinMs: number;
  replyDelayFirstMaxMs: number;
  replyDelayThinkExtraMs: number;
  /** Max uploaded sticker size in bytes (blob stored in Redis) */
  stickerMaxBytes: number;
  /** Body cap for the few upload routes (global default is 1MB) */
  uploadBodyLimit: number;
  /** Inject sticker catalog + allow sendImage */
  stickerSendEnabled: boolean;
  maxStickersPerReply: number;
  /**
   * Master switch for inbound image understanding. Default OFF.
   * When off, images are never downloaded and get a canned "can't see it" line.
   */
  visionEnabled: boolean;
  /**
   * How an image reaches the conversation.
   *
   * `caption` (default): a dedicated vision endpoint describes the image and
   * only that TEXT enters the roleplay turn — so the persona's own model needs
   * no multimodal support at all. This is the mode that works with a text-only
   * platform model such as deepseek.
   *
   * `direct`: the image is handed to the roleplay model as content parts.
   * Requires that model to be vision-capable; it errors outright otherwise.
   */
  visionMode: VisionMode;
  /**
   * Vision endpoint. Admin-level credentials, dialed directly like the platform
   * LLM — a captioner is not user-supplied, so it does not need the tools
   * gateway. Empty base/key fall back to the platform LLM's.
   */
  visionBaseUrl: string;
  visionApiKey: string;
  /** Vision model id. Required for vision to do anything at all. */
  visionModel: string;
  /** Cap on caption length — a description, not an essay. */
  visionCaptionMaxTokens: number;
  /**
   * Act on the speech-to-text WeChat/iLink already did for a voice message.
   *
   * Default ON, and unrelated to VISION_ENABLED: the transcript arrives inside
   * the inbound message, so using it costs nothing extra and needs no model.
   * Turn off to have voice notes answered with "didn't catch that" instead.
   */
  voiceTranscriptEnabled: boolean;
  /** Max images forwarded from a single message (each one costs real tokens) */
  visionMaxImages: number;
  /** Hard cap per downloaded attachment, before base64 inflation */
  inboundMediaMaxBytes: number;
  /** Global hard switch for idle proactive outreach */
  proactiveEnabled: boolean;
  proactiveIdleHours: number;
  proactiveMinIntervalHours: number;
  proactiveMaxPerDay: number;
  /** e.g. "0-8"; empty string disables quiet hours */
  proactiveQuietHours: string;
  proactiveScanIntervalSec: number;
  proactiveMaxPerScan: number;
  proactiveLockTtlSec: number;
  proactiveAttemptCooldownHours: number;
  /** Memory: top-K when over fullInjectMax */
  memoryTopK: number;
  /** Memory: inject all when count ≤ this */
  memoryFullInjectMax: number;
  /** Memory: hard cap stored facts per peer+persona */
  memoryMaxItems: number;
  /** LLM tool: get_current_time */
  timeToolEnabled: boolean;
  timeToolTimeZone: string;
  /** WeChat user-to-user relay via @LINUX DO username */
  p2pEnabled: boolean;
  p2pBindCodeTtlSec: number;
  p2pRequestTtlSec: number;
  p2pSessionIdleSec: number;
  p2pRelayMaxChars: number;
  p2pMaxRequestsPerDay: number;
  /** Admin broadcast: delay between messages (ms) */
  broadcastIntervalMs: number;
  /** Admin broadcast: max text length */
  broadcastMaxText: number;
  /** Admin broadcast: retained job history count */
  broadcastHistory: number;
  /** Web try-chat (persona preview without WeChat) */
  tryChatEnabled: boolean;
  tryChatMaxUserMsgsPerDay: number;
  tryChatMaxUserMsgsPerSession: number;
  tryChatSessionTtlSec: number;
  tryChatMaxHistory: number;
  /** Server-side persona fork */
  personaForkEnabled: boolean;
  /** Local username+password auth */
  localAuthEnabled: boolean;
  passwordMinLength: number;
  /** Local register requires invite code */
  inviteRequiredForLocal: boolean;
  inviteCodeTtlSec: number;
  inviteCodeLength: number;
  inviteMaxPendingPerUser: number;
  /** Sliding window: max invites generated per user per window */
  inviteQuotaWindowHours: number;
  inviteQuotaMax: number;
  firstUserIsAdmin: boolean;
  /**
   * LINUX DO Connect OAuth login. Default on when LINUXDO_CLIENT_* configured.
   * Set LINUXDO_AUTH_ENABLED=false to disable the "使用 LINUX DO 登录" path
   * entirely (login + callback both refuse) even when credentials exist.
   */
  linuxdoAuthEnabled: boolean;
  /**
   * Optional ops labels for multi-node fleet display (not public URLs).
   * WORKER_ID itself is read by BotWorkerManager from process.env.
   */
  nodeLabel: string;
  nodeRegion: string;
  /** App version string for worker heartbeat */
  appVersion: string;
  /** Consume OTA update jobs from Redis (default true) */
  otaEnabled: boolean;
  /** Allow pnpm install during OTA when lock/package.json changes */
  otaAllowInstall: boolean;
  /** Staging dir for OTA writes (absolute or relative to repo root) */
  otaStagingDir: string;
  /** Admin live activity stream (SSE) */
  dataStreamEnabled: boolean;
  /** Redis command sample rate for stream (0–1) */
  dataStreamRedisSample: number;
  /** Process-local max stream events per second */
  dataStreamMaxEps: number;
}

/** Read OTA-written version file (monorepo root `.wa-version`). */
export function readWaVersionFile(repoRoot: string): string | null {
  try {
    const p = path.join(repoRoot, ".wa-version");
    if (!fs.existsSync(p)) return null;
    const v = fs.readFileSync(p, "utf8").trim().split(/\r?\n/)[0]?.trim() ?? "";
    return v || null;
  } catch {
    return null;
  }
}

export function readPackageJsonVersion(repoRoot: string): string | null {
  try {
    const p = path.join(repoRoot, "package.json");
    if (!fs.existsSync(p)) return null;
    const j = JSON.parse(fs.readFileSync(p, "utf8")) as { version?: string };
    const v = (j.version || "").trim();
    return v || null;
  } catch {
    return null;
  }
}

/**
 * Resolve runtime version for heartbeat / admin display.
 *
 * Order (OTA-friendly — env cannot be changed by OTA):
 * 1. `.wa-version` at monorepo root (written by OTA apply)
 * 2. `APP_VERSION` env (optional ops pin when no OTA stamp)
 * 3. root `package.json` version (not workspace package / npm_package_version;
 *    pnpm --filter @wechat-ai/api would otherwise report apps/api's 0.1.0)
 * 4. fallback
 */
export function resolveAppVersion(
  env: NodeJS.ProcessEnv,
  repoRoot: string,
  fallback = "0.2.0",
): string {
  const fromFile = readWaVersionFile(repoRoot);
  if (fromFile) return fromFile;
  const fromEnv = (env.APP_VERSION ?? "").trim();
  if (fromEnv) return fromEnv;
  // Prefer monorepo root package.json only — ignore npm_package_version
  // (set by pnpm to the filtered workspace package, e.g. apps/api @ 0.1.0).
  const fromPkg = readPackageJsonVersion(repoRoot);
  if (fromPkg) return fromPkg;
  return fallback;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const repoRoot = resolveRepoRoot();
  const port = Number(env.WECHAT_AI_PORT ?? "8787");
  const host = env.WECHAT_AI_HOST ?? "127.0.0.1";
  const publicBaseUrl =
    env.PUBLIC_BASE_URL ??
    `http://${host === "0.0.0.0" ? "127.0.0.1" : host}:${port}`;
  const corsOrigins = new Set<string>();
  try {
    corsOrigins.add(new URL(publicBaseUrl).origin);
  } catch {
    /* ignore bad PUBLIC_BASE_URL */
  }
  if (env.CORS_ORIGINS) {
    for (const part of env.CORS_ORIGINS.split(",")) {
      const o = part.trim();
      if (!o) continue;
      try {
        corsOrigins.add(new URL(o).origin);
      } catch {
        // allow bare origin like https://a.com
        if (/^https?:\/\//i.test(o)) corsOrigins.add(o.replace(/\/$/, ""));
      }
    }
  }
  return {
    host,
    port,
    token: env.WECHAT_AI_TOKEN ?? "dev-insecure-token",
    redisUrl: env.REDIS_URL ?? "redis://127.0.0.1:6379",
    stickerMaxBytes: Number(env.STICKER_MAX_BYTES ?? String(2 * 1024 * 1024)),
    uploadBodyLimit: Math.max(
      12 * 1024 * 1024,
      Number(env.STICKER_MAX_BYTES ?? String(2 * 1024 * 1024)) * 2,
    ),
    stickerSendEnabled: env.STICKER_SEND_ENABLED !== "false",
    maxStickersPerReply: Number(env.MAX_STICKERS_PER_REPLY ?? "2"),
    visionEnabled: env.VISION_ENABLED === "true",
    visionMode: resolveVisionMode(env.VISION_MODE),
    visionBaseUrl: (env.VISION_BASE_URL ?? "").trim(),
    visionApiKey: (env.VISION_API_KEY ?? "").trim(),
    visionModel: (env.VISION_MODEL ?? "").trim(),
    visionCaptionMaxTokens: Math.max(
      32,
      Number(env.VISION_CAPTION_MAX_TOKENS ?? "300") || 300,
    ),
    voiceTranscriptEnabled: env.VOICE_TRANSCRIPT_ENABLED !== "false",
    visionMaxImages: Math.max(1, Number(env.VISION_MAX_IMAGES ?? "2") || 2),
    inboundMediaMaxBytes: Math.max(
      64 * 1024,
      Number(env.INBOUND_MEDIA_MAX_BYTES ?? String(4 * 1024 * 1024)) ||
        4 * 1024 * 1024,
    ),
    proactiveEnabled: env.PROACTIVE_ENABLED === "true",
    proactiveIdleHours: Number(env.PROACTIVE_IDLE_HOURS ?? "12"),
    proactiveMinIntervalHours: Number(
      env.PROACTIVE_MIN_INTERVAL_HOURS ?? "24",
    ),
    proactiveMaxPerDay: Number(env.PROACTIVE_MAX_PER_DAY ?? "1"),
    proactiveQuietHours:
      env.PROACTIVE_QUIET_HOURS === undefined
        ? "0-8"
        : String(env.PROACTIVE_QUIET_HOURS).trim(),
    proactiveScanIntervalSec: Number(
      env.PROACTIVE_SCAN_INTERVAL_SEC ?? "300",
    ),
    proactiveMaxPerScan: Number(env.PROACTIVE_MAX_PER_SCAN ?? "10"),
    proactiveLockTtlSec: Number(env.PROACTIVE_LOCK_TTL_SEC ?? "180"),
    proactiveAttemptCooldownHours: Number(
      env.PROACTIVE_ATTEMPT_COOLDOWN_HOURS ?? "1",
    ),
    memoryTopK: Number(env.MEMORY_TOP_K ?? "12"),
    memoryFullInjectMax: Number(env.MEMORY_FULL_INJECT_MAX ?? "20"),
    memoryMaxItems: Number(env.MEMORY_MAX_ITEMS ?? "100"),
    timeToolEnabled: env.TIME_TOOL_ENABLED !== "false",
    timeToolTimeZone: (env.TIME_TOOL_TIMEZONE ?? "Asia/Shanghai").trim() ||
      "Asia/Shanghai",
    p2pEnabled: env.P2P_ENABLED !== "false",
    p2pBindCodeTtlSec: Number(env.P2P_BIND_CODE_TTL_SEC ?? "600"),
    p2pRequestTtlSec: Number(env.P2P_REQUEST_TTL_SEC ?? "300"),
    p2pSessionIdleSec: Number(env.P2P_SESSION_IDLE_SEC ?? "1800"),
    p2pRelayMaxChars: Number(env.P2P_RELAY_MAX_CHARS ?? "500"),
    p2pMaxRequestsPerDay: Number(env.P2P_MAX_REQUESTS_PER_DAY ?? "20"),
    broadcastIntervalMs: Number(env.BROADCAST_INTERVAL_MS ?? "200"),
    broadcastMaxText: Number(env.BROADCAST_MAX_TEXT ?? "2000"),
    broadcastHistory: Number(env.BROADCAST_HISTORY ?? "100"),
    tryChatEnabled: env.TRY_CHAT_ENABLED !== "false",
    tryChatMaxUserMsgsPerDay: Number(
      env.TRY_CHAT_MAX_USER_MSGS_PER_DAY ?? "40",
    ),
    tryChatMaxUserMsgsPerSession: Number(
      env.TRY_CHAT_MAX_USER_MSGS_PER_SESSION ?? "20",
    ),
    tryChatSessionTtlSec: Number(env.TRY_CHAT_SESSION_TTL_SEC ?? "3600"),
    tryChatMaxHistory: Number(env.TRY_CHAT_MAX_HISTORY ?? "40"),
    personaForkEnabled: env.PERSONA_FORK_ENABLED !== "false",
    localAuthEnabled: env.LOCAL_AUTH_ENABLED !== "false",
    passwordMinLength: Number(env.PASSWORD_MIN_LENGTH ?? "8"),
    inviteRequiredForLocal: env.INVITE_REQUIRED_FOR_LOCAL !== "false",
    inviteCodeTtlSec: Number(env.INVITE_CODE_TTL_SEC ?? String(7 * 24 * 3600)),
    inviteCodeLength: Number(env.INVITE_CODE_LENGTH ?? "10"),
    inviteMaxPendingPerUser: Number(env.INVITE_MAX_PENDING_PER_USER ?? "20"),
    inviteQuotaWindowHours: Number(env.INVITE_QUOTA_WINDOW_HOURS ?? "24"),
    inviteQuotaMax: Number(env.INVITE_QUOTA_MAX ?? "3"),
    firstUserIsAdmin: env.FIRST_USER_IS_ADMIN !== "false",
    linuxdoAuthEnabled: env.LINUXDO_AUTH_ENABLED !== "false",
    llmBaseUrl: env.LLM_BASE_URL ?? "https://api.openai.com/v1",
    llmApiKey: env.LLM_API_KEY ?? "",
    llmModel: env.LLM_MODEL ?? "gpt-4o-mini",
    toolsBaseUrl: (env.TOOLS_BASE_URL ?? "").trim().replace(/\/+$/, ""),
    toolsApiKey: (env.TOOLS_API_KEY ?? "").trim(),
    toolsTimeoutMs: Number(env.TOOLS_TIMEOUT_MS ?? "60000"),
    webSearchEnabled: env.WEB_SEARCH_ENABLED === "true",
    webSearchMaxResults: Number(env.WEB_SEARCH_MAX_RESULTS ?? "5"),
    llmProviderSecret: (env.LLM_PROVIDER_SECRET ?? "").trim(),
    chatflowHttpAllowlist: (env.CHATFLOW_HTTP_ALLOWLIST ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    chatflowMaxSteps: Number(env.CHATFLOW_MAX_STEPS ?? "32"),
    chatflowMaxNodes: Number(env.CHATFLOW_MAX_NODES ?? "40"),
    defaultPersonaSlug: env.DEFAULT_PERSONA_SLUG ?? "catgirl",
    allowUnapproved: env.ALLOW_UNAPPROVED_USERS === "true",
    shortHistoryLimit: Number(env.SHORT_HISTORY_LIMIT ?? "20"),
    memoryExtractEveryN: Number(env.MEMORY_EXTRACT_EVERY_N ?? "8"),
    workerEnabled: env.WORKER_ENABLED !== "false",
    maxBotsPerWorker: Number(env.MAX_BOTS_PER_WORKER ?? "500"),
    leaseTtlSec: Number(env.LEASE_TTL_SEC ?? "45"),
    leaseRenewSec: Number(env.LEASE_RENEW_SEC ?? "15"),
    rebalanceEnabled: env.REBALANCE_ENABLED !== "false",
    rebalanceIntervalSec: Number(env.REBALANCE_INTERVAL_SEC ?? "60"),
    rebalanceSlack: Number(env.REBALANCE_SLACK ?? "2"),
    rebalanceMaxPerTick: Number(env.REBALANCE_MAX_PER_TICK ?? "50"),
    workerWeightTtlSec: Number(env.WORKER_WEIGHT_TTL_SEC ?? "3600"),
    replyConcurrency: Number(env.REPLY_CONCURRENCY ?? "16"),
    inboxMaxLen: Number(env.INBOX_MAX_LEN ?? "20000"),
    logLevel: resolveLogLevel(env.LOG_LEVEL),
    logSlowRequestMs: Math.max(
      50,
      Number(env.LOG_SLOW_REQUEST_MS ?? "1000") || 1000,
    ),
    peerRatePerMinute: Number(env.PEER_RATE_PER_MINUTE ?? "20"),
    splitReply: env.SPLIT_REPLY !== "false",
    maxReplyChunks: Number(env.MAX_REPLY_CHUNKS ?? "5"),
    maxChunkChars: Number(env.MAX_CHUNK_CHARS ?? "72"),
    multiBubbleJson: env.MULTI_BUBBLE_JSON !== "false",
    replyFilterEnabled: env.REPLY_FILTER_ENABLED === "true",
    replyDelayMsPerChar: Number(env.REPLY_DELAY_MS_PER_CHAR ?? "90"),
    replyDelayMinMs: Number(env.REPLY_DELAY_MIN_MS ?? "1400"),
    replyDelayMaxMs: Number(env.REPLY_DELAY_MAX_MS ?? "5500"),
    replyDelayFirstMinMs: Number(env.REPLY_DELAY_FIRST_MIN_MS ?? "900"),
    replyDelayFirstMaxMs: Number(env.REPLY_DELAY_FIRST_MAX_MS ?? "2200"),
    replyDelayThinkExtraMs: Number(env.REPLY_DELAY_THINK_EXTRA_MS ?? "400"),
    repoRoot,
    publicBaseUrl,
    originProxySecret: (env.ORIGIN_PROXY_SECRET ?? "").trim(),
    sessionCookieName: env.SESSION_COOKIE_NAME ?? "wa_session",
    adminIds: parseAdminIds(env.LINUXDO_ADMIN_IDS),
    cookieSecure: env.COOKIE_SECURE === "true",
    corsOrigins,
    nodeLabel: (env.NODE_LABEL ?? "").trim(),
    nodeRegion: (env.NODE_REGION ?? "").trim(),
    appVersion: resolveAppVersion(env, repoRoot),
    otaEnabled: env.OTA_ENABLED !== "false",
    otaAllowInstall: env.OTA_ALLOW_INSTALL !== "false",
    otaStagingDir: (env.OTA_STAGING_DIR ?? ".wa-update-staging").trim() ||
      ".wa-update-staging",
    dataStreamEnabled: env.DATA_STREAM_ENABLED !== "false",
    dataStreamRedisSample: Math.min(
      1,
      Math.max(0, Number(env.DATA_STREAM_REDIS_SAMPLE ?? "0.08")),
    ),
    dataStreamMaxEps: Math.max(5, Number(env.DATA_STREAM_MAX_EPS ?? "80")),
  };
}
