import crypto from "node:crypto";
import type { RedisStore } from "./client.js";
import { newId, nowIso, dayKey } from "./client.js";
import { K } from "./keys.js";
import { deleteInboundQueue } from "./inbound-queue.js";
import {
  defaultPersonaIdCache,
  invalidateDefaultPersonaCache,
  invalidatePromptCache,
  invalidateSessionCache,
  invalidateSuperAdminCache,
  invalidateUserCache,
  promptCache,
  sessionCache,
  SnapshotCache,
  SQUARE_SNAPSHOT_MS,
  superAdminIdCache,
  userCache,
} from "./hot-cache.js";
import {
  forceReleaseBotLease,
  markBotPollable,
  unmarkBotPollable,
} from "./worker-fleet.js";
import {
  assignmentKeys,
  deepStatsMaxPeers,
  memoryKeys,
  messageKeys,
  pairKey,
  parsePeerPairs,
  shouldComputeDeepStats,
  type PeerPair,
} from "./doctor-stats.js";

/** Short content hash for CDN cache-busting (sha256 hex prefix). */
export function hashStickerBlob(data: Buffer): string {
  return crypto.createHash("sha256").update(data).digest("hex").slice(0, 16);
}

export type AuthProvider = "linuxdo" | "local";

export interface User {
  id: string;
  username: string;
  name: string;
  avatar_url: string | null;
  trust_level: number;
  is_admin: number;
  created_at: string;
  updated_at: string;
  /** Missing on legacy rows → treat as "linuxdo" */
  auth_provider?: AuthProvider;
  /** scrypt encoded; local accounts only; never expose in API DTOs */
  password_hash?: string | null;
  invited_by?: string | null;
  invite_code_used?: string | null;
  /** 0|1; missing = not banned */
  is_banned?: number;
  banned_at?: string | null;
  banned_reason?: string | null;
  banned_by?: string | null;
}

export function isUserBanned(user: User | null | undefined): boolean {
  return Boolean(user?.is_banned);
}

export function userAuthProvider(user: User): AuthProvider {
  return user.auth_provider === "local" ? "local" : "linuxdo";
}

/** Public DTO fields (no password_hash). */
export function userPublicFields(user: User) {
  return {
    id: user.id,
    username: user.username,
    name: user.name,
    avatarUrl: user.avatar_url,
    isAdmin: Boolean(user.is_admin),
    trustLevel: user.trust_level,
    authProvider: userAuthProvider(user),
    isBanned: isUserBanned(user),
    bannedAt: user.banned_at ?? null,
    bannedReason: user.banned_reason ?? null,
    createdAt: user.created_at,
  };
}

const USERNAME_RE = /^[a-zA-Z][a-zA-Z0-9_]{2,31}$/;
const RESERVED_USERNAMES = new Set([
  "admin",
  "system",
  "local",
  "api",
  "root",
  "me",
  "null",
  "undefined",
  "support",
  "official",
]);

export function validateLocalUsername(username: string): string {
  const u = username.trim();
  if (!USERNAME_RE.test(u)) {
    throw new Error("invalid_username");
  }
  if (RESERVED_USERNAMES.has(u.toLowerCase())) {
    throw new Error("reserved_username");
  }
  return u;
}

export async function claimUsername(
  db: RedisStore,
  username: string,
  userId: string,
): Promise<"ok" | "taken"> {
  const lower = username.trim().toLowerCase();
  if (!lower) return "taken";
  const key = K.userByName(lower);
  const ok = await db.redis.set(key, userId, "NX");
  if (ok === "OK") return "ok";
  const existing = await db.redis.get(key);
  if (existing === userId) return "ok";
  return "taken";
}

export async function releaseUsername(
  db: RedisStore,
  username: string,
  userId: string,
): Promise<void> {
  const lower = username.trim().toLowerCase();
  if (!lower) return;
  const key = K.userByName(lower);
  const mapped = await db.redis.get(key);
  if (mapped === userId) await db.redis.del(key);
}

export interface BotAccount {
  id: string;
  owner_user_id: string;
  display_name: string;
  account_ref: string | null;
  base_url: string | null;
  updates_cursor: string;
  status: string;
  created_at: string;
  updated_at: string;
  /** Bot-level proactive outreach master switch (0/1). Missing = off. */
  proactive_enabled?: number;
  /** Idle hours before proactive contact (overrides global default when set). */
  proactive_idle_hours?: number;
  /** Min hours between two proactive sends to the same peer. */
  proactive_min_interval_hours?: number;
  /** Max proactive sends per peer per calendar day. */
  proactive_max_per_day?: number;
  /** Quiet hours e.g. "0-8" (local Asia/Shanghai); empty/undefined = off. */
  proactive_quiet_hours?: string | null;
}

/** iLink credentials (sensitive) — separate Redis key from BotAccount metadata */
export interface BotCredentials {
  botId: string;
  botToken: string;
  baseUrl?: string | null;
  accountRef?: string | null;
  displayName?: string | null;
  savedAt: string;
}

export type PersonaVisibility = "public" | "private";
export type PersonaMode = "prompt" | "chatflow";

export interface Persona {
  id: string;
  slug: string;
  display_name: string;
  description: string;
  content_policy: string;
  is_default: number;
  enabled: number;
  published_version_id: string | null;
  /** system = official seed; otherwise LINUX DO user id */
  owner_user_id: string;
  visibility: PersonaVisibility;
  tags: string[];
  /** Library-add popularity (non-owner adds) */
  use_count: number;
  /** Cumulative peer assignments (only increments when persona changes) */
  assign_count?: number;
  /** How many times this persona was forked */
  fork_count?: number;
  /** Lineage when this persona was forked from another */
  forked_from_id?: string | null;
  forked_from_slug?: string | null;
  forked_from_name?: string | null;
  system_prompt?: string;
  /**
   * Execution mode. Default prompt (classic system prompt).
   * chatflow uses graph_json on the published version (engine later).
   */
  mode?: PersonaMode;
  /** User custom LLM provider id; null/absent = platform LLM. Egress via HF tools. */
  llm_provider_id?: string | null;
  /** Allow web_search tool when global WEB_SEARCH_ENABLED */
  web_search_enabled?: number;
  created_at?: string;
  updated_at?: string;
}

/** heatScore = use*2 + assign*5 + fork*3 */
export function personaHeatScore(p: {
  use_count?: number;
  assign_count?: number;
  fork_count?: number;
}): number {
  return (
    Number(p.use_count || 0) * 2 +
    Number(p.assign_count || 0) * 5 +
    Number(p.fork_count || 0) * 3
  );
}

export interface TryChatSession {
  userId: string;
  personaId: string;
  botName: string;
  createdAt: string;
  /** User messages sent in this session */
  msgCount: number;
}

export interface TryChatMessage {
  role: "user" | "assistant";
  content: string;
}

const PROMPT_MAX_CHARS = 8000;

export interface PersonaVersion {
  id: string;
  persona_id: string;
  version: number;
  system_prompt: string;
  /**
   * Chatflow graph JSON (version 1). Optional; when persona.mode=chatflow
   * and missing, engine falls back to default start→llm→answer.
   */
  graph_json?: string | null;
  created_at: string;
}

export interface Peer {
  id: string;
  bot_account_id: string;
  peer_id: string;
  display_name: string | null;
  approved: number;
  approved_at?: string | null;
  created_at?: string;
  /** Owner opt-in: allow bot to proactively message this peer (0/1). Default 0. */
  proactive_enabled?: number;
  /** Last user/assistant chat activity (ISO). */
  last_activity_at?: string | null;
  /** Last successful proactive outbound (ISO). */
  last_proactive_at?: string | null;
  /** Last proactive attempt including skip (ISO) — used for scan cooldown. */
  last_proactive_attempt_at?: string | null;
}

export interface MessageRow {
  id: string;
  bot_account_id: string;
  peer_id: string;
  persona_id: string | null;
  role: string;
  content: string;
  context_token: string | null;
  created_at: string;
  /**
   * Running count of user messages for this peer, from the INCR that
   * insertMessage already issues. Present only on freshly inserted user rows —
   * never persisted, so it is absent on anything read back from Redis.
   */
  user_count?: number;
}

export interface MemoryRow {
  id: string;
  bot_account_id: string;
  peer_id: string;
  persona_id: string;
  kind: string;
  content: string;
  created_at?: string;
  updated_at?: string;
}

export interface AuditRow {
  id: string;
  action: string;
  actor: string;
  meta_json: string;
  created_at: string;
}

export type StickerVisibility = "public" | "private";
export type StickerReviewStatus = "pending" | "approved" | "rejected";

/**
 * Sticker square entry. Image bytes in Redis `wa:sticker:{id}:blob`.
 * Public stickers require admin approval before appearing in the square.
 */
export interface Sticker {
  id: string;
  slug: string;
  display_name: string;
  description: string;
  tags: string[];
  mime: string;
  size_bytes: number;
  /** Logical name only; blob is always in Redis by id */
  file_name: string;
  owner_user_id: string;
  visibility: StickerVisibility;
  review_status: StickerReviewStatus;
  reject_reason?: string;
  reviewed_at?: string;
  reviewed_by?: string;
  enabled: number;
  use_count: number;
  /** sha256 hex prefix of blob; used for /cdn/s/?v= cache-busting */
  content_hash?: string;
  created_at: string;
  updated_at: string;
}

/** Compact sticker row for LLM prompt injection */
export interface StickerPromptEntry {
  slug: string;
  display_name: string;
  description: string;
  tags: string[];
}

const STICKER_SLUG_RE = /^[a-z0-9][a-z0-9_-]{1,63}$/;

export interface UsageDayStats {
  day: string;
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  requests: number;
  by_user: Record<string, { total_tokens: number; requests: number; username?: string }>;
  by_bot: Record<string, { total_tokens: number; requests: number; display_name?: string }>;
}

// ── Users ──────────────────────────────────────────────

export async function countUsers(db: RedisStore): Promise<number> {
  return db.redis.scard(K.usersAll);
}

export async function upsertUser(
  db: RedisStore,
  input: {
    id: string;
    username: string;
    name?: string;
    avatarUrl?: string | null;
    trustLevel?: number;
    forceAdmin?: boolean;
    authProvider?: AuthProvider;
    inviteCodeUsed?: string | null;
    invitedBy?: string | null;
  },
  adminIds: Set<string>,
  opts?: { firstUserIsAdmin?: boolean },
): Promise<User> {
  const existing = await db.getJson<User>(K.user(input.id));
  const totalUsers = await countUsers(db);
  const bootstrapAdmin =
    Boolean(opts?.firstUserIsAdmin) &&
    !existing &&
    totalUsers === 0 &&
    adminIds.size === 0;
  const isAdmin =
    input.forceAdmin ||
    bootstrapAdmin ||
    adminIds.has(input.id) ||
    adminIds.has(input.username) ||
    Boolean(existing?.is_admin);

  // Resolve username with global index ownership
  let username = (input.username || "").trim() || input.id;
  if (existing?.username) {
    const wantLower = username.toLowerCase();
    const oldLower = existing.username.trim().toLowerCase();
    if (wantLower !== oldLower) {
      const mapped = await db.redis.get(K.userByName(wantLower));
      if (mapped && mapped !== input.id) {
        // Keep old username — do not steal index
        username = existing.username;
      }
    }
  } else {
    // New user: if name taken by someone else, fall back
    const wantLower = username.toLowerCase();
    const mapped = await db.redis.get(K.userByName(wantLower));
    if (mapped && mapped !== input.id) {
      username = `ld_${input.id}`.slice(0, 32);
    }
  }

  const user: User = {
    id: input.id,
    username,
    name: input.name || username,
    avatar_url: input.avatarUrl ?? existing?.avatar_url ?? null,
    trust_level: input.trustLevel ?? existing?.trust_level ?? 0,
    is_admin: isAdmin ? 1 : 0,
    created_at: existing?.created_at ?? nowIso(),
    updated_at: nowIso(),
    // Preserve local auth fields across OAuth re-login
    auth_provider:
      existing?.auth_provider ?? input.authProvider ?? "linuxdo",
    password_hash: existing?.password_hash ?? null,
    invited_by: existing?.invited_by ?? input.invitedBy ?? null,
    invite_code_used:
      existing?.invite_code_used ?? input.inviteCodeUsed ?? null,
    is_banned: existing?.is_banned ?? 0,
    banned_at: existing?.banned_at ?? null,
    banned_reason: existing?.banned_reason ?? null,
    banned_by: existing?.banned_by ?? null,
  };
  // Runs on every OAuth login. Read both username-index pointers together,
  // then apply all writes in one pipeline (was ~6 sequential round trips).
  const newNameKey = K.userByName(user.username.trim().toLowerCase());
  const oldNameKey = existing?.username
    ? K.userByName(existing.username.trim().toLowerCase())
    : null;
  const renamed = Boolean(oldNameKey && oldNameKey !== newNameKey);

  const [oldMapped, curMapped] = await Promise.all([
    renamed
      ? (db.redis.get(oldNameKey!) as Promise<string | null>)
      : Promise.resolve(null),
    db.redis.get(newNameKey) as Promise<string | null>,
  ]);

  const pipe = db.redis.pipeline();
  pipe.set(K.user(user.id), JSON.stringify(user));
  pipe.sadd(K.usersAll, user.id);
  if (user.is_admin) pipe.sadd(K.adminIds, user.id);
  if (renamed && oldMapped === user.id) pipe.del(oldNameKey!);
  // Only claim the name index if free or already ours
  if (!curMapped || curMapped === user.id) pipe.set(newNameKey, user.id);
  await pipe.exec();

  userCache.set(user.id, user);
  if (user.is_admin) invalidateSuperAdminCache();
  return user;
}

/**
 * Create a local password user. Caller must have already claimed username
 * and consumed invite. id = newId("loc").
 */
export async function createLocalUser(
  db: RedisStore,
  input: {
    username: string;
    passwordHash: string;
    name?: string;
    invitedBy?: string | null;
    inviteCodeUsed?: string | null;
    forceAdmin?: boolean;
  },
  adminIds: Set<string>,
  opts?: { firstUserIsAdmin?: boolean },
): Promise<User> {
  const username = validateLocalUsername(input.username);
  const id = newId("loc");
  const totalUsers = await countUsers(db);
  const bootstrapAdmin =
    Boolean(opts?.firstUserIsAdmin) &&
    totalUsers === 0 &&
    adminIds.size === 0;
  const isAdmin =
    input.forceAdmin ||
    bootstrapAdmin ||
    adminIds.has(username) ||
    adminIds.has(id);

  const claim = await claimUsername(db, username, id);
  if (claim === "taken") {
    throw new Error("username_taken");
  }

  const now = nowIso();
  const user: User = {
    id,
    username,
    name: (input.name || username).trim() || username,
    avatar_url: null,
    trust_level: 0,
    is_admin: isAdmin ? 1 : 0,
    created_at: now,
    updated_at: now,
    auth_provider: "local",
    password_hash: input.passwordHash,
    invited_by: input.invitedBy ?? null,
    invite_code_used: input.inviteCodeUsed ?? null,
    is_banned: 0,
  };
  const pipe = db.redis.pipeline();
  pipe.set(K.user(user.id), JSON.stringify(user));
  pipe.sadd(K.usersAll, user.id);
  if (user.is_admin) pipe.sadd(K.adminIds, user.id);
  await pipe.exec();
  userCache.set(user.id, user);
  if (user.is_admin) invalidateSuperAdminCache();
  return user;
}

