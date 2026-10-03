import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  addPersonaToLibrary,
  addStickerToLibrary,
  approvePeer,
  approveSticker,
  clearMemories,
  clearMessages,
  clearPrimaryBind,
  createBindCode,
  blockUser,
  deleteMemory,
  countPendingStickers,
  createAppSession,
  createLocalUser,
  createPersona,
  createInviteCode,
  consumeInviteCode,
  peekInviteCode,
  listPendingInvites,
  revokeInviteCode,
  getInviteSettings,
  setInviteSettings,
  getInviteQuotaStatus,
  forkPersona,
  createSticker,
  deleteBotAccount,
  deleteUserAccount,
  deleteSticker,
  destroyAppSession,
  destroyAllSessionsForUser,
  doctorSnapshot,
  ensureStickerContentHash,
  getAppSession,
  getAssignmentsMany,
  getBindByUser,
  getBotAccount,
  getBotAccountsByIds,
  getContextToken,
  getPersona,
  getPersonaBySlug,
  getPersonaLibraryIdSet,
  getPersonasByIds,
  getPublishedPrompt,
  getPublishedPromptsMany,
  getSticker,
  getStickerBlob,
  getStickerBySlug,
  getStickerLibraryIdSet,
  getUsageDayStats,
  dayKey,
  dayKeyOffset,
  getUser,
  getUserByUsername,
  getUsersByIds,
  isInPersonaLibrary,
  isInPersonaLibraryLocal,
  isInStickerLibrary,
  isValidStickerSlug,
  listAuditLogs,
  listBlockedUserIds,
  listBotAccounts,
  listFailedInbound,
  retryFailedInbound,
  inboundQueueStats,
  hasBotCredentials,
  hasBotCredentialsMany,
  listBotsByOwner,
  countBotsByOwners,
  countUserMessages,
  listMemories,
  listMemoriesMany,
  listPeers,
  listPeersForBots,
  listPersonas,
  listRecentMessages,
  listPersonasByOwner,
  listStickers,
  listStickersByOwner,
  listUserPersonaLibrary,
  listUserStickerLibrary,
  countUsers,
  listUsers,
  isSuperAdmin,
  resolveSuperAdminId,
  peerStatsByBots,
  publishPersonaVersion,
  rejectSticker,
  removePersonaFromLibrary,
  removeStickerFromLibrary,
  replaceStickerBlob,
  restorePersona,
  restoreSticker,
  setDefaultPersona,
  saveOauthState,
  searchPublicPersonas,
  searchPublicStickers,
  seedPersonas,
  setAssignment,
  setUserAdmin,
  setUserBanned,
  isUserBanned,
  userPublicFields,
  validateLocalUsername,
  hashPassword,
  verifyPassword,
  assertPasswordPolicy,
  softDeletePersona,
  softDeleteSticker,
  takeOauthState,
  setBotStatus,
  setPeerProactiveEnabled,
  unblockUser,
  updateBotDisplayName,
  updateBotProactiveSettings,
  updatePersonaMeta,
  updateStickerMeta,
  userCanUsePersona,
  upsertUser,
  writeAudit,
  cancelBroadcastJob,
  createBroadcastJob,
  getBroadcastJob,
  listBroadcastJobs,
  listBotSendTargets,
  previewBroadcast,
  forceOfflineWorker,
  clearWorkerFence,
  listWorkerFences,
  listLeasedBots,
  publishWorkerWake,
  listWorkerWeights,
  setWorkerWeight,
  clearWorkerWeight,
  pruneWorkerWeights,
  parseWorkerWeightInput,
  DEFAULT_WORKER_WEIGHT,
  MIN_WORKER_WEIGHT,
  MAX_WORKER_WEIGHT,
  listPollableBotIds,
  getCurrentRelease,
  getReleaseMeta,
  listReleaseVersions,
  publishRelease,
  setCurrentRelease,
  buildReleaseMeta,
  putBlobChunks,
  blobExists,
  enqueueWorkerUpdate,
  getWorkerUpdateStatus,
  getWorkerUpdateStatuses,
  releaseSummary,
  sha256Buffer,
  type BroadcastScope,
  type BroadcastTarget,
  type Db,
  type Persona,
  type Sticker,
  type User,
  type ReleaseFileEntry,
  personaHeatScore,
  createLlmProvider,
  updateLlmProvider,
  deleteLlmProvider,
  listLlmProvidersByOwner,
  getLlmProvider,
  toPublicProvider,
  getPublishedGraph,
} from "@wechat-ai/db";
import {
  mergeBotProactiveConfig,
  TryChatError,
  TryChatService,
  createDefaultChatflowGraph,
  validateChatflowGraph,
  ChatflowError,
  type ChatService,
} from "@wechat-ai/core";
import { probeToolsHealth } from "@wechat-ai/llm";
import type { BotWorkerManager } from "./worker.js";
import type { BotLoginSessionManager } from "./bot-login-sessions.js";
import type { AppConfig } from "./config.js";
import {
  buildAuthorizeUrl,
  exchangeCode,
  fetchUserInfo,
  loadLinuxDoConfig,
  newOAuthState,
} from "./oauth-linuxdo.js";
import {
  decodeBase64Image,
  makeStickerFileName,
} from "./sticker-store.js";
import {
  assertSafeStickerImage,
  StickerSecurityError,
} from "./sticker-security.js";
import {
  CC_CDN_STICKER,
  CC_NO_STORE,
  CC_PRIVATE_NO_STORE,
  CC_PRIVATE_QR,
  CC_PRIVATE_STICKER,
  CDN_CDN_STICKER,
  etagFromHash,
  ifNoneMatchHits,
  setPrivateNoStore,
  setPublicCache,
} from "./cache-headers.js";
import { qrSvg } from "./qrcode.js";
import { canBootstrapFirstAdmin } from "./auth-bootstrap.js";
import { resolveClientIp } from "./client-ip.js";
import { RateLimiter } from "./rate-limit.js";
import { RuntimeSettingsUnavailableError } from "./runtime-config.js";


export interface RouteContext {
  db: Db;
  chat: ChatService;
  tryChat: TryChatService;
  worker: BotWorkerManager;
  loginSessions: BotLoginSessionManager;
  cfg: AppConfig;
  /** Admin live activity stream (optional when DATA_STREAM_ENABLED=false) */
  activityBus?: import("./activity-stream.js").ActivityBus | null;
  /** Redis-backed runtime config overrides (env supplies the defaults) */
  settings?: import("./runtime-config.js").RuntimeConfigManager | null;
}

function personaPublicDto(
  p: Persona,
  extra?: Record<string, unknown>,
): Record<string, unknown> {
  const forkedFrom =
    p.forked_from_id
      ? {
          id: p.forked_from_id,
          slug: p.forked_from_slug ?? null,
          displayName: p.forked_from_name ?? null,
        }
      : null;
  return {
    id: p.id,
    slug: p.slug,
    displayName: p.display_name,
    description: p.description,
    tags: p.tags,
    visibility: p.visibility,
    ownerUserId: p.owner_user_id,
    useCount: p.use_count || 0,
    assignCount: p.assign_count || 0,
    forkCount: p.fork_count || 0,
    heatScore: personaHeatScore(p),
    forkedFrom,
    mode: p.mode === "chatflow" ? "chatflow" : "prompt",
    llmProviderId: p.llm_provider_id ?? null,
    webSearchEnabled: Boolean(p.web_search_enabled),
    updatedAt: p.updated_at,
    ...extra,
  };
}

function parseCookie(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    out[k] = decodeURIComponent(v);
  }
  return out;
}

function setSessionCookie(
  reply: FastifyReply,
  cfg: AppConfig,
  sid: string,
): void {
  const maxAge = 7 * 24 * 3600;
  const secure = cfg.cookieSecure ? "; Secure" : "";
  reply.header(
    "Set-Cookie",
    `${cfg.sessionCookieName}=${encodeURIComponent(sid)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`,
  );
}

function clearSessionCookie(reply: FastifyReply, cfg: AppConfig): void {
  reply.header(
    "Set-Cookie",
    `${cfg.sessionCookieName}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`,
  );
}

async function requireUser(
  req: FastifyRequest,
  reply: FastifyReply,
  ctx: RouteContext,
): Promise<User | null> {
  const cookies = parseCookie(req.headers.cookie);
  const sid = cookies[ctx.cfg.sessionCookieName];
  if (!sid) {
    reply.code(401).send({ error: "login_required" });
    return null;
  }
  const sess = await getAppSession(ctx.db, sid);
  if (!sess) {
    reply.code(401).send({ error: "session_expired" });
    return null;
  }
  const user = await getUser(ctx.db, sess.userId);
  if (!user) {
    reply.code(401).send({ error: "user_not_found" });
    return null;
  }
  if (isUserBanned(user)) {
    await destroyAppSession(ctx.db, sid);
    clearSessionCookie(reply, ctx.cfg);
    reply.code(403).send({
      error: "user_banned",
      message: user.banned_reason || "账号已被封禁",
    });
    return null;
  }
  return user;
}

/**
 * Rate-limit key. Forwarded IPs only count when the request proves it came
 * through our own LB — otherwise anyone hitting the origin directly picks their
 * own bucket and the auth limiters stop limiting. See client-ip.ts.
 */
function clientIp(req: FastifyRequest, proxySecret: string): string {
  return resolveClientIp({
    headers: req.headers,
    socketIp: req.ip,
    proxySecret,
  });
}

function inviteDefaultsFromCfg(cfg: AppConfig) {
  return {
    quotaWindowHours: cfg.inviteQuotaWindowHours,
    quotaMax: cfg.inviteQuotaMax,
    codeTtlSec: cfg.inviteCodeTtlSec,
    maxPendingPerUser: cfg.inviteMaxPendingPerUser,
    codeLength: cfg.inviteCodeLength,
  };
}

function inviteUrl(cfg: AppConfig, code: string): string {
  const base = cfg.publicBaseUrl.replace(/\/$/, "");
  return `${base}/app?invite=${encodeURIComponent(code)}`;
}

async function requireAdmin(
  req: FastifyRequest,
  reply: FastifyReply,
  ctx: RouteContext,
): Promise<User | null> {
  const user = await requireUser(req, reply, ctx);
  if (!user) return null;
  if (!user.is_admin) {
    reply.code(403).send({ error: "admin_required" });
    return null;
  }
  return user;
}

/** First system admin only (earliest created_at among is_admin users). */
async function requireSuperAdmin(
  req: FastifyRequest,
  reply: FastifyReply,
  ctx: RouteContext,
): Promise<User | null> {
  const admin = await requireAdmin(req, reply, ctx);
  if (!admin) return null;
  if (!(await isSuperAdmin(ctx.db, admin.id))) {
    reply.code(403).send({
      error: "super_admin_required",
      message: "仅系统首位管理员（超管）可执行此操作",
    });
    return null;
  }
  return admin;
}

/**
 * Send non-public sticker bytes (own / pending / admin review) with ETag
 * revalidation. Sticker blobs are content-addressed, so a matching
 * If-None-Match lets us answer 304 *without* pulling the blob out of Redis —
 * these endpoints back thumbnail grids, so that is the whole page's cost.
 */
async function sendPrivateStickerImage(
  ctx: RouteContext,
  req: FastifyRequest,
  reply: FastifyReply,
  sticker: Sticker,
): Promise<unknown> {
  let s = sticker;
  if (!s.content_hash) {
    s = (await ensureStickerContentHash(ctx.db, s)) ?? s;
  }
  const etag = s.content_hash ? etagFromHash(s.content_hash) : null;
  reply.header("Cache-Control", CC_PRIVATE_STICKER);
  if (etag) {
    reply.header("ETag", etag);
    if (ifNoneMatchHits(req.headers["if-none-match"], etag)) {
      return reply.code(304).send();
    }
  }
  const buf = await getStickerBlob(ctx.db, s.id);
  if (!buf) return reply.code(404).send({ error: "blob missing" });
  return reply.type(s.mime || "application/octet-stream").send(buf);
}

/** Parse comma-separated type filters: message,redis,worker,llm or exact types. */
function parseStreamTypeFilter(raw?: string): Set<string> | null {
  if (!raw?.trim()) return null;
  const parts = raw
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  if (!parts.length) return null;
  return new Set(parts);
}

function streamTypeMatches(type: string, filter: Set<string>): boolean {
  const t = type.toLowerCase();
  if (filter.has(t)) return true;
  // group prefixes: message → message.in / message.out
  for (const f of filter) {
    if (t === f || t.startsWith(f + ".")) return true;
  }
  return false;
}

/**
 * Shape event for client: short preview by default; full=1 uses fullText (cap 2k).
 * Worker emits both preview (48) and fullText (≤2000).
 */
function shapeStreamEventForClient(
  ev: import("./activity-stream.js").StreamEvent,
  full: boolean,
): import("./activity-stream.js").StreamEvent {
  if (!ev.data || !ev.type.startsWith("message.")) {
    if (!ev.data) return ev;
    // Strip fullText from non-message if ever present
    if ("fullText" in ev.data || "text" in ev.data) {
      const data = { ...ev.data };
      delete data.fullText;
      delete data.text;
      return { ...ev, data };
    }
    return ev;
  }
  const data = { ...ev.data };
  const short =
    typeof data.preview === "string" ? data.preview : "";
  const long =
    typeof data.fullText === "string"
      ? data.fullText
      : typeof data.text === "string"
        ? data.text
        : short;
  const len =
    typeof data.len === "number" ? data.len : Math.max(short.length, long.length);
  const chosen = full ? long : short || long.slice(0, 48);
  const cap = full ? 2000 : 48;
  let preview = chosen;
  let truncated = len > chosen.length || !!data.truncated;
  if (preview.length > cap) {
    preview = preview.slice(0, cap) + "…";
    truncated = true;
  }
  data.preview = preview;
  data.len = len;
  data.truncated = truncated;
  delete data.fullText;
  delete data.text;
  return { ...ev, data };
}