export async function getUser(
  db: RedisStore,
  id: string,
): Promise<User | undefined> {
  const cached = userCache.get(id) as User | undefined;
  if (cached) return cached;
  const user = (await db.getJson<User>(K.user(id))) ?? undefined;
  if (user) userCache.set(id, user);
  return user;
}

/** Lookup user by LINUX DO username (case-insensitive). */
export async function getUserByUsername(
  db: RedisStore,
  username: string,
): Promise<User | undefined> {
  const name = username.trim().toLowerCase();
  if (!name) return undefined;
  const id = await db.redis.get(K.userByName(name));
  if (id) return getUser(db, id);

  // One-shot backfill for users created before the username index existed.
  // Guarded: without this, every lookup of a non-existent username re-scanned
  // and re-wrote the whole user table (N+1 writes per 404).
  if (usernameIndexBackfilled) return undefined;
  const users = await listUsers(db);
  const pipe = db.redis.pipeline();
  let hit: User | undefined;
  for (const u of users) {
    const un = (u.username || "").trim().toLowerCase();
    if (!un) continue;
    pipe.set(K.userByName(un), u.id);
    if (un === name) hit = u;
  }
  await pipe.exec();
  usernameIndexBackfilled = true;
  return hit;
}

/** Set once the legacy username index has been rebuilt in this process. */
let usernameIndexBackfilled = false;

export async function listUsers(db: RedisStore): Promise<User[]> {
  const ids = (await db.redis.smembers(K.usersAll)) as string[];
  if (!ids.length) return [];
  const rows = await db.mgetJson<User>(ids.map((id: string) => K.user(id)));
  const users = rows.filter((u): u is User => Boolean(u));
  return users.sort((a, b) => b.created_at.localeCompare(a.created_at));
}

/**
 * System super-admin: the earliest-created user who is still an admin.
 * ("系统的第一个管理员") Used for sensitive ops like fleet node force-offline.
 */
export async function resolveSuperAdminId(
  db: RedisStore,
): Promise<string | null> {
  // Scans every user; /auth/me asks for it on every admin page load, so cache
  // it. Invalidated on admin grant/revoke and account delete.
  const cached = superAdminIdCache.get("id");
  if (cached !== undefined) return cached;
  const users = await listUsers(db);
  const admins = users.filter((u) => Boolean(u.is_admin));
  if (!admins.length) {
    superAdminIdCache.set("id", null);
    return null;
  }
  admins.sort((a, b) => {
    const c = (a.created_at || "").localeCompare(b.created_at || "");
    if (c !== 0) return c;
    return a.id.localeCompare(b.id);
  });
  const id = admins[0]!.id;
  superAdminIdCache.set("id", id);
  return id;
}

export async function isSuperAdmin(
  db: RedisStore,
  userId: string,
): Promise<boolean> {
  if (!userId) return false;
  const sid = await resolveSuperAdminId(db);
  return Boolean(sid && sid === userId);
}

/** SCARD of each owner's bot set — one pipeline RTT. */
export async function countBotsByOwners(
  db: RedisStore,
  userIds: string[],
): Promise<Record<string, number>> {
  if (!userIds.length) return {};
  const counts = await db.scardMany(userIds.map((id) => K.botsByOwner(id)));
  const out: Record<string, number> = {};
  userIds.forEach((id, i) => {
    out[id] = counts[i] ?? 0;
  });
  return out;
}

/** Batch load users by id (MGET). Missing ids omitted. */
export async function getUsersByIds(
  db: RedisStore,
  userIds: string[],
): Promise<Map<string, User>> {
  const uniq = [...new Set(userIds.filter(Boolean))];
  const map = new Map<string, User>();
  if (!uniq.length) return map;
  const rows = await db.mgetJson<User>(uniq.map((id) => K.user(id)));
  uniq.forEach((id, i) => {
    const u = rows[i];
    if (u) map.set(id, u);
  });
  return map;
}

/** Grant or revoke admin. Caller must enforce safety (self / last admin). */
export async function setUserAdmin(
  db: RedisStore,
  userId: string,
  isAdmin: boolean,
): Promise<User> {
  const user = await getUser(db, userId);
  if (!user) throw new Error("user not found");
  user.is_admin = isAdmin ? 1 : 0;
  user.updated_at = nowIso();
  const pipe = db.redis.pipeline();
  pipe.set(K.user(userId), JSON.stringify(user));
  if (isAdmin) pipe.sadd(K.adminIds, userId);
  else pipe.srem(K.adminIds, userId);
  await pipe.exec();
  userCache.set(userId, user);
  invalidateSuperAdminCache();
  return user;
}

export async function setUserBanned(
  db: RedisStore,
  userId: string,
  banned: boolean,
  opts?: { reason?: string | null; actorId?: string | null },
): Promise<User> {
  const user = await getUser(db, userId);
  if (!user) throw new Error("user not found");
  if (banned) {
    user.is_banned = 1;
    user.banned_at = nowIso();
    user.banned_reason = opts?.reason?.trim() || null;
    user.banned_by = opts?.actorId ?? null;
  } else {
    user.is_banned = 0;
    user.banned_at = null;
    user.banned_reason = null;
    user.banned_by = null;
  }
  user.updated_at = nowIso();
  await db.setJson(K.user(userId), user);
  userCache.set(userId, user);
  return user;
}

/**
 * Delete user account (cascade bots, sessions, indexes). Best-effort libs/bind.
 */
export async function deleteUserAccount(
  db: RedisStore,
  userId: string,
): Promise<boolean> {
  const user = await getUser(db, userId);
  if (!user) return false;

  // Cascade bots (sequential — each one touches leases / fleet state)
  const botIds = (await db.redis.smembers(K.botsByOwner(userId))) as string[];
  for (const botId of botIds) {
    await deleteBotAccount(db, botId);
  }

  // Independent cleanups — run together instead of chaining round trips
  const [, , codes] = await Promise.all([
    destroyAllSessionsForUser(db, userId),
    user.username
      ? releaseUsername(db, user.username, userId)
      : Promise.resolve(),
    db.redis.smembers(K.invitesByUser(userId)) as Promise<string[]>,
    db.redis.srem(K.usersAll, userId),
    db.redis.srem(K.adminIds, userId),
  ]);

  // Pending invites owned by user — one DEL
  if (codes.length) {
    await db.redis.del(...codes.map((c) => K.invite(c)));
  }

  // Best-effort related keys
  await db.del(
    K.user(userId),
    K.personaLib(userId),
    K.stickerLib(userId),
    K.personasByOwner(userId),
    K.stickersByOwner(userId),
    K.botsByOwner(userId),
    K.bindUser(userId),
    K.blockSet(userId),
    K.invitesByUser(userId),
    K.inviteGenLog(userId),
    K.sessionsByUser(userId),
  );

  invalidateUserCache(userId);
  invalidateSuperAdminCache();
  return true;
}

// ── Sessions (app login) ───────────────────────────────

export async function createAppSession(
  db: RedisStore,
  userId: string,
  ttlSec = 7 * 24 * 3600,
): Promise<string> {
  const sid = newId("sess");
  await db.setJson(K.session(sid), { userId, createdAt: nowIso() }, ttlSec);
  await db.redis.sadd(K.sessionsByUser(userId), sid);
  // Align index TTL roughly with session (refresh not needed for ban kicks)
  await db.redis.expire(K.sessionsByUser(userId), ttlSec + 3600);
  return sid;
}

export async function getAppSession(
  db: RedisStore,
  sid: string,
): Promise<{ userId: string } | null> {
  const cached = sessionCache.get(sid);
  if (cached) return cached;
  const sess = await db.getJson<{ userId: string; createdAt?: string }>(
    K.session(sid),
  );
  if (sess?.userId) sessionCache.set(sid, sess);
  return sess;
}

export async function destroyAppSession(
  db: RedisStore,
  sid: string,
): Promise<void> {
  invalidateSessionCache(sid);
  const sess = await db.getJson<{ userId: string }>(K.session(sid));
  await db.del(K.session(sid));
  if (sess?.userId) {
    await db.redis.srem(K.sessionsByUser(sess.userId), sid);
  }
}

/** Destroy every session for a user (ban / password revoke). */
export async function destroyAllSessionsForUser(
  db: RedisStore,
  userId: string,
): Promise<number> {
  const sids = (await db.redis.smembers(K.sessionsByUser(userId))) as string[];
  if (!sids.length) {
    await db.redis.del(K.sessionsByUser(userId));
    return 0;
  }
  // One DEL for every session key + the index (was N+1 round trips)
  for (const sid of sids) invalidateSessionCache(sid);
  await db.redis.del(
    ...sids.map((sid) => K.session(sid)),
    K.sessionsByUser(userId),
  );
  return sids.length;
}

export async function saveOauthState(
  db: RedisStore,
  state: string,
  payload: { redirect?: string },
  ttlSec = 600,
): Promise<void> {
  await db.setJson(K.oauthState(state), payload, ttlSec);
}

export async function takeOauthState(
  db: RedisStore,
  state: string,
): Promise<{ redirect?: string } | null> {
  const v = await db.getJson<{ redirect?: string }>(K.oauthState(state));
  if (v) await db.del(K.oauthState(state));
  return v;
}

// ── Bots ───────────────────────────────────────────────

export async function saveBotCredentials(
  db: RedisStore,
  creds: BotCredentials,
): Promise<void> {
  const token = (creds.botToken || "").trim();
  if (!token) throw new Error("botToken required");
  const row: BotCredentials = {
    botId: creds.botId,
    botToken: token,
    baseUrl: creds.baseUrl ?? null,
    accountRef: creds.accountRef ?? null,
    displayName: creds.displayName ?? null,
    savedAt: creds.savedAt || nowIso(),
  };
  await db.setJson(K.botCreds(creds.botId), row);
}

export async function getBotCredentials(
  db: RedisStore,
  botId: string,
): Promise<BotCredentials | null> {
  const row = await db.getJson<BotCredentials>(K.botCreds(botId));
  if (!row?.botToken?.trim()) return null;
  return row;
}

export async function hasBotCredentials(
  db: RedisStore,
  botId: string,
): Promise<boolean> {
  // EXISTS is 1 RTT and avoids shipping the full token JSON
  return (await db.redis.exists(K.botCreds(botId))) === 1;
}

/** Batch credential presence check (pipeline EXISTS). */
export async function hasBotCredentialsMany(
  db: RedisStore,
  botIds: string[],
): Promise<Record<string, boolean>> {
  if (!botIds.length) return {};
  const flags = await db.existsMany(botIds.map((id) => K.botCreds(id)));
  const out: Record<string, boolean> = {};
  botIds.forEach((id, i) => {
    out[id] = Boolean(flags[i]);
  });
  return out;
}

export async function deleteBotCredentials(
  db: RedisStore,
  botId: string,
): Promise<void> {
  await db.del(K.botCreds(botId));
}

export async function upsertBotAccount(
  db: RedisStore,
  row: {
    id?: string;
    ownerUserId: string;
    displayName: string;
    accountRef?: string;
    baseUrl?: string;
    /** Store iLink token in Redis (`wa:bot:{id}:creds`) */
    botToken?: string;
  },
): Promise<BotAccount> {
  const id = row.id ?? newId("bot");
  const existing = await db.getJson<BotAccount>(K.bot(id));
  const bot: BotAccount = {
    id,
    owner_user_id: row.ownerUserId || existing?.owner_user_id || "",
    display_name: row.displayName,
    account_ref: row.accountRef ?? existing?.account_ref ?? null,
    base_url: row.baseUrl ?? existing?.base_url ?? null,
    updates_cursor: existing?.updates_cursor ?? "",
    status: existing?.status ?? "active",
    created_at: existing?.created_at ?? nowIso(),
    updated_at: nowIso(),
    // Preserve proactive settings across re-login / rename upserts
    proactive_enabled: existing?.proactive_enabled,
    proactive_idle_hours: existing?.proactive_idle_hours,
    proactive_min_interval_hours: existing?.proactive_min_interval_hours,
    proactive_max_per_day: existing?.proactive_max_per_day,
    proactive_quiet_hours: existing?.proactive_quiet_hours,
  };
  await db.setJson(K.bot(id), bot);
  await db.redis.sadd(K.botsAll, id);
  if (bot.owner_user_id) {
    await db.redis.sadd(K.botsByOwner(bot.owner_user_id), id);
  }
  if (row.botToken != null && row.botToken.trim()) {
    await saveBotCredentials(db, {
      botId: id,
      botToken: row.botToken,
      baseUrl: row.baseUrl ?? bot.base_url,
      accountRef: row.accountRef ?? bot.account_ref,
      displayName: row.displayName,
      savedAt: nowIso(),
    });
  }
  // Keep fleet pollable set in sync (active + has token)
  if (bot.status === "active") {
    const hasTok =
      (row.botToken != null && row.botToken.trim().length > 0) ||
      (await hasBotCredentials(db, id));
    if (hasTok) await markBotPollable(db, id);
  }
  return bot;
}

export async function deleteBotAccount(
  db: RedisStore,
  botId: string,
): Promise<boolean> {
  const bot = await getBotAccount(db, botId);
  if (!bot) return false;
  await unmarkBotPollable(db, botId);
  await forceReleaseBotLease(db, botId);
  await db.del(K.bot(botId));
  await deleteBotCredentials(db, botId);
  await deleteInboundQueue(db, botId);
  await db.redis.srem(K.botsAll, botId);
  if (bot.owner_user_id) {
    await db.redis.srem(K.botsByOwner(bot.owner_user_id), botId);
  }
  // clean peers/messages indexes lightly
  const peerKeys = await db.redis.smembers(K.peersByBot(botId));
  for (const pk of peerKeys) {
    await db.del(K.peer(botId, pk), K.assignment(botId, pk), K.messages(botId, pk));
  }
  await db.del(K.peersByBot(botId), K.proactivePeersByBot(botId));
  return true;
}

export async function listBotAccounts(db: RedisStore): Promise<BotAccount[]> {
  const ids = (await db.redis.smembers(K.botsAll)) as string[];
  if (!ids.length) return [];
  const rows = await db.mgetJson<BotAccount>(
    ids.map((id: string) => K.bot(id)),
  );
  const out = rows.filter((b): b is BotAccount => Boolean(b));
  return out.sort((a, b) => a.created_at.localeCompare(b.created_at));
}

export async function listBotsByOwner(
  db: RedisStore,
  userId: string,
): Promise<BotAccount[]> {
  const ids = (await db.redis.smembers(K.botsByOwner(userId))) as string[];
  if (!ids.length) return [];
  const rows = await db.mgetJson<BotAccount>(
    ids.map((id: string) => K.bot(id)),
  );
  return rows.filter((b): b is BotAccount => Boolean(b));
}

/**
 * Peer total + unapproved counts per bot — 2 RTTs (pipeline SMEMBERS + MGET).
 * Avoids N×(listPeers) round-trips on admin bot list.
 */
export async function peerStatsByBots(
  db: RedisStore,
  botIds: string[],
): Promise<Record<string, { peerCount: number; unapprovedPeerCount: number }>> {
  const out: Record<string, { peerCount: number; unapprovedPeerCount: number }> =
    {};
  for (const id of botIds) {
    out[id] = { peerCount: 0, unapprovedPeerCount: 0 };
  }
  if (!botIds.length) return out;

  const peerIdLists = await db.smembersMany(
    botIds.map((id) => K.peersByBot(id)),
  );

  const flatKeys: string[] = [];
  const ownerOfKey: string[] = [];
  botIds.forEach((botId, i) => {
    const pids = peerIdLists[i] ?? [];
    out[botId]!.peerCount = pids.length;
    for (const pid of pids) {
      flatKeys.push(K.peer(botId, pid));
      ownerOfKey.push(botId);
    }
  });

  if (!flatKeys.length) return out;

  // mgetJson already chunks (and now runs those chunks concurrently) — the
  // extra outer loop here only re-serialized them.
  const peers = await db.mgetJson<Peer>(flatKeys);
  peers.forEach((p, j) => {
    if (p && !p.approved) {
      const botId = ownerOfKey[j]!;
      out[botId]!.unapprovedPeerCount += 1;
    }
  });
  return out;
}

export async function getBotAccount(
  db: RedisStore,
  id: string,
): Promise<BotAccount | undefined> {
  return (await db.getJson<BotAccount>(K.bot(id))) ?? undefined;
}

/** Batch bot fetch — avoids N+1 on admin dashboard worker list (hundreds of bots). */
export async function getBotAccountsByIds(
  db: RedisStore,
  botIds: string[],
): Promise<Map<string, BotAccount>> {
  const uniq = [...new Set(botIds.filter(Boolean))];
  const map = new Map<string, BotAccount>();
  if (!uniq.length) return map;
  const rows = await db.mgetJson<BotAccount>(uniq.map((id) => K.bot(id)));
  uniq.forEach((id, i) => {
    const b = rows[i];
    if (b) map.set(id, b);
  });
  return map;
}

export async function setBotCursor(
  db: RedisStore,
  botId: string,
  cursor: string,
  workerId?: string,
): Promise<void> {
  // A delayed poller must not overwrite the successor's cursor or resurrect
  // a deleted bot row after its batch has been persisted.
  const ok = await db.redis.eval(`
local raw=redis.call('GET',KEYS[1])
if not raw then return 0 end
if ARGV[1] ~= '' and redis.call('GET',KEYS[2]) ~= ARGV[1] then return 0 end
local bot=cjson.decode(raw)
bot.updates_cursor=ARGV[2]; bot.updated_at=ARGV[3]
redis.call('SET',KEYS[1],cjson.encode(bot)); return 1`,
  2, K.bot(botId), K.botLease(botId), workerId ?? "", cursor, nowIso());
  if (workerId && Number(ok) !== 1) throw new Error("Inbound bot lease lost");
}

export async function setBotStatus(
  db: RedisStore,
  botId: string,
  status: "active" | "inactive",
): Promise<BotAccount> {
  const bot = await getBotAccount(db, botId);
  if (!bot) throw new Error("bot not found");
  bot.status = status === "inactive" ? "inactive" : "active";
  bot.updated_at = nowIso();
  await db.setJson(K.bot(botId), bot);
  if (bot.status === "active" && (await hasBotCredentials(db, botId))) {
    await markBotPollable(db, botId);
  } else {
    await unmarkBotPollable(db, botId);
    await forceReleaseBotLease(db, botId);
  }
  return bot;
}

export async function updateBotDisplayName(
  db: RedisStore,
  botId: string,
  displayName: string,
): Promise<BotAccount> {
  const bot = await getBotAccount(db, botId);
  if (!bot) throw new Error("bot not found");
  const name = displayName.trim();
  if (!name) throw new Error("displayName required");
  if (name.length > 32) throw new Error("displayName too long (max 32)");
  bot.display_name = name;
  bot.updated_at = nowIso();
  await db.setJson(K.bot(botId), bot);
  return bot;
}

export interface BotProactivePatch {
  proactiveEnabled?: boolean;
  proactiveIdleHours?: number;
  proactiveMinIntervalHours?: number;
  proactiveMaxPerDay?: number;
  /** null or "" clears quiet hours */
  proactiveQuietHours?: string | null;
}

export async function updateBotProactiveSettings(
  db: RedisStore,
  botId: string,
  patch: BotProactivePatch,
): Promise<BotAccount> {
  const bot = await getBotAccount(db, botId);
  if (!bot) throw new Error("bot not found");

  if (patch.proactiveEnabled !== undefined) {
    bot.proactive_enabled = patch.proactiveEnabled ? 1 : 0;
  }
  if (patch.proactiveIdleHours !== undefined) {
    const h = Number(patch.proactiveIdleHours);
    // 0.25h = 15min minimum idle; allow up to 30 days
    if (!Number.isFinite(h) || h < 0.25 || h > 24 * 30) {
      throw new Error("空闲小时须在 0.25～720 之间（0.25 = 15 分钟）");
    }
    bot.proactive_idle_hours = h;
  }
  if (patch.proactiveMinIntervalHours !== undefined) {
    const h = Number(patch.proactiveMinIntervalHours);
    // 0 = no min interval between proactive sends
    if (!Number.isFinite(h) || h < 0 || h > 24 * 30) {
      throw new Error("最小间隔须在 0～720 小时（0 = 不限制）");
    }
    bot.proactive_min_interval_hours = h;
  }
  if (patch.proactiveMaxPerDay !== undefined) {
    const n = Math.floor(Number(patch.proactiveMaxPerDay));
    // 0 = unlimited daily sends
    if (!Number.isFinite(n) || n < 0 || n > 9999) {
      throw new Error("每日上限须在 0～9999（0 = 不限制）");
    }
    bot.proactive_max_per_day = n;
  }
  if (patch.proactiveQuietHours !== undefined) {
    const raw = patch.proactiveQuietHours;
    if (raw == null || String(raw).trim() === "") {
      bot.proactive_quiet_hours = null;
    } else {
      const s = String(raw).trim();
      if (!/^\d{1,2}-\d{1,2}$/.test(s)) {
        throw new Error('proactiveQuietHours must look like "0-8"');
      }
      bot.proactive_quiet_hours = s;
    }
  }
  bot.updated_at = nowIso();
  await db.setJson(K.bot(botId), bot);
  return bot;
}

// ── Personas / Square ──────────────────────────────────

function normalizePersona(raw: Persona | null | undefined): Persona | undefined {
  if (!raw) return undefined;
  return {
    ...raw,
    owner_user_id: raw.owner_user_id || "system",
    visibility: raw.visibility === "private" ? "private" : "public",
    tags: Array.isArray(raw.tags) ? raw.tags : [],
    use_count: Number(raw.use_count || 0),
    assign_count: Number(raw.assign_count || 0),
    fork_count: Number(raw.fork_count || 0),
    forked_from_id: raw.forked_from_id ?? null,
    forked_from_slug: raw.forked_from_slug ?? null,
    forked_from_name: raw.forked_from_name ?? null,
    is_default: raw.is_default ? 1 : 0,
    enabled: raw.enabled === 0 ? 0 : 1,
    mode: raw.mode === "chatflow" ? "chatflow" : "prompt",
    llm_provider_id: raw.llm_provider_id ?? null,
    web_search_enabled: raw.web_search_enabled ? 1 : 0,
  };
}

export function generatePersonaSlug(ownerUserId: string, title: string): string {
  const base = title
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/gi, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 24);
  const shortOwner = ownerUserId.replace(/[^a-zA-Z0-9]/g, "").slice(-6) || "u";
  const rand = Math.random().toString(36).slice(2, 8);
  return `p-${shortOwner}-${base || "persona"}-${rand}`.slice(0, 64);
}

export async function createPersona(
  db: RedisStore,
  input: {
    slug?: string;
    displayName: string;
    description?: string;
    contentPolicy?: string;
    systemPrompt: string;
    isDefault?: boolean;
    ownerUserId?: string;
    visibility?: PersonaVisibility;
    tags?: string[];
    mode?: PersonaMode;
    llmProviderId?: string | null;
    webSearchEnabled?: boolean;
    /** Optional initial chatflow graph (object or JSON string) */
    graphJson?: string | object | null;
  },
): Promise<Persona> {
  const prompt = input.systemPrompt.trim();
  if (!prompt) throw new Error("systemPrompt required");
  if (prompt.length > PROMPT_MAX_CHARS) {
    throw new Error(`systemPrompt too long (max ${PROMPT_MAX_CHARS})`);
  }
  const owner = input.ownerUserId || "system";
  const visibility: PersonaVisibility =
    input.visibility === "private" ? "private" : "public";
  const slug =
    input.slug?.trim() || generatePersonaSlug(owner, input.displayName);
  if (await getPersonaBySlug(db, slug)) {
    throw new Error("slug exists");
  }

  const personaId = newId("persona");
  const versionId = newId("pver");
  if (input.isDefault) {
    await clearDefaultPersonaFlags(db);
  }
  let graph_json: string | null = null;
  if (input.graphJson != null && input.graphJson !== "") {
    graph_json =
      typeof input.graphJson === "string"
        ? input.graphJson
        : JSON.stringify(input.graphJson);
  }
  const version: PersonaVersion = {
    id: versionId,
    persona_id: personaId,
    version: 1,
    system_prompt: prompt,
    graph_json,
    created_at: nowIso(),
  };
  const persona: Persona = {
    id: personaId,
    slug,
    display_name: input.displayName.trim(),
    description: (input.description ?? "").trim(),
    content_policy: input.contentPolicy ?? "standard",
    is_default: input.isDefault ? 1 : 0,
    enabled: 1,
    published_version_id: versionId,
    owner_user_id: owner,
    visibility,
    tags: (input.tags ?? []).map((t) => t.trim()).filter(Boolean).slice(0, 12),
    use_count: 0,
    assign_count: 0,
    fork_count: 0,
    forked_from_id: null,
    forked_from_slug: null,
    forked_from_name: null,
    mode: input.mode === "chatflow" ? "chatflow" : "prompt",
    llm_provider_id: input.llmProviderId?.trim() || null,
    web_search_enabled: input.webSearchEnabled ? 1 : 0,
    created_at: nowIso(),
    updated_at: nowIso(),
  };
  // All writes in one round trip (was 6–9 sequential RTTs against remote Redis)
  const pipe = db.redis.pipeline();
  pipe.set(K.persona(personaId), JSON.stringify(persona));
  pipe.set(K.personaVersion(versionId), JSON.stringify(version));
  pipe.sadd(K.personasAll, personaId);
  pipe.set(K.personaSlug(slug), personaId);
  pipe.rpush(K.personaVersions(personaId), versionId);
  if (visibility === "public") {
    pipe.sadd(K.personasPublic, personaId);
  }
  if (owner !== "system") {
    pipe.sadd(K.personasByOwner(owner), personaId);
    pipe.sadd(K.personaLib(owner), personaId);
  }
  if (persona.is_default) {
    pipe.set(K.personaDefault, personaId);
  }
  await pipe.exec();
  if (persona.is_default) defaultPersonaIdCache.set("id", personaId);
  promptCache.set(personaId, prompt);
  invalidatePublicPersonasSnapshot();
  return persona;
}

export async function listPersonas(db: RedisStore): Promise<Persona[]> {
  const ids = (await db.redis.smembers(K.personasAll)) as string[];
  if (!ids.length) return [];
  const rows = await db.mgetJson<Persona>(
    ids.map((id: string) => K.persona(id)),
  );
  const out: Persona[] = [];
  for (const raw of rows) {
    const p = normalizePersona(raw ?? undefined);
    if (p) out.push(p);
  }
  return out.sort((a, b) => a.slug.localeCompare(b.slug));
}

export async function getPersona(
  db: RedisStore,
  id: string,
): Promise<Persona | undefined> {
  const raw = await db.getJson<Persona>(K.persona(id));
  const p = normalizePersona(raw ?? undefined);
  if (!p) return undefined;
  // migrate legacy indexes once
  if (!raw?.owner_user_id || !raw?.visibility) {
    await db.setJson(K.persona(id), p);
    if (p.visibility === "public" && p.enabled) {
      await db.redis.sadd(K.personasPublic, id);
      invalidatePublicPersonasSnapshot();
    }
  }
  return p;
}

/** Batch persona fetch (MGET). */
export async function getPersonasByIds(
  db: RedisStore,
  personaIds: string[],
): Promise<Map<string, Persona>> {
  const uniq = [...new Set(personaIds.filter(Boolean))];
  const map = new Map<string, Persona>();
  if (!uniq.length) return map;
  const rows = await db.mgetJson<Persona>(
    uniq.map((id) => K.persona(id)),
  );
  uniq.forEach((id, i) => {
    const p = normalizePersona(rows[i] ?? undefined);
    if (p) map.set(id, p);
  });
  return map;
}

export async function getPersonaBySlug(
  db: RedisStore,
  slug: string,
): Promise<Persona | undefined> {
  const id = await db.redis.get(K.personaSlug(slug));
  if (!id) return undefined;
  return getPersona(db, id);
}

/** Prompt for a persona we already loaded (1 RTT, not 2). */
export async function getPublishedPromptFromPersona(
  db: RedisStore,
  persona: Persona,
): Promise<string | null> {
  const cached = promptCache.get(persona.id);
  if (cached !== undefined) return cached;
  if (!persona.published_version_id) {
    promptCache.set(persona.id, null);
    return null;
  }
  const v = await db.getJson<PersonaVersion>(
    K.personaVersion(persona.published_version_id),
  );
  const prompt = v?.system_prompt ?? null;
  promptCache.set(persona.id, prompt);
  return prompt;
}

/**
 * Batch published prompts for already-loaded personas — 1 MGET RTT.
 * Map key = persona id; missing versions omitted.
 */
export async function getPublishedPromptsMany(
  db: RedisStore,
  personas: Persona[],
): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  if (!personas.length) return map;

  const needFetch: Persona[] = [];
  for (const p of personas) {
    const cached = promptCache.get(p.id);
    if (cached !== undefined) {
      if (cached) map.set(p.id, cached);
      continue;
    }
    if (!p.published_version_id) {
      promptCache.set(p.id, null);
      continue;
    }
    needFetch.push(p);
  }

  if (needFetch.length) {
    const keys = needFetch.map((p) =>
      K.personaVersion(p.published_version_id!),
    );
    const rows = await db.mgetJson<PersonaVersion>(keys);
    needFetch.forEach((p, i) => {
      const prompt = rows[i]?.system_prompt ?? null;
      promptCache.set(p.id, prompt);
      if (prompt) map.set(p.id, prompt);
    });
  }
  return map;
}

export async function getPublishedPrompt(
  db: RedisStore,
  personaId: string,
): Promise<string | null> {
  const cached = promptCache.get(personaId);
  if (cached !== undefined) return cached;
  const p = await getPersona(db, personaId);
  if (!p) {
    promptCache.set(personaId, null);
    return null;
  }
  return getPublishedPromptFromPersona(db, p);
}