export async function registerRoutes(
  app: FastifyInstance,
  ctx: RouteContext,
): Promise<void> {
  // CORS only on /api/v1 — never on HTML shells (keeps CF cache clean)
  app.addHook("onRequest", async (req, reply) => {
    const path = req.url.split("?")[0] || "";
    if (!path.startsWith("/api/v1")) return;

    const origin = req.headers.origin;
    if (origin && ctx.cfg.corsOrigins.has(origin)) {
      reply.header("Access-Control-Allow-Origin", origin);
      reply.header("Access-Control-Allow-Credentials", "true");
      reply.header("Vary", "Origin");
    }
    reply.header(
      "Access-Control-Allow-Headers",
      "Authorization, Content-Type",
    );
    reply.header("Access-Control-Allow-Methods", "GET,POST,PUT,DELETE,OPTIONS");
    if (req.method === "OPTIONS") {
      return reply.code(204).send();
    }
  });

  // Default: private APIs must not be shared-cached
  app.addHook("onSend", async (req, reply, payload) => {
    const path = req.url.split("?")[0] || "";
    if (!path.startsWith("/api/v1")) return payload;
    if (!reply.getHeader("cache-control") && !reply.getHeader("Cache-Control")) {
      reply.header("Cache-Control", CC_PRIVATE_NO_STORE);
    }
    return payload;
  });

  app.get("/health", async (_req, reply) => {
    reply.header("Cache-Control", CC_NO_STORE);
    return { ok: true, service: "wechat-ai" };
  });

  /** Cache tools /health so readiness probes stay cheap (TTL 15s). */
  let toolsHealthCache: { at: number; ok: boolean } | null = null;
  let toolsHealthInflight: Promise<{ ok: boolean }> | null = null;
  const TOOLS_HEALTH_TTL_MS = 15_000;
  const cachedToolsHealth = async (
    baseUrl: string,
  ): Promise<{ ok: boolean }> => {
    const now = Date.now();
    if (toolsHealthCache && now - toolsHealthCache.at < TOOLS_HEALTH_TTL_MS) {
      return { ok: toolsHealthCache.ok };
    }
    if (toolsHealthInflight) return toolsHealthInflight;
    toolsHealthInflight = probeToolsHealth(baseUrl, 4000)
      .then((r) => {
        toolsHealthCache = { at: Date.now(), ok: r.ok };
        return { ok: r.ok };
      })
      .catch(() => {
        toolsHealthCache = { at: Date.now(), ok: false };
        return { ok: false };
      })
      .finally(() => {
        toolsHealthInflight = null;
      });
    return toolsHealthInflight;
  };

  /** LB / CF Worker readiness: Redis + process identity (short timeout on client). */
  app.get("/health/ready", async (_req, reply) => {
    reply.header("Cache-Control", CC_NO_STORE);
    const workerId = ctx.worker.getWorkerId();
    // LB probes hit this constantly — run the three checks concurrently.
    // Tools gateway is the only egress for user custom LLM + web search;
    // cachedToolsHealth keeps probes off HF.
    const workerRunning = ctx.worker.isRunning();
    const [redisOk, tools] = await Promise.all([
      ctx.db.ping().then(
        () => true,
        () => false,
      ),
      ctx.cfg.toolsBaseUrl
        ? cachedToolsHealth(ctx.cfg.toolsBaseUrl)
        : Promise.resolve(null),
    ]);
    // Required only when the deployment actually depends on tools
    const toolsRequired =
      Boolean(ctx.cfg.toolsBaseUrl) && ctx.cfg.webSearchEnabled;
    const ok = redisOk && (!toolsRequired || tools?.ok === true);
    const body = {
      ok,
      service: "wechat-ai",
      redis: redisOk,
      workerId,
      workerRunning,
      workerEnabled: ctx.cfg.workerEnabled,
      tools: ctx.cfg.toolsBaseUrl
        ? { configured: true, ok: tools?.ok === true, required: toolsRequired }
        : { configured: false, ok: false, required: false },
    };
    if (!ok) return reply.code(503).send(body);
    return body;
  });

  // Public CDN: approved + public + enabled stickers only (no cookie)
  const cdnLimiter = new RateLimiter(120, 60_000);
  app.get<{ Params: { id: string }; Querystring: { v?: string } }>(
    "/cdn/s/:id",
    async (req, reply) => {
      const ip =
        (req.headers["cf-connecting-ip"] as string | undefined) ||
        req.ip ||
        "unknown";
      if (!cdnLimiter.tryTake(`cdn:${ip}`)) {
        return reply.code(429).send({ error: "rate limited" });
      }
      // Strip accidental extension from id (e.g. sticker_xxx.png)
      let id = req.params.id || "";
      id = id.replace(/\.(png|jpe?g|gif|webp|bin)$/i, "");
      if (!id) return reply.code(404).send({ error: "not found" });

      let s = await getSticker(ctx.db, id);
      if (
        !s ||
        !s.enabled ||
        s.visibility !== "public" ||
        s.review_status !== "approved"
      ) {
        return reply.code(404).send({ error: "not found" });
      }
      if (!s.content_hash) {
        s = (await ensureStickerContentHash(ctx.db, s)) ?? s;
      }
      // Answer conditional requests from the content hash alone — no reason to
      // pull the blob out of Redis just to throw it away on a 304.
      if (s.content_hash) {
        const etag = etagFromHash(s.content_hash);
        setPublicCache(reply, CC_CDN_STICKER, CDN_CDN_STICKER, {
          etag,
          cacheTag: `sticker-${s.id}`,
        });
        if (ifNoneMatchHits(req.headers["if-none-match"], etag)) {
          return reply.code(304).send();
        }
        const buf = await getStickerBlob(ctx.db, s.id);
        if (!buf) return reply.code(404).send({ error: "not found" });
        return reply.type(s.mime || "application/octet-stream").send(buf);
      }

      // No hash (blob missing on migrate) — fall back to length-based ETag
      const buf = await getStickerBlob(ctx.db, s.id);
      if (!buf) return reply.code(404).send({ error: "not found" });
      const etag = etagFromHash(String(buf.length));
      setPublicCache(reply, CC_CDN_STICKER, CDN_CDN_STICKER, {
        etag,
        cacheTag: `sticker-${s.id}`,
      });
      if (ifNoneMatchHits(req.headers["if-none-match"], etag)) {
        return reply.code(304).send();
      }
      return reply.type(s.mime || "application/octet-stream").send(buf);
    },
  );

  // ── Auth (LINUX DO OAuth + local password + invites) ──

  const authLoginLimiter = new RateLimiter(20, 60_000);
  const authRegisterLimiter = new RateLimiter(10, 60_000);
  const authInvitePeekLimiter = new RateLimiter(40, 60_000);

  app.get("/api/v1/auth/config", async (_req, reply) => {
    setPrivateNoStore(reply);
    const oauth = loadLinuxDoConfig();
    // Publish the register endpoint's invite waiver so the register form can
    // drop its invite field instead of blocking a fresh local-only deployment
    // on a code nobody can issue yet.
    //
    // canBootstrapFirstAdmin stays the authority; the two config terms repeated
    // in front of it are only a short-circuit, because this endpoint is
    // unauthenticated, uncached and hit on every page load, and no user count
    // can flip the answer once either of them is false. Don't fold them away.
    const bootstrapAvailable =
      ctx.cfg.localAuthEnabled &&
      ctx.cfg.firstUserIsAdmin &&
      ctx.cfg.adminIds.size === 0 &&
      canBootstrapFirstAdmin({
        totalUsers: await countUsers(ctx.db),
        firstUserIsAdmin: ctx.cfg.firstUserIsAdmin,
        adminIdCount: ctx.cfg.adminIds.size,
      });
    return {
      oauthEnabled: Boolean(oauth) && ctx.cfg.linuxdoAuthEnabled,
      provider: "linux.do",
      localAuthEnabled: ctx.cfg.localAuthEnabled,
      inviteRequiredForLocal: ctx.cfg.inviteRequiredForLocal,
      bootstrapAvailable,
      passwordMinLength: ctx.cfg.passwordMinLength,
    };
  });

  app.get("/api/v1/auth/login", async (req, reply) => {
    const oauth = loadLinuxDoConfig();
    if (!ctx.cfg.linuxdoAuthEnabled) {
      return reply
        .code(503)
        .send({ error: "LINUX DO 登录已关闭（LINUXDO_AUTH_ENABLED=false）" });
    }
    if (!oauth) {
      return reply
        .code(503)
        .send({ error: "LINUX DO OAuth 未配置（LINUXDO_CLIENT_ID/SECRET/REDIRECT_URI）" });
    }
    const state = newOAuthState();
    const q = req.query as { redirect?: string };
    await saveOauthState(ctx.db, state, { redirect: q.redirect || "/app" });
    return reply.redirect(buildAuthorizeUrl(oauth, state));
  });

  app.get("/api/v1/auth/callback", async (req, reply) => {
    const oauth = loadLinuxDoConfig();
    if (!ctx.cfg.linuxdoAuthEnabled) {
      return reply.code(503).type("text/plain; charset=utf-8").send("LINUX DO 登录已关闭");
    }
    if (!oauth) return reply.code(503).send("oauth not configured");
    const q = req.query as { code?: string; state?: string; error?: string };
    if (q.error) return reply.code(400).send(`oauth error: ${q.error}`);
    if (!q.code || !q.state) return reply.code(400).send("missing code/state");
    const st = await takeOauthState(ctx.db, q.state);
    if (!st) return reply.code(400).send("invalid or expired state");

    try {
      const token = await exchangeCode(oauth, q.code);
      const info = await fetchUserInfo(oauth, token.access_token);
      const user = await upsertUser(
        ctx.db,
        {
          id: String(info.id),
          username: info.username,
          name: info.name || info.username,
          avatarUrl: info.avatar_url ?? null,
          trustLevel: info.trust_level ?? 0,
          authProvider: "linuxdo",
        },
        ctx.cfg.adminIds,
        {
          firstUserIsAdmin: ctx.cfg.firstUserIsAdmin,
        },
      );
      if (isUserBanned(user)) {
        return reply
          .code(403)
          .type("text/plain; charset=utf-8")
          .send(
            `账号已被封禁${user.banned_reason ? `：${user.banned_reason}` : ""}`,
          );
      }
      const sid = await createAppSession(ctx.db, user.id);
      setSessionCookie(reply, ctx.cfg, sid);
      await writeAudit(ctx.db, "user_login", user.id, {
        username: user.username,
        is_admin: user.is_admin,
        method: "oauth",
      });
      const dest = st.redirect?.startsWith("/") ? st.redirect : "/app";
      return reply.redirect(dest);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return reply.code(502).type("text/plain").send(`OAuth failed: ${msg}`);
    }
  });

  app.post<{
    Body: {
      username?: string;
      password?: string;
      inviteCode?: string;
      name?: string;
    };
  }>("/api/v1/auth/register", async (req, reply) => {
    if (!ctx.cfg.localAuthEnabled) {
      return reply.code(503).send({ error: "local_auth_disabled" });
    }
    const ip = clientIp(req, ctx.cfg.originProxySecret);
    if (!authRegisterLimiter.tryTake(`reg:${ip}`)) {
      return reply.code(429).send({ error: "rate limited" });
    }
    const usernameRaw = String(req.body?.username || "");
    const password = String(req.body?.password || "");
    const inviteCode = String(req.body?.inviteCode || "");
    const name = req.body?.name ? String(req.body.name).trim() : undefined;

    let username: string;
    try {
      username = validateLocalUsername(usernameRaw);
      assertPasswordPolicy(password, ctx.cfg.passwordMinLength);
    } catch (e) {
      const msg = e instanceof Error ? e.message : "invalid";
      if (msg === "weak_password") {
        return reply.code(400).send({
          error: "weak_password",
          message: `密码至少 ${ctx.cfg.passwordMinLength} 位`,
        });
      }
      if (msg === "reserved_username") {
        return reply.code(400).send({ error: "reserved_username", message: "用户名不可用" });
      }
      return reply.code(400).send({
        error: "invalid_username",
        message: "用户名须以字母开头，3–32 位字母/数字/下划线",
      });
    }

    // Unauthenticated endpoint — never scan the user table here. SCARD is O(1)
    // and only feeds the `is this the very first user` check.
    const [settings, totalUsers] = await Promise.all([
      getInviteSettings(ctx.db, inviteDefaultsFromCfg(ctx.cfg)),
      countUsers(ctx.db),
    ]);
    const needInvite = ctx.cfg.inviteRequiredForLocal;
    const bootstrap = canBootstrapFirstAdmin({
      totalUsers,
      firstUserIsAdmin: ctx.cfg.firstUserIsAdmin,
      adminIdCount: ctx.cfg.adminIds.size,
    });

    let inviteRec: Awaited<ReturnType<typeof peekInviteCode>> = null;
    if (needInvite && !bootstrap) {
      inviteRec = await peekInviteCode(ctx.db, inviteCode);
      if (!inviteRec) {
        return reply.code(400).send({
          error: "invalid_invite",
          message: "邀请码无效或已使用",
        });
      }
    }

    const passwordHash = await hashPassword(password);
    let user;
    try {
      // Create user first (claims username). Consume invite after; roll back if race.
      try {
        user = await createLocalUser(
          ctx.db,
          {
            username,
            passwordHash,
            name,
            invitedBy: inviteRec?.inviterUserId ?? null,
            inviteCodeUsed: inviteRec?.code ?? null,
          },
          ctx.cfg.adminIds,
          { firstUserIsAdmin: ctx.cfg.firstUserIsAdmin },
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg === "username_taken") {
          return reply.code(409).send({
            error: "username_taken",
            message: "用户名已被占用",
          });
        }
        if (msg === "invalid_username" || msg === "reserved_username") {
          return reply.code(400).send({
            error: msg,
            message:
              msg === "reserved_username"
                ? "用户名不可用"
                : "用户名须以字母开头，3–32 位字母/数字/下划线",
          });
        }
        throw err;
      }

      if (needInvite && !bootstrap) {
        const consumed = await consumeInviteCode(ctx.db, inviteCode, user.id);
        if (!consumed) {
          await deleteUserAccount(ctx.db, user.id);
          return reply.code(400).send({
            error: "invalid_invite",
            message: "邀请码无效或已使用",
          });
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return reply.code(400).send({ error: msg });
    }

    const sid = await createAppSession(ctx.db, user.id);
    setSessionCookie(reply, ctx.cfg, sid);
    await writeAudit(ctx.db, "user_register", user.id, {
      username: user.username,
      method: "password",
      invitedBy: user.invited_by,
      inviteCode: user.invite_code_used,
    });
    return { user: userPublicFields(user) };
  });

  app.post<{ Body: { username?: string; password?: string } }>(
    "/api/v1/auth/password-login",
    async (req, reply) => {
      if (!ctx.cfg.localAuthEnabled) {
        return reply.code(503).send({ error: "local_auth_disabled" });
      }
      const ip = clientIp(req, ctx.cfg.originProxySecret);
      const usernameRaw = String(req.body?.username || "").trim();
      const password = String(req.body?.password || "");
      const unameKey = usernameRaw.toLowerCase() || "-";
      if (
        !authLoginLimiter.tryTake(`login:${ip}`) ||
        !authLoginLimiter.tryTake(`loginu:${unameKey}`)
      ) {
        return reply.code(429).send({ error: "rate limited" });
      }
      const user = usernameRaw
        ? await getUserByUsername(ctx.db, usernameRaw)
        : undefined;
      const hash = user?.password_hash || null;
      // Always verify to reduce timing gap when hash exists; dummy when missing
      let ok = false;
      if (hash) {
        ok = await verifyPassword(password, hash);
      } else {
        // burn some CPU with a failed verify against a fixed-format dummy
        await verifyPassword(
          password || "x",
          "scrypt$16384$8$1$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        );
        ok = false;
      }
      if (!ok || !user) {
        return reply.code(401).send({ error: "invalid_credentials" });
      }
      if (isUserBanned(user)) {
        return reply.code(403).send({
          error: "user_banned",
          message: user.banned_reason || "账号已被封禁",
        });
      }
      const sid = await createAppSession(ctx.db, user.id);
      setSessionCookie(reply, ctx.cfg, sid);
      await writeAudit(ctx.db, "user_login", user.id, {
        username: user.username,
        method: "password",
      });
      return { user: userPublicFields(user) };
    },
  );

  app.get<{ Params: { code: string } }>(
    "/api/v1/auth/invite/:code",
    async (req, reply) => {
      const ip = clientIp(req, ctx.cfg.originProxySecret);
      if (!authInvitePeekLimiter.tryTake(`invpeek:${ip}`)) {
        return reply.code(429).send({ error: "rate limited" });
      }
      const rec = await peekInviteCode(ctx.db, req.params.code);
      if (!rec) {
        return { valid: false };
      }
      return {
        valid: true,
        expiresAt: rec.expiresAt,
        inviterUsername: rec.inviterUsername,
      };
    },
  );

  app.post("/api/v1/auth/logout", async (req, reply) => {
    const cookies = parseCookie(req.headers.cookie);
    const sid = cookies[ctx.cfg.sessionCookieName];
    if (sid) await destroyAppSession(ctx.db, sid);
    clearSessionCookie(reply, ctx.cfg);
    return { ok: true };
  });

  app.get("/api/v1/auth/me", async (req, reply) => {
    const user = await requireUser(req, reply, ctx);
    if (!user) return;
    const superAdmin = user.is_admin
      ? await isSuperAdmin(ctx.db, user.id)
      : false;
    return {
      user: {
        ...userPublicFields(user),
        isSuperAdmin: superAdmin,
      },
    };
  });

  // ── Me: invites ───────────────────────────────────────

  app.get("/api/v1/me/invites", async (req, reply) => {
    const user = await requireUser(req, reply, ctx);
    if (!user) return;
    const settings = await getInviteSettings(
      ctx.db,
      inviteDefaultsFromCfg(ctx.cfg),
    );
    const [items, quota] = await Promise.all([
      listPendingInvites(ctx.db, user.id),
      getInviteQuotaStatus(ctx.db, user.id, settings),
    ]);
    return {
      items: items.map((i) => ({
        code: i.code,
        createdAt: i.createdAt,
        expiresAt: i.expiresAt,
        inviteUrl: inviteUrl(ctx.cfg, i.code),
      })),
      quota: {
        used: quota.used,
        max: Number.isFinite(quota.max) ? quota.max : null,
        windowHours: quota.windowHours,
        remaining: Number.isFinite(quota.remaining) ? quota.remaining : null,
        retryAfterSec: quota.retryAfterSec,
      },
      settings: {
        maxPendingPerUser: settings.maxPendingPerUser,
        codeTtlSec: settings.codeTtlSec,
      },
    };
  });

  app.post("/api/v1/me/invites", async (req, reply) => {
    const user = await requireUser(req, reply, ctx);
    if (!user) return;
    const settings = await getInviteSettings(
      ctx.db,
      inviteDefaultsFromCfg(ctx.cfg),
    );
    try {
      const result = await createInviteCode(ctx.db, {
        inviterUserId: user.id,
        inviterUsername: user.username,
        settings,
      });
      if (!result.ok) {
        if (result.error === "invite_quota") {
          return reply.code(429).send({
            error: "invite_quota",
            message: "邀请生成次数已达上限，请稍后再试",
            used: result.quota?.used,
            max: result.quota?.max,
            windowHours: result.quota?.windowHours,
            retryAfterSec: result.quota?.retryAfterSec,
          });
        }
        return reply.code(400).send({
          error: "invite_pending_limit",
          message: `未使用邀请码过多（最多 ${result.maxPending} 个）`,
          maxPending: result.maxPending,
        });
      }
      await writeAudit(ctx.db, "invite_created", user.id, {
        code: result.invite.code,
      });
      return {
        code: result.invite.code,
        createdAt: result.invite.createdAt,
        expiresAt: result.invite.expiresAt,
        inviteUrl: inviteUrl(ctx.cfg, result.invite.code),
        quota: {
          used: result.quota.used,
          max: Number.isFinite(result.quota.max) ? result.quota.max : null,
          windowHours: result.quota.windowHours,
          remaining: Number.isFinite(result.quota.remaining)
            ? result.quota.remaining
            : null,
          retryAfterSec: result.quota.retryAfterSec,
        },
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return reply.code(500).send({ error: message });
    }
  });

  app.delete<{ Params: { code: string } }>(
    "/api/v1/me/invites/:code",
    async (req, reply) => {
      const user = await requireUser(req, reply, ctx);
      if (!user) return;
      const ok = await revokeInviteCode(ctx.db, user.id, req.params.code);
      if (!ok) return reply.code(404).send({ error: "not found" });
      await writeAudit(ctx.db, "invite_revoked", user.id, {
        code: req.params.code,
      });
      return { ok: true };
    },
  );

  // ── WeChat ↔ LINUX DO bind (for @username P2P) ─────

  app.get("/api/v1/me/wechat-bind", async (req, reply) => {
    const user = await requireUser(req, reply, ctx);
    if (!user) return;
    if (!ctx.cfg.p2pEnabled) {
      return { enabled: false, bound: false };
    }
    const bind = await getBindByUser(ctx.db, user.id);
    if (!bind) {
      return {
        enabled: true,
        bound: false,
        username: user.username,
      };
    }
    const ctxToken = await getContextToken(ctx.db, bind.botId, bind.peerId);
    return {
      enabled: true,
      bound: true,
      username: user.username,
      botId: bind.botId,
      peerId: bind.peerId,
      boundAt: bind.boundAt,
      reachable: Boolean(ctxToken),
    };
  });

  app.post("/api/v1/me/wechat-bind/code", async (req, reply) => {
    const user = await requireUser(req, reply, ctx);
    if (!user) return;
    if (!ctx.cfg.p2pEnabled) {
      return reply.code(503).send({ error: "p2p_disabled" });
    }
    try {
      const rec = await createBindCode(
        ctx.db,
        user.id,
        user.username,
        ctx.cfg.p2pBindCodeTtlSec,
      );
      await writeAudit(ctx.db, "wechat_bind_code", user.id, {
        codePrefix: rec.code.slice(0, 2),
      });
      return {
        code: rec.code,
        expiresInSec: ctx.cfg.p2pBindCodeTtlSec,
        username: user.username,
        instruction: `在微信中给机器人发送：/绑定 ${rec.code}`,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return reply.code(500).send({ error: message });
    }
  });

  app.delete("/api/v1/me/wechat-bind", async (req, reply) => {
    const user = await requireUser(req, reply, ctx);
    if (!user) return;
    const prev = await clearPrimaryBind(ctx.db, user.id);
    await writeAudit(ctx.db, "wechat_bind_clear", user.id, {
      hadBind: Boolean(prev),
      botId: prev?.botId,
      peerId: prev?.peerId,
    });
    return { ok: true, cleared: Boolean(prev) };
  });

  // ── P2P block list ───────────────────────────────────

  app.get("/api/v1/me/blocks", async (req, reply) => {
    const user = await requireUser(req, reply, ctx);
    if (!user) return;
    if (!ctx.cfg.p2pEnabled) {
      return { enabled: false, blocks: [] };
    }
    const ids = await listBlockedUserIds(ctx.db, user.id);
    const map = await getUsersByIds(ctx.db, ids);
    const blocks = ids.map((id) => {
      const u = map.get(id);
      return {
        userId: id,
        username: u?.username ?? null,
        name: u?.name ?? null,
        avatarUrl: u?.avatar_url ?? null,
      };
    });
    return { enabled: true, blocks };
  });

  app.post<{ Body: { username?: string; userId?: string } }>(
    "/api/v1/me/blocks",
    async (req, reply) => {
      const user = await requireUser(req, reply, ctx);
      if (!user) return;
      if (!ctx.cfg.p2pEnabled) {
        return reply.code(503).send({ error: "p2p_disabled" });
      }
      const username = (req.body?.username || "").trim();
      let targetId = (req.body?.userId || "").trim();
      let targetUser = targetId ? await getUser(ctx.db, targetId) : undefined;
      if (!targetUser && username) {
        targetUser = await getUserByUsername(ctx.db, username);
        targetId = targetUser?.id || "";
      }
      if (!targetUser || !targetId) {
        return reply.code(404).send({ error: "user_not_found" });
      }
      const r = await blockUser(ctx.db, user.id, targetId);
      if (!r.ok && r.reason === "self") {
        return reply.code(400).send({ error: "cannot_block_self" });
      }
      await writeAudit(ctx.db, "p2p_block", user.id, {
        blockedUserId: targetId,
        username: targetUser.username,
        already: r.ok === false && r.reason === "already",
      });
      return {
        ok: true,
        already: r.ok === false && r.reason === "already",
        blocked: {
          userId: targetUser.id,
          username: targetUser.username,
          name: targetUser.name,
        },
      };
    },
  );

  app.delete<{ Params: { userId: string } }>(
    "/api/v1/me/blocks/:userId",
    async (req, reply) => {
      const user = await requireUser(req, reply, ctx);
      if (!user) return;
      const targetId = req.params.userId;
      if (!targetId) {
        return reply.code(400).send({ error: "userId required" });
      }
      const removed = await unblockUser(ctx.db, user.id, targetId);
      await writeAudit(ctx.db, "p2p_unblock", user.id, {
        blockedUserId: targetId,
        removed,
      });
      return { ok: true, removed };
    },
  );

  // ── User bots ────────────────────────────────────────

  function proactiveDefaults() {
    return {
      idleHours: ctx.cfg.proactiveIdleHours,
      minIntervalHours: ctx.cfg.proactiveMinIntervalHours,
      maxPerDay: ctx.cfg.proactiveMaxPerDay,
      quietHours: ctx.cfg.proactiveQuietHours,
    };
  }

  function mapBotProactive(b: {
    proactive_enabled?: number;
    proactive_idle_hours?: number;
    proactive_min_interval_hours?: number;
    proactive_max_per_day?: number;
    proactive_quiet_hours?: string | null;
  }) {
    const merged = mergeBotProactiveConfig(b, proactiveDefaults());
    return {
      globalProactiveEnabled: ctx.cfg.proactiveEnabled,
      proactiveEnabled: merged.enabled,
      proactiveIdleHours: merged.idleHours,
      proactiveMinIntervalHours: merged.minIntervalHours,
      proactiveMaxPerDay: merged.maxPerDay,
      proactiveQuietHours: merged.quietHours,
    };
  }

  app.get("/api/v1/me/bots", async (req, reply) => {
    const user = await requireUser(req, reply, ctx);
    if (!user) return;
    const bots = await listBotsByOwner(ctx.db, user.id);
    const tokenMap = await hasBotCredentialsMany(
      ctx.db,
      bots.map((b) => b.id),
    );
    const mapped = bots.map((b) => ({
      id: b.id,
      displayName: b.display_name,
      accountRef: b.account_ref,
      status: b.status,
      ownerUserId: b.owner_user_id,
      hasToken: Boolean(tokenMap[b.id]),
      ...mapBotProactive(b),
    }));
    return { bots: mapped };
  });

  app.post<{ Body: { displayName?: string } }>(
    "/api/v1/me/bots/login/start",
    async (req, reply) => {
      const user = await requireUser(req, reply, ctx);
      if (!user) return;
      try {
        const session = await ctx.loginSessions.start(
          user.id,
          req.body?.displayName,
        );
        return { session };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return reply.code(502).send({ error: message });
      }
    },
  );

  /** Re-scan QR to refresh token for an existing bot (keeps peers / memories / assignments). */
  app.post<{ Params: { botId: string } }>(
    "/api/v1/me/bots/:botId/relogin/start",
    async (req, reply) => {
      const user = await requireUser(req, reply, ctx);
      if (!user) return;
      const bot = await getBotAccount(ctx.db, req.params.botId);
      if (!bot) return reply.code(404).send({ error: "not found" });
      if (bot.owner_user_id !== user.id && !user.is_admin) {
        return reply.code(403).send({ error: "forbidden" });
      }
      try {
        // Session owner = acting user (so poll/cancel ACL works for owner or admin)
        const session = await ctx.loginSessions.start(
          user.id,
          bot.display_name,
          { rebindBotId: bot.id },
        );
        return { session };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (/not found/i.test(message)) {
          return reply.code(404).send({ error: message });
        }
        return reply.code(502).send({ error: message });
      }
    },
  );

  app.get<{ Params: { sessionId: string } }>(
    "/api/v1/me/bots/login/:sessionId",
    async (req, reply) => {
      const user = await requireUser(req, reply, ctx);
      if (!user) return;
      const session = await ctx.loginSessions.get(req.params.sessionId);
      if (!session || session.ownerUserId !== user.id) {
        return reply.code(404).send({ error: "session not found" });
      }
      return { session };
    },
  );

  /**
   * Login QR as SVG, rendered on this box.
   *
   * The scan link embeds a login ticket. It used to be handed to
   * api.qrserver.com as a query parameter to get a QR image back, which put a
   * credential in a third party's logs. Rendering locally keeps it between this
   * origin and the owner's browser. Served as its own resource (rather than
   * inlined in the 1.5s status poll) so the browser fetches it once.
   */
  app.get<{ Params: { sessionId: string } }>(
    "/api/v1/me/bots/login/:sessionId/qr.svg",
    async (req, reply) => {
      const user = await requireUser(req, reply, ctx);
      if (!user) return;
      const session = await ctx.loginSessions.get(req.params.sessionId);
      if (!session || session.ownerUserId !== user.id) {
        return reply.code(404).send({ error: "session not found" });
      }
      if (!session.openUrl) {
        return reply.code(409).send({ error: "qr not ready" });
      }

      let svg: string;
      try {
        svg = qrSvg(session.openUrl, { ec: "M", border: 4, pixelSize: 200 });
      } catch (err) {
        req.log?.warn(
          { err, sessionId: session.sessionId },
          "qr render failed",
        );
        return reply.code(500).send({ error: "qr render failed" });
      }

      reply.header("Content-Type", "image/svg+xml; charset=utf-8");
      // Ticket-bearing and per-owner: never shared, never stored. The client
      // fetches this once per login session, so no-store costs nothing.
      reply.header("Cache-Control", CC_PRIVATE_QR);
      return reply.send(svg);
    },
  );

  app.post<{ Params: { sessionId: string } }>(
    "/api/v1/me/bots/login/:sessionId/cancel",
    async (req, reply) => {
      const user = await requireUser(req, reply, ctx);
      if (!user) return;
      const ok = await ctx.loginSessions.cancel(req.params.sessionId, user.id);
      if (!ok) return reply.code(404).send({ error: "session not found" });
      return { ok: true };
    },
  );

  app.patch<{
    Params: { botId: string };
    Body: {
      displayName?: string;
      proactiveEnabled?: boolean;
      proactiveIdleHours?: number;
      proactiveMinIntervalHours?: number;
      proactiveMaxPerDay?: number;
      proactiveQuietHours?: string | null;
    };
  }>("/api/v1/me/bots/:botId", async (req, reply) => {
    const user = await requireUser(req, reply, ctx);
    if (!user) return;
    const bot = await getBotAccount(ctx.db, req.params.botId);
    if (!bot) return reply.code(404).send({ error: "not found" });
    if (bot.owner_user_id !== user.id && !user.is_admin) {
      return reply.code(403).send({ error: "forbidden" });
    }
    const body = req.body ?? {};
    const hasName = body.displayName !== undefined;
    const hasProactive =
      body.proactiveEnabled !== undefined ||
      body.proactiveIdleHours !== undefined ||
      body.proactiveMinIntervalHours !== undefined ||
      body.proactiveMaxPerDay !== undefined ||
      body.proactiveQuietHours !== undefined;

    if (!hasName && !hasProactive) {
      return reply.code(400).send({
        error: "displayName or proactive settings required",
      });
    }

    try {
      let updated = bot;
      if (hasName) {
        if (!body.displayName?.trim()) {
          return reply.code(400).send({ error: "displayName required" });
        }
        updated = await updateBotDisplayName(
          ctx.db,
          bot.id,
          body.displayName,
        );
        await writeAudit(ctx.db, "bot_renamed", user.id, {
          botId: bot.id,
          displayName: updated.display_name,
        });
      }
      if (hasProactive) {
        updated = await updateBotProactiveSettings(ctx.db, bot.id, {
          proactiveEnabled: body.proactiveEnabled,
          proactiveIdleHours: body.proactiveIdleHours,
          proactiveMinIntervalHours: body.proactiveMinIntervalHours,
          proactiveMaxPerDay: body.proactiveMaxPerDay,
          proactiveQuietHours: body.proactiveQuietHours,
        });
        await writeAudit(ctx.db, "bot_proactive_updated", user.id, {
          botId: bot.id,
          proactiveEnabled: updated.proactive_enabled,
          proactiveIdleHours: updated.proactive_idle_hours,
          proactiveMinIntervalHours: updated.proactive_min_interval_hours,
          proactiveMaxPerDay: updated.proactive_max_per_day,
          proactiveQuietHours: updated.proactive_quiet_hours,
        });
      }
      return {
        bot: {
          id: updated.id,
          displayName: updated.display_name,
          accountRef: updated.account_ref,
          status: updated.status,
          ownerUserId: updated.owner_user_id,
          ...mapBotProactive(updated),
        },
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return reply.code(400).send({ error: message });
    }
  });

  app.delete<{ Params: { botId: string } }>(
    "/api/v1/me/bots/:botId",
    async (req, reply) => {
      const user = await requireUser(req, reply, ctx);
      if (!user) return;
      const bot = await getBotAccount(ctx.db, req.params.botId);
      if (!bot) return reply.code(404).send({ error: "not found" });
      if (bot.owner_user_id !== user.id && !user.is_admin) {
        return reply.code(403).send({ error: "forbidden" });
      }
      // deleteBotAccount also removes Redis creds (wa:bot:{id}:creds)
      await deleteBotAccount(ctx.db, bot.id);
      ctx.worker.stopBot(bot.id);
      await writeAudit(ctx.db, "bot_deleted", user.id, { botId: bot.id });
      return { ok: true };
    },
  );

  // Peers for my bots
  app.get("/api/v1/me/peers", async (req, reply) => {
    const user = await requireUser(req, reply, ctx);
    if (!user) return;
    const botId = (req.query as { botId?: string }).botId;
    const myBots = await listBotsByOwner(ctx.db, user.id);
    const botIds = new Set(myBots.map((b) => b.id));
    if (botId && !botIds.has(botId) && !user.is_admin) {
      return reply.code(403).send({ error: "forbidden" });
    }
    const peers = botId
      ? await listPeers(ctx.db, botId)
      : await listPeersForBots(ctx.db, [...botIds]);
    const asgMap = await getAssignmentsMany(
      ctx.db,
      peers.map((p) => ({
        botAccountId: p.bot_account_id,
        peerId: p.peer_id,
      })),
    );
    const personaIds = [
      ...new Set(
        peers
          .map((p) => asgMap.get(`${p.bot_account_id}|${p.peer_id}`))
          .filter((id): id is string => Boolean(id)),
      ),
    ];
    const personaMap = await getPersonasByIds(ctx.db, personaIds);
    const enriched = peers.map((p) => {
      const personaId =
        asgMap.get(`${p.bot_account_id}|${p.peer_id}`) ?? null;
      const persona = personaId ? personaMap.get(personaId) : undefined;
      return {
        ...p,
        personaId,
        personaSlug: persona?.slug ?? null,
        personaName: persona?.display_name ?? null,
        proactiveEnabled: Boolean(p.proactive_enabled),
        lastActivityAt: p.last_activity_at ?? null,
        lastProactiveAt: p.last_proactive_at ?? null,
      };
    });
    return {
      peers: enriched,
      globalProactiveEnabled: ctx.cfg.proactiveEnabled,
    };
  });

  app.patch<{
    Body: { botAccountId: string; peerId: string; enabled: boolean };
  }>("/api/v1/me/peers/proactive", async (req, reply) => {
    const user = await requireUser(req, reply, ctx);
    if (!user) return;
    const { botAccountId, peerId, enabled } = req.body ?? {};
    if (!botAccountId || !peerId || typeof enabled !== "boolean") {
      return reply
        .code(400)
        .send({ error: "botAccountId, peerId, enabled required" });
    }
    const bot = await getBotAccount(ctx.db, botAccountId);
    if (!bot || (bot.owner_user_id !== user.id && !user.is_admin)) {
      return reply.code(403).send({ error: "forbidden" });
    }
    try {
      const peer = await setPeerProactiveEnabled(
        ctx.db,
        botAccountId,
        peerId,
        enabled,
      );
      await writeAudit(ctx.db, "peer_proactive_toggled", user.id, {
        botAccountId,
        peerId,
        enabled,
      });
      return {
        peer: {
          ...peer,
          proactiveEnabled: Boolean(peer.proactive_enabled),
        },
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return reply.code(400).send({ error: message });
    }
  });

  app.post<{
    Body: { botAccountId: string; peerId: string; personaId?: string };
  }>("/api/v1/me/peers/approve", async (req, reply) => {
    const user = await requireUser(req, reply, ctx);
    if (!user) return;
    const { botAccountId, peerId, personaId } = req.body ?? {};
    if (!botAccountId || !peerId) {
      return reply.code(400).send({ error: "botAccountId and peerId required" });
    }
    const bot = await getBotAccount(ctx.db, botAccountId);
    if (!bot || (bot.owner_user_id !== user.id && !user.is_admin)) {
      return reply.code(403).send({ error: "forbidden" });
    }
    const peer = await approvePeer(ctx.db, botAccountId, peerId);
    if (personaId) await setAssignment(ctx.db, botAccountId, peerId, personaId);
    await writeAudit(ctx.db, "peer_approved", user.id, {
      botAccountId,
      peerId,
    });
    return { peer };
  });

  app.put<{
    Body: { botAccountId: string; peerId: string; personaId: string };
  }>("/api/v1/me/assignments", async (req, reply) => {
    const user = await requireUser(req, reply, ctx);
    if (!user) return;
    const { botAccountId, peerId, personaId } = req.body ?? {};
    if (!botAccountId || !peerId || !personaId) {
      return reply.code(400).send({ error: "missing fields" });
    }
    const bot = await getBotAccount(ctx.db, botAccountId);
    if (!bot || (bot.owner_user_id !== user.id && !user.is_admin)) {
      return reply.code(403).send({ error: "forbidden" });
    }
    if (!(await userCanUsePersona(ctx.db, user.id, personaId))) {
      return reply
        .code(403)
        .send({ error: "persona_not_in_library", message: "请先添加人设，或人设已私有" });
    }
    await setAssignment(ctx.db, botAccountId, peerId, personaId);
    return { ok: true };
  });

  /** @deprecated use /me/personas — kept for compatibility, returns library */
  app.get("/api/v1/personas", async (req, reply) => {
    const user = await requireUser(req, reply, ctx);
    if (!user) return;
    const personas = await listUserPersonaLibrary(ctx.db, user.id);
    const prompts = await getPublishedPromptsMany(ctx.db, personas);
    return {
      personas: personas.map((p) => ({
        ...p,
        systemPromptPreview: (prompts.get(p.id) ?? "").slice(0, 200),
      })),
    };
  });

  // ── Persona Square ───────────────────────────────────

  app.get("/api/v1/square/personas", async (req, reply) => {
    const user = await requireUser(req, reply, ctx);
    if (!user) return;
    const q = req.query as {
      q?: string;
      page?: string;
      limit?: string;
      sort?: string;
    };
    const limit = Math.min(Math.max(Number(q.limit ?? "20") || 20, 1), 50);
    const page = Math.max(Number(q.page ?? "1") || 1, 1);
    const offset = (page - 1) * limit;
    const sort =
      q.sort === "recent" ||
      q.sort === "name" ||
      q.sort === "use" ||
      q.sort === "heat"
        ? q.sort
        : "heat";
    const { items, total } = await searchPublicPersonas(ctx.db, {
      q: q.q,
      limit,
      offset,
      sort,
    });
    const [libIds, prompts] = await Promise.all([
      getPersonaLibraryIdSet(ctx.db, user.id),
      getPublishedPromptsMany(ctx.db, items),
    ]);
    const personas = items.map((p) =>
      personaPublicDto(p, {
        inLibrary: isInPersonaLibraryLocal(p, user.id, libIds),
        systemPromptPreview: (prompts.get(p.id) ?? "").slice(0, 160),
      }),
    );
    return { personas, total, page, limit };
  });

  app.get<{ Params: { id: string } }>(
    "/api/v1/square/personas/:id",
    async (req, reply) => {
      const user = await requireUser(req, reply, ctx);
      if (!user) return;
      const p = await getPersona(ctx.db, req.params.id);
      if (!p || !p.enabled) {
        return reply.code(404).send({ error: "not found" });
      }
      if (p.visibility === "private" && p.owner_user_id !== user.id) {
        return reply.code(403).send({ error: "private" });
      }
      const [prompt, graph, inLibrary] = await Promise.all([
        getPublishedPrompt(ctx.db, p.id),
        getPublishedGraph(ctx.db, p.id),
        isInPersonaLibrary(ctx.db, user.id, p.id),
      ]);
      return {
        persona: personaPublicDto(p, {
          systemPrompt: prompt,
          graph: graph ?? null,
          inLibrary,
        }),
      };
    },
  );

  /** GET chatflow graph (owner or public read for try/editor load). */
  app.get<{ Params: { id: string } }>(
    "/api/v1/square/personas/:id/graph",
    async (req, reply) => {
      const user = await requireUser(req, reply, ctx);
      if (!user) return;
      const p = await getPersona(ctx.db, req.params.id);
      if (!p || !p.enabled) {
        return reply.code(404).send({ error: "not found" });
      }
      const canRead =
        p.owner_user_id === user.id ||
        user.is_admin ||
        (p.visibility === "public" && p.enabled);
      if (!canRead) {
        return reply.code(403).send({ error: "forbidden" });
      }
      const stored = await getPublishedGraph(ctx.db, p.id);
      const graph = stored ?? createDefaultChatflowGraph();
      return {
        personaId: p.id,
        mode: p.mode === "chatflow" ? "chatflow" : "prompt",
        graph,
        isDefault: !stored,
        editable: p.owner_user_id === user.id || Boolean(user.is_admin),
      };
    },
  );

  /** PUT chatflow graph (owner only). Also switches mode to chatflow. */
  app.put<{
    Params: { id: string };
    Body: { graph?: unknown; systemPrompt?: string; mode?: "prompt" | "chatflow" };
  }>("/api/v1/square/personas/:id/graph", async (req, reply) => {
    const user = await requireUser(req, reply, ctx);
    if (!user) return;
    const p = await getPersona(ctx.db, req.params.id);
    if (!p) return reply.code(404).send({ error: "not found" });
    if (p.owner_user_id !== user.id && !user.is_admin) {
      return reply.code(403).send({ error: "forbidden" });
    }
    const body = req.body ?? {};
    try {
      const graph = body.graph ?? createDefaultChatflowGraph();
      validateChatflowGraph(graph, {
        maxNodes: ctx.cfg.chatflowMaxNodes,
      });
      const prompt =
        body.systemPrompt?.trim() ||
        (await getPublishedPrompt(ctx.db, p.id)) ||
        "你是一个有帮助的助手。";
      const persona = await updatePersonaMeta(ctx.db, p.id, {
        systemPrompt: prompt,
        graphJson: graph,
        mode: body.mode === "prompt" ? "prompt" : "chatflow",
      });
      await writeAudit(ctx.db, "persona_graph_saved", user.id, {
        id: p.id,
      });
      return {
        persona: personaPublicDto(persona),
        graph,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const code =
        err instanceof ChatflowError ? 400 : message.includes("not found") ? 404 : 400;
      return reply.code(code).send({ error: message });
    }
  });

  app.post<{
    Params: { id: string };
    Body: { displayName?: string };
  }>("/api/v1/square/personas/:id/fork", async (req, reply) => {
    const user = await requireUser(req, reply, ctx);
    if (!user) return;
    if (!ctx.cfg.personaForkEnabled) {
      return reply.code(503).send({ error: "fork_disabled", message: "人设改编已关闭" });
    }
    try {
      const { persona, systemPrompt } = await forkPersona(ctx.db, {
        sourceId: req.params.id,
        ownerUserId: user.id,
        displayName: req.body?.displayName,
        allowPrivateSource: Boolean(user.is_admin),
      });
      await writeAudit(ctx.db, "persona_forked", user.id, {
        sourceId: req.params.id,
        personaId: persona.id,
      });
      return {
        persona: personaPublicDto(persona, { systemPrompt }),
        systemPrompt,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes("not found")) {
        return reply.code(404).send({ error: message });
      }
      if (message.includes("private")) {
        return reply.code(403).send({ error: message });
      }
      return reply.code(400).send({ error: message });
    }
  });

  app.post<{
    Body: {
      displayName: string;
      description?: string;
      systemPrompt: string;
      visibility?: "public" | "private";
      tags?: string[];
      mode?: "prompt" | "chatflow";
      llmProviderId?: string | null;
      webSearchEnabled?: boolean;
    };
  }>("/api/v1/square/personas", async (req, reply) => {
    const user = await requireUser(req, reply, ctx);
    if (!user) return;
    const body = req.body ?? {};
    if (!body.displayName?.trim() || !body.systemPrompt?.trim()) {
      return reply
        .code(400)
        .send({ error: "displayName and systemPrompt required" });
    }
    try {
      if (body.llmProviderId) {
        const prov = await getLlmProvider(ctx.db, body.llmProviderId);
        if (!prov || prov.owner_user_id !== user.id) {
          return reply.code(400).send({ error: "invalid llmProviderId" });
        }
      }
      const persona = await createPersona(ctx.db, {
        displayName: body.displayName,
        description: body.description,
        systemPrompt: body.systemPrompt,
        visibility: body.visibility === "private" ? "private" : "public",
        tags: body.tags,
        ownerUserId: user.id,
        mode: body.mode === "chatflow" ? "chatflow" : "prompt",
        llmProviderId: body.llmProviderId ?? null,
        webSearchEnabled: Boolean(body.webSearchEnabled),
      });
      await writeAudit(ctx.db, "persona_published_square", user.id, {
        id: persona.id,
        visibility: persona.visibility,
      });
      return { persona: personaPublicDto(persona) };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return reply.code(400).send({ error: message });
    }
  });

  app.put<{
    Params: { id: string };
    Body: {
      displayName?: string;
      description?: string;
      tags?: string[];
      visibility?: "public" | "private";
      systemPrompt?: string;
      mode?: "prompt" | "chatflow";
      llmProviderId?: string | null;
      webSearchEnabled?: boolean;
    };
  }>("/api/v1/square/personas/:id", async (req, reply) => {
    const user = await requireUser(req, reply, ctx);
    if (!user) return;
    const p = await getPersona(ctx.db, req.params.id);
    if (!p) return reply.code(404).send({ error: "not found" });
    if (p.owner_user_id !== user.id && !user.is_admin) {
      return reply.code(403).send({ error: "forbidden" });
    }
    try {
      const body = req.body ?? {};
      if (body.llmProviderId) {
        const prov = await getLlmProvider(ctx.db, body.llmProviderId);
        if (!prov || prov.owner_user_id !== user.id) {
          return reply.code(400).send({ error: "invalid llmProviderId" });
        }
      }
      const persona = await updatePersonaMeta(ctx.db, p.id, {
        displayName: body.displayName,
        description: body.description,
        tags: body.tags,
        visibility: body.visibility,
        systemPrompt: body.systemPrompt,
        mode: body.mode,
        llmProviderId: body.llmProviderId,
        webSearchEnabled: body.webSearchEnabled,
      });
      return { persona: personaPublicDto(persona) };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return reply.code(400).send({ error: message });
    }
  });

  app.delete<{ Params: { id: string } }>(
    "/api/v1/square/personas/:id",
    async (req, reply) => {
      const user = await requireUser(req, reply, ctx);
      if (!user) return;
      const p = await getPersona(ctx.db, req.params.id);
      if (!p) return reply.code(404).send({ error: "not found" });
      if (p.owner_user_id === "system") {
        return reply.code(403).send({ error: "cannot delete system persona" });
      }
      if (p.owner_user_id !== user.id && !user.is_admin) {
        return reply.code(403).send({ error: "forbidden" });
      }
      await softDeletePersona(ctx.db, p.id);
      await writeAudit(ctx.db, "persona_soft_deleted", user.id, { id: p.id });
      return { ok: true };
    },
  );

  // ── User custom LLM providers (egress via HF tools only) ──
  app.get("/api/v1/me/llm-providers", async (req, reply) => {
    const user = await requireUser(req, reply, ctx);
    if (!user) return;
    const secret = ctx.cfg.llmProviderSecret;
    if (!secret) {
      return {
        providers: [],
        configured: false,
        error: "LLM_PROVIDER_SECRET not configured on server",
      };
    }
    const rows = await listLlmProvidersByOwner(ctx.db, user.id);
    return {
      configured: true,
      providers: rows.map((r) => toPublicProvider(r, secret)),
      toolsGateway: Boolean(ctx.cfg.toolsBaseUrl),
      webSearchEnabled: ctx.cfg.webSearchEnabled,
    };
  });

  app.post<{
    Body: {
      name?: string;
      baseUrl?: string;
      apiKey?: string;
      defaultModel?: string;
    };
  }>("/api/v1/me/llm-providers", async (req, reply) => {
    const user = await requireUser(req, reply, ctx);
    if (!user) return;
    const secret = ctx.cfg.llmProviderSecret;
    if (!secret) {
      return reply
        .code(503)
        .send({ error: "LLM_PROVIDER_SECRET not configured on server" });
    }
    if (!ctx.cfg.toolsBaseUrl || !ctx.cfg.toolsApiKey) {
      return reply.code(503).send({
        error:
          "TOOLS_BASE_URL / TOOLS_API_KEY required for user custom LLM (HF tools)",
      });
    }
    const body = req.body ?? {};
    try {
      const row = await createLlmProvider(ctx.db, {
        ownerUserId: user.id,
        name: body.name || "",
        baseUrl: body.baseUrl || "",
        apiKey: body.apiKey || "",
        defaultModel: body.defaultModel || "",
        secret,
      });
      await writeAudit(ctx.db, "llm_provider_create", user.id, {
        id: row.id,
        baseUrl: row.base_url,
      });
      return { provider: toPublicProvider(row, secret) };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return reply.code(400).send({ error: message });
    }
  });

  app.patch<{
    Params: { id: string };
    Body: {
      name?: string;
      baseUrl?: string;
      apiKey?: string;
      defaultModel?: string;
      enabled?: boolean;
    };
  }>("/api/v1/me/llm-providers/:id", async (req, reply) => {
    const user = await requireUser(req, reply, ctx);
    if (!user) return;
    const secret = ctx.cfg.llmProviderSecret;
    if (!secret) {
      return reply
        .code(503)
        .send({ error: "LLM_PROVIDER_SECRET not configured" });
    }
    try {
      const row = await updateLlmProvider(ctx.db, req.params.id, user.id, {
        ...req.body,
        secret,
      });
      return { provider: toPublicProvider(row, secret) };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message === "not_found") {
        return reply.code(404).send({ error: "not found" });
      }
      return reply.code(400).send({ error: message });
    }
  });

  app.delete<{ Params: { id: string } }>(
    "/api/v1/me/llm-providers/:id",
    async (req, reply) => {
      const user = await requireUser(req, reply, ctx);
      if (!user) return;
      const ok = await deleteLlmProvider(ctx.db, req.params.id, user.id);
      if (!ok) return reply.code(404).send({ error: "not found" });
      await writeAudit(ctx.db, "llm_provider_delete", user.id, {
        id: req.params.id,
      });
      return { ok: true };
    },
  );

  app.get("/api/v1/me/personas", async (req, reply) => {
    const user = await requireUser(req, reply, ctx);
    if (!user) return;
    const [library, created] = await Promise.all([
      listUserPersonaLibrary(ctx.db, user.id),
      listPersonasByOwner(ctx.db, user.id),
    ]);
    return {
      library: library.map((p) =>
        personaPublicDto(p, {
          enabled: p.enabled,
        }),
      ),
      created: created.map((p) =>
        personaPublicDto(p, {
          enabled: p.enabled,
        }),
      ),
    };
  });

  app.post<{ Params: { id: string } }>(
    "/api/v1/me/personas/:id/add",
    async (req, reply) => {
      const user = await requireUser(req, reply, ctx);
      if (!user) return;
      try {
        const persona = await addPersonaToLibrary(
          ctx.db,
          user.id,
          req.params.id,
        );
        await writeAudit(ctx.db, "persona_added_lib", user.id, {
          personaId: persona.id,
        });
        return { ok: true, persona };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const code =
          message.includes("private") || message.includes("not found")
            ? 403
            : 400;
        return reply.code(code).send({ error: message });
      }
    },
  );

  app.delete<{ Params: { id: string } }>(
    "/api/v1/me/personas/:id",
    async (req, reply) => {
      const user = await requireUser(req, reply, ctx);
      if (!user) return;
      await removePersonaFromLibrary(ctx.db, user.id, req.params.id);
      return { ok: true };
    },
  );

  // ── Web try-chat (persona preview, no WeChat) ─────────

  function tryChatHttpError(
    reply: FastifyReply,
    err: unknown,
  ): FastifyReply | null {
    if (!(err instanceof TryChatError)) return null;
    const map: Record<string, number> = {
      disabled: 503,
      not_found: 404,
      forbidden: 403,
      quota_day: 429,
      quota_session: 429,
      empty: 400,
      llm: 502,
      no_prompt: 400,
    };
    return reply
      .code(map[err.code] ?? 400)
      .send({ error: err.code, message: err.message });
  }

  app.post<{
    Body: { personaId: string; botName?: string };
  }>("/api/v1/try-chat/sessions", async (req, reply) => {
    const user = await requireUser(req, reply, ctx);
    if (!user) return;
    if (!ctx.cfg.tryChatEnabled) {
      return reply
        .code(503)
        .send({ error: "disabled", message: "网页试聊已关闭" });
    }
    const personaId = req.body?.personaId?.trim();
    if (!personaId) {
      return reply.code(400).send({ error: "personaId required" });
    }
    try {
      // inLibrary rides along so the client doesn't need a follow-up
      // GET /square/personas/:id just to render the "add" button state.
      const [result, inLibrary] = await Promise.all([
        ctx.tryChat.startSession({
          userId: user.id,
          personaId,
          botName: req.body?.botName,
        }),
        isInPersonaLibrary(ctx.db, user.id, personaId).catch(() => false),
      ]);
      return {
        sessionId: result.sessionId,
        persona: {
          id: result.persona.id,
          slug: result.persona.slug,
          displayName: result.persona.display_name,
          description: result.persona.description,
          inLibrary,
        },
        inLibrary,
        botName: result.botName,
        expiresInSec: result.expiresInSec,
        remainingToday: result.remainingToday,
      };
    } catch (err) {
      const sent = tryChatHttpError(reply, err);
      if (sent) return;
      const message = err instanceof Error ? err.message : String(err);
      return reply.code(400).send({ error: message });
    }
  });

  app.post<{
    Params: { sessionId: string };
    Body: { text: string };
  }>("/api/v1/try-chat/sessions/:sessionId/messages", async (req, reply) => {
    const user = await requireUser(req, reply, ctx);
    if (!user) return;
    if (!ctx.cfg.tryChatEnabled) {
      return reply
        .code(503)
        .send({ error: "disabled", message: "网页试聊已关闭" });
    }
    try {
      const result = await ctx.tryChat.sendMessage({
        userId: user.id,
        sessionId: req.params.sessionId,
        text: req.body?.text ?? "",
        username: user.username,
      });
      return {
        messages: result.parts.map((p) =>
          p.kind === "sticker"
            ? { type: "sticker" as const, slug: p.slug }
            : { type: "text" as const, text: p.text },
        ),
        displayText: result.displayText,
        usage: result.usage,
        remainingToday: result.remainingToday,
        remainingSession: result.remainingSession,
      };
    } catch (err) {
      const sent = tryChatHttpError(reply, err);
      if (sent) return;
      const message = err instanceof Error ? err.message : String(err);
      return reply.code(400).send({ error: message });
    }
  });

  app.delete<{ Params: { sessionId: string } }>(
    "/api/v1/try-chat/sessions/:sessionId",
    async (req, reply) => {
      const user = await requireUser(req, reply, ctx);
      if (!user) return;
      try {
        await ctx.tryChat.endSession(user.id, req.params.sessionId);
        return { ok: true };
      } catch (err) {
        const sent = tryChatHttpError(reply, err);
        if (sent) return;
        return { ok: true };
      }
    },
  );

  // ── Sticker Square ───────────────────────────────────

  function publicStickerDto(
    s: Sticker,
    extra?: { inLibrary?: boolean },
  ) {
    const isCdnEligible =
      !!s.enabled &&
      s.visibility === "public" &&
      s.review_status === "approved";
    const imageUrl = isCdnEligible
      ? `/cdn/s/${s.id}${s.content_hash ? `?v=${encodeURIComponent(s.content_hash)}` : ""}`
      : `/api/v1/square/stickers/${s.id}/image`;
    return {
      id: s.id,
      slug: s.slug,
      displayName: s.display_name,
      description: s.description,
      tags: s.tags,
      mime: s.mime,
      sizeBytes: s.size_bytes,
      visibility: s.visibility,
      reviewStatus: s.review_status,
      rejectReason: s.reject_reason,
      ownerUserId: s.owner_user_id,
      useCount: s.use_count,
      enabled: !!s.enabled,
      contentHash: s.content_hash ?? null,
      imageUrl,
      updatedAt: s.updated_at,
      createdAt: s.created_at,
      ...extra,
    };
  }

  function parseStickerUpload(
    body: {
      mime?: string;
      dataBase64?: string;
    },
    maxBytes: number,
  ): { data: Buffer; mime: string } {
    if (!body.dataBase64) throw new StickerSecurityError("missing image", "empty");
    let data: Buffer;
    try {
      data = decodeBase64Image(body.dataBase64);
    } catch {
      throw new StickerSecurityError("invalid base64", "bad_base64");
    }
    const { mime } = assertSafeStickerImage(data, body.mime, { maxBytes });
    return { data, mime };
  }

  app.get("/api/v1/square/stickers", async (req, reply) => {
    const user = await requireUser(req, reply, ctx);
    if (!user) return;
    const q = req.query as {
      q?: string;
      page?: string;
      limit?: string;
      sort?: string;
    };
    const limit = Math.min(Math.max(Number(q.limit ?? "20") || 20, 1), 50);
    const page = Math.max(Number(q.page ?? "1") || 1, 1);
    const offset = (page - 1) * limit;
    const sort =
      q.sort === "recent" || q.sort === "name" || q.sort === "use"
        ? q.sort
        : "use";
    const [{ items, total }, libIds] = await Promise.all([
      searchPublicStickers(ctx.db, { q: q.q, limit, offset, sort }),
      getStickerLibraryIdSet(ctx.db, user.id),
    ]);
    const stickers = items.map((s) =>
      publicStickerDto(s, {
        inLibrary: libIds.has(s.id),
      }),
    );
    return { stickers, total, page, limit };
  });

  app.get<{ Params: { id: string } }>(
    "/api/v1/square/stickers/:id",
    async (req, reply) => {
      const user = await requireUser(req, reply, ctx);
      if (!user) return;
      const [s, inLibrary] = await Promise.all([
        getSticker(ctx.db, req.params.id),
        isInStickerLibrary(ctx.db, user.id, req.params.id),
      ]);
      if (!s || !s.enabled) {
        return reply.code(404).send({ error: "not found" });
      }
      const isOwner = s.owner_user_id === user.id;
      const isPublicApproved =
        s.visibility === "public" && s.review_status === "approved";
      if (!isOwner && !isPublicApproved && !user.is_admin) {
        return reply.code(403).send({ error: "forbidden" });
      }
      return { sticker: publicStickerDto(s, { inLibrary }) };
    },
  );

  app.get<{ Params: { id: string } }>(
    "/api/v1/square/stickers/:id/image",
    async (req, reply) => {
      const user = await requireUser(req, reply, ctx);
      if (!user) return;
      const s = await getSticker(ctx.db, req.params.id);
      if (!s || !s.enabled) {
        return reply.code(404).send({ error: "not found" });
      }
      const isOwner = s.owner_user_id === user.id;
      const isPublicApproved =
        s.visibility === "public" && s.review_status === "approved";
      if (!isOwner && !isPublicApproved && !user.is_admin) {
        return reply.code(403).send({ error: "forbidden" });
      }
      return sendPrivateStickerImage(ctx, req, reply, s);
    },
  );

  app.post<{
    Body: {
      slug?: string;
      displayName: string;
      description?: string;
      tags?: string[];
      visibility?: "public" | "private";
      mime?: string;
      dataBase64: string;
    };
  }>("/api/v1/square/stickers", { bodyLimit: ctx.cfg.uploadBodyLimit }, async (req, reply) => {
    const user = await requireUser(req, reply, ctx);
    if (!user) return;
    const body = req.body ?? {};
    if (!body.displayName?.trim() || !body.dataBase64) {
      return reply
        .code(400)
        .send({ error: "displayName and dataBase64 required" });
    }
    try {
      const { data, mime } = parseStickerUpload(body, ctx.cfg.stickerMaxBytes);
      const sticker = await createSticker(ctx.db, {
        slug: body.slug,
        displayName: body.displayName,
        description: body.description,
        tags: Array.isArray(body.tags) ? body.tags : undefined,
        visibility: body.visibility === "private" ? "private" : "public",
        mime,
        sizeBytes: data.length,
        ownerUserId: user.id,
        autoApprove: false,
        data,
      });
      await writeAudit(ctx.db, "sticker_submit", user.id, {
        id: sticker.id,
        visibility: sticker.visibility,
        reviewStatus: sticker.review_status,
      });
      return { sticker: publicStickerDto(sticker) };
    } catch (err) {
      if (err instanceof StickerSecurityError) {
        return reply
          .code(400)
          .send({ error: "unsafe_image", code: err.code, message: err.message });
      }
      const message = err instanceof Error ? err.message : String(err);
      const code = message.includes("slug") ? 409 : 400;
      return reply.code(code).send({ error: message });
    }
  });

  app.put<{
    Params: { id: string };
    Body: {
      slug?: string;
      displayName?: string;
      description?: string;
      tags?: string[];
      visibility?: "public" | "private";
      mime?: string;
      dataBase64?: string;
    };
  }>("/api/v1/square/stickers/:id", { bodyLimit: ctx.cfg.uploadBodyLimit }, async (req, reply) => {
    const user = await requireUser(req, reply, ctx);
    if (!user) return;
    const cur = await getSticker(ctx.db, req.params.id);
    if (!cur) return reply.code(404).send({ error: "not found" });
    if (cur.owner_user_id !== user.id && !user.is_admin) {
      return reply.code(403).send({ error: "forbidden" });
    }
    const body = req.body ?? {};
    try {
      if (body.dataBase64) {
        const { data, mime } = parseStickerUpload(body, ctx.cfg.stickerMaxBytes);
        await replaceStickerBlob(ctx.db, cur.id, data, {
          mime,
          fileName: makeStickerFileName(cur.id, mime),
        });
      }
      const sticker = await updateStickerMeta(ctx.db, cur.id, {
        slug: body.slug,
        displayName: body.displayName,
        description: body.description,
        tags: body.tags,
        visibility: body.visibility,
        rePending: true,
      });
      await writeAudit(ctx.db, "sticker_update_user", user.id, {
        id: sticker.id,
      });
      return { sticker: publicStickerDto(sticker) };
    } catch (err) {
      if (err instanceof StickerSecurityError) {
        return reply
          .code(400)
          .send({ error: "unsafe_image", code: err.code, message: err.message });
      }
      const message = err instanceof Error ? err.message : String(err);
      return reply.code(400).send({ error: message });
    }
  });

  app.delete<{ Params: { id: string } }>(
    "/api/v1/square/stickers/:id",
    async (req, reply) => {
      const user = await requireUser(req, reply, ctx);
      if (!user) return;
      const cur = await getSticker(ctx.db, req.params.id);
      if (!cur) return reply.code(404).send({ error: "not found" });
      if (cur.owner_user_id === "system") {
        return reply.code(403).send({ error: "cannot delete system sticker" });
      }
      if (cur.owner_user_id !== user.id && !user.is_admin) {
        return reply.code(403).send({ error: "forbidden" });
      }
      await softDeleteSticker(ctx.db, cur.id);
      await writeAudit(ctx.db, "sticker_soft_delete", user.id, { id: cur.id });
      return { ok: true };
    },
  );

  app.get("/api/v1/me/stickers", async (req, reply) => {
    const user = await requireUser(req, reply, ctx);
    if (!user) return;
    const [library, created] = await Promise.all([
      listUserStickerLibrary(ctx.db, user.id),
      listStickersByOwner(ctx.db, user.id),
    ]);
    return {
      library: library.map((s) => publicStickerDto(s)),
      created: created.map((s) => publicStickerDto(s)),
    };
  });

  app.post<{ Params: { id: string } }>(
    "/api/v1/me/stickers/:id/add",
    async (req, reply) => {
      const user = await requireUser(req, reply, ctx);
      if (!user) return;
      try {
        const sticker = await addStickerToLibrary(
          ctx.db,
          user.id,
          req.params.id,
        );
        await writeAudit(ctx.db, "sticker_lib_add", user.id, {
          stickerId: sticker.id,
        });
        return { ok: true, sticker: publicStickerDto(sticker) };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const code =
          message.includes("private") || message.includes("not available")
            ? 403
            : 400;
        return reply.code(code).send({ error: message });
      }
    },
  );

  app.delete<{ Params: { id: string } }>(
    "/api/v1/me/stickers/:id",
    async (req, reply) => {
      const user = await requireUser(req, reply, ctx);
      if (!user) return;
      await removeStickerFromLibrary(ctx.db, user.id, req.params.id);
      return { ok: true };
    },
  );

  // ── Admin ────────────────────────────────────────────

  app.get("/api/v1/admin/dashboard", async (req, reply) => {
    const admin = await requireAdmin(req, reply, ctx);
    if (!admin) return;
    // Everything here is independent — one wave instead of 4 chained waits.
    // redisOk doubles as the liveness probe, so it rides along too.
    const [snap, today, yesterday, workerIds, workerStats, nodes, botOwners, redisOk] =
      await Promise.all([
        doctorSnapshot(ctx.db),
        getUsageDayStats(ctx.db, dayKey()),
        getUsageDayStats(ctx.db, dayKeyOffset(-1)),
        ctx.worker.listActiveBotIdsAsync(),
        ctx.worker.getFleetStats(),
        ctx.worker.listFleetNodes().catch(() => []),
        listLeasedBots(ctx.db).catch(() => ({} as Record<string, string>)),
        ctx.db.ping().then(
          () => true,
          () => false,
        ),
      ]);
    const botMap = await getBotAccountsByIds(ctx.db, workerIds);
    const workerBots = workerIds.map((id) => {
      const b = botMap.get(id);
      return {
        id,
        displayName: b?.display_name ?? id,
        status: b?.status ?? "unknown",
        workerId: botOwners[id] ?? null,
      };
    });
    const nodesOnline = nodes.filter((n) => n.online && !n.fenced).length;
    return {
      snapshot: snap,
      usage: { today, yesterday },
      workers: workerIds,
      workerBots,
      workerId: ctx.worker.getWorkerId(),
      workerStats,
      nodes,
      nodesOnline,
      nodesTotal: nodes.length,
      redisOk,
      safeConfig: {
        publicBaseUrl: ctx.cfg.publicBaseUrl,
        workerEnabled: ctx.cfg.workerEnabled,
        maxBotsPerWorker: ctx.cfg.maxBotsPerWorker,
        replyConcurrency: ctx.cfg.replyConcurrency,
        inboxMaxLen: ctx.cfg.inboxMaxLen,
        llmModel: ctx.cfg.llmModel,
        llmBaseUrl: ctx.cfg.llmBaseUrl,
        multiBubbleJson: ctx.cfg.multiBubbleJson,
        splitReply: ctx.cfg.splitReply,
        allowUnapproved: ctx.cfg.allowUnapproved,
      },
    };
  });

  /** Global peer list for ops (filter unapproved by default via query). */
  app.get("/api/v1/admin/peers", async (req, reply) => {
    const admin = await requireAdmin(req, reply, ctx);
    if (!admin) return;
    const q = req.query as { status?: string; limit?: string };
    const status = (q.status || "unapproved").toLowerCase();
    const limit = Math.min(Math.max(Number(q.limit) || 100, 1), 300);
    let peers = await listPeers(ctx.db);
    if (status === "unapproved") peers = peers.filter((p) => !p.approved);
    else if (status === "approved") peers = peers.filter((p) => p.approved);
    peers = peers.slice(0, limit);
    const botIds = [...new Set(peers.map((p) => p.bot_account_id))];
    const [botMap, asgMap] = await Promise.all([
      getBotAccountsByIds(ctx.db, botIds),
      getAssignmentsMany(
        ctx.db,
        peers.map((p) => ({
          botAccountId: p.bot_account_id,
          peerId: p.peer_id,
        })),
      ),
    ]);
    const ownerIds = [
      ...new Set(
        [...botMap.values()]
          .map((b) => b.owner_user_id)
          .filter(Boolean),
      ),
    ];
    const owners = await getUsersByIds(ctx.db, ownerIds);
    const items = peers.map((p) => {
      const bot = botMap.get(p.bot_account_id);
      const owner = bot?.owner_user_id
        ? owners.get(bot.owner_user_id)
        : undefined;
      return {
        botAccountId: p.bot_account_id,
        peerId: p.peer_id,
        approved: Boolean(p.approved),
        botName: bot?.display_name ?? p.bot_account_id,
        ownerUserId: bot?.owner_user_id ?? null,
        ownerUsername: owner?.username ?? null,
        personaId:
          asgMap.get(`${p.bot_account_id}|${p.peer_id}`) ?? null,
        createdAt: p.created_at ?? null,
      };
    });
    return { total: items.length, peers: items };
  });

  app.post<{
    Body: { botAccountId: string; peerId: string };
  }>("/api/v1/admin/peers/approve", async (req, reply) => {
    const admin = await requireAdmin(req, reply, ctx);
    if (!admin) return;
    const { botAccountId, peerId } = req.body ?? {};
    if (!botAccountId || !peerId) {
      return reply.code(400).send({ error: "botAccountId and peerId required" });
    }
    const bot = await getBotAccount(ctx.db, botAccountId);
    if (!bot) return reply.code(404).send({ error: "bot not found" });
    await approvePeer(ctx.db, botAccountId, peerId);
    await writeAudit(ctx.db, "admin_peer_approve", admin.id, {
      botAccountId,
      peerId,
    });
    return { ok: true };
  });

  /** Approve all currently unapproved peers (ops convenience). */
  app.post("/api/v1/admin/peers/approve-all", async (req, reply) => {
    const admin = await requireAdmin(req, reply, ctx);
    if (!admin) return;
    const peers = (await listPeers(ctx.db)).filter((p) => !p.approved);
    // Batched, not serialized: 500 pending peers used to be ~1000 chained
    // round trips (~40s, past most proxy timeouts). Still goes through
    // approvePeer so each row is re-read — writing back the stale rows we
    // already hold would clobber last_activity_at written by another node.
    let approved = 0;
    const BATCH = 100;
    for (let off = 0; off < peers.length; off += BATCH) {
      const slice = peers.slice(off, off + BATCH);
      const res = await Promise.allSettled(
        slice.map((p) => approvePeer(ctx.db, p.bot_account_id, p.peer_id)),
      );
      approved += res.filter((r) => r.status === "fulfilled").length;
    }
    await writeAudit(ctx.db, "admin_peer_approve_all", admin.id, {
      approved,
    });
    return { ok: true, approved };
  });

  app.get("/api/v1/admin/system", async (req, reply) => {
    const admin = await requireAdmin(req, reply, ctx);
    if (!admin) return;
    // Independent — one wave instead of three chained waits
    const [snap, workerIds, workerStats, nodes, redisOk] = await Promise.all([
      doctorSnapshot(ctx.db),
      ctx.worker.listActiveBotIdsAsync(),
      ctx.worker.getFleetStats(),
      ctx.worker.listFleetNodes().catch(() => []),
      ctx.db.ping().then(
        () => true,
        () => false,
      ),
    ]);
    return {
      snapshot: snap,
      workers: workerIds,
      workerId: ctx.worker.getWorkerId(),
      workerStats,
      nodes,
      nodesOnline: nodes.filter((n) => n.online && !n.fenced).length,
      nodesTotal: nodes.length,
      redisOk,
      uptimeSec: Math.floor(process.uptime()),
      node: process.version,
      safeConfig: {
        publicBaseUrl: ctx.cfg.publicBaseUrl,
        workerEnabled: ctx.cfg.workerEnabled,
        maxBotsPerWorker: ctx.cfg.maxBotsPerWorker,
        replyConcurrency: ctx.cfg.replyConcurrency,
        inboxMaxLen: ctx.cfg.inboxMaxLen,
        llmModel: ctx.cfg.llmModel,
        llmBaseUrl: ctx.cfg.llmBaseUrl,
        multiBubbleJson: ctx.cfg.multiBubbleJson,
        splitReply: ctx.cfg.splitReply,
        allowUnapproved: ctx.cfg.allowUnapproved,
        maxReplyChunks: ctx.cfg.maxReplyChunks,
        maxChunkChars: ctx.cfg.maxChunkChars,
      },
    };
  });

  /** Deployment nodes — super-admin only. */
  app.get("/api/v1/admin/nodes", async (req, reply) => {
    const admin = await requireSuperAdmin(req, reply, ctx);
    if (!admin) return;
    // targetShare divides the bots that actually want polling, so the panel's
    // "目标" column matches what the fleet is really distributing.
    const pollableTotal = await listPollableBotIds(ctx.db)
      .then((ids) => ids.length)
      .catch(() => undefined);
    const [nodes, fences, weights, currentRelease] = await Promise.all([
      ctx.worker.listFleetNodes({ totalBots: pollableTotal }),
      listWorkerFences(ctx.db).catch(() => []),
      listWorkerWeights(ctx.db).catch(() => ({})),
      getCurrentRelease(ctx.db).catch(() => null),
    ]);
    const desiredVersion = currentRelease?.version ?? null;
    const statusMap = await getWorkerUpdateStatuses(
      ctx.db,
      nodes.map((n) => n.id),
    ).catch(() => new Map());
    const enriched = nodes.map((n) => {
      const st = statusMap.get(n.id) ?? null;
      const outdated = Boolean(
        desiredVersion &&
          (n.version || "") !== desiredVersion &&
          !n.fenced,
      );
      return {
        ...n,
        update: {
          outdated,
          desiredVersion,
          status: st?.phase ?? null,
          error: st?.error ?? null,
          progress: st?.progress ?? null,
          message: st?.message ?? null,
          targetVersion: st?.version ?? null,
        },
      };
    });
    const online = nodes.filter((n) => n.online && !n.fenced);
    return {
      nodes: enriched,
      nodesOnline: online.length,
      nodesTotal: nodes.length,
      nodesFenced: nodes.filter((n) => n.fenced).length,
      nodesWeighted: nodes.filter((n) => n.weightOverride).length,
      fences,
      weights,
      pollableTotal: pollableTotal ?? null,
      /** Sum of weights across online nodes — the denominator of each share */
      weightTotal: online.reduce((a, n) => a + n.weight, 0),
      weightLimits: {
        min: MIN_WORKER_WEIGHT,
        max: MAX_WORKER_WEIGHT,
        default: DEFAULT_WORKER_WEIGHT,
      },
      /** Weights only take effect while the rebalancer may move leases */
      rebalanceEnabled: ctx.cfg.rebalanceEnabled,
      rebalanceIntervalSec: ctx.cfg.rebalanceIntervalSec,
      /** Seconds a weight survives after its node stops heartbeating */
      weightTtlSec: ctx.cfg.workerWeightTtlSec,
      selfWorkerId: ctx.worker.getWorkerId(),
      leaseTtlSec: ctx.cfg.leaseTtlSec,
      release: releaseSummary(currentRelease),
      appVersion: ctx.cfg.appVersion,
      otaEnabled: ctx.cfg.otaEnabled,
    };
  });

  /**
   * Set a node's load weight (percent of an even share; 100 = default).
   *
   * Weights are relative between *online* nodes: with A=200 and B=100 the
   * fleet aims for a 2:1 split. 0 drains a node without fencing it — it keeps
   * heartbeating and can be restored instantly.
   */
  app.post<{
    Params: { workerId: string };
    Body: { weight?: number | string; percent?: number | string };
  }>("/api/v1/admin/nodes/:workerId/weight", async (req, reply) => {
    const admin = await requireSuperAdmin(req, reply, ctx);
    if (!admin) return;
    const workerId = decodeURIComponent(req.params.workerId || "").trim();
    if (!workerId) {
      return reply.code(400).send({ error: "workerId required" });
    }
    const parsed = parseWorkerWeightInput(
      req.body?.weight ?? req.body?.percent,
    );
    if (!parsed.ok) {
      return reply.code(400).send({
        error: parsed.error,
        message:
          parsed.error === "weight_required"
            ? "weight required"
            : parsed.error === "weight_out_of_range"
              ? `weight must be between ${MIN_WORKER_WEIGHT} and ${MAX_WORKER_WEIGHT}`
              : "weight must be a number",
      });
    }
    const weight = parsed.value;
    const record = await setWorkerWeight(ctx.db, workerId, weight, {
      byUserId: admin.id,
      byUsername: admin.username ?? null,
    });
    await writeAudit(ctx.db, "admin_node_set_weight", admin.id, {
      workerId,
      weight,
    });
    try {
      // Nodes drop their cached weight on wake, so this lands next tick
      await publishWorkerWake(ctx.db);
    } catch {
      /* optional */
    }
    const note = ctx.cfg.rebalanceEnabled
      ? `约 ${ctx.cfg.rebalanceIntervalSec}s 内生效`
      : "但 REBALANCE_ENABLED=false，租约不会自动迁移";
    return {
      ok: true,
      workerId,
      weight,
      cleared: record === null,
      message:
        weight === DEFAULT_WORKER_WEIGHT
          ? `已恢复默认权重（100%）；${note}`
          : weight === 0
            ? `已设为 0%（腾空节点，不再认领 bot）；${note}`
            : `已设为 ${weight}%；${note}`,
    };
  });

  /** Remove the override so the node returns to an even share. */
  app.delete<{ Params: { workerId: string } }>(
    "/api/v1/admin/nodes/:workerId/weight",
    async (req, reply) => {
      const admin = await requireSuperAdmin(req, reply, ctx);
      if (!admin) return;
      const workerId = decodeURIComponent(req.params.workerId || "").trim();
      if (!workerId) {
        return reply.code(400).send({ error: "workerId required" });
      }
      const cleared = await clearWorkerWeight(ctx.db, workerId);
      await writeAudit(ctx.db, "admin_node_clear_weight", admin.id, {
        workerId,
        cleared,
      });
      try {
        await publishWorkerWake(ctx.db);
      } catch {
        /* optional */
      }
      return {
        ok: true,
        workerId,
        cleared,
        weight: DEFAULT_WORKER_WEIGHT,
        message: cleared ? "已恢复默认权重（100%）" : "该节点没有权重覆盖",
      };
    },
  );

  /** Drop weight overrides for nodes that are gone (neither online nor fenced). */
  app.post("/api/v1/admin/nodes/weights/prune", async (req, reply) => {
    const admin = await requireSuperAdmin(req, reply, ctx);
    if (!admin) return;
    const removed = await pruneWorkerWeights(ctx.db);
    if (removed.length) {
      await writeAudit(ctx.db, "admin_node_prune_weights", admin.id, {
        removed,
      });
    }
    return {
      ok: true,
      removed,
      message: removed.length
        ? `已清理 ${removed.length} 个失效节点的权重`
        : "没有失效的权重记录",
    };
  });

  // ── OTA releases (super-admin) ─────────────────────────

  app.get("/api/v1/admin/releases/current", async (req, reply) => {
    const admin = await requireSuperAdmin(req, reply, ctx);
    if (!admin) return;
    const cur = await getCurrentRelease(ctx.db);
    return {
      release: cur,
      summary: releaseSummary(cur),
      appVersion: ctx.cfg.appVersion,
      otaEnabled: ctx.cfg.otaEnabled,
    };
  });

  app.get("/api/v1/admin/releases", async (req, reply) => {
    const admin = await requireSuperAdmin(req, reply, ctx);
    if (!admin) return;
    const q = req.query as { limit?: string };
    const limit = Number(q.limit ?? "20");
    const [versions, current] = await Promise.all([
      listReleaseVersions(ctx.db, limit),
      getCurrentRelease(ctx.db),
    ]);
    return {
      versions,
      currentVersion: current?.version ?? null,
      appVersion: ctx.cfg.appVersion,
    };
  });

  /**
   * Publish release: either full JSON (small packs) or multi-step blob upload.
   *
   * Body modes:
   * 1) { mode: "blob", sha256, dataBase64 } — upload one content-addressed file
   * 2) { mode: "publish", version, files: [{path,sha256,size}], setCurrent?, createdBy? }
   *    (blobs must already exist)
   * 3) { mode: "pack", version, files: [{path,sha256,size,dataBase64}], setCurrent? }
   *    — inline file bodies (CLI convenience for moderate packs)
   */
  app.post<{
    Body: {
      mode?: string;
      sha256?: string;
      dataBase64?: string;
      version?: string;
      files?: Array<{
        path: string;
        sha256: string;
        size: number;
        dataBase64?: string;
      }>;
      setCurrent?: boolean;
    };
  }>("/api/v1/admin/releases", { bodyLimit: ctx.cfg.uploadBodyLimit }, async (req, reply) => {
    const admin = await requireSuperAdmin(req, reply, ctx);
    if (!admin) return;
    const body = req.body || {};
    const mode = (body.mode || "pack").trim();

    try {
      if (mode === "blob") {
        const sha = (body.sha256 || "").trim().toLowerCase();
        const b64 = body.dataBase64 || "";
        if (!/^[a-f0-9]{64}$/.test(sha) || !b64) {
          return reply.code(400).send({ error: "sha256_and_dataBase64_required" });
        }
        const data = Buffer.from(b64, "base64");
        if (sha256Buffer(data) !== sha) {
          return reply.code(400).send({ error: "sha256_mismatch" });
        }
        if (data.length > 8 * 1024 * 1024) {
          return reply.code(400).send({ error: "blob_too_large", max: 8 * 1024 * 1024 });
        }
        const meta = await putBlobChunks(ctx.db, sha, data);
        return { ok: true, blob: meta, existed: await blobExists(ctx.db, sha) };
      }

      if (mode === "publish") {
        const files = (body.files || []).map((f) => ({
          path: f.path,
          sha256: f.sha256,
          size: f.size,
        }));
        const meta = buildReleaseMeta({
          version: body.version || "",
          files,
          createdBy: admin.username || admin.id,
        });
        await publishRelease(ctx.db, meta, {
          setCurrent: body.setCurrent !== false,
        });
        await writeAudit(ctx.db, "admin_release_publish", admin.id, {
          version: meta.version,
          fileCount: meta.fileCount,
          totalBytes: meta.totalBytes,
        });
        return { ok: true, release: meta, summary: releaseSummary(meta) };
      }

      // mode === pack: files with inline dataBase64
      if (mode === "pack") {
        const rawFiles = body.files || [];
        if (!rawFiles.length) {
          return reply.code(400).send({ error: "files_required" });
        }
        const entries: ReleaseFileEntry[] = [];
        for (const f of rawFiles) {
          if (!f.dataBase64) {
            return reply
              .code(400)
              .send({ error: "dataBase64_required", path: f.path });
          }
          const data = Buffer.from(f.dataBase64, "base64");
          if (data.length > 8 * 1024 * 1024) {
            return reply
              .code(400)
              .send({ error: "file_too_large", path: f.path });
          }
          const hash = sha256Buffer(data);
          if (f.sha256 && f.sha256.toLowerCase() !== hash) {
            return reply
              .code(400)
              .send({ error: "sha256_mismatch", path: f.path });
          }
          await putBlobChunks(ctx.db, hash, data);
          entries.push({
            path: f.path,
            sha256: hash,
            size: data.length,
          });
        }
        const meta = buildReleaseMeta({
          version: body.version || "",
          files: entries,
          createdBy: admin.username || admin.id,
        });
        await publishRelease(ctx.db, meta, {
          setCurrent: body.setCurrent !== false,
        });
        await writeAudit(ctx.db, "admin_release_publish", admin.id, {
          version: meta.version,
          fileCount: meta.fileCount,
          totalBytes: meta.totalBytes,
          mode: "pack",
        });
        return { ok: true, release: meta, summary: releaseSummary(meta) };
      }

      return reply.code(400).send({ error: "unknown_mode", mode });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return reply.code(400).send({ error: message });
    }
  });

  app.post<{ Body: { version?: string } }>(
    "/api/v1/admin/releases/current",
    async (req, reply) => {
      const admin = await requireSuperAdmin(req, reply, ctx);
      if (!admin) return;
      const version = (req.body?.version || "").trim();
      if (!version) {
        return reply.code(400).send({ error: "version required" });
      }
      try {
        const meta = await setCurrentRelease(ctx.db, version);
        await writeAudit(ctx.db, "admin_release_set_current", admin.id, {
          version,
        });
        return { ok: true, release: meta, summary: releaseSummary(meta) };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return reply.code(400).send({ error: message });
      }
    },
  );

  app.post<{
    Params: { workerId: string };
    Body: { version?: string; force?: boolean; confirm?: string };
  }>("/api/v1/admin/nodes/:workerId/update", async (req, reply) => {
    const admin = await requireSuperAdmin(req, reply, ctx);
    if (!admin) return;
    if (!ctx.cfg.otaEnabled) {
      return reply.code(400).send({ error: "OTA_ENABLED=false" });
    }
    const workerId = decodeURIComponent(req.params.workerId || "").trim();
    if (!workerId) {
      return reply.code(400).send({ error: "workerId required" });
    }
    const confirm = (req.body?.confirm || "").trim();
    if (confirm && confirm !== workerId) {
      return reply.code(400).send({
        error: "confirm_mismatch",
        message: "confirm must equal workerId",
      });
    }
    let version = (req.body?.version || "").trim();
    if (!version) {
      const cur = await getCurrentRelease(ctx.db);
      if (!cur) {
        return reply
          .code(400)
          .send({ error: "no_current_release", message: "先发布 release 包" });
      }
      version = cur.version;
    } else {
      const meta = await getReleaseMeta(ctx.db, version);
      if (!meta) {
        return reply.code(400).send({ error: "release_not_found" });
      }
    }
    try {
      const status = await enqueueWorkerUpdate(ctx.db, workerId, {
        version,
        requestedAt: new Date().toISOString(),
        requestedBy: admin.id,
        requestedByUsername: admin.username ?? null,
        force: Boolean(req.body?.force),
      });
      await writeAudit(ctx.db, "admin_node_update", admin.id, {
        workerId,
        version,
        force: Boolean(req.body?.force),
      });
      try {
        await publishWorkerWake(ctx.db);
      } catch {
        /* */
      }
      return {
        ok: true,
        workerId,
        version,
        status,
        message: `已下发更新任务 → ${version}，节点将在下一心跳周期内应用并重启`,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return reply.code(400).send({ error: message });
    }
  });

  app.post<{
    Body: { version?: string; force?: boolean };
  }>("/api/v1/admin/nodes/update-outdated", async (req, reply) => {
    const admin = await requireSuperAdmin(req, reply, ctx);
    if (!admin) return;
    if (!ctx.cfg.otaEnabled) {
      return reply.code(400).send({ error: "OTA_ENABLED=false" });
    }
    let version = (req.body?.version || "").trim();
    if (!version) {
      const cur = await getCurrentRelease(ctx.db);
      if (!cur) {
        return reply.code(400).send({ error: "no_current_release" });
      }
      version = cur.version;
    }
    const nodes = await ctx.worker.listFleetNodes();
    const targets = nodes.filter(
      (n) =>
        n.online &&
        !n.fenced &&
        (req.body?.force || !n.version || n.version !== version),
    );
    const results: Array<{ workerId: string; ok: boolean; error?: string }> =
      [];
    for (const n of targets) {
      try {
        await enqueueWorkerUpdate(ctx.db, n.id, {
          version,
          requestedAt: new Date().toISOString(),
          requestedBy: admin.id,
          requestedByUsername: admin.username ?? null,
          force: Boolean(req.body?.force),
        });
        results.push({ workerId: n.id, ok: true });
      } catch (err) {
        results.push({
          workerId: n.id,
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    await writeAudit(ctx.db, "admin_nodes_update_outdated", admin.id, {
      version,
      count: results.filter((r) => r.ok).length,
      targets: results.map((r) => r.workerId),
    });
    try {
      await publishWorkerWake(ctx.db);
    } catch {
      /* */
    }
    return {
      ok: true,
      version,
      queued: results.filter((r) => r.ok).length,
      results,
    };
  });

  app.get<{ Params: { workerId: string } }>(
    "/api/v1/admin/nodes/:workerId/update-status",
    async (req, reply) => {
      const admin = await requireSuperAdmin(req, reply, ctx);
      if (!admin) return;
      const workerId = decodeURIComponent(req.params.workerId || "").trim();
      if (!workerId) {
        return reply.code(400).send({ error: "workerId required" });
      }
      const status = await getWorkerUpdateStatus(ctx.db, workerId);
      return { workerId, status };
    },
  );

  /**
   * Force a deployment node offline (super-admin only).
   */
  app.post<{
    Params: { workerId: string };
    Body: { reason?: string; confirm?: string };
  }>("/api/v1/admin/nodes/:workerId/force-offline", async (req, reply) => {
    const admin = await requireSuperAdmin(req, reply, ctx);
    if (!admin) return;
    const workerId = decodeURIComponent(req.params.workerId || "").trim();
    if (!workerId) {
      return reply.code(400).send({ error: "workerId required" });
    }
    // Require confirm match to avoid misclick (UI sends confirm=workerId)
    const confirm = (req.body?.confirm || "").trim();
    if (confirm && confirm !== workerId) {
      return reply.code(400).send({
        error: "confirm_mismatch",
        message: "confirm must equal workerId",
      });
    }
    if (workerId === ctx.worker.getWorkerId()) {
      // Allow fencing self (drain this node via another admin path), but warn
      // — request may hang if this process is the only one; still OK for multi-node.
    }
    try {
      const { released, fence } = await forceOfflineWorker(ctx.db, workerId, {
        reason: req.body?.reason,
        byUserId: admin.id,
        byUsername: admin.username ?? null,
      });
      await writeAudit(ctx.db, "admin_node_force_offline", admin.id, {
        workerId,
        released,
        reason: fence.reason,
      });
      return {
        ok: true,
        workerId,
        released,
        fence,
        message:
          released > 0
            ? `已强制下线，释放 ${released} 个 bot 租约；目标进程将停止认领`
            : "已强制下线（无租约或已释放）；目标进程将停止认领",
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return reply.code(400).send({ error: message });
    }
  });

  /** Clear force-offline fence so the node may rejoin the fleet. */
  app.post<{ Params: { workerId: string } }>(
    "/api/v1/admin/nodes/:workerId/clear-fence",
    async (req, reply) => {
      const admin = await requireSuperAdmin(req, reply, ctx);
      if (!admin) return;
      const workerId = decodeURIComponent(req.params.workerId || "").trim();
      if (!workerId) {
        return reply.code(400).send({ error: "workerId required" });
      }
      const cleared = await clearWorkerFence(ctx.db, workerId);
      await writeAudit(ctx.db, "admin_node_clear_fence", admin.id, {
        workerId,
        cleared,
      });
      try {
        await publishWorkerWake(ctx.db);
      } catch {
        /* optional */
      }
      return {
        ok: true,
        workerId,
        cleared,
        message: cleared
          ? "已解除下线封锁，节点将在下一心跳重新加入"
          : "该节点没有封锁记录",
      };
    },
  );

  app.get<{ Params: { botId: string } }>("/api/v1/admin/bots/:botId/inbox", async (req, reply) => {
    if (!await requireSuperAdmin(req, reply, ctx)) return;
    const botId = req.params.botId;
    if (!await getBotAccount(ctx.db, botId)) return reply.code(404).send({ error: "bot_not_found" });
    return {
      ...await inboundQueueStats(ctx.db, [botId]),
      failedJobs: await listFailedInbound(ctx.db, botId),
    };
  });

  app.post<{ Params: { botId: string; jobId: string } }>("/api/v1/admin/bots/:botId/inbox/:jobId/retry", async (req, reply) => {
    const admin = await requireSuperAdmin(req, reply, ctx);
    if (!admin) return;
    const { botId, jobId } = req.params;
    if (!await getBotAccount(ctx.db, botId)) return reply.code(404).send({ error: "bot_not_found" });
    if (!await retryFailedInbound(ctx.db, botId, jobId)) return reply.code(404).send({ error: "failed_job_not_found" });
    await writeAudit(ctx.db, "admin_inbound_retry", admin.id, { botId, jobId });
    return { ok: true };
  });

  /** Start/restart workers for every active bot that has Redis credentials. */
  app.post("/api/v1/admin/workers/restart-all", async (req, reply) => {
    const admin = await requireSuperAdmin(req, reply, ctx);
    if (!admin) return;
    if (!ctx.cfg.workerEnabled) {
      return reply.code(400).send({ error: "WORKER_ENABLED=false" });
    }
    const bots = await listBotAccounts(ctx.db);
    const tokenMap = await hasBotCredentialsMany(
      ctx.db,
      bots.map((b) => b.id),
    );
    let started = 0;
    let skipped = 0;
    for (const b of bots) {
      if (b.status !== "active") {
        skipped++;
        continue;
      }
      if (!tokenMap[b.id]) {
        skipped++;
        continue;
      }
      ctx.worker.restartBot(b.id);
      started++;
    }
    await writeAudit(ctx.db, "admin_workers_restart_all", admin.id, {
      started,
      skipped,
    });
    return {
      ok: true,
      started,
      skipped,
      workers: await ctx.worker.listActiveBotIdsAsync(),
    };
  });

  app.post("/api/v1/admin/workers/stop-all", async (req, reply) => {
    const admin = await requireSuperAdmin(req, reply, ctx);
    if (!admin) return;
    const before = await ctx.worker.stopAllBots();
    await writeAudit(ctx.db, "admin_workers_stop_all", admin.id, {
      count: before.length,
      botIds: before,
    });
    return { ok: true, stopped: before.length };
  });

  /** Idempotent official persona seed (catgirl / girlfriend if missing). */
  app.post("/api/v1/admin/system/seed-personas", async (req, reply) => {
    const admin = await requireAdmin(req, reply, ctx);
    if (!admin) return;
    const before = (await listPersonas(ctx.db)).length;
    await seedPersonas(ctx.db);
    const afterList = await listPersonas(ctx.db);
    const after = afterList.length;
    await writeAudit(ctx.db, "admin_seed_personas", admin.id, {
      before,
      after,
      added: Math.max(0, after - before),
    });
    return {
      ok: true,
      before,
      after,
      added: Math.max(0, after - before),
      defaultPersona:
        afterList.find((p) => p.is_default)?.slug ??
        afterList.find((p) => p.enabled)?.slug ??
        null,
    };
  });

  app.get("/api/v1/admin/memories", async (req, reply) => {
    const admin = await requireAdmin(req, reply, ctx);
    if (!admin) return;
    const q = req.query as {
      botAccountId?: string;
      peerId?: string;
      personaId?: string;
    };
    if (!q.botAccountId || !q.peerId) {
      return reply.code(400).send({ error: "botAccountId and peerId required" });
    }
    const bot = await getBotAccount(ctx.db, q.botAccountId);
    if (!bot) return reply.code(404).send({ error: "bot not found" });
    if (q.personaId) {
      return {
        memories: await listMemories(
          ctx.db,
          q.botAccountId,
          q.peerId,
          q.personaId,
        ),
      };
    }
    // All personas for this peer — one pipelined wave, not one LRANGE each
    const personas = await listPersonas(ctx.db);
    const memMap = await listMemoriesMany(
      ctx.db,
      q.botAccountId,
      q.peerId,
      personas.map((p) => p.id),
    );
    const groups: {
      personaId: string;
      personaName: string;
      memories: { id: string; content: string }[];
    }[] = [];
    let total = 0;
    for (const p of personas) {
      const mems = memMap.get(p.id);
      if (mems?.length) {
        groups.push({
          personaId: p.id,
          personaName: p.display_name,
          memories: mems.map((m) => ({ id: m.id, content: m.content })),
        });
        total += mems.length;
      }
    }
    return { total, groups };
  });

  app.post<{
    Body: { botAccountId: string; peerId: string; personaId?: string };
  }>("/api/v1/admin/memories/reset", async (req, reply) => {
    const admin = await requireAdmin(req, reply, ctx);
    if (!admin) return;
    const { botAccountId, peerId, personaId } = req.body ?? {};
    if (!botAccountId || !peerId) {
      return reply.code(400).send({ error: "botAccountId and peerId required" });
    }
    const bot = await getBotAccount(ctx.db, botAccountId);
    if (!bot) return reply.code(404).send({ error: "bot not found" });
    await clearMemories(ctx.db, botAccountId, peerId, personaId);
    await writeAudit(ctx.db, "admin_memory_reset", admin.id, {
      botAccountId,
      peerId,
      personaId: personaId || null,
    });
    return { ok: true };
  });

  app.post<{
    Body: { botAccountId: string; peerId: string };
  }>("/api/v1/admin/messages/clear", async (req, reply) => {
    const admin = await requireAdmin(req, reply, ctx);
    if (!admin) return;
    const { botAccountId, peerId } = req.body ?? {};
    if (!botAccountId || !peerId) {
      return reply.code(400).send({ error: "botAccountId and peerId required" });
    }
    const bot = await getBotAccount(ctx.db, botAccountId);
    if (!bot) return reply.code(404).send({ error: "bot not found" });
    await clearMessages(ctx.db, botAccountId, peerId);
    await writeAudit(ctx.db, "admin_messages_clear", admin.id, {
      botAccountId,
      peerId,
    });
    return { ok: true };
  });

  app.get("/api/v1/admin/users", async (req, reply) => {
    const admin = await requireAdmin(req, reply, ctx);
    if (!admin) return;
    const users = await listUsers(ctx.db);
    const [botCounts, superAdminId] = await Promise.all([
      countBotsByOwners(
        ctx.db,
        users.map((u) => u.id),
      ),
      resolveSuperAdminId(ctx.db),
    ]);
    const mapped = users.map((u) => ({
      id: u.id,
      username: u.username,
      name: u.name,
      isAdmin: Boolean(u.is_admin),
      isSuperAdmin: Boolean(superAdminId && u.id === superAdminId),
      trustLevel: u.trust_level,
      avatarUrl: u.avatar_url,
      botCount: botCounts[u.id] ?? 0,
      createdAt: u.created_at,
      authProvider: u.auth_provider === "local" ? "local" : "linuxdo",
      isBanned: Boolean(u.is_banned),
      bannedAt: u.banned_at ?? null,
      bannedReason: u.banned_reason ?? null,
      invitedBy: u.invited_by ?? null,
    }));
    return { users: mapped };
  });

  app.get<{ Params: { id: string } }>(
    "/api/v1/admin/users/:id",
    async (req, reply) => {
      const admin = await requireAdmin(req, reply, ctx);
      if (!admin) return;
      const u = await getUser(ctx.db, req.params.id);
      if (!u) return reply.code(404).send({ error: "not found" });
      const bots = await listBotsByOwner(ctx.db, u.id);
      const [active, tokenMap] = await Promise.all([
        ctx.worker.listActiveBotIdsAsync().then((ids) => new Set(ids)),
        hasBotCredentialsMany(
          ctx.db,
          bots.map((b) => b.id),
        ),
      ]);
      return {
        user: {
          ...userPublicFields(u),
          invitedBy: u.invited_by ?? null,
          inviteCodeUsed: u.invite_code_used ?? null,
        },
        bots: bots.map((b) => ({
          id: b.id,
          displayName: b.display_name,
          status: b.status,
          hasToken: Boolean(tokenMap[b.id]),
          workerActive: active.has(b.id),
        })),
      };
    },
  );

  app.patch<{
    Params: { id: string };
    Body: { isAdmin?: boolean };
  }>("/api/v1/admin/users/:id", async (req, reply) => {
    // Grant/revoke admin is super-admin only.
    const admin = await requireSuperAdmin(req, reply, ctx);
    if (!admin) return;
    const target = await getUser(ctx.db, req.params.id);
    if (!target) return reply.code(404).send({ error: "not found" });
    if (typeof req.body?.isAdmin !== "boolean") {
      return reply.code(400).send({ error: "isAdmin boolean required" });
    }
    const next = req.body.isAdmin;
    if (!next && target.id === admin.id) {
      return reply.code(400).send({ error: "cannot revoke your own admin" });
    }
    // Super-admin (earliest-created admin) cannot be demoted by anyone.
    if (!next && target.is_admin && (await isSuperAdmin(ctx.db, target.id))) {
      return reply.code(400).send({
        error: "cannot_revoke_super_admin",
        message: "系统首位管理员（超管）不可撤销",
      });
    }
    if (!next && target.is_admin) {
      const all = await listUsers(ctx.db);
      const adminCount = all.filter((u) => u.is_admin).length;
      if (adminCount <= 1) {
        return reply
          .code(400)
          .send({ error: "cannot revoke the last admin" });
      }
    }
    const updated = await setUserAdmin(ctx.db, target.id, next);
    await writeAudit(
      ctx.db,
      next ? "user_admin_grant" : "user_admin_revoke",
      admin.id,
      { userId: target.id, username: target.username },
    );
    return {
      user: userPublicFields(updated),
    };
  });

  app.post<{
    Params: { id: string };
    Body: { reason?: string; cascadeBots?: boolean };
  }>("/api/v1/admin/users/:id/ban", async (req, reply) => {
    const admin = await requireAdmin(req, reply, ctx);
    if (!admin) return;
    const target = await getUser(ctx.db, req.params.id);
    if (!target) return reply.code(404).send({ error: "not found" });
    if (target.id === admin.id) {
      return reply.code(400).send({ error: "cannot ban yourself" });
    }
    // Super-admin cannot be banned by anyone (including other admins).
    if (target.is_admin && (await isSuperAdmin(ctx.db, target.id))) {
      return reply.code(400).send({
        error: "cannot_ban_super_admin",
        message: "系统首位管理员（超管）不可封禁",
      });
    }
    if (target.is_admin) {
      const all = await listUsers(ctx.db);
      const adminCount = all.filter((u) => u.is_admin && !u.is_banned).length;
      if (adminCount <= 1) {
        return reply.code(400).send({ error: "cannot ban the last admin" });
      }
    }
    const updated = await setUserBanned(ctx.db, target.id, true, {
      reason: req.body?.reason,
      actorId: admin.id,
    });
    await destroyAllSessionsForUser(ctx.db, target.id);
    // Default cascade: deactivate all bots
    const cascade = req.body?.cascadeBots !== false;
    if (cascade) {
      const bots = await listBotsByOwner(ctx.db, target.id);
      for (const b of bots) {
        if (b.status === "active") {
          await setBotStatus(ctx.db, b.id, "inactive");
          ctx.worker.stopBot(b.id);
        }
      }
    }
    await writeAudit(ctx.db, "user_banned", admin.id, {
      userId: target.id,
      username: target.username,
      reason: req.body?.reason ?? null,
      cascadeBots: cascade,
    });
    return { user: userPublicFields(updated) };
  });

  app.post<{ Params: { id: string } }>(
    "/api/v1/admin/users/:id/unban",
    async (req, reply) => {
      const admin = await requireAdmin(req, reply, ctx);
      if (!admin) return;
      const target = await getUser(ctx.db, req.params.id);
      if (!target) return reply.code(404).send({ error: "not found" });
      const updated = await setUserBanned(ctx.db, target.id, false);
      await writeAudit(ctx.db, "user_unbanned", admin.id, {
        userId: target.id,
        username: target.username,
      });
      return { user: userPublicFields(updated) };
    },
  );

  app.delete<{
    Params: { id: string };
    Querystring: { confirm?: string };
  }>("/api/v1/admin/users/:id", async (req, reply) => {
    const admin = await requireAdmin(req, reply, ctx);
    if (!admin) return;
    const target = await getUser(ctx.db, req.params.id);
    if (!target) return reply.code(404).send({ error: "not found" });
    if (target.id === admin.id) {
      return reply.code(400).send({ error: "cannot delete yourself" });
    }
    // Super-admin = earliest-created admin; cannot be deleted by anyone.
    if (target.is_admin && (await isSuperAdmin(ctx.db, target.id))) {
      return reply.code(400).send({
        error: "cannot_delete_super_admin",
        message: "系统首位管理员（超管）不可删除",
      });
    }
    if (target.is_admin) {
      const all = await listUsers(ctx.db);
      const adminCount = all.filter((u) => u.is_admin).length;
      if (adminCount <= 1) {
        return reply.code(400).send({ error: "cannot delete the last admin" });
      }
    }
    const confirm = (req.query?.confirm || "").trim();
    if (!confirm || confirm.toLowerCase() !== target.username.toLowerCase()) {
      return reply.code(400).send({
        error: "confirm_required",
        message: "请在 query confirm= 中传入目标用户名以确认删除",
      });
    }
    // Stop workers for owned bots before delete
    const bots = await listBotsByOwner(ctx.db, target.id);
    for (const b of bots) {
      ctx.worker.stopBot(b.id);
    }
    const ok = await deleteUserAccount(ctx.db, target.id);
    if (!ok) return reply.code(404).send({ error: "not found" });
    await writeAudit(ctx.db, "user_deleted", admin.id, {
      userId: target.id,
      username: target.username,
    });
    return { ok: true };
  });

  // Invite settings (admin)
  app.get("/api/v1/admin/settings/invites", async (req, reply) => {
    const admin = await requireAdmin(req, reply, ctx);
    if (!admin) return;
    const settings = await getInviteSettings(
      ctx.db,
      inviteDefaultsFromCfg(ctx.cfg),
    );
    return { settings };
  });

  app.patch<{
    Body: {
      quotaWindowHours?: number;
      quotaMax?: number;
      codeTtlSec?: number;
      maxPendingPerUser?: number;
      codeLength?: number;
    };
  }>("/api/v1/admin/settings/invites", async (req, reply) => {
    const admin = await requireAdmin(req, reply, ctx);
    if (!admin) return;
    const body = req.body || {};
    const settings = await setInviteSettings(
      ctx.db,
      {
        quotaWindowHours: body.quotaWindowHours,
        quotaMax: body.quotaMax,
        codeTtlSec: body.codeTtlSec,
        maxPendingPerUser: body.maxPendingPerUser,
        codeLength: body.codeLength,
      },
      inviteDefaultsFromCfg(ctx.cfg),
    );
    await writeAudit(ctx.db, "invite_settings_updated", admin.id, {
      settings,
    });
    return { settings };
  });

  // ── Runtime config (super-admin-only env overrides, stored in Redis) ──
  // Read included: the payload names every tuning knob and which ones are
  // overridden, and this surface can disable the worker fleet-wide.
  app.get("/api/v1/admin/settings/runtime", async (req, reply) => {
    const admin = await requireSuperAdmin(req, reply, ctx);
    if (!admin) return;
    if (!ctx.settings) {
      return reply
        .code(503)
        .send({ error: "runtime settings manager not initialized" });
    }
    return {
      ...ctx.settings.view(),
      warnings: ctx.settings.currentWarnings(),
      canEdit: true,
    };
  });

  app.patch<{
    Body: {
      patch?: Record<string, unknown>;
      reset?: string[];
    };
  }>("/api/v1/admin/settings/runtime", async (req, reply) => {
    const admin = await requireSuperAdmin(req, reply, ctx);
    if (!admin) return;
    if (!ctx.settings) {
      return reply
        .code(503)
        .send({ error: "runtime settings manager not initialized" });
    }
    const body = req.body || {};
    let result;
    try {
      result = await ctx.settings.patch({
        patch: body.patch,
        reset: Array.isArray(body.reset) ? body.reset : undefined,
        actor: admin.username || admin.id,
      });
    } catch (err) {
      // Never write a merge derived from a failed read — that would wipe every
      // other override fleet-wide. Ask the admin to retry instead.
      if (err instanceof RuntimeSettingsUnavailableError) {
        return reply.code(503).send({ error: err.message });
      }
      throw err;
    }
    if (result.changed.length) {
      await writeAudit(ctx.db, "runtime_settings_updated", admin.id, {
        changed: result.changed,
        restartRequired: result.restartRequired,
      });
    }
    return {
      ...result.view,
      warnings: result.warnings,
      changed: result.changed,
      restartRequired: result.restartRequired,
      canEdit: true,
    };
  });

  app.post("/api/v1/admin/settings/runtime/reset", async (req, reply) => {
    const admin = await requireSuperAdmin(req, reply, ctx);
    if (!admin) return;
    if (!ctx.settings) {
      return reply
        .code(503)
        .send({ error: "runtime settings manager not initialized" });
    }
    const result = await ctx.settings.patch({
      resetAll: true,
      actor: admin.username || admin.id,
    });
    await writeAudit(ctx.db, "runtime_settings_reset", admin.id, {
      changed: result.changed,
    });
    return {
      ...result.view,
      warnings: result.warnings,
      changed: result.changed,
      restartRequired: result.restartRequired,
      canEdit: true,
    };
  });

  app.get("/api/v1/admin/bots", async (req, reply) => {
    const admin = await requireAdmin(req, reply, ctx);
    if (!admin) return;
    // listActiveBotIdsAsync is itself 2 chained RTTs — don't chain it after
    // the bot listing as well.
    const [bots, activeIds] = await Promise.all([
      listBotAccounts(ctx.db),
      ctx.worker.listActiveBotIdsAsync(),
    ]);
    const active = new Set(activeIds);
    const botIds = bots.map((b) => b.id);
    const [owners, tokenMap, peerStats] = await Promise.all([
      getUsersByIds(
        ctx.db,
        bots.map((b) => b.owner_user_id).filter(Boolean),
      ),
      hasBotCredentialsMany(ctx.db, botIds),
      peerStatsByBots(ctx.db, botIds),
    ]);
    const mapped = bots.map((b) => {
      const owner = b.owner_user_id
        ? owners.get(b.owner_user_id)
        : undefined;
      const stats = peerStats[b.id] ?? {
        peerCount: 0,
        unapprovedPeerCount: 0,
      };
      return {
        id: b.id,
        displayName: b.display_name,
        ownerUserId: b.owner_user_id,
        ownerUsername: owner?.username ?? null,
        ownerName: owner?.name ?? null,
        status: b.status,
        accountRef: b.account_ref,
        workerActive: active.has(b.id),
        hasToken: Boolean(tokenMap[b.id]),
        peerCount: stats.peerCount,
        unapprovedPeerCount: stats.unapprovedPeerCount,
        updatedAt: b.updated_at,
      };
    });
    return { bots: mapped };
  });

  app.get<{ Params: { botId: string } }>(
    "/api/v1/admin/bots/:botId",
    async (req, reply) => {
      const admin = await requireAdmin(req, reply, ctx);
      if (!admin) return;
      const bot = await getBotAccount(ctx.db, req.params.botId);
      if (!bot) return reply.code(404).send({ error: "not found" });
      const owner = bot.owner_user_id
        ? await getUser(ctx.db, bot.owner_user_id)
        : undefined;
      const peers = await listPeers(ctx.db, bot.id);
      const [active, hasToken, asgMap] = await Promise.all([
        ctx.worker.listActiveBotIdsAsync().then((ids) => new Set(ids)),
        hasBotCredentials(ctx.db, bot.id),
        getAssignmentsMany(
          ctx.db,
          peers.map((p) => ({
            botAccountId: p.bot_account_id,
            peerId: p.peer_id,
          })),
        ),
      ]);
      // Message counts / last message still per-peer but parallelized
      const peerItems = await Promise.all(
        peers.map(async (p) => {
          const [msgCount, recent] = await Promise.all([
            countUserMessages(ctx.db, p.bot_account_id, p.peer_id),
            listRecentMessages(ctx.db, p.bot_account_id, p.peer_id, 1),
          ]);
          const last = recent[recent.length - 1];
          return {
            peerId: p.peer_id,
            approved: Boolean(p.approved),
            personaId:
              asgMap.get(`${p.bot_account_id}|${p.peer_id}`) ?? null,
            createdAt: p.created_at ?? null,
            messageCount: msgCount,
            lastMessageAt: last?.created_at ?? null,
            lastRole: last?.role ?? null,
          };
        }),
      );
      return {
        bot: {
          id: bot.id,
          displayName: bot.display_name,
          ownerUserId: bot.owner_user_id,
          ownerUsername: owner?.username ?? null,
          status: bot.status,
          accountRef: bot.account_ref,
          baseUrl: bot.base_url,
          workerActive: active.has(bot.id),
          hasToken,
          updatesCursor: bot.updates_cursor ? "set" : "empty",
          createdAt: bot.created_at,
          updatedAt: bot.updated_at,
        },
        peers: peerItems,
      };
    },
  );

  app.patch<{
    Params: { botId: string };
    Body: { displayName?: string; status?: "active" | "inactive" };
  }>("/api/v1/admin/bots/:botId", async (req, reply) => {
    const admin = await requireAdmin(req, reply, ctx);
    if (!admin) return;
    const bot = await getBotAccount(ctx.db, req.params.botId);
    if (!bot) return reply.code(404).send({ error: "not found" });
    const displayName = req.body?.displayName;
    const status = req.body?.status;
    if (!displayName?.trim() && status !== "active" && status !== "inactive") {
      return reply
        .code(400)
        .send({ error: "displayName or status required" });
    }
    try {
      let updated = bot;
      if (displayName?.trim()) {
        updated = await updateBotDisplayName(ctx.db, bot.id, displayName);
        await writeAudit(ctx.db, "admin_bot_renamed", admin.id, {
          botId: bot.id,
          displayName: updated.display_name,
        });
      }
      if (status === "active" || status === "inactive") {
        updated = await setBotStatus(ctx.db, bot.id, status);
        if (status === "inactive") {
          ctx.worker.stopBot(bot.id);
        } else if (await hasBotCredentials(ctx.db, bot.id)) {
          // Always mark pollable; worker process claims if enabled
          ctx.worker.restartBot(bot.id);
        }
        await writeAudit(ctx.db, "admin_bot_status", admin.id, {
          botId: bot.id,
          status,
        });
      }
      return {
        bot: {
          id: updated.id,
          displayName: updated.display_name,
          status: updated.status,
          ownerUserId: updated.owner_user_id,
        },
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return reply.code(400).send({ error: message });
    }
  });

  app.post<{ Params: { botId: string } }>(
    "/api/v1/admin/bots/:botId/stop-worker",
    async (req, reply) => {
      const admin = await requireSuperAdmin(req, reply, ctx);
      if (!admin) return;
      const bot = await getBotAccount(ctx.db, req.params.botId);
      if (!bot) return reply.code(404).send({ error: "not found" });
      ctx.worker.stopBot(bot.id);
      await writeAudit(ctx.db, "admin_bot_stop_worker", admin.id, {
        botId: bot.id,
      });
      return { ok: true };
    },
  );

  app.post<{ Params: { botId: string } }>(
    "/api/v1/admin/bots/:botId/start-worker",
    async (req, reply) => {
      const admin = await requireSuperAdmin(req, reply, ctx);
      if (!admin) return;
      const bot = await getBotAccount(ctx.db, req.params.botId);
      if (!bot) return reply.code(404).send({ error: "not found" });
      if (bot.status !== "active") {
        return reply.code(400).send({ error: "bot is not active" });
      }
      if (!(await hasBotCredentials(ctx.db, bot.id))) {
        return reply
          .code(400)
          .send({ error: "missing token — user must re-scan login" });
      }
      ctx.worker.restartBot(bot.id);
      await writeAudit(ctx.db, "admin_bot_start_worker", admin.id, {
        botId: bot.id,
      });
      return { ok: true, workerActive: true };
    },
  );

  app.delete<{ Params: { botId: string } }>(
    "/api/v1/admin/bots/:botId",
    async (req, reply) => {
      const admin = await requireAdmin(req, reply, ctx);
      if (!admin) return;
      const bot = await getBotAccount(ctx.db, req.params.botId);
      if (!bot) return reply.code(404).send({ error: "not found" });
      ctx.worker.stopBot(bot.id);
      await deleteBotAccount(ctx.db, bot.id);
      await writeAudit(ctx.db, "admin_bot_deleted", admin.id, {
        botId: bot.id,
        ownerUserId: bot.owner_user_id,
      });
      return { ok: true };
    },
  );

  // ── Admin broadcast (async text push) ──────────────────

  function publicBroadcastJob(job: Awaited<ReturnType<typeof getBroadcastJob>>) {
    if (!job) return null;
    return {
      id: job.id,
      createdBy: job.createdBy,
      createdAt: job.createdAt,
      updatedAt: job.updatedAt,
      status: job.status,
      text: job.text,
      scope: job.scope,
      botIds: job.botIds,
      targetCount: job.targets?.length ?? 0,
      stats: job.stats,
      error: job.error ?? null,
      startedAt: job.startedAt ?? null,
      finishedAt: job.finishedAt ?? null,
      failures: job.failures ?? [],
      cursor: job.cursor ?? 0,
      recipientCount: job.recipients?.length ?? 0,
    };
  }

  app.get("/api/v1/admin/broadcast", async (req, reply) => {
    const admin = await requireSuperAdmin(req, reply, ctx);
    if (!admin) return;
    const limit = Number((req.query as { limit?: string }).limit ?? "30");
    const jobs = await listBroadcastJobs(ctx.db, Math.min(100, Math.max(1, limit)));
    return { jobs: jobs.map((j) => publicBroadcastJob(j)) };
  });

  app.get<{ Params: { id: string } }>(
    "/api/v1/admin/broadcast/:id",
    async (req, reply) => {
      const admin = await requireSuperAdmin(req, reply, ctx);
      if (!admin) return;
      const job = await getBroadcastJob(ctx.db, req.params.id);
      if (!job) return reply.code(404).send({ error: "not found" });
      return { job: publicBroadcastJob(job) };
    },
  );

  app.post<{
    Body: {
      text?: string;
      scope?: BroadcastScope;
      botIds?: string[];
      targets?: BroadcastTarget[];
      /** If true, only expand & return counts — do not create */
      preview?: boolean;
    };
  }>("/api/v1/admin/broadcast", async (req, reply) => {
    const admin = await requireSuperAdmin(req, reply, ctx);
    if (!admin) return;

    const text = (req.body?.text ?? "").trim();
    const maxText = Math.max(1, ctx.cfg.broadcastMaxText || 2000);
    if (!text) {
      return reply.code(400).send({ error: "text required" });
    }
    if (text.length > maxText) {
      return reply
        .code(400)
        .send({ error: `text too long (max ${maxText})` });
    }

    const scope = req.body?.scope;
    if (scope !== "all_bots" && scope !== "bots" && scope !== "targets") {
      return reply
        .code(400)
        .send({ error: "scope must be all_bots | bots | targets" });
    }

    const botIds = Array.isArray(req.body?.botIds)
      ? req.body!.botIds.map(String)
      : [];
    const targets = Array.isArray(req.body?.targets)
      ? req.body!.targets
          .filter(
            (t) =>
              t &&
              typeof t === "object" &&
              typeof (t as BroadcastTarget).botId === "string" &&
              typeof (t as BroadcastTarget).peerId === "string",
          )
          .map((t) => ({
            botId: String((t as BroadcastTarget).botId).trim(),
            peerId: String((t as BroadcastTarget).peerId).trim(),
          }))
      : [];

    if (scope === "bots" && !botIds.length) {
      return reply.code(400).send({ error: "botIds required for scope=bots" });
    }
    if (scope === "targets" && !targets.length) {
      return reply
        .code(400)
        .send({ error: "targets required for scope=targets" });
    }

    if (req.body?.preview) {
      const preview = await previewBroadcast(ctx.db, {
        scope,
        botIds,
        targets,
      });
      return {
        preview: {
          deliverable: preview.deliverable,
          skippedNoToken: preview.skippedNoToken,
          missingBots: preview.missingBots,
          textLength: text.length,
        },
      };
    }

    try {
      const job = await createBroadcastJob(ctx.db, {
        createdBy: admin.id,
        text,
        scope,
        botIds,
        targets,
        historyLimit: ctx.cfg.broadcastHistory,
      });
      await writeAudit(ctx.db, "admin_broadcast_create", admin.id, {
        jobId: job.id,
        scope: job.scope,
        total: job.stats.total,
        textLen: text.length,
        botIds: job.botIds,
      });
      // Nudge worker to start immediately (same process or next poll)
      try {
        ctx.worker.wakeBroadcast();
      } catch {
        /* worker may be disabled */
      }
      return reply.code(201).send({ job: publicBroadcastJob(job) });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return reply.code(400).send({ error: message });
    }
  });

  app.post<{ Params: { id: string } }>(
    "/api/v1/admin/broadcast/:id/cancel",
    async (req, reply) => {
      const admin = await requireSuperAdmin(req, reply, ctx);
      if (!admin) return;
      try {
        const job = await cancelBroadcastJob(ctx.db, req.params.id);
        if (!job) return reply.code(404).send({ error: "not found" });
        await writeAudit(ctx.db, "admin_broadcast_cancel", admin.id, {
          jobId: job.id,
          stats: job.stats,
        });
        return { job: publicBroadcastJob(job) };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return reply.code(400).send({ error: message });
      }
    },
  );

  app.get<{ Params: { botId: string } }>(
    "/api/v1/admin/bots/:botId/send-targets",
    async (req, reply) => {
      const admin = await requireSuperAdmin(req, reply, ctx);
      if (!admin) return;
      const bot = await getBotAccount(ctx.db, req.params.botId);
      if (!bot) return reply.code(404).send({ error: "not found" });
      const targets = await listBotSendTargets(ctx.db, bot.id);
      return {
        botId: bot.id,
        displayName: bot.display_name,
        targets,
        deliverable: targets.filter((t) => t.hasContextToken).length,
        total: targets.length,
      };
    },
  );

  app.get("/api/v1/admin/audit", async (req, reply) => {
    const admin = await requireAdmin(req, reply, ctx);
    if (!admin) return;
    const limit = Number((req.query as { limit?: string }).limit ?? "50");
    return { logs: await listAuditLogs(ctx.db, Math.min(limit, 200)) };
  });

  /**
   * Recent activity stream backlog (super-admin). Merges Redis LIST + local ring.
   * Query: limit, types=message,redis,worker,llm, full=1
   */
  app.get("/api/v1/admin/stream/recent", async (req, reply) => {
    const admin = await requireSuperAdmin(req, reply, ctx);
    if (!admin) return;
    if (!ctx.cfg.dataStreamEnabled || !ctx.activityBus) {
      return reply.code(503).send({ error: "data_stream_disabled" });
    }
    const q = req.query as {
      limit?: string;
      types?: string;
      full?: string;
    };
    const limit = Math.min(Math.max(Number(q.limit) || 100, 1), 300);
    const full = q.full === "1" || q.full === "true";
    const typeFilter = parseStreamTypeFilter(q.types);
    let events = await ctx.activityBus.recentMerged(limit);
    if (typeFilter) {
      events = events.filter((e) => streamTypeMatches(e.type, typeFilter));
    }
    events = events.map((e) => shapeStreamEventForClient(e, full));
    return {
      events,
      enabled: true,
      source: ctx.activityBus.getSource(),
    };
  });

  /**
   * Live SSE activity stream (super-admin).
   * Query: types, full=1, heartbeat=15
   */
  app.get("/api/v1/admin/stream", async (req, reply) => {
    const admin = await requireSuperAdmin(req, reply, ctx);
    if (!admin) return;
    if (!ctx.cfg.dataStreamEnabled || !ctx.activityBus) {
      return reply.code(503).send({ error: "data_stream_disabled" });
    }

    const q = req.query as {
      types?: string;
      full?: string;
      heartbeat?: string;
      limit?: string;
    };
    const full = q.full === "1" || q.full === "true";
    const typeFilter = parseStreamTypeFilter(q.types);
    const heartbeatSec = Math.min(
      Math.max(Number(q.heartbeat) || 15, 5),
      60,
    );
    const backlogLimit = Math.min(Math.max(Number(q.limit) || 80, 0), 200);
    const bus = ctx.activityBus;

    // Disable compression buffering for this response
    reply.hijack();
    const raw = reply.raw;
    raw.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });

    let closed = false;
    const write = (chunk: string) => {
      if (closed) return;
      try {
        raw.write(chunk);
      } catch {
        closed = true;
      }
    };

    const sendEvent = (ev: import("./activity-stream.js").StreamEvent) => {
      if (typeFilter && !streamTypeMatches(ev.type, typeFilter)) return;
      const shaped = shapeStreamEventForClient(ev, full);
      write(`id: ${shaped.id}\n`);
      write(`event: activity\n`);
      write(`data: ${JSON.stringify(shaped)}\n\n`);
    };

    write(`event: meta\ndata: ${JSON.stringify({
      ok: true,
      source: bus.getSource(),
      full,
      types: q.types || "all",
      ts: new Date().toISOString(),
    })}\n\n`);

    if (backlogLimit > 0) {
      try {
        let backlog = await bus.recentMerged(backlogLimit);
        if (typeFilter) {
          backlog = backlog.filter((e) => streamTypeMatches(e.type, typeFilter));
        }
        // Send oldest first so UI can append chronologically
        for (const ev of backlog.slice().reverse()) {
          sendEvent(ev);
        }
      } catch {
        /* */
      }
    }

    const unsub = bus.subscribe((ev) => {
      sendEvent(ev);
    });

    const heartbeat = setInterval(() => {
      write(`: ping ${Date.now()}\n\n`);
    }, heartbeatSec * 1000);

    const onClose = () => {
      if (closed) return;
      closed = true;
      clearInterval(heartbeat);
      unsub();
      try {
        raw.end();
      } catch {
        /* */
      }
    };

    req.raw.on("close", onClose);
    req.raw.on("error", onClose);
  });

  app.get("/api/v1/admin/usage", async (req, reply) => {
    const admin = await requireAdmin(req, reply, ctx);
    if (!admin) return;
    const q = req.query as { day?: string; days?: string };
    if (q.days) {
      const n = Math.min(Math.max(Number(q.days) || 7, 1), 30);
      // Each day is an independent multi-RTT read — fan them out. 30 days
      // used to be ~30x the latency of one.
      const days = await Promise.all(
        Array.from({ length: n }, (_unused, i) =>
          getUsageDayStats(ctx.db, dayKeyOffset(-i)),
        ),
      );
      return { days };
    }
    const day = q.day || dayKey();
    return { usage: await getUsageDayStats(ctx.db, day) };
  });

  app.get("/api/v1/admin/personas", async (req, reply) => {
    const admin = await requireAdmin(req, reply, ctx);
    if (!admin) return;
    const q = ((req.query as { q?: string }).q ?? "").trim().toLowerCase();
    const includeDisabled =
      (req.query as { includeDisabled?: string }).includeDisabled === "1" ||
      (req.query as { includeDisabled?: string }).includeDisabled === "true";
    const all = await listPersonas(ctx.db);
    let personas = includeDisabled ? all : all.filter((p) => p.enabled);
    if (q) {
      personas = personas.filter((p) => {
        const hay = [p.display_name, p.description, p.slug, ...(p.tags || [])]
          .join(" ")
          .toLowerCase();
        return hay.includes(q);
      });
    }
    return {
      total: personas.length,
      personas: personas.map((p) =>
        personaPublicDto(p, {
          enabled: p.enabled !== 0,
          isDefault: Boolean(p.is_default),
        }),
      ),
    };
  });

  app.get<{ Params: { id: string } }>(
    "/api/v1/admin/personas/:id",
    async (req, reply) => {
      const admin = await requireAdmin(req, reply, ctx);
      if (!admin) return;
      const p = await getPersona(ctx.db, req.params.id);
      if (!p) return reply.code(404).send({ error: "not found" });
      const prompt = await getPublishedPrompt(ctx.db, p.id);
      return {
        persona: personaPublicDto(p, {
          enabled: p.enabled !== 0,
          isDefault: Boolean(p.is_default),
          systemPrompt: prompt,
        }),
      };
    },
  );

  app.post<{ Params: { id: string } }>(
    "/api/v1/admin/personas/:id/set-default",
    async (req, reply) => {
      const admin = await requireAdmin(req, reply, ctx);
      if (!admin) return;
      try {
        const persona = await setDefaultPersona(ctx.db, req.params.id);
        await writeAudit(ctx.db, "admin_persona_set_default", admin.id, {
          id: persona.id,
        });
        return {
          ok: true,
          persona: {
            id: persona.id,
            displayName: persona.display_name,
            isDefault: true,
          },
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return reply.code(400).send({ error: message });
      }
    },
  );

  app.put<{
    Params: { id: string };
    Body: {
      displayName?: string;
      description?: string;
      tags?: string[];
      visibility?: "public" | "private";
      systemPrompt?: string;
    };
  }>("/api/v1/admin/personas/:id", async (req, reply) => {
    const admin = await requireAdmin(req, reply, ctx);
    if (!admin) return;
    const p = await getPersona(ctx.db, req.params.id);
    if (!p) return reply.code(404).send({ error: "not found" });
    try {
      const persona = await updatePersonaMeta(ctx.db, p.id, req.body ?? {});
      await writeAudit(ctx.db, "admin_persona_updated", admin.id, {
        id: p.id,
      });
      return { persona };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return reply.code(400).send({ error: message });
    }
  });

  app.post<{ Params: { id: string } }>(
    "/api/v1/admin/personas/:id/takedown",
    async (req, reply) => {
      const admin = await requireAdmin(req, reply, ctx);
      if (!admin) return;
      const p = await getPersona(ctx.db, req.params.id);
      if (!p) return reply.code(404).send({ error: "not found" });
      if (p.owner_user_id === "system") {
        return reply.code(403).send({ error: "cannot takedown system persona" });
      }
      await softDeletePersona(ctx.db, p.id);
      await writeAudit(ctx.db, "persona_takedown", admin.id, { id: p.id });
      return { ok: true };
    },
  );

  app.post<{ Params: { id: string } }>(
    "/api/v1/admin/personas/:id/restore",
    async (req, reply) => {
      const admin = await requireAdmin(req, reply, ctx);
      if (!admin) return;
      try {
        const persona = await restorePersona(ctx.db, req.params.id);
        await writeAudit(ctx.db, "persona_restore", admin.id, {
          id: persona.id,
        });
        return { ok: true, persona };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return reply.code(404).send({ error: message });
      }
    },
  );

  app.post<{
    Body: {
      slug: string;
      displayName: string;
      description?: string;
      systemPrompt: string;
      isDefault?: boolean;
      contentPolicy?: string;
      tags?: string[];
    };
  }>("/api/v1/admin/personas", async (req, reply) => {
    const admin = await requireAdmin(req, reply, ctx);
    if (!admin) return;
    const body = req.body;
    if (!body?.slug || !body.displayName || !body.systemPrompt) {
      return reply.code(400).send({ error: "missing fields" });
    }
    if (await getPersonaBySlug(ctx.db, body.slug)) {
      return reply.code(409).send({ error: "slug exists" });
    }
    const persona = await createPersona(ctx.db, {
      slug: body.slug,
      displayName: body.displayName,
      description: body.description,
      systemPrompt: body.systemPrompt,
      isDefault: body.isDefault,
      contentPolicy: body.contentPolicy ?? "standard",
      ownerUserId: "system",
      visibility: "public",
      tags: Array.isArray(body.tags) ? body.tags : undefined,
    });
    await writeAudit(ctx.db, "persona_created", admin.id, { id: persona.id });
    return { persona };
  });

  app.post<{
    Params: { id: string };
    Body: { systemPrompt: string };
  }>("/api/v1/admin/personas/:id/publish", async (req, reply) => {
    const admin = await requireAdmin(req, reply, ctx);
    if (!admin) return;
    if (!req.body?.systemPrompt) {
      return reply.code(400).send({ error: "systemPrompt required" });
    }
    try {
      const version = await publishPersonaVersion(
        ctx.db,
        req.params.id,
        req.body.systemPrompt,
      );
      await writeAudit(ctx.db, "admin_persona_publish", admin.id, {
        id: req.params.id,
      });
      return { version };
    } catch {
      return reply.code(404).send({ error: "not found" });
    }
  });

  // ── Admin stickers (review + official upload) ────────

  app.get("/api/v1/admin/stickers", async (req, reply) => {
    const admin = await requireAdmin(req, reply, ctx);
    if (!admin) return;
    const q = req.query as {
      q?: string;
      enabled?: string;
      status?: string;
    };
    const reviewStatus =
      q.status === "pending" ||
      q.status === "approved" ||
      q.status === "rejected"
        ? q.status
        : "all";
    let [stickers, pendingCount] = await Promise.all([
      listStickers(ctx.db, { q: q.q, reviewStatus }),
      countPendingStickers(ctx.db),
    ]);
    if (q.enabled === "1" || q.enabled === "true") {
      stickers = stickers.filter((s) => s.enabled);
    } else if (q.enabled === "0" || q.enabled === "false") {
      stickers = stickers.filter((s) => !s.enabled);
    }
    return { stickers, pendingCount };
  });

  app.get<{ Params: { id: string } }>(
    "/api/v1/admin/stickers/:id",
    async (req, reply) => {
      const admin = await requireAdmin(req, reply, ctx);
      if (!admin) return;
      const sticker = await getSticker(ctx.db, req.params.id);
      if (!sticker) return reply.code(404).send({ error: "not found" });
      return { sticker };
    },
  );

  app.get<{ Params: { id: string } }>(
    "/api/v1/admin/stickers/:id/image",
    async (req, reply) => {
      const admin = await requireAdmin(req, reply, ctx);
      if (!admin) return;
      const sticker = await getSticker(ctx.db, req.params.id);
      if (!sticker) return reply.code(404).send({ error: "not found" });
      return sendPrivateStickerImage(ctx, req, reply, sticker);
    },
  );

  app.post<{
    Body: {
      slug?: string;
      displayName: string;
      description?: string;
      tags?: string[];
      mime?: string;
      dataBase64: string;
      enabled?: boolean;
      autoApprove?: boolean;
      visibility?: "public" | "private";
    };
  }>("/api/v1/admin/stickers", { bodyLimit: ctx.cfg.uploadBodyLimit }, async (req, reply) => {
    const admin = await requireAdmin(req, reply, ctx);
    if (!admin) return;
    const body = req.body;
    if (!body?.displayName || !body.dataBase64) {
      return reply.code(400).send({ error: "missing fields" });
    }
    if (body.slug && !isValidStickerSlug(body.slug.trim().toLowerCase())) {
      return reply
        .code(400)
        .send({ error: "invalid slug", hint: "use a-z0-9_- , 2-64 chars" });
    }
    if (body.slug && (await getStickerBySlug(ctx.db, body.slug))) {
      return reply.code(409).send({ error: "slug exists" });
    }

    try {
      const { data, mime } = parseStickerUpload(body, ctx.cfg.stickerMaxBytes);
      const sticker = await createSticker(ctx.db, {
        slug: body.slug,
        displayName: body.displayName,
        description: body.description,
        tags: Array.isArray(body.tags) ? body.tags : undefined,
        mime,
        sizeBytes: data.length,
        enabled: body.enabled !== false,
        ownerUserId: "system",
        visibility: body.visibility === "private" ? "private" : "public",
        autoApprove: body.autoApprove !== false,
        data,
      });
      await writeAudit(ctx.db, "sticker_create", admin.id, {
        id: sticker.id,
        slug: sticker.slug,
      });
      return { sticker };
    } catch (err) {
      if (err instanceof StickerSecurityError) {
        return reply
          .code(400)
          .send({ error: "unsafe_image", code: err.code, message: err.message });
      }
      const msg = (err as Error).message;
      if (msg === "slug exists") {
        return reply.code(409).send({ error: "slug exists" });
      }
      if (msg === "invalid slug") {
        return reply.code(400).send({ error: "invalid slug" });
      }
      throw err;
    }
  });

  app.put<{
    Params: { id: string };
    Body: {
      slug?: string;
      displayName?: string;
      description?: string;
      tags?: string[];
      enabled?: boolean;
      mime?: string;
      dataBase64?: string;
      visibility?: "public" | "private";
    };
  }>("/api/v1/admin/stickers/:id", { bodyLimit: ctx.cfg.uploadBodyLimit }, async (req, reply) => {
    const admin = await requireAdmin(req, reply, ctx);
    if (!admin) return;
    const cur = await getSticker(ctx.db, req.params.id);
    if (!cur) return reply.code(404).send({ error: "not found" });

    const body = req.body ?? {};

    try {
      if (body.dataBase64) {
        const { data, mime } = parseStickerUpload(body, ctx.cfg.stickerMaxBytes);
        await replaceStickerBlob(ctx.db, cur.id, data, {
          mime,
          fileName: makeStickerFileName(cur.id, mime),
        });
      }

      // Admin meta edits do not force re-pending for system stickers
      const sticker = await updateStickerMeta(ctx.db, cur.id, {
        slug: body.slug,
        displayName: body.displayName,
        description: body.description,
        tags: body.tags,
        enabled: body.enabled,
        visibility: body.visibility,
        rePending: cur.owner_user_id !== "system",
      });
      await writeAudit(ctx.db, "sticker_update", admin.id, {
        id: sticker.id,
        slug: sticker.slug,
      });
      return { sticker };
    } catch (err) {
      if (err instanceof StickerSecurityError) {
        return reply
          .code(400)
          .send({ error: "unsafe_image", code: err.code, message: err.message });
      }
      const msg = (err as Error).message;
      if (msg === "slug exists") {
        return reply.code(409).send({ error: "slug exists" });
      }
      if (msg === "invalid slug") {
        return reply.code(400).send({ error: "invalid slug" });
      }
      if (msg === "not found") {
        return reply.code(404).send({ error: "not found" });
      }
      throw err;
    }
  });

  app.post<{ Params: { id: string } }>(
    "/api/v1/admin/stickers/:id/approve",
    async (req, reply) => {
      const admin = await requireAdmin(req, reply, ctx);
      if (!admin) return;
      try {
        const sticker = await approveSticker(ctx.db, req.params.id, admin.id);
        await writeAudit(ctx.db, "sticker_approve", admin.id, {
          id: sticker.id,
        });
        return { sticker };
      } catch {
        return reply.code(404).send({ error: "not found" });
      }
    },
  );

  app.post<{
    Params: { id: string };
    Body: { reason?: string };
  }>("/api/v1/admin/stickers/:id/reject", async (req, reply) => {
    const admin = await requireAdmin(req, reply, ctx);
    if (!admin) return;
    try {
      const sticker = await rejectSticker(
        ctx.db,
        req.params.id,
        admin.id,
        req.body?.reason,
      );
      await writeAudit(ctx.db, "sticker_reject", admin.id, {
        id: sticker.id,
        reason: req.body?.reason,
      });
      return { sticker };
    } catch {
      return reply.code(404).send({ error: "not found" });
    }
  });

  app.post<{ Params: { id: string } }>(
    "/api/v1/admin/stickers/:id/takedown",
    async (req, reply) => {
      const admin = await requireAdmin(req, reply, ctx);
      if (!admin) return;
      try {
        const sticker = await softDeleteSticker(ctx.db, req.params.id);
        await writeAudit(ctx.db, "sticker_takedown", admin.id, {
          id: sticker.id,
        });
        return { sticker };
      } catch {
        return reply.code(404).send({ error: "not found" });
      }
    },
  );

  app.post<{ Params: { id: string } }>(
    "/api/v1/admin/stickers/:id/restore",
    async (req, reply) => {
      const admin = await requireAdmin(req, reply, ctx);
      if (!admin) return;
      try {
        const sticker = await restoreSticker(ctx.db, req.params.id);
        await writeAudit(ctx.db, "sticker_restore", admin.id, {
          id: sticker.id,
        });
        return { sticker };
      } catch {
        return reply.code(404).send({ error: "not found" });
      }
    },
  );

  app.delete<{ Params: { id: string } }>(
    "/api/v1/admin/stickers/:id",
    async (req, reply) => {
      const admin = await requireAdmin(req, reply, ctx);
      if (!admin) return;
      const removed = await deleteSticker(ctx.db, req.params.id);
      if (!removed) return reply.code(404).send({ error: "not found" });
      await writeAudit(ctx.db, "sticker_delete", admin.id, {
        id: removed.id,
        slug: removed.slug,
      });
      return { ok: true };
    },
  );

  app.get("/api/v1/me/memories", async (req, reply) => {
    const user = await requireUser(req, reply, ctx);
    if (!user) return;
    const q = req.query as {
      botAccountId?: string;
      peerId?: string;
      personaId?: string;
    };
    if (!q.botAccountId || !q.peerId) {
      return reply.code(400).send({ error: "botAccountId and peerId required" });
    }
    const bot = await getBotAccount(ctx.db, q.botAccountId);
    if (!bot || (bot.owner_user_id !== user.id && !user.is_admin)) {
      return reply.code(403).send({ error: "forbidden" });
    }
    if (q.personaId) {
      return {
        memories: await listMemories(
          ctx.db,
          q.botAccountId,
          q.peerId,
          q.personaId,
        ),
      };
    }
    const personas = await listPersonas(ctx.db);
    // One pipelined wave instead of one LRANGE per persona on the platform
    const memMap = await listMemoriesMany(
      ctx.db,
      q.botAccountId,
      q.peerId,
      personas.map((p) => p.id),
    );
    const groups: {
      personaId: string;
      personaName: string;
      memories: { id: string; content: string }[];
    }[] = [];
    let total = 0;
    for (const p of personas) {
      const mems = memMap.get(p.id);
      if (mems?.length) {
        groups.push({
          personaId: p.id,
          personaName: p.display_name,
          memories: mems.map((m) => ({ id: m.id, content: m.content })),
        });
        total += mems.length;
      }
    }
    return { total, groups };
  });

  app.post<{
    Body: { botAccountId: string; peerId: string; personaId?: string };
  }>("/api/v1/me/memories/reset", async (req, reply) => {
    const user = await requireUser(req, reply, ctx);
    if (!user) return;
    const { botAccountId, peerId, personaId } = req.body ?? {};
    if (!botAccountId || !peerId) {
      return reply.code(400).send({ error: "missing fields" });
    }
    const bot = await getBotAccount(ctx.db, botAccountId);
    if (!bot || (bot.owner_user_id !== user.id && !user.is_admin)) {
      return reply.code(403).send({ error: "forbidden" });
    }
    await ctx.chat.resetMemory(botAccountId, peerId, personaId);
    return { ok: true };
  });

  app.delete<{
    Body: {
      botAccountId: string;
      peerId: string;
      personaId: string;
      memoryId: string;
    };
  }>("/api/v1/me/memories", async (req, reply) => {
    const user = await requireUser(req, reply, ctx);
    if (!user) return;
    const { botAccountId, peerId, personaId, memoryId } = req.body ?? {};
    if (!botAccountId || !peerId || !personaId || !memoryId) {
      return reply.code(400).send({ error: "missing fields" });
    }
    const bot = await getBotAccount(ctx.db, botAccountId);
    if (!bot || (bot.owner_user_id !== user.id && !user.is_admin)) {
      return reply.code(403).send({ error: "forbidden" });
    }
    const ok = await deleteMemory(
      ctx.db,
      botAccountId,
      peerId,
      personaId,
      memoryId,
    );
    if (!ok) return reply.code(404).send({ error: "memory not found" });
    await writeAudit(ctx.db, "memory_delete", user.id, {
      botAccountId,
      peerId,
      personaId,
      memoryId,
    });
    return { ok: true };
  });

  app.delete<{
    Body: {
      botAccountId: string;
      peerId: string;
      personaId: string;
      memoryId: string;
    };
  }>("/api/v1/admin/memories", async (req, reply) => {
    const admin = await requireAdmin(req, reply, ctx);
    if (!admin) return;
    const { botAccountId, peerId, personaId, memoryId } = req.body ?? {};
    if (!botAccountId || !peerId || !personaId || !memoryId) {
      return reply
        .code(400)
        .send({ error: "botAccountId, peerId, personaId, memoryId required" });
    }
    const bot = await getBotAccount(ctx.db, botAccountId);
    if (!bot) return reply.code(404).send({ error: "bot not found" });
    const ok = await deleteMemory(
      ctx.db,
      botAccountId,
      peerId,
      personaId,
      memoryId,
    );
    if (!ok) return reply.code(404).send({ error: "memory not found" });
    await writeAudit(ctx.db, "admin_memory_delete", admin.id, {
      botAccountId,
      peerId,
      personaId,
      memoryId,
    });
    return { ok: true };
  });
}