export async function publishPersonaVersion(
  db: RedisStore,
  personaId: string,
  systemPrompt: string,
  graphJson?: string | null,
): Promise<PersonaVersion> {
  const prompt = systemPrompt.trim();
  if (!prompt) throw new Error("systemPrompt required");
  if (prompt.length > PROMPT_MAX_CHARS) {
    throw new Error(`systemPrompt too long (max ${PROMPT_MAX_CHARS})`);
  }
  const p = await getPersona(db, personaId);
  if (!p) throw new Error("persona not found");
  const len = await db.redis.llen(K.personaVersions(personaId));
  let graph_json: string | null | undefined = graphJson;
  if (graphJson === undefined) {
    // Preserve previous published graph when only prompt is updated
    if (p.published_version_id) {
      const prev = await db.getJson<PersonaVersion>(
        K.personaVersion(p.published_version_id),
      );
      graph_json = prev?.graph_json ?? null;
    } else {
      graph_json = null;
    }
  } else if (graphJson === null || graphJson === "") {
    graph_json = null;
  } else {
    graph_json = graphJson;
  }
  const version: PersonaVersion = {
    id: newId("pver"),
    persona_id: personaId,
    version: len + 1,
    system_prompt: prompt,
    graph_json: graph_json ?? null,
    created_at: nowIso(),
  };
  p.published_version_id = version.id;
  p.updated_at = nowIso();
  await db.setJson(K.personaVersion(version.id), version);
  await db.setJson(K.persona(personaId), p);
  await db.redis.rpush(K.personaVersions(personaId), version.id);
  invalidatePromptCache(personaId);
  promptCache.set(personaId, prompt);
  return version;
}

/** Load published chatflow graph object (or null). */
export async function getPublishedGraph(
  db: RedisStore,
  personaId: string,
): Promise<unknown | null> {
  const p = await getPersona(db, personaId);
  if (!p?.published_version_id) return null;
  const v = await db.getJson<PersonaVersion>(
    K.personaVersion(p.published_version_id),
  );
  if (!v?.graph_json) return null;
  try {
    return JSON.parse(v.graph_json) as unknown;
  } catch {
    return null;
  }
}

export async function getPublishedGraphFromPersona(
  db: RedisStore,
  persona: Persona,
): Promise<unknown | null> {
  if (!persona.published_version_id) return null;
  const v = await db.getJson<PersonaVersion>(
    K.personaVersion(persona.published_version_id),
  );
  if (!v?.graph_json) return null;
  try {
    return JSON.parse(v.graph_json) as unknown;
  } catch {
    return null;
  }
}

export async function updatePersonaMeta(
  db: RedisStore,
  personaId: string,
  patch: {
    displayName?: string;
    description?: string;
    tags?: string[];
    visibility?: PersonaVisibility;
    systemPrompt?: string;
    /** JSON string or object; stored on published version */
    graphJson?: string | object | null;
    mode?: PersonaMode;
    llmProviderId?: string | null;
    webSearchEnabled?: boolean;
  },
): Promise<Persona> {
  const p = await getPersona(db, personaId);
  if (!p) throw new Error("persona not found");
  if (patch.displayName != null) p.display_name = patch.displayName.trim();
  if (patch.description != null) p.description = patch.description.trim();
  if (patch.tags) {
    p.tags = patch.tags.map((t) => t.trim()).filter(Boolean).slice(0, 12);
  }
  if (patch.visibility) {
    p.visibility = patch.visibility;
    if (p.visibility === "public" && p.enabled) {
      await db.redis.sadd(K.personasPublic, personaId);
    } else {
      await db.redis.srem(K.personasPublic, personaId);
    }
  }
  if (patch.mode != null) {
    p.mode = patch.mode === "chatflow" ? "chatflow" : "prompt";
  }
  if (patch.llmProviderId !== undefined) {
    p.llm_provider_id = patch.llmProviderId?.trim() || null;
  }
  if (patch.webSearchEnabled !== undefined) {
    p.web_search_enabled = patch.webSearchEnabled ? 1 : 0;
  }
  p.updated_at = nowIso();
  await db.setJson(K.persona(personaId), p);
  invalidatePublicPersonasSnapshot();

  const hasPrompt = patch.systemPrompt != null;
  const hasGraph = patch.graphJson !== undefined;
  if (hasPrompt || hasGraph) {
    let prompt = patch.systemPrompt;
    if (prompt == null) {
      prompt = (await getPublishedPrompt(db, personaId)) || "";
    }
    let graphStr: string | null | undefined;
    if (hasGraph) {
      if (patch.graphJson === null || patch.graphJson === "") {
        graphStr = null;
      } else if (typeof patch.graphJson === "string") {
        graphStr = patch.graphJson;
      } else {
        graphStr = JSON.stringify(patch.graphJson);
      }
    }
    await publishPersonaVersion(db, personaId, prompt, graphStr);
  }
  return (await getPersona(db, personaId))!;
}

export async function softDeletePersona(
  db: RedisStore,
  personaId: string,
): Promise<void> {
  const p = await getPersona(db, personaId);
  if (!p) throw new Error("persona not found");
  p.enabled = 0;
  p.updated_at = nowIso();
  const pipe = db.redis.pipeline();
  pipe.set(K.persona(personaId), JSON.stringify(p));
  pipe.srem(K.personasPublic, personaId);
  // Drop from owner library so /me lists don't keep a dead reference.
  // personasByOwner is kept so admin can restore / audit lineage.
  if (p.owner_user_id && p.owner_user_id !== "system") {
    pipe.srem(K.personaLib(p.owner_user_id), personaId);
  }
  await pipe.exec();
  invalidatePublicPersonasSnapshot();
}

export async function restorePersona(
  db: RedisStore,
  personaId: string,
): Promise<Persona> {
  const p = await getPersona(db, personaId);
  if (!p) throw new Error("persona not found");
  p.enabled = 1;
  p.updated_at = nowIso();
  const pipe = db.redis.pipeline();
  pipe.set(K.persona(personaId), JSON.stringify(p));
  if (p.visibility === "public") {
    pipe.sadd(K.personasPublic, personaId);
  }
  if (p.owner_user_id && p.owner_user_id !== "system") {
    pipe.sadd(K.personaLib(p.owner_user_id), personaId);
  }
  await pipe.exec();
  invalidatePublicPersonasSnapshot();
  return p;
}

/** Clear is_default flags using pointer key when possible. */
async function clearDefaultPersonaFlags(db: RedisStore): Promise<void> {
  const pointed = await db.redis.get(K.personaDefault);
  if (pointed) {
    const cur = await getPersona(db, pointed);
    if (cur?.is_default) {
      cur.is_default = 0;
      cur.updated_at = nowIso();
      await db.setJson(K.persona(cur.id), cur);
    }
  } else {
    // Legacy: no pointer — scan once to clear flags
    const all = await listPersonas(db);
    for (const other of all) {
      if (other.is_default) {
        other.is_default = 0;
        other.updated_at = nowIso();
        await db.setJson(K.persona(other.id), other);
      }
    }
  }
  await db.redis.del(K.personaDefault);
  invalidateDefaultPersonaCache();
  invalidatePublicPersonasSnapshot();
}

/** Mark one persona as default; clears previous default. */
export async function setDefaultPersona(
  db: RedisStore,
  personaId: string,
): Promise<Persona> {
  const p = await getPersona(db, personaId);
  if (!p) throw new Error("persona not found");
  if (!p.enabled) throw new Error("cannot set disabled persona as default");
  await clearDefaultPersonaFlags(db);
  p.is_default = 1;
  p.updated_at = nowIso();
  const pipe = db.redis.pipeline();
  pipe.set(K.persona(personaId), JSON.stringify(p));
  pipe.set(K.personaDefault, personaId);
  await pipe.exec();
  defaultPersonaIdCache.set("id", personaId);
  invalidatePublicPersonasSnapshot();
  return p;
}

/**
 * Snapshot of every enabled+public persona, normalized once.
 *
 * The square hits this for every page / sort / keyword change, and the library
 * endpoints need it too. Without the snapshot each of those is SMEMBERS +
 * MGET(all public personas) against a remote Redis.
 */
const publicPersonasSnapshot = new SnapshotCache<readonly Persona[]>(
  SQUARE_SNAPSHOT_MS,
);

/** Drop the square snapshot after any mutation that changes what it contains. */
export function invalidatePublicPersonasSnapshot(): void {
  publicPersonasSnapshot.invalidate();
}

/**
 * Enabled + public personas (2 RTTs on miss, 0 on hit).
 *
 * The array and its rows are SHARED across requests — copy before sorting or
 * mutating. The array is frozen so an accidental in-place `sort()`/`push()`
 * throws instead of silently reordering the square for everyone.
 */
export async function listPublicPersonasCached(
  db: RedisStore,
): Promise<readonly Persona[]> {
  return publicPersonasSnapshot.get(async () => {
    const ids = (await db.redis.smembers(K.personasPublic)) as string[];
    if (!ids.length) return [];
    const rows = await db.mgetJson<Persona>(
      ids.map((id: string) => K.persona(id)),
    );
    const out: Persona[] = [];
    for (const raw of rows) {
      const p = normalizePersona(raw ?? undefined);
      if (!p || !p.enabled || p.visibility !== "public") continue;
      out.push(p);
    }
    return Object.freeze(out);
  });
}

export type PublicPersonaSort = "heat" | "use" | "recent" | "name";

/** Public square search (keyword filter + sort). Default: heat. */
export async function searchPublicPersonas(
  db: RedisStore,
  opts: {
    q?: string;
    limit?: number;
    offset?: number;
    sort?: PublicPersonaSort;
  } = {},
): Promise<{ items: Persona[]; total: number }> {
  const limit = Math.min(Math.max(opts.limit ?? 20, 1), 50);
  const offset = Math.max(opts.offset ?? 0, 0);
  const q = (opts.q ?? "").trim().toLowerCase();
  const sort: PublicPersonaSort =
    opts.sort === "recent" ||
    opts.sort === "name" ||
    opts.sort === "use" ||
    opts.sort === "heat"
      ? opts.sort
      : "heat";
  const all = await listPublicPersonasCached(db);
  const items: Persona[] = [];
  for (const p of all) {
    if (q) {
      const hay = [
        p.display_name,
        p.description,
        p.slug,
        ...(p.tags || []),
      ]
        .join(" ")
        .toLowerCase();
      if (!hay.includes(q)) continue;
    }
    items.push(p);
  }
  items.sort((a, b) => {
    if (sort === "name") {
      return a.display_name.localeCompare(b.display_name, "zh");
    }
    if (sort === "recent") {
      return (b.updated_at || "").localeCompare(a.updated_at || "");
    }
    if (sort === "use") {
      return (
        (b.use_count || 0) - (a.use_count || 0) ||
        (b.updated_at || "").localeCompare(a.updated_at || "")
      );
    }
    // heat (default): composite score then recency
    return (
      personaHeatScore(b) - personaHeatScore(a) ||
      (b.updated_at || "").localeCompare(a.updated_at || "")
    );
  });
  return {
    total: items.length,
    items: items.slice(offset, offset + limit),
  };
}

export async function listPersonasByOwner(
  db: RedisStore,
  userId: string,
  opts: { includeDisabled?: boolean } = {},
): Promise<Persona[]> {
  const ids = (await db.redis.smembers(K.personasByOwner(userId))) as string[];
  if (!ids.length) return [];
  const rows = await db.mgetJson<Persona>(
    ids.map((id: string) => K.persona(id)),
  );
  const out: Persona[] = [];
  for (const raw of rows) {
    const p = normalizePersona(raw ?? undefined);
    if (!p) continue;
    // Soft-deleted personas stay in owner index for restore, but user UI
    // should not list them (this was causing "deleted but still there").
    if (!opts.includeDisabled && !p.enabled) continue;
    out.push(p);
  }
  return out.sort((a, b) =>
    (b.updated_at || "").localeCompare(a.updated_at || ""),
  );
}

export async function listUserPersonaLibrary(
  db: RedisStore,
  userId: string,
): Promise<Persona[]> {
  // Avoid full personasAll scan: cached public snapshot + library + owned.
  // The three reads are independent — issue them together (1 RTT with
  // autopipelining) instead of chaining SMEMBERS → MGET → SMEMBERS → MGET.
  const [publicPersonas, libIds, owned] = await Promise.all([
    listPublicPersonasCached(db),
    db.redis.smembers(K.personaLib(userId)) as Promise<string[]>,
    listPersonasByOwner(db, userId),
  ]);
  const libSet = new Set(libIds);
  // Library ids not already covered by the public snapshot (private / forked)
  const publicIdSet = new Set(publicPersonas.map((p) => p.id));
  const extraIds = libIds.filter((id) => !publicIdSet.has(id));
  const extraRows = extraIds.length
    ? await db.mgetJson<Persona>(extraIds.map((id) => K.persona(id)))
    : [];
  const candidates: (Persona | null)[] = [
    ...publicPersonas,
    ...extraRows.map((raw) => normalizePersona(raw ?? undefined) ?? null),
  ];
  const map = new Map<string, Persona>();
  for (const p of candidates) {
    if (!p || !p.enabled) continue;
    // system public always available
    if (p.owner_user_id === "system" && p.visibility === "public") {
      map.set(p.id, p);
      continue;
    }
    // private only if owner
    if (p.visibility === "private" && p.owner_user_id !== userId) continue;
    // in library set or will be filled by owned below
    if (libSet.has(p.id) || p.owner_user_id === userId) {
      map.set(p.id, p);
    }
  }
  for (const p of owned) {
    if (p.enabled) map.set(p.id, p);
  }
  return [...map.values()].sort((a, b) =>
    a.display_name.localeCompare(b.display_name, "zh"),
  );
}

/** One SMEMBERS for library membership checks on list endpoints. */
export async function getPersonaLibraryIdSet(
  db: RedisStore,
  userId: string,
): Promise<Set<string>> {
  const ids = (await db.redis.smembers(K.personaLib(userId))) as string[];
  return new Set(ids);
}

/** Local in-library check when persona row + library set already loaded. */
export function isInPersonaLibraryLocal(
  p: Persona,
  userId: string,
  libIds: Set<string>,
): boolean {
  if (p.owner_user_id === "system" && p.visibility === "public") return true;
  if (p.owner_user_id === userId) return true;
  return libIds.has(p.id);
}

/** One SMEMBERS for sticker library list endpoints. */
export async function getStickerLibraryIdSet(
  db: RedisStore,
  userId: string,
): Promise<Set<string>> {
  const ids = (await db.redis.smembers(K.stickerLib(userId))) as string[];
  return new Set(ids);
}

export async function userCanUsePersona(
  db: RedisStore,
  userId: string,
  personaId: string,
): Promise<boolean> {
  const p = await getPersona(db, personaId);
  if (!p || !p.enabled) return false;
  if (p.owner_user_id === "system" && p.visibility === "public") return true;
  if (p.owner_user_id === userId) return true;
  if (p.visibility === "private") return false;
  // public + in library
  return Boolean(await db.redis.sismember(K.personaLib(userId), personaId));
}

export async function addPersonaToLibrary(
  db: RedisStore,
  userId: string,
  personaId: string,
): Promise<Persona> {
  const p = await getPersona(db, personaId);
  if (!p || !p.enabled) throw new Error("persona not found");
  if (p.visibility === "private" && p.owner_user_id !== userId) {
    throw new Error("persona is private");
  }
  const added = await db.redis.sadd(K.personaLib(userId), personaId);
  if (added && p.owner_user_id !== userId) {
    p.use_count = (p.use_count || 0) + 1;
    await db.setJson(K.persona(personaId), p);
    invalidatePublicPersonasSnapshot();
  }
  return p;
}

export async function removePersonaFromLibrary(
  db: RedisStore,
  userId: string,
  personaId: string,
): Promise<void> {
  const removed = await db.redis.srem(K.personaLib(userId), personaId);
  if (!removed) return;
  const p = await getPersona(db, personaId);
  // Mirror addPersonaToLibrary: only non-owner adds bump use_count
  if (p && p.owner_user_id !== userId && (p.use_count || 0) > 0) {
    p.use_count = Math.max(0, (p.use_count || 0) - 1);
    await db.setJson(K.persona(personaId), p);
    invalidatePublicPersonasSnapshot();
  }
}

export async function isInPersonaLibrary(
  db: RedisStore,
  userId: string,
  personaId: string,
): Promise<boolean> {
  const p = await getPersona(db, personaId);
  if (!p) return false;
  if (p.owner_user_id === "system" && p.visibility === "public") return true;
  if (p.owner_user_id === userId) return true;
  return Boolean(await db.redis.sismember(K.personaLib(userId), personaId));
}

/**
 * Fork a persona into a private editable copy owned by `ownerUserId`.
 * Source must be enabled and either public or owned by caller (or allowPrivateSource).
 */
export async function forkPersona(
  db: RedisStore,
  input: {
    sourceId: string;
    ownerUserId: string;
    displayName?: string;
    /** Allow forking private personas (owner/admin). Default false. */
    allowPrivateSource?: boolean;
  },
): Promise<{ persona: Persona; systemPrompt: string }> {
  const source = await getPersona(db, input.sourceId);
  if (!source || !source.enabled) {
    throw new Error("persona not found");
  }
  if (source.visibility === "private") {
    const ok =
      source.owner_user_id === input.ownerUserId || input.allowPrivateSource;
    if (!ok) throw new Error("persona is private");
  }
  const systemPrompt = await getPublishedPrompt(db, source.id);
  if (!systemPrompt?.trim()) {
    throw new Error("persona has no published prompt");
  }
  const sourceGraph = await getPublishedGraph(db, source.id);
  const displayName = (
    input.displayName?.trim() || `${source.display_name} 的改编`
  ).slice(0, 64);
  const tags = [...(source.tags || [])];
  if (!tags.includes("fork")) tags.push("fork");

  const persona = await createPersona(db, {
    displayName,
    description: source.description,
    contentPolicy: source.content_policy,
    systemPrompt,
    ownerUserId: input.ownerUserId,
    visibility: "private",
    tags: tags.slice(0, 12),
    // Copy mode / web search; never copy author's llm_provider_id (keys stay private)
    mode: source.mode === "chatflow" ? "chatflow" : "prompt",
    llmProviderId: null,
    webSearchEnabled: Boolean(source.web_search_enabled),
  });

  if (sourceGraph) {
    await publishPersonaVersion(
      db,
      persona.id,
      systemPrompt,
      JSON.stringify(sourceGraph),
    );
  }

  persona.forked_from_id = source.id;
  persona.forked_from_slug = source.slug;
  persona.forked_from_name = source.display_name;
  persona.updated_at = nowIso();
  source.fork_count = Number(source.fork_count || 0) + 1;
  source.updated_at = nowIso();
  const pipe = db.redis.pipeline();
  pipe.set(K.persona(persona.id), JSON.stringify(persona));
  pipe.set(K.persona(source.id), JSON.stringify(source));
  await pipe.exec();
  invalidatePublicPersonasSnapshot();

  return { persona, systemPrompt };
}

// ── Peers / assignments ────────────────────────────────

export async function ensurePeer(
  db: RedisStore,
  botAccountId: string,
  peerId: string,
  displayName?: string,
): Promise<Peer> {
  const existing = await db.getJson<Peer>(K.peer(botAccountId, peerId));
  if (existing) {
    if (displayName && !existing.display_name) {
      existing.display_name = displayName;
      await db.setJson(K.peer(botAccountId, peerId), existing);
    }
    return existing;
  }
  const peer: Peer = {
    id: newId("peer"),
    bot_account_id: botAccountId,
    peer_id: peerId,
    display_name: displayName ?? null,
    approved: 0,
    approved_at: null,
    created_at: nowIso(),
  };
  await db.setJson(K.peer(botAccountId, peerId), peer);
  await db.redis.sadd(K.peersByBot(botAccountId), peerId);
  await db.redis.sadd(K.peersAll, `${botAccountId}|${peerId}`);
  return peer;
}

export async function approvePeer(
  db: RedisStore,
  botAccountId: string,
  peerId: string,
): Promise<Peer> {
  const peer = await ensurePeer(db, botAccountId, peerId);
  peer.approved = 1;
  peer.approved_at = nowIso();
  await db.setJson(K.peer(botAccountId, peerId), peer);
  return peer;
}

/** Mark last chat activity for idle-based proactive outreach. */
export async function touchPeerActivity(
  db: RedisStore,
  botAccountId: string,
  peerId: string,
  at: string = nowIso(),
): Promise<void> {
  const peer = await ensurePeer(db, botAccountId, peerId);
  await touchPeerActivityFrom(db, peer, at);
}

/**
 * Same, for callers that already hold the Peer row (the chat path does — it
 * came back from ensurePeer). Skips the read half of the read-modify-write.
 *
 * Mutates the passed row, so pass a row you own (ensurePeer/getPeer return
 * freshly parsed objects; never pass an element of a cached snapshot).
 */
export async function touchPeerActivityFrom(
  db: RedisStore,
  peer: Peer,
  at: string = nowIso(),
): Promise<void> {
  peer.last_activity_at = at;
  await db.setJson(K.peer(peer.bot_account_id, peer.peer_id), peer);
}

/**
 * Owner opt-in for proactive contact on a single peer.
 * Only approved peers may enable. Maintains proactivePeersByBot index.
 */
export async function setPeerProactiveEnabled(
  db: RedisStore,
  botAccountId: string,
  peerId: string,
  enabled: boolean,
): Promise<Peer> {
  const peer = await ensurePeer(db, botAccountId, peerId);
  if (enabled && !peer.approved) {
    throw new Error("peer must be approved before enabling proactive");
  }
  peer.proactive_enabled = enabled ? 1 : 0;
  await db.setJson(K.peer(botAccountId, peerId), peer);
  if (enabled) {
    await db.redis.sadd(K.proactivePeersByBot(botAccountId), peerId);
  } else {
    await db.redis.srem(K.proactivePeersByBot(botAccountId), peerId);
  }
  return peer;
}

export async function listProactivePeerIds(
  db: RedisStore,
  botAccountId: string,
): Promise<string[]> {
  return (await db.redis.smembers(
    K.proactivePeersByBot(botAccountId),
  )) as string[];
}

export async function getContextToken(
  db: RedisStore,
  botAccountId: string,
  peerId: string,
): Promise<string | null> {
  const v = await db.redis.get(K.contextToken(botAccountId, peerId));
  return v && v.trim() ? v : null;
}

export async function tryAcquireProactiveLock(
  db: RedisStore,
  botAccountId: string,
  peerId: string,
  ttlSec: number,
): Promise<boolean> {
  const ok = await db.redis.set(
    K.proactiveLock(botAccountId, peerId),
    "1",
    "EX",
    Math.max(30, ttlSec),
    "NX",
  );
  return ok === "OK";
}

export async function releaseProactiveLock(
  db: RedisStore,
  botAccountId: string,
  peerId: string,
): Promise<void> {
  await db.del(K.proactiveLock(botAccountId, peerId));
}

export async function getProactiveDayCount(
  db: RedisStore,
  botAccountId: string,
  peerId: string,
  day: string = dayKey(),
): Promise<number> {
  const n = await db.redis.get(
    K.proactiveDayCount(botAccountId, peerId, day),
  );
  return n ? Number(n) : 0;
}

export async function incrProactiveDayCount(
  db: RedisStore,
  botAccountId: string,
  peerId: string,
  day: string = dayKey(),
): Promise<number> {
  const key = K.proactiveDayCount(botAccountId, peerId, day);
  const n = await db.redis.incr(key);
  if (n === 1) {
    // Expire ~2 days after the day key to cover timezone edge cases
    await db.redis.expire(key, 60 * 60 * 48);
  }
  return n;
}

/** Record a proactive send (or attempt) on the peer record. */
export async function markPeerProactive(
  db: RedisStore,
  botAccountId: string,
  peerId: string,
  opts: { sent: boolean; at?: string },
): Promise<Peer> {
  const peer = await ensurePeer(db, botAccountId, peerId);
  const at = opts.at ?? nowIso();
  peer.last_proactive_attempt_at = at;
  if (opts.sent) {
    peer.last_proactive_at = at;
    peer.last_activity_at = at;
  }
  await db.setJson(K.peer(botAccountId, peerId), peer);
  return peer;
}

export async function listPeers(
  db: RedisStore,
  botAccountId?: string,
): Promise<Peer[]> {
  if (botAccountId) {
    const ids = (await db.redis.smembers(
      K.peersByBot(botAccountId),
    )) as string[];
    if (!ids.length) return [];
    const rows = await db.mgetJson<Peer>(
      ids.map((pid: string) => K.peer(botAccountId, pid)),
    );
    return rows.filter((p): p is Peer => Boolean(p));
  }
  const pairs = (await db.redis.smembers(K.peersAll)) as string[];
  if (!pairs.length) return [];
  const keys: string[] = [];
  for (const pair of pairs) {
    const [botId, peerId] = pair.split("|");
    if (!botId || !peerId) continue;
    keys.push(K.peer(botId, peerId));
  }
  if (!keys.length) return [];
  const rows = await db.mgetJson<Peer>(keys);
  return rows.filter((p): p is Peer => Boolean(p));
}

/**
 * List peers for multiple bots — 2 RTTs (pipeline SMEMBERS + MGET),
 * not N× listPeers.
 */
export async function listPeersForBots(
  db: RedisStore,
  botIds: string[],
): Promise<Peer[]> {
  const uniq = [...new Set(botIds.filter(Boolean))];
  if (!uniq.length) return [];
  const peerIdLists = await db.smembersMany(
    uniq.map((id) => K.peersByBot(id)),
  );
  const keys: string[] = [];
  uniq.forEach((botId, i) => {
    for (const pid of peerIdLists[i] ?? []) {
      keys.push(K.peer(botId, pid));
    }
  });
  if (!keys.length) return [];
  const rows = await db.mgetJson<Peer>(keys);
  return rows.filter((p): p is Peer => Boolean(p));
}

/**
 * Assign persona to peer. When the persona id changes, increments the new
 * persona's assign_count (never decrements — ranking stability).
 */
export async function setAssignment(
  db: RedisStore,
  botAccountId: string,
  peerId: string,
  personaId: string,
): Promise<void> {
  const prev = await db.redis.get(K.assignment(botAccountId, peerId));
  await db.redis.set(K.assignment(botAccountId, peerId), personaId);
  if (prev !== personaId) {
    const p = await getPersona(db, personaId);
    if (p) {
      p.assign_count = Number(p.assign_count || 0) + 1;
      p.updated_at = nowIso();
      await db.setJson(K.persona(personaId), p);
      invalidatePublicPersonasSnapshot();
    }
  }
}

export async function getAssignment(
  db: RedisStore,
  botAccountId: string,
  peerId: string,
): Promise<{ persona_id: string } | undefined> {
  const personaId = await db.redis.get(K.assignment(botAccountId, peerId));
  return personaId ? { persona_id: personaId } : undefined;
}

export async function getAssignmentPersonaId(
  db: RedisStore,
  botAccountId: string,
  peerId: string,
): Promise<string | null> {
  return (await db.redis.get(K.assignment(botAccountId, peerId))) ?? null;
}

/**
 * Batch assignment lookup — 1 MGET RTT.
 * Map key = `${botAccountId}|${peerId}` → persona_id.
 */
export async function getAssignmentsMany(
  db: RedisStore,
  pairs: Array<{ botAccountId: string; peerId: string }>,
): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  if (!pairs.length) return map;
  const keys = pairs.map((p) => K.assignment(p.botAccountId, p.peerId));
  const vals = await db.mgetStrings(keys);
  pairs.forEach((p, i) => {
    const personaId = vals[i];
    if (personaId) map.set(`${p.botAccountId}|${p.peerId}`, personaId);
  });
  return map;
}

export async function getDefaultPersona(
  db: RedisStore,
): Promise<Persona | undefined> {
  const cachedId = defaultPersonaIdCache.get("id");
  if (cachedId) {
    const p = await getPersona(db, cachedId);
    if (p?.enabled) return p;
  } else if (cachedId === null) {
    // fall through to public scan for any enabled
  } else {
    const pointed = await db.redis.get(K.personaDefault);
    if (pointed) {
      defaultPersonaIdCache.set("id", pointed);
      const p = await getPersona(db, pointed);
      if (p?.enabled) return p;
    }
  }

  // Fallback: public personas only (much smaller than all), then full list
  const publicPersonas = await listPublicPersonasCached(db);
  if (publicPersonas.length) {
    let fallback: Persona | undefined;
    for (const p of publicPersonas) {
      if (!p?.enabled) continue;
      if (p.is_default) {
        await db.redis.set(K.personaDefault, p.id);
        defaultPersonaIdCache.set("id", p.id);
        return p;
      }
      if (!fallback) fallback = p;
    }
    if (fallback) {
      defaultPersonaIdCache.set("id", fallback.id);
      return fallback;
    }
  }

  const all = await listPersonas(db);
  const def =
    all.find((p) => p.is_default && p.enabled) ??
    all.find((p) => p.enabled);
  if (def) {
    await db.redis.set(K.personaDefault, def.id);
    defaultPersonaIdCache.set("id", def.id);
  } else {
    defaultPersonaIdCache.set("id", null);
  }
  return def;
}

export async function resolvePersonaForPeer(
  db: RedisStore,
  botAccountId: string,
  peerId: string,
): Promise<Persona | undefined> {
  const assigned = await getAssignmentPersonaId(db, botAccountId, peerId);
  if (assigned) {
    const p = await getPersona(db, assigned);
    if (p?.enabled) return p;
  }
  return getDefaultPersona(db);
}

// ── Messages / memories ────────────────────────────────

export async function insertMessage(
  db: RedisStore,
  row: {
    botAccountId: string;
    peerId: string;
    personaId?: string | null;
    role: "user" | "assistant" | "system";
    content: string;
    contextToken?: string | null;
  },
): Promise<MessageRow> {
  const msg: MessageRow = {
    id: newId("msg"),
    bot_account_id: row.botAccountId,
    peer_id: row.peerId,
    persona_id: row.personaId ?? null,
    role: row.role,
    content: row.content,
    context_token: row.contextToken ?? null,
    created_at: nowIso(),
  };
  const key = K.messages(row.botAccountId, row.peerId);
  // One round trip for append + trim (+ the user counter). This sits between
  // "model produced text" and "first bubble sent", so every RTT here is
  // latency the human sees.
  const pipe = db.redis.pipeline();
  pipe.rpush(key, JSON.stringify(msg));
  pipe.ltrim(key, -500, -1);
  if (row.role === "user") {
    pipe.incr(K.msgCountUser(row.botAccountId, row.peerId));
  }
  const res = await pipe.exec();
  if (row.role === "user") {
    // INCR reply is the running user-message count — hand it back so callers
    // don't need a separate GET to decide on memory extraction.
    const n = Number(res?.[2]?.[1] ?? 0);
    if (Number.isFinite(n) && n > 0) msg.user_count = n;
  }
  return msg;
}

export async function listRecentMessages(
  db: RedisStore,
  botAccountId: string,
  peerId: string,
  limit: number,
  personaId?: string | null,
): Promise<MessageRow[]> {
  const raw = await db.redis.lrange(
    K.messages(botAccountId, peerId),
    -Math.max(limit * 3, limit),
    -1,
  );
  let msgs = raw.map((r) => JSON.parse(r) as MessageRow);
  if (personaId) {
    msgs = msgs.filter(
      (m) => !m.persona_id || m.persona_id === personaId,
    );
  }
  return msgs.slice(-limit);
}

export async function countUserMessages(
  db: RedisStore,
  botAccountId: string,
  peerId: string,
): Promise<number> {
  const n = await db.redis.get(K.msgCountUser(botAccountId, peerId));
  return n ? Number(n) : 0;
}

/** Clear short-term chat history for a peer (not long-term memories). */
export async function clearMessages(
  db: RedisStore,
  botAccountId: string,
  peerId: string,
): Promise<void> {
  await db.del(K.messages(botAccountId, peerId));
  await db.del(K.msgCountUser(botAccountId, peerId));
}

export async function upsertContextToken(
  db: RedisStore,
  botAccountId: string,
  peerId: string,
  contextToken: string,
): Promise<void> {
  await db.redis.set(K.contextToken(botAccountId, peerId), contextToken);
}

export async function listMemories(
  db: RedisStore,
  botAccountId: string,
  peerId: string,
  personaId: string,
): Promise<MemoryRow[]> {
  const raw = await db.redis.lrange(
    K.memories(botAccountId, peerId, personaId),
    0,
    -1,
  );
  return raw.map((r) => JSON.parse(r) as MemoryRow);
}

export async function replaceMemories(
  db: RedisStore,
  botAccountId: string,
  peerId: string,
  personaId: string,
  facts: string[],
  opts?: { maxItems?: number },
): Promise<void> {
  const key = K.memories(botAccountId, peerId, personaId);
  const maxItems = Math.max(1, opts?.maxItems ?? 100);
  const cleaned: string[] = [];
  const seen = new Set<string>();
  for (const f of facts) {
    const t = (f ?? "").trim();
    if (!t) continue;
    const low = t.toLowerCase();
    if (seen.has(low)) continue;
    seen.add(low);
    cleaned.push(t);
  }
  const capped =
    cleaned.length > maxItems ? cleaned.slice(-maxItems) : cleaned;
  const at = nowIso();
  const rows = capped.map((t) =>
    JSON.stringify({
      id: newId("mem"),
      bot_account_id: botAccountId,
      peer_id: peerId,
      persona_id: personaId,
      kind: "fact",
      content: t,
      created_at: at,
      updated_at: at,
    } satisfies MemoryRow),
  );
  // DEL + all RPUSHes in one round trip. Was 1 + N sequential RTTs (N up to
  // MEMORY_MAX_ITEMS), and left a window where the list was deleted but not
  // yet refilled — a concurrent listMemories saw truncated memory.
  const pipe = db.redis.pipeline();
  pipe.del(key);
  if (rows.length) pipe.rpush(key, ...rows);
  await pipe.exec();
}

/** Delete a single memory by id within a bot/peer/persona list. */
export async function deleteMemory(
  db: RedisStore,
  botAccountId: string,
  peerId: string,
  personaId: string,
  memoryId: string,
): Promise<boolean> {
  const key = K.memories(botAccountId, peerId, personaId);
  const raw = await db.redis.lrange(key, 0, -1);
  if (!raw.length) return false;
  const kept: string[] = [];
  let found = false;
  for (const r of raw) {
    try {
      const row = JSON.parse(r) as MemoryRow;
      if (row.id === memoryId) {
        found = true;
        continue;
      }
      kept.push(r);
    } catch {
      kept.push(r);
    }
  }
  if (!found) return false;
  // Atomic-ish rewrite in one round trip (no delete-then-refill window)
  const pipe = db.redis.pipeline();
  pipe.del(key);
  if (kept.length) pipe.rpush(key, ...kept);
  await pipe.exec();
  return true;
}

export async function clearMemories(
  db: RedisStore,
  botAccountId: string,
  peerId: string,
  personaId?: string,
): Promise<void> {
  if (personaId) {
    await db.del(K.memories(botAccountId, peerId, personaId));
    return;
  }
  const personas = await listPersonas(db);
  if (!personas.length) return;
  // One DEL for every persona-scoped list (was N+1 round trips)
  await db.del(
    ...personas.map((p) => K.memories(botAccountId, peerId, p.id)),
  );
}

/**
 * Memories for many personas in one wave (chunked pipeline of LRANGE).
 * Replaces `for (const p of personas) await listMemories(...)`.
 */
export async function listMemoriesMany(
  db: RedisStore,
  botAccountId: string,
  peerId: string,
  personaIds: string[],
): Promise<Map<string, MemoryRow[]>> {
  const out = new Map<string, MemoryRow[]>();
  if (!personaIds.length) return out;
  const CHUNK = 200;
  const chunks: string[][] = [];
  for (let off = 0; off < personaIds.length; off += CHUNK) {
    chunks.push(personaIds.slice(off, off + CHUNK));
  }
  const results = await Promise.all(
    chunks.map((ids) => {
      const pipe = db.redis.pipeline();
      for (const id of ids) {
        pipe.lrange(K.memories(botAccountId, peerId, id), 0, -1);
      }
      return pipe.exec();
    }),
  );
  chunks.forEach((ids, ci) => {
    const res = results[ci];
    ids.forEach((id, i) => {
      const raw = res?.[i]?.[1];
      if (!Array.isArray(raw) || !raw.length) return;
      const rows: MemoryRow[] = [];
      for (const r of raw as string[]) {
        try {
          rows.push(JSON.parse(r) as MemoryRow);
        } catch {
          /* skip corrupt row */
        }
      }
      if (rows.length) out.set(id, rows);
    });
  });
  return out;
}

// ── Audit / doctor / usage ─────────────────────────────

export async function writeAudit(
  db: RedisStore,
  action: string,
  actor = "system",
  meta: Record<string, unknown> = {},
): Promise<void> {
  const row: AuditRow = {
    id: newId("audit"),
    action,
    actor,
    meta_json: JSON.stringify(meta),
    created_at: nowIso(),
  };
  // LPUSH + LTRIM in one round trip — writeAudit runs on every mutation route
  await db.redis
    .pipeline()
    .lpush(K.audit, JSON.stringify(row))
    .ltrim(K.audit, 0, 999)
    .exec();
}

export async function listAuditLogs(
  db: RedisStore,
  limit = 50,
): Promise<AuditRow[]> {
  const raw = await db.redis.lrange(K.audit, 0, Math.max(0, limit - 1));
  return raw.map((r) => JSON.parse(r) as AuditRow);
}

export async function recordTokenUsage(
  db: RedisStore,
  input: {
    userId?: string | null;
    botId?: string | null;
    promptTokens: number;
    completionTokens: number;
    username?: string;
    botName?: string;
  },
): Promise<void> {
  const day = dayKey();
  const total = input.promptTokens + input.completionTokens;
  const pipe = db.redis.pipeline();
  const dayKeyH = K.usageDay(day);
  pipe.hincrby(dayKeyH, "prompt_tokens", input.promptTokens);
  pipe.hincrby(dayKeyH, "completion_tokens", input.completionTokens);
  pipe.hincrby(dayKeyH, "total_tokens", total);
  pipe.hincrby(dayKeyH, "requests", 1);
  pipe.expire(dayKeyH, 90 * 24 * 3600);
  if (input.userId) {
    const uk = K.usageDayUser(day, input.userId);
    pipe.hincrby(uk, "total_tokens", total);
    pipe.hincrby(uk, "requests", 1);
    if (input.username) pipe.hset(uk, "username", input.username);
    pipe.expire(uk, 90 * 24 * 3600);
    pipe.sadd(K.usageDayUsers(day), input.userId);
    // The index sets had no TTL while the hashes they point at expire at 90d
    pipe.expire(K.usageDayUsers(day), 90 * 24 * 3600);
  }
  if (input.botId) {
    const bk = K.usageDayBot(day, input.botId);
    pipe.hincrby(bk, "total_tokens", total);
    pipe.hincrby(bk, "requests", 1);
    if (input.botName) pipe.hset(bk, "display_name", input.botName);
    pipe.expire(bk, 90 * 24 * 3600);
    pipe.sadd(K.usageDayBots(day), input.botId);
    pipe.expire(K.usageDayBots(day), 90 * 24 * 3600);
  }
  await pipe.exec();
}

export async function getUsageDayStats(
  db: RedisStore,
  day = dayKey(),
): Promise<UsageDayStats> {
  const dayHKey = K.usageDay(day);
  const [hRaw, userIdsRaw, botIdsRaw] = await Promise.all([
    db.redis.hgetall(dayHKey),
    db.redis.smembers(K.usageDayUsers(day)),
    db.redis.smembers(K.usageDayBots(day)),
  ]);
  const h = hRaw as Record<string, string>;
  const userIds = userIdsRaw as string[];
  const botIds = botIdsRaw as string[];

  const by_user: UsageDayStats["by_user"] = {};
  const by_bot: UsageDayStats["by_bot"] = {};

  // Chunk pipelines — large by_user/by_bot days stall Upstash if unbounded
  const CHUNK = 150;
  const allKeys: { kind: "user" | "bot"; id: string; key: string }[] = [
    ...userIds.map((uid) => ({
      kind: "user" as const,
      id: uid,
      key: K.usageDayUser(day, uid),
    })),
    ...botIds.map((bid) => ({
      kind: "bot" as const,
      id: bid,
      key: K.usageDayBot(day, bid),
    })),
  ];
  // Chunked so a big day doesn't build one enormous pipeline, but the chunks
  // run together — serializing them made this ~N/150 round trips.
  const slices: (typeof allKeys)[] = [];
  for (let off = 0; off < allKeys.length; off += CHUNK) {
    slices.push(allKeys.slice(off, off + CHUNK));
  }
  const execs = await Promise.all(
    slices.map((slice) => {
      const pipe = db.redis.pipeline();
      for (const row of slice) pipe.hgetall(row.key);
      return pipe.exec();
    }),
  );
  slices.forEach((slice, si) => {
    const res = execs[si];
    slice.forEach((row, j) => {
      const hrow = (res?.[j]?.[1] ?? {}) as Record<string, string>;
      if (row.kind === "user") {
        by_user[row.id] = {
          total_tokens: Number(hrow.total_tokens || 0),
          requests: Number(hrow.requests || 0),
          username: hrow.username,
        };
      } else {
        by_bot[row.id] = {
          total_tokens: Number(hrow.total_tokens || 0),
          requests: Number(hrow.requests || 0),
          display_name: hrow.display_name,
        };
      }
    });
  });

  return {
    day,
    prompt_tokens: Number(h.prompt_tokens || 0),
    completion_tokens: Number(h.completion_tokens || 0),
    total_tokens: Number(h.total_tokens || 0),
    requests: Number(h.requests || 0),
    by_user,
    by_bot,
  };
}

export interface DoctorSnapshot {
  bots: number;
  activeBots: number;
  personas: number;
  defaultPersona: string | null;
  peers: number;
  approvedPeers: number;
  unapprovedPeers: number;
  /** Peers with an explicit persona assignment (exact) */
  assignments: number;
  /**
   * Messages currently stored. Conversation history is trimmed to the last 500
   * per (bot, peer), so this is the retained count, not lifetime volume.
   */
  messages: number;
  /**
   * Stored memory facts for each peer's persona in effect (its assignment, else
   * the platform default). Lists orphaned by an earlier assignment are not
   * counted — see memoryKeys() in doctor-stats.ts for why.
   */
  memories: number;
  users: number;
  /**
   * False when the dataset is past DOCTOR_DEEP_STATS_MAX_PEERS and the three
   * counters above were skipped rather than measured. Display "未统计" for a
   * zero with this false — do not read it as "none".
   */
  deepStats: boolean;
}

/**
 * These are counts over the whole dataset — computing them pulls every bot,
 * peer and persona row out of Redis (megabytes at a few hundred bots). The
 * admin dashboard polls, so serve a short-lived shared snapshot instead of
 * re-scanning per poll and per concurrent admin.
 */
const doctorSnapshotCache = new SnapshotCache<DoctorSnapshot>(
  Number(process.env.REDIS_L1_DOCTOR_MS ?? "15000"),
);

export async function doctorSnapshot(
  db: RedisStore,
): Promise<DoctorSnapshot> {
  return doctorSnapshotCache.get(() => computeDoctorSnapshot(db));
}

async function computeDoctorSnapshot(
  db: RedisStore,
): Promise<DoctorSnapshot> {
  // Prefer SCARD + chunked MGET (full listPeers/listBotAccounts was heavy at 400+ bots)
  const [botIds, peerPairs, personaIds, users] = await Promise.all([
    db.redis.smembers(K.botsAll) as Promise<string[]>,
    db.redis.smembers(K.peersAll) as Promise<string[]>,
    db.redis.smembers(K.personasAll) as Promise<string[]>,
    db.redis.scard(K.usersAll),
  ]);

  const pairs = parsePeerPairs(peerPairs);
  const peerKeys = pairs.map((p) => K.peer(p.botId, p.peerId));

  const [bots, peers, personas] = await Promise.all([
    botIds.length
      ? db.mgetJson<BotAccount>(botIds.map((id) => K.bot(id)))
      : Promise.resolve([] as (BotAccount | null)[]),
    peerKeys.length
      ? db.mgetJson<Peer>(peerKeys)
      : Promise.resolve([] as (Peer | null)[]),
    personaIds.length
      ? db.mgetJson<Persona>(personaIds.map((id) => K.persona(id)))
      : Promise.resolve([] as (Persona | null)[]),
  ]);

  const botRows = bots.filter((b): b is BotAccount => Boolean(b));
  const peerRows = peers.filter((p): p is Peer => Boolean(p));
  const personaRows = personas.filter((p): p is Persona => Boolean(p));
  const def = personaRows.find((p) => p.is_default);

  const deep = await computeDeepStats(db, pairs, def?.id ?? null);

  return {
    bots: botRows.length,
    activeBots: botRows.filter((b) => b.status === "active").length,
    personas: personaRows.filter((p) => p.enabled).length,
    defaultPersona: def?.slug ?? null,
    peers: peerRows.length,
    approvedPeers: peerRows.filter((p) => p.approved).length,
    unapprovedPeers: peerRows.filter((p) => !p.approved).length,
    assignments: deep.assignments,
    messages: deep.messages,
    memories: deep.memories,
    users: Number(users) || 0,
    deepStats: deep.computed,
  };
}

/**
 * assignments / messages / memories for the dashboard.
 *
 * Cost is ~4 extra key reads per peer (1 MGET for assignments, then pipelined
 * LLENs), all behind the same REDIS_L1_DOCTOR_MS snapshot cache as the rest.
 * Past DOCTOR_DEEP_STATS_MAX_PEERS it reports `computed: false` rather than
 * quietly billing a large fleet for numbers nobody asked to pay for.
 */
async function computeDeepStats(
  db: RedisStore,
  pairs: PeerPair[],
  defaultPersonaId: string | null,
): Promise<{
  assignments: number;
  messages: number;
  memories: number;
  computed: boolean;
}> {
  const empty = { assignments: 0, messages: 0, memories: 0 };
  if (!shouldComputeDeepStats(pairs.length, deepStatsMaxPeers())) {
    return { ...empty, computed: false };
  }
  if (!pairs.length) return { ...empty, computed: true };

  const [assignedValues, messages] = await Promise.all([
    db.mgetStrings(assignmentKeys(pairs)),
    sumListLengths(db, messageKeys(pairs)),
  ]);

  const assignedByPair = new Map<string, string>();
  pairs.forEach((pair, i) => {
    const personaId = assignedValues[i];
    if (personaId) assignedByPair.set(pairKey(pair), personaId);
  });

  const memories = await sumListLengths(
    db,
    memoryKeys(pairs, assignedByPair, defaultPersonaId),
  );

  return {
    assignments: assignedByPair.size,
    messages,
    memories,
    computed: true,
  };
}

/** Total length across many Redis lists — chunked pipeline, like listMemoriesMany. */
async function sumListLengths(
  db: RedisStore,
  keys: string[],
): Promise<number> {
  if (!keys.length) return 0;
  const CHUNK = 200;
  const chunks: string[][] = [];
  for (let off = 0; off < keys.length; off += CHUNK) {
    chunks.push(keys.slice(off, off + CHUNK));
  }
  const results = await Promise.all(
    chunks.map((slice) => {
      const pipe = db.redis.pipeline();
      for (const key of slice) pipe.llen(key);
      return pipe.exec();
    }),
  );
  let total = 0;
  for (const res of results) {
    for (const entry of res ?? []) {
      const n = Number(entry?.[1] ?? 0);
      if (Number.isFinite(n) && n > 0) total += n;
    }
  }
  return total;
}

// ── Stickers (square + review; blob in Redis) ──────────

export function isValidStickerSlug(slug: string): boolean {
  return STICKER_SLUG_RE.test(slug);
}

export function generateStickerSlug(ownerUserId: string, name: string): string {
  const shortOwner =
    ownerUserId.replace(/[^a-zA-Z0-9]/g, "").slice(-6) || "u";
  const base = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 24);
  const rand = Math.random().toString(36).slice(2, 8);
  return `s-${shortOwner}-${base || "sticker"}-${rand}`.slice(0, 64);
}

function normalizeSticker(raw: Sticker | null | undefined): Sticker | undefined {
  if (!raw || !raw.id || !raw.slug) return undefined;
  const visibility: StickerVisibility =
    raw.visibility === "private" ? "private" : "public";
  let review_status: StickerReviewStatus = "approved";
  if (
    raw.review_status === "pending" ||
    raw.review_status === "rejected" ||
    raw.review_status === "approved"
  ) {
    review_status = raw.review_status;
  } else if (!("review_status" in (raw as object)) && !raw.owner_user_id) {
    // legacy admin-only stickers → treat as system approved public
    review_status = "approved";
  }
  return {
    id: raw.id,
    slug: raw.slug,
    display_name: raw.display_name || raw.slug,
    description: raw.description || "",
    tags: Array.isArray(raw.tags) ? raw.tags.filter(Boolean) : [],
    mime: raw.mime || "image/png",
    size_bytes: Number(raw.size_bytes) || 0,
    file_name: raw.file_name || `${raw.id}.bin`,
    owner_user_id: raw.owner_user_id || "system",
    visibility,
    review_status,
    reject_reason: raw.reject_reason,
    reviewed_at: raw.reviewed_at,
    reviewed_by: raw.reviewed_by,
    enabled: raw.enabled ? 1 : 0,
    use_count: Number(raw.use_count || 0),
    content_hash:
      typeof raw.content_hash === "string" && raw.content_hash
        ? raw.content_hash
        : undefined,
    created_at: raw.created_at || nowIso(),
    updated_at: raw.updated_at || nowIso(),
  };
}

/** Sync public / pending index sets from current meta. */
async function syncStickerIndexes(
  db: RedisStore,
  s: Sticker,
): Promise<void> {
  const onSquare =
    s.enabled === 1 &&
    s.visibility === "public" &&
    s.review_status === "approved";
  const pending = s.enabled === 1 && s.review_status === "pending";

  // Both index writes in one round trip
  const pipe = db.redis.pipeline();
  if (onSquare) pipe.sadd(K.stickersPublic, s.id);
  else pipe.srem(K.stickersPublic, s.id);
  if (pending) pipe.sadd(K.stickersPending, s.id);
  else pipe.srem(K.stickersPending, s.id);
  await pipe.exec();

  invalidatePublicStickersSnapshot();
}

export async function putStickerBlob(
  db: RedisStore,
  id: string,
  data: Buffer,
): Promise<void> {
  if (!data?.length) throw new Error("empty blob");
  await db.redis.set(K.stickerBlob(id), data);
}

export async function getStickerBlob(
  db: RedisStore,
  id: string,
): Promise<Buffer | null> {
  const buf = await db.redis.getBuffer(K.stickerBlob(id));
  if (!buf || !buf.length) return null;
  return Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
}

export async function deleteStickerBlob(
  db: RedisStore,
  id: string,
): Promise<void> {
  await db.redis.del(K.stickerBlob(id));
}

export async function createSticker(
  db: RedisStore,
  input: {
    slug?: string;
    displayName: string;
    description?: string;
    tags?: string[];
    mime: string;
    sizeBytes?: number;
    fileName?: string;
    enabled?: boolean;
    ownerUserId?: string;
    visibility?: StickerVisibility;
    /** Admin direct upload auto-approves public stickers by default */
    autoApprove?: boolean;
    data: Buffer;
  },
): Promise<Sticker> {
  if (!input.data?.length) throw new Error("empty blob");
  const owner = input.ownerUserId || "system";
  const visibility: StickerVisibility =
    input.visibility === "private" ? "private" : "public";
  let slug = (input.slug || "").trim().toLowerCase();
  if (!slug) slug = generateStickerSlug(owner, input.displayName);
  if (!isValidStickerSlug(slug)) throw new Error("invalid slug");
  if (await getStickerBySlug(db, slug)) throw new Error("slug exists");

  const autoApprove =
    input.autoApprove === true ||
    (input.autoApprove !== false && owner === "system");
  let review_status: StickerReviewStatus;
  if (visibility === "private") {
    // private: usable by owner without square listing
    review_status = "approved";
  } else if (autoApprove) {
    review_status = "approved";
  } else {
    review_status = "pending";
  }

  const id = newId("sticker");
  const ext = (input.mime.split("/")[1] || "bin").replace("jpeg", "jpg");
  const fileName = input.fileName?.trim() || `${id}.${ext}`;
  const now = nowIso();
  const content_hash = hashStickerBlob(input.data);
  const row: Sticker = {
    id,
    slug,
    display_name: (input.displayName || slug).trim(),
    description: (input.description ?? "").trim(),
    tags: (input.tags ?? [])
      .map((t) => t.trim())
      .filter(Boolean)
      .slice(0, 16),
    mime: input.mime,
    size_bytes: input.sizeBytes || input.data.length,
    file_name: fileName,
    owner_user_id: owner,
    visibility,
    review_status,
    reviewed_at: review_status === "approved" ? now : undefined,
    reviewed_by: review_status === "approved" && autoApprove ? owner : undefined,
    enabled: input.enabled === false ? 0 : 1,
    use_count: 0,
    content_hash,
    created_at: now,
    updated_at: now,
  };
  if (!input.data?.length) throw new Error("empty blob");
  // Blob + meta + every index in one round trip (was 5–7 sequential RTTs)
  const pipe = db.redis.pipeline();
  pipe.set(K.stickerBlob(id), input.data);
  pipe.set(K.sticker(id), JSON.stringify(row));
  pipe.sadd(K.stickersAll, id);
  pipe.set(K.stickerSlug(slug), id);
  if (owner !== "system") {
    pipe.sadd(K.stickersByOwner(owner), id);
    pipe.sadd(K.stickerLib(owner), id);
  }
  await pipe.exec();
  await syncStickerIndexes(db, row);
  return row;
}

export async function getSticker(
  db: RedisStore,
  id: string,
): Promise<Sticker | undefined> {
  // One GET — this is the hottest sticker path (CDN image, square detail,
  // worker sticker send). Reading the key twice doubled its cost for nothing.
  const raw = await db.getJson<Sticker>(K.sticker(id));
  const s = normalizeSticker(raw ?? undefined);
  if (s && raw && (!raw.owner_user_id || !raw.review_status)) {
    // Lazy migrate legacy records missing owner/review into indexes
    await db.setJson(K.sticker(id), s);
    await syncStickerIndexes(db, s);
  }
  return s;
}

export async function getStickerBySlug(
  db: RedisStore,
  slug: string,
): Promise<Sticker | undefined> {
  const id = await db.redis.get(K.stickerSlug(slug.trim().toLowerCase()));
  if (!id) return undefined;
  return getSticker(db, id);
}

export async function listStickers(
  db: RedisStore,
  opts?: {
    enabledOnly?: boolean;
    q?: string;
    reviewStatus?: StickerReviewStatus | "all";
    ownerUserId?: string;
  },
): Promise<Sticker[]> {
  const ids = (await db.redis.smembers(K.stickersAll)) as string[];
  if (!ids.length) return [];
  const rows = await db.mgetJson<Sticker>(ids.map((id) => K.sticker(id)));
  let out: Sticker[] = [];
  for (const raw of rows) {
    const s = normalizeSticker(raw ?? undefined);
    if (s) out.push(s);
  }
  if (opts?.enabledOnly) out = out.filter((s) => s.enabled === 1);
  if (opts?.ownerUserId) {
    out = out.filter((s) => s.owner_user_id === opts.ownerUserId);
  }
  if (opts?.reviewStatus && opts.reviewStatus !== "all") {
    out = out.filter((s) => s.review_status === opts.reviewStatus);
  }
  const q = opts?.q?.trim().toLowerCase();
  if (q) {
    out = out.filter(
      (s) =>
        s.slug.includes(q) ||
        s.display_name.toLowerCase().includes(q) ||
        s.description.toLowerCase().includes(q) ||
        s.tags.some((t) => t.toLowerCase().includes(q)) ||
        s.owner_user_id.includes(q),
    );
  }
  return out.sort((a, b) =>
    (b.updated_at || "").localeCompare(a.updated_at || ""),
  );
}

/** Snapshot of every enabled+public+approved sticker (see persona equivalent). */
const publicStickersSnapshot = new SnapshotCache<readonly Sticker[]>(
  SQUARE_SNAPSHOT_MS,
);

export function invalidatePublicStickersSnapshot(): void {
  publicStickersSnapshot.invalidate();
}

/** Square-visible stickers (2 RTTs on miss, 0 on hit). Shared + frozen — see personas. */
export async function listPublicStickersCached(
  db: RedisStore,
): Promise<readonly Sticker[]> {
  return publicStickersSnapshot.get(async () => {
    const ids = (await db.redis.smembers(K.stickersPublic)) as string[];
    if (!ids.length) return [];
    const rows = await db.mgetJson<Sticker>(ids.map((id) => K.sticker(id)));
    const out: Sticker[] = [];
    for (const raw of rows) {
      const s = normalizeSticker(raw ?? undefined);
      if (
        !s ||
        !s.enabled ||
        s.visibility !== "public" ||
        s.review_status !== "approved"
      ) {
        continue;
      }
      out.push(s);
    }
    return Object.freeze(out);
  });
}

export type PublicStickerSort = "use" | "recent" | "name";

export async function searchPublicStickers(
  db: RedisStore,
  opts: {
    q?: string;
    limit?: number;
    offset?: number;
    sort?: PublicStickerSort;
  } = {},
): Promise<{ items: Sticker[]; total: number }> {
  const limit = Math.min(Math.max(opts.limit ?? 20, 1), 50);
  const offset = Math.max(opts.offset ?? 0, 0);
  const q = (opts.q ?? "").trim().toLowerCase();
  const sort: PublicStickerSort =
    opts.sort === "recent" || opts.sort === "name" || opts.sort === "use"
      ? opts.sort
      : "use";
  const all = await listPublicStickersCached(db);
  const items: Sticker[] = [];
  for (const s of all) {
    if (q) {
      const hay = [s.display_name, s.description, s.slug, ...(s.tags || [])]
        .join(" ")
        .toLowerCase();
      if (!hay.includes(q)) continue;
    }
    items.push(s);
  }
  items.sort((a, b) => {
    if (sort === "name") {
      return a.display_name.localeCompare(b.display_name, "zh");
    }
    if (sort === "recent") {
      return (b.updated_at || "").localeCompare(a.updated_at || "");
    }
    return (
      (b.use_count || 0) - (a.use_count || 0) ||
      (b.updated_at || "").localeCompare(a.updated_at || "")
    );
  });
  return { total: items.length, items: items.slice(offset, offset + limit) };
}

export async function listStickersByOwner(
  db: RedisStore,
  userId: string,
): Promise<Sticker[]> {
  const ids = (await db.redis.smembers(K.stickersByOwner(userId))) as string[];
  if (!ids.length) return [];
  const rows = await db.mgetJson<Sticker>(ids.map((id) => K.sticker(id)));
  const out: Sticker[] = [];
  for (const raw of rows) {
    const s = normalizeSticker(raw ?? undefined);
    if (s) out.push(s);
  }
  return out.sort((a, b) =>
    (b.updated_at || "").localeCompare(a.updated_at || ""),
  );
}

/** Whether a sticker can be used by this user (library / own / system public). */
export function stickerUsableByUser(s: Sticker, userId: string): boolean {
  if (!s.enabled) return false;
  if (s.owner_user_id === userId) {
    // own private always; own public only if not rejected (pending still ok for owner)
    return s.review_status !== "rejected";
  }
  if (s.owner_user_id === "system") {
    return (
      s.visibility === "public" && s.review_status === "approved"
    );
  }
  return (
    s.visibility === "public" && s.review_status === "approved"
  );
}

export async function listUserStickerLibrary(
  db: RedisStore,
  userId: string,
): Promise<Sticker[]> {
  const map = new Map<string, Sticker>();
  // Public snapshot, library set and owned set are independent — fetch together
  // instead of 3 chained SMEMBERS→MGET pairs (6 sequential RTTs).
  const [publicStickers, libIds, owned] = await Promise.all([
    listPublicStickersCached(db),
    db.redis.smembers(K.stickerLib(userId)) as Promise<string[]>,
    listStickersByOwner(db, userId),
  ]);
  // system public approved
  for (const s of publicStickers) {
    if (s.owner_user_id === "system" && stickerUsableByUser(s, userId)) {
      map.set(s.id, s);
    }
  }
  if (libIds.length) {
    const publicById = new Map(publicStickers.map((s) => [s.id, s]));
    const missing = libIds.filter((id) => !publicById.has(id));
    const extra = missing.length
      ? await db.mgetJson<Sticker>(missing.map((id) => K.sticker(id)))
      : [];
    const libStickers: (Sticker | undefined)[] = [
      ...libIds.map((id) => publicById.get(id)).filter(Boolean),
      ...extra.map((raw) => normalizeSticker(raw ?? undefined)),
    ];
    for (const s of libStickers) {
      if (!s || !s.enabled) continue;
      if (s.owner_user_id === userId) {
        if (s.review_status !== "rejected") map.set(s.id, s);
        continue;
      }
      if (s.visibility === "public" && s.review_status === "approved") {
        map.set(s.id, s);
      }
    }
  }
  for (const s of owned) {
    if (s.enabled && s.review_status !== "rejected") map.set(s.id, s);
  }
  return [...map.values()].sort((a, b) =>
    a.display_name.localeCompare(b.display_name, "zh"),
  );
}

/**
 * Stickers available for LLM injection for a bot owner.
 */
export async function listStickersForOwnerPrompt(
  db: RedisStore,
  ownerUserId: string,
): Promise<StickerPromptEntry[]> {
  if (!ownerUserId) return [];
  const lib = await listUserStickerLibrary(db, ownerUserId);
  return lib
    .filter((s) => stickerUsableByUser(s, ownerUserId))
    .map((s) => ({
      slug: s.slug,
      display_name: s.display_name,
      description: s.description,
      tags: s.tags,
    }));
}

/** @deprecated use listStickersForOwnerPrompt — global list no longer used for chat */
export async function listEnabledStickersForPrompt(
  db: RedisStore,
): Promise<StickerPromptEntry[]> {
  const all = await listStickers(db, {
    enabledOnly: true,
    reviewStatus: "approved",
  });
  return all
    .filter((s) => s.visibility === "public" || s.owner_user_id === "system")
    .map((s) => ({
      slug: s.slug,
      display_name: s.display_name,
      description: s.description,
      tags: s.tags,
    }));
}

export async function userCanUseSticker(
  db: RedisStore,
  userId: string,
  stickerId: string,
): Promise<boolean> {
  const s = await getSticker(db, stickerId);
  if (!s) return false;
  return userCanUseStickerRow(db, userId, s);
}

/**
 * Same check for callers that already hold the row. The slug path used to load
 * the same sticker twice (once by slug, once by id inside userCanUseSticker).
 *
 * Note the decision itself is never cached — library membership changes, and a
 * stale allow would be a security regression.
 */
export async function userCanUseStickerRow(
  db: RedisStore,
  userId: string,
  s: Sticker,
): Promise<boolean> {
  if (!stickerUsableByUser(s, userId)) return false;
  if (s.owner_user_id === userId) return true;
  if (s.owner_user_id === "system" && s.review_status === "approved") {
    return true;
  }
  return Boolean(await db.redis.sismember(K.stickerLib(userId), s.id));
}

export async function userCanUseStickerSlug(
  db: RedisStore,
  userId: string,
  slug: string,
): Promise<Sticker | null> {
  const s = await getStickerBySlug(db, slug);
  if (!s) return null;
  if (!(await userCanUseStickerRow(db, userId, s))) return null;
  return s;
}

export async function addStickerToLibrary(
  db: RedisStore,
  userId: string,
  stickerId: string,
): Promise<Sticker> {
  const s = await getSticker(db, stickerId);
  if (!s || !s.enabled) throw new Error("sticker not found");
  if (s.visibility === "private" && s.owner_user_id !== userId) {
    throw new Error("sticker is private");
  }
  if (
    s.owner_user_id !== userId &&
    (s.review_status !== "approved" || s.visibility !== "public")
  ) {
    throw new Error("sticker not available");
  }
  const added = await db.redis.sadd(K.stickerLib(userId), stickerId);
  if (added && s.owner_user_id !== userId) {
    s.use_count = (s.use_count || 0) + 1;
    s.updated_at = nowIso();
    await db.setJson(K.sticker(stickerId), s);
    invalidatePublicStickersSnapshot();
  }
  return s;
}

export async function removeStickerFromLibrary(
  db: RedisStore,
  userId: string,
  stickerId: string,
): Promise<void> {
  const removed = await db.redis.srem(K.stickerLib(userId), stickerId);
  if (!removed) return;
  const s = await getSticker(db, stickerId);
  // Mirror addStickerToLibrary: only non-owner adds bump use_count
  if (s && s.owner_user_id !== userId && (s.use_count || 0) > 0) {
    s.use_count = Math.max(0, (s.use_count || 0) - 1);
    s.updated_at = nowIso();
    await db.setJson(K.sticker(stickerId), s);
    invalidatePublicStickersSnapshot();
  }
}

// ── Web try-chat (ephemeral) ───────────────────────────

export async function createTryChatSession(
  db: RedisStore,
  input: {
    userId: string;
    personaId: string;
    botName?: string;
    ttlSec?: number;
  },
): Promise<{ sessionId: string; session: TryChatSession; ttlSec: number }> {
  const ttlSec = Math.max(60, input.ttlSec ?? 3600);
  const sessionId = newId("try");
  const session: TryChatSession = {
    userId: input.userId,
    personaId: input.personaId,
    botName: (input.botName?.trim() || "助手").slice(0, 32),
    createdAt: nowIso(),
    msgCount: 0,
  };
  await db.setJson(K.trySession(sessionId), session, ttlSec);
  return { sessionId, session, ttlSec };
}

export async function getTryChatSession(
  db: RedisStore,
  sessionId: string,
): Promise<TryChatSession | null> {
  const s = await db.getJson<TryChatSession>(K.trySession(sessionId));
  return s?.userId && s.personaId ? s : null;
}

export async function saveTryChatSession(
  db: RedisStore,
  sessionId: string,
  session: TryChatSession,
  ttlSec: number,
): Promise<void> {
  await db.setJson(K.trySession(sessionId), session, Math.max(60, ttlSec));
}

export async function deleteTryChatSession(
  db: RedisStore,
  sessionId: string,
): Promise<void> {
  await db.del(K.trySession(sessionId));
  await db.del(K.trySessionMsgs(sessionId));
}

export async function listTryChatMessages(
  db: RedisStore,
  sessionId: string,
  max = 40,
): Promise<TryChatMessage[]> {
  const n = Math.max(1, Math.min(max, 100));
  const raw = await db.redis.lrange(K.trySessionMsgs(sessionId), -n, -1);
  const out: TryChatMessage[] = [];
  for (const r of raw) {
    try {
      const m = JSON.parse(r) as TryChatMessage;
      if (m?.role && m.content != null) out.push(m);
    } catch {
      /* skip */
    }
  }
  return out;
}

export async function appendTryChatMessages(
  db: RedisStore,
  sessionId: string,
  messages: TryChatMessage[],
  opts: { maxHistory?: number; ttlSec?: number } = {},
): Promise<void> {
  if (!messages.length) return;
  const maxHistory = Math.max(4, opts.maxHistory ?? 40);
  const ttlSec = Math.max(60, opts.ttlSec ?? 3600);
  const pipe = db.redis.pipeline();
  for (const m of messages) {
    pipe.rpush(K.trySessionMsgs(sessionId), JSON.stringify(m));
  }
  pipe.ltrim(K.trySessionMsgs(sessionId), -maxHistory, -1);
  pipe.expire(K.trySessionMsgs(sessionId), ttlSec);
  await pipe.exec();
}

/** Increment daily try-chat user-message counter. Returns new count. */
export async function incrTryChatDayCount(
  db: RedisStore,
  userId: string,
  day?: string,
): Promise<number> {
  const d = day || dayKey();
  const key = K.tryDayCount(userId, d);
  const n = await db.redis.incr(key);
  if (n === 1) {
    await db.redis.expire(key, 2 * 24 * 3600);
  }
  return n;
}

export async function getTryChatDayCount(
  db: RedisStore,
  userId: string,
  day?: string,
): Promise<number> {
  const d = day || dayKey();
  const v = await db.redis.get(K.tryDayCount(userId, d));
  return Number(v || 0);
}

export async function isInStickerLibrary(
  db: RedisStore,
  userId: string,
  stickerId: string,
): Promise<boolean> {
  return Boolean(await db.redis.sismember(K.stickerLib(userId), stickerId));
}

export async function approveSticker(
  db: RedisStore,
  id: string,
  reviewerId: string,
): Promise<Sticker> {
  const s = await getSticker(db, id);
  if (!s) throw new Error("not found");
  s.review_status = "approved";
  s.reject_reason = undefined;
  s.reviewed_at = nowIso();
  s.reviewed_by = reviewerId;
  s.updated_at = nowIso();
  await db.setJson(K.sticker(id), s);
  await syncStickerIndexes(db, s);
  return s;
}

export async function rejectSticker(
  db: RedisStore,
  id: string,
  reviewerId: string,
  reason?: string,
): Promise<Sticker> {
  const s = await getSticker(db, id);
  if (!s) throw new Error("not found");
  s.review_status = "rejected";
  s.reject_reason = (reason || "").trim() || undefined;
  s.reviewed_at = nowIso();
  s.reviewed_by = reviewerId;
  s.updated_at = nowIso();
  await db.setJson(K.sticker(id), s);
  await syncStickerIndexes(db, s);
  return s;
}

export async function softDeleteSticker(
  db: RedisStore,
  id: string,
): Promise<Sticker> {
  const s = await getSticker(db, id);
  if (!s) throw new Error("not found");
  s.enabled = 0;
  s.updated_at = nowIso();
  await db.setJson(K.sticker(id), s);
  await syncStickerIndexes(db, s);
  return s;
}

export async function restoreSticker(
  db: RedisStore,
  id: string,
): Promise<Sticker> {
  const s = await getSticker(db, id);
  if (!s) throw new Error("not found");
  s.enabled = 1;
  // public restored items go back to pending unless system
  if (s.visibility === "public" && s.owner_user_id !== "system") {
    if (s.review_status === "rejected") s.review_status = "pending";
  }
  s.updated_at = nowIso();
  await db.setJson(K.sticker(id), s);
  await syncStickerIndexes(db, s);
  return s;
}

export async function countPendingStickers(db: RedisStore): Promise<number> {
  return db.redis.scard(K.stickersPending);
}

export async function updateStickerMeta(
  db: RedisStore,
  id: string,
  patch: {
    displayName?: string;
    description?: string;
    tags?: string[];
    enabled?: boolean;
    mime?: string;
    sizeBytes?: number;
    fileName?: string;
    slug?: string;
    visibility?: StickerVisibility;
    /** sha256 prefix of image bytes (CDN ?v=) */
    contentHash?: string;
    /** When true, public content changes reset review to pending */
    rePending?: boolean;
  },
): Promise<Sticker> {
  const cur = await getSticker(db, id);
  if (!cur) throw new Error("not found");

  if (patch.slug !== undefined) {
    const nextSlug = patch.slug.trim().toLowerCase();
    if (!isValidStickerSlug(nextSlug)) throw new Error("invalid slug");
    if (nextSlug !== cur.slug) {
      const existing = await getStickerBySlug(db, nextSlug);
      if (existing && existing.id !== id) throw new Error("slug exists");
      await db.redis.del(K.stickerSlug(cur.slug));
      await db.redis.set(K.stickerSlug(nextSlug), id);
      cur.slug = nextSlug;
    }
  }
  if (patch.displayName !== undefined) {
    cur.display_name = patch.displayName.trim() || cur.slug;
  }
  if (patch.description !== undefined) {
    cur.description = patch.description.trim();
  }
  if (patch.tags !== undefined) {
    cur.tags = patch.tags
      .map((t) => t.trim())
      .filter(Boolean)
      .slice(0, 16);
  }
  if (patch.enabled !== undefined) {
    cur.enabled = patch.enabled ? 1 : 0;
  }
  if (patch.mime !== undefined) cur.mime = patch.mime;
  if (patch.sizeBytes !== undefined) cur.size_bytes = patch.sizeBytes;
  if (patch.fileName !== undefined) cur.file_name = patch.fileName;
  if (patch.contentHash !== undefined) cur.content_hash = patch.contentHash;
  if (patch.visibility !== undefined) {
    cur.visibility = patch.visibility === "private" ? "private" : "public";
  }

  const needsReReview =
    patch.rePending === true ||
    (cur.visibility === "public" &&
      cur.owner_user_id !== "system" &&
      (patch.rePending !== false &&
        (patch.displayName !== undefined ||
          patch.description !== undefined ||
          patch.tags !== undefined ||
          patch.visibility === "public" ||
          patch.mime !== undefined ||
          patch.sizeBytes !== undefined ||
          patch.contentHash !== undefined)));

  if (needsReReview && cur.visibility === "public" && cur.owner_user_id !== "system") {
    cur.review_status = "pending";
    cur.reject_reason = undefined;
  }
  if (cur.visibility === "private") {
    // private is usable without square review
    if (cur.review_status === "pending") cur.review_status = "approved";
  }

  cur.updated_at = nowIso();
  await db.setJson(K.sticker(id), cur);
  await syncStickerIndexes(db, cur);
  return cur;
}

export async function deleteSticker(
  db: RedisStore,
  id: string,
): Promise<Sticker | undefined> {
  const cur = await getSticker(db, id);
  if (!cur) return undefined;
  const pipe = db.redis.pipeline();
  pipe.del(K.sticker(id), K.stickerBlob(id), K.stickerSlug(cur.slug));
  pipe.srem(K.stickersAll, id);
  pipe.srem(K.stickersPublic, id);
  pipe.srem(K.stickersPending, id);
  if (cur.owner_user_id && cur.owner_user_id !== "system") {
    pipe.srem(K.stickersByOwner(cur.owner_user_id), id);
  }
  await pipe.exec();
  invalidatePublicStickersSnapshot();
  return cur;
}

/**
 * Replace image bytes; public non-system stickers go back to pending.
 * Updates content_hash for CDN cache-busting (`?v=`).
 */
export async function replaceStickerBlob(
  db: RedisStore,
  id: string,
  data: Buffer,
  patch?: { mime?: string; fileName?: string },
): Promise<Sticker> {
  const cur = await getSticker(db, id);
  if (!cur) throw new Error("not found");
  if (!data?.length) throw new Error("empty blob");
  await putStickerBlob(db, id, data);
  const content_hash = hashStickerBlob(data);
  return updateStickerMeta(db, id, {
    mime: patch?.mime ?? cur.mime,
    sizeBytes: data.length,
    fileName: patch?.fileName ?? cur.file_name,
    contentHash: content_hash,
    rePending: true,
  });
}

/**
 * Ensure sticker meta has content_hash (lazy migrate from blob).
 * Returns updated sticker or null if blob missing.
 */
export async function ensureStickerContentHash(
  db: RedisStore,
  sticker: Sticker,
): Promise<Sticker | null> {
  if (sticker.content_hash) return sticker;
  const buf = await getStickerBlob(db, sticker.id);
  if (!buf) return null;
  const content_hash = hashStickerBlob(buf);
  const next: Sticker = {
    ...sticker,
    content_hash,
    size_bytes: sticker.size_bytes || buf.length,
    updated_at: nowIso(),
  };
  await db.setJson(K.sticker(sticker.id), next);
  invalidatePublicStickersSnapshot();
  return next;
}
