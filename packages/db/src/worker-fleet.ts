import type { RedisStore } from "./client.js";
import { nowIso } from "./client.js";
import { K } from "./keys.js";

/**
 * Seconds without a fresh heartbeat before a fleet node is treated as dead
 * and dropped from the admin list (meta TTL / online window / ghost fence).
 */
export const WORKER_STALE_SEC = 60;

/** Inbound message job (poll → queue → reply). */
export interface InboundJob {
  id: string;
  botId: string;
  peerId: string;
  contextToken: string;
  /** Empty string when media-only / non-text */
  text: string;
  /** true when user sent non-text without usable transcript */
  mediaOnly: boolean;
  enqueuedAt: string;
}

export interface WorkerMeta {
  id: string;
  hostname: string;
  pid: number;
  maxBots: number;
  botCount: number;
  startedAt: string;
  updatedAt: string;
  role: "poll" | "all";
  /** Optional ops label (NODE_LABEL), e.g. rack / role name */
  label?: string;
  /** Optional region (NODE_REGION) */
  region?: string;
  /** App / image version string when known */
  version?: string;
  /**
   * Admin load weight in percent this node believes it has (100 = default).
   * Heartbeat carries it so peers can size their own share without a second
   * Redis read; `wa:workers:weights` stays the source of truth.
   */
  weight?: number;
}

// ── Admin load weight (per-node share of the pollable bots) ──────────

/** Weight of a node with no admin override — the even-split baseline. */
export const DEFAULT_WORKER_WEIGHT = 100;
/** 0% = drain: claim only what no other node has room for. */
export const MIN_WORKER_WEIGHT = 0;
/** 500% = up to 5× an unweighted node's share. */
export const MAX_WORKER_WEIGHT = 500;

export interface WorkerWeight {
  workerId: string;
  /** Relative share in percent; 100 is one unweighted node's share */
  percent: number;
  updatedAt: string;
  byUserId: string | null;
  byUsername: string | null;
}

/**
 * How long a weight override outlives its node's last heartbeat before it is
 * deleted automatically.
 *
 * Must comfortably exceed a restart: an OTA apply reinstalls dependencies and
 * reboots the process, and losing the tuning on every deploy would be worse
 * than keeping a dead row around for an hour.
 */
export const DEFAULT_WORKER_WEIGHT_TTL_SEC = 3600;

/**
 * Validate an admin-supplied weight before it reaches Redis.
 *
 * Deliberately stricter than `Number()`: `Number(" ")`, `Number([])` and
 * `Number(false)` are all 0, which is the "drain this node" value — a
 * malformed request must be rejected, not silently take a node out of
 * rotation. Only a real number or a numeric string is accepted, and the
 * range is checked rather than clamped so the caller learns it was wrong.
 */
export function parseWorkerWeightInput(
  raw: unknown,
): { ok: true; value: number } | { ok: false; error: string } {
  if (raw === undefined || raw === null) {
    return { ok: false, error: "weight_required" };
  }
  let n: number;
  if (typeof raw === "number") {
    n = raw;
  } else if (typeof raw === "string" && raw.trim() !== "") {
    n = Number(raw.trim());
  } else {
    return { ok: false, error: "weight_not_a_number" };
  }
  if (!Number.isFinite(n)) return { ok: false, error: "weight_not_a_number" };
  if (n < MIN_WORKER_WEIGHT || n > MAX_WORKER_WEIGHT) {
    return { ok: false, error: "weight_out_of_range" };
  }
  return { ok: true, value: normalizeWorkerWeight(n) };
}

/** Clamp/round any admin or Redis value into the supported percent range. */
export function normalizeWorkerWeight(value: unknown): number {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return DEFAULT_WORKER_WEIGHT;
  return Math.min(MAX_WORKER_WEIGHT, Math.max(MIN_WORKER_WEIGHT, n));
}

/**
 * Whether any node carries a non-default weight. Workers take the cheap
 * unweighted path (no extra Redis reads per tick) when this is false.
 */
export function hasWorkerWeightOverrides(
  weights: Record<string, WorkerWeight>,
): boolean {
  for (const w of Object.values(weights)) {
    if (normalizeWorkerWeight(w.percent) !== DEFAULT_WORKER_WEIGHT) return true;
  }
  return false;
}

/** All admin weight overrides, keyed by workerId (missing = default 100%). */
export async function listWorkerWeights(
  db: RedisStore,
): Promise<Record<string, WorkerWeight>> {
  // Deliberately propagates Redis failures. An empty object means "no node is
  // weighted", which is a real instruction — returning it for a failed read
  // would silently un-drain a 0% node and un-weight the whole fleet. Callers
  // that can tolerate a gap catch this themselves.
  const raw = ((await db.redis.hgetall(K.workerWeights)) ?? {}) as Record<
    string,
    string
  >;
  const out: Record<string, WorkerWeight> = {};
  for (const [workerId, value] of Object.entries(raw)) {
    if (!value) continue;
    try {
      const parsed = JSON.parse(value) as Partial<WorkerWeight>;
      out[workerId] = {
        workerId,
        percent: normalizeWorkerWeight(parsed.percent),
        updatedAt: parsed.updatedAt || nowIso(),
        byUserId: parsed.byUserId ?? null,
        byUsername: parsed.byUsername ?? null,
      };
    } catch {
      // Tolerate a bare number written by an older build / redis-cli
      const percent = Number(value);
      if (Number.isFinite(percent)) {
        out[workerId] = {
          workerId,
          percent: normalizeWorkerWeight(percent),
          updatedAt: nowIso(),
          byUserId: null,
          byUsername: null,
        };
      }
    }
  }
  return out;
}

/**
 * Last-seen timestamps for weighted nodes (workerId → ISO).
 * Separate hash from the weights themselves — see K.workerWeightsSeen.
 */
export async function listWorkerWeightSeen(
  db: RedisStore,
): Promise<Record<string, string>> {
  // Propagates like listWorkerWeights: the GC deletes based on these
  // timestamps, so an empty result from a failed read would expire nodes early.
  const raw = ((await db.redis.hgetall(K.workerWeightsSeen)) ?? {}) as Record<
    string,
    string
  >;
  const out: Record<string, string> = {};
  for (const [id, v] of Object.entries(raw)) {
    if (v) out[id] = v;
  }
  return out;
}

/** Effective weight percent for one node (default when unset). */
export async function getWorkerWeight(
  db: RedisStore,
  workerId: string,
): Promise<number> {
  try {
    const raw = (await db.redis.hget(K.workerWeights, workerId)) as
      | string
      | null;
    if (!raw) return DEFAULT_WORKER_WEIGHT;
    try {
      const parsed = JSON.parse(raw) as Partial<WorkerWeight>;
      return normalizeWorkerWeight(parsed.percent);
    } catch {
      return normalizeWorkerWeight(raw);
    }
  } catch {
    return DEFAULT_WORKER_WEIGHT;
  }
}

/**
 * Set a node's load weight. Writing the default clears the override so the
 * hash only ever holds nodes the admin actually tuned.
 */
export async function setWorkerWeight(
  db: RedisStore,
  workerId: string,
  percent: number,
  opts?: { byUserId?: string | null; byUsername?: string | null },
): Promise<WorkerWeight | null> {
  const id = workerId.trim();
  if (!id) throw new Error("workerId required");
  const value = normalizeWorkerWeight(percent);
  if (value === DEFAULT_WORKER_WEIGHT) {
    await clearWorkerWeight(db, id);
    return null;
  }
  const now = nowIso();
  const record: WorkerWeight = {
    workerId: id,
    percent: value,
    updatedAt: now,
    byUserId: opts?.byUserId ?? null,
    byUsername: opts?.byUsername ?? null,
  };
  await db.redis
    .pipeline()
    .hset(K.workerWeights, id, JSON.stringify(record))
    // Start the expiry clock now: a weight set for a node that never comes
    // online should still age out instead of sitting there forever.
    .hset(K.workerWeightsSeen, id, now)
    .exec();
  return record;
}

/** Drop the override (node falls back to the default share). */
export async function clearWorkerWeight(
  db: RedisStore,
  workerId: string,
): Promise<boolean> {
  const res = await db.redis
    .pipeline()
    .hdel(K.workerWeights, workerId)
    .hdel(K.workerWeightsSeen, workerId)
    .exec();
  return Number(res?.[0]?.[1] ?? 0) > 0;
}

export interface WorkerWeightGcResult {
  /** Weights deleted because their node has been gone past the grace period */
  removed: string[];
  /** Weights whose `lastSeenAt` was refreshed because the node is alive */
  touched: string[];
  /** Entries still within the grace period (node gone, not expired yet) */
  pending: number;
}

/**
 * Age out weight overrides whose node has disappeared, and keep the clock
 * fresh for the ones still running.
 *
 * Liveness comes from the heartbeat meta key (`wa:worker:<id>`), not from
 * `lastSeenAt` — every build writes that key, so a node running an older
 * image mid-OTA is never mistaken for gone. `lastSeenAt` only decides how
 * long a node that is *already* absent has left.
 *
 * Fenced nodes are never expired: an admin force-offline is temporary and the
 * weight must survive until the fence is cleared.
 *
 * Idempotent (HSET/HDEL), so every node may run it concurrently.
 */
export async function gcWorkerWeights(
  db: RedisStore,
  opts?: {
    /** Seconds a weight survives after its node's last heartbeat */
    graceSec?: number;
    /** Pre-fetched weights, to save an HGETALL when the caller has them */
    weights?: Record<string, WorkerWeight>;
    now?: number;
    /** Expire every absent node immediately, ignoring the grace period */
    force?: boolean;
  },
): Promise<WorkerWeightGcResult> {
  const weights = opts?.weights ?? (await listWorkerWeights(db));
  const ids = Object.keys(weights);
  if (!ids.length) return { removed: [], touched: [], pending: 0 };

  const graceMs = Math.max(60, opts?.graceSec ?? DEFAULT_WORKER_WEIGHT_TTL_SEC) * 1000;
  const now = opts?.now ?? Date.now();

  const [liveFlags, fencedIds, seenMap] = await Promise.all([
    db.existsMany(ids.map((id) => K.workerMeta(id))),
    db.redis.smembers(K.workersFenced) as Promise<string[]>,
    listWorkerWeightSeen(db),
  ]);
  const fenced = new Set(fencedIds);

  const removed: string[] = [];
  const touched: string[] = [];
  let pending = 0;

  ids.forEach((id, i) => {
    // Fall back to when the admin set the weight: a node that has never been
    // seen since must still start its clock somewhere.
    const seen = Date.parse(seenMap[id] || weights[id]!.updatedAt);
    if (liveFlags[i]) {
      // Rewrite at most a few times per grace period, not on every pass.
      if (!Number.isFinite(seen) || now - seen > graceMs / 4) touched.push(id);
      return;
    }
    if (fenced.has(id)) return;
    if (!opts?.force && Number.isFinite(seen) && now - seen <= graceMs) {
      pending++;
      return;
    }
    removed.push(id);
  });

  if (touched.length) {
    const stamp = new Date(now).toISOString();
    const pipe = db.redis.pipeline();
    for (const id of touched) pipe.hset(K.workerWeightsSeen, id, stamp);
    await pipe.exec();
  }
  if (removed.length) {
    await db.redis
      .pipeline()
      .hdel(K.workerWeights, ...removed)
      .hdel(K.workerWeightsSeen, ...removed)
      .exec();
  }
  // Orphaned timestamps for weights that were cleared elsewhere
  const stale = Object.keys(seenMap).filter((id) => !(id in weights));
  if (stale.length) {
    await db.redis.hdel(K.workerWeightsSeen, ...stale).catch(() => 0);
  }

  return { removed, touched, pending };
}

/**
 * Delete every weight whose node is gone right now, ignoring the grace period.
 * The admin panel's "立即清理" — same liveness rule as the GC, no waiting.
 */
export async function pruneWorkerWeights(db: RedisStore): Promise<string[]> {
  const { removed } = await gcWorkerWeights(db, { force: true });
  return removed;
}

/**
 * Weighted share of `total` for one node (floored).
 * Falls back to an even split when every weight is 0 — a fleet drained to
 * nothing must still poll, otherwise every bot goes silent.
 */
export function weightedShare(
  total: number,
  weight: number,
  totalWeight: number,
  nodeCount: number,
): number {
  if (total <= 0) return 0;
  if (totalWeight > 0) {
    return Math.floor((total * Math.max(0, weight)) / totalWeight);
  }
  return nodeCount > 0 ? Math.floor(total / nodeCount) : total;
}

/** One node as seen by the planner. `maxBots <= 0` means "no local cap". */
export interface WeightedTargetNode {
  id: string;
  weight?: number;
  maxBots?: number;
}

/**
 * How many bots each node should hold: `total` split by weight, capped by each
 * node's own maxBots, with the overflow from capped nodes redistributed among
 * the rest.
 *
 * Two properties matter, and both come from computing one number instead of
 * separate claim/shed bounds:
 *
 * - **Exact**: largest-remainder rounding makes the targets sum to `total`
 *   (minus whatever no node has capacity for), so flooring never strands bots
 *   that nobody is allowed to claim.
 * - **Stable**: every node runs this over the same heartbeat data and gets the
 *   same answer (ties broken by id), so claim and shed agree. A per-side
 *   ceil/floor split would make a node claim one bot and shed it every tick.
 */
export function computeWeightedTargets(
  nodes: WeightedTargetNode[],
  total: number,
): Record<string, number> {
  const out: Record<string, number> = {};
  if (!nodes.length) return out;
  for (const n of nodes) out[n.id] = 0;

  let remaining = Math.max(0, Math.floor(total));
  if (remaining <= 0) return out;

  // Deterministic across nodes: same input order → same rounding.
  let pool = [...nodes].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  while (pool.length && remaining > 0) {
    const totalWeight = pool.reduce(
      (a, n) => a + normalizeWorkerWeight(n.weight ?? DEFAULT_WORKER_WEIGHT),
      0,
    );
    const rows = pool.map((n) => {
      const w = normalizeWorkerWeight(n.weight ?? DEFAULT_WORKER_WEIGHT);
      // Every weight zero → even split; going silent is worse than ignoring
      // a drain the admin applied fleet-wide.
      const exact =
        totalWeight > 0 ? (remaining * w) / totalWeight : remaining / pool.length;
      return { node: n, exact, alloc: Math.floor(exact) };
    });
    let left = remaining - rows.reduce((a, r) => a + r.alloc, 0);
    for (const r of [...rows].sort((a, b) => {
      const d = b.exact - b.alloc - (a.exact - a.alloc);
      return d !== 0 ? d : a.node.id < b.node.id ? -1 : 1;
    })) {
      if (left <= 0) break;
      r.alloc++;
      left--;
    }

    const over = rows.filter((r) => {
      const cap = Number(r.node.maxBots || 0);
      return cap > 0 && r.alloc > cap;
    });
    if (!over.length) {
      for (const r of rows) out[r.node.id] = r.alloc;
      return out;
    }
    // Pin the capped nodes and re-split what's left over the others.
    const capped = new Set<string>();
    for (const r of over) {
      const cap = Number(r.node.maxBots || 0);
      out[r.node.id] = cap;
      remaining -= cap;
      capped.add(r.node.id);
    }
    pool = pool.filter((n) => !capped.has(n.id));
    remaining = Math.max(0, remaining);
  }
  return out;
}

/** Fleet node view for admin (meta + leased bots). */
export interface FleetNodeView {
  id: string;
  hostname: string;
  pid: number;
  maxBots: number;
  botCount: number;
  startedAt: string;
  updatedAt: string;
  role: "poll" | "all";
  label?: string;
  region?: string;
  version?: string;
  /** Bot ids currently leased by this worker */
  leasedBotIds: string[];
  leasedCount: number;
  /** Whether this process is the reporting instance */
  isSelf: boolean;
  /** Heartbeat fresh within ttlSec (caller supplies) */
  online: boolean;
  /** Admin force-offline fence active */
  fenced: boolean;
  fenceReason?: string | null;
  fencedAt?: string | null;
  fencedBy?: string | null;
  /** Effective load weight percent (100 = default even share) */
  weight: number;
  /** True when an admin override exists (weight !== default is stored) */
  weightOverride: boolean;
  weightUpdatedAt?: string | null;
  weightBy?: string | null;
  /** Last heartbeat the GC recorded for this weight (drives auto-expiry) */
  weightLastSeenAt?: string | null;
  /**
   * Bots this node should hold given current weights across online nodes,
   * capped by maxBots. null when the node is offline/fenced (no share).
   */
  targetShare: number | null;
}

/**
 * Build admin fleet node list from registered worker metas + bot ownership sets.
 * Also includes fenced-but-not-registered workers so admin can clear the fence.
 */
export async function listFleetNodes(
  db: RedisStore,
  opts?: {
    selfWorkerId?: string;
    onlineWithinSec?: number;
    /** Bots to split across nodes for `targetShare` (default: leased sum) */
    totalBots?: number;
  },
): Promise<FleetNodeView[]> {
  // Metas, fences and weights are independent reads
  const [metas, fences, weights, weightSeen] = await Promise.all([
    listWorkerMetas(db),
    listWorkerFences(db),
    // Read-only admin view: a weights hiccup degrades the column rather than
    // failing the whole node list.
    listWorkerWeights(db).catch(() => ({}) as Record<string, WorkerWeight>),
    listWorkerWeightSeen(db).catch(() => ({}) as Record<string, string>),
  ]);
  const onlineWithin = Math.max(15, opts?.onlineWithinSec ?? WORKER_STALE_SEC);
  const now = Date.now();
  const fenceById = new Map(fences.map((f) => [f.workerId, f]));

  const lists = metas.length
    ? await db.smembersMany(metas.map((m) => K.workerBots(m.id)))
    : [];
  const seen = new Set<string>();
  const out: FleetNodeView[] = [];
  const staleFenceIds: string[] = [];

  metas.forEach((m, i) => {
    seen.add(m.id);
    const leasedBotIds = lists[i] ?? [];
    let online = true;
    try {
      const t = Date.parse(m.updatedAt);
      if (Number.isFinite(t)) {
        online = now - t <= onlineWithin * 1000;
      }
    } catch {
      online = false;
    }
    const fence = fenceById.get(m.id);
    const weight = weights[m.id];
    out.push({
      id: m.id,
      hostname: m.hostname,
      pid: m.pid,
      maxBots: m.maxBots,
      botCount: m.botCount,
      startedAt: m.startedAt,
      updatedAt: m.updatedAt,
      role: m.role,
      label: m.label,
      region: m.region,
      version: m.version,
      leasedBotIds,
      leasedCount: leasedBotIds.length,
      isSelf: Boolean(opts?.selfWorkerId && opts.selfWorkerId === m.id),
      online: fence ? false : online,
      fenced: Boolean(fence),
      fenceReason: fence?.reason ?? null,
      fencedAt: fence?.createdAt ?? null,
      fencedBy: fence?.byUsername || fence?.byUserId || null,
      weight: weight
        ? normalizeWorkerWeight(weight.percent)
        : DEFAULT_WORKER_WEIGHT,
      weightOverride: Boolean(weight),
      weightUpdatedAt: weight?.updatedAt ?? null,
      weightBy: weight?.byUsername || weight?.byUserId || null,
      weightLastSeenAt: weight
        ? (weightSeen[weight.workerId] ?? weight.updatedAt)
        : null,
      targetShare: null,
    });
  });

  // Fenced workers no longer in reg — list briefly so admin can clear;
  // drop after WORKER_STALE_SEC (no heartbeat / ghost row).
  const staleMs = onlineWithin * 1000;
  for (const fence of fences) {
    if (seen.has(fence.workerId)) continue;
    const t = Date.parse(fence.createdAt);
    const age = Number.isFinite(t) ? now - t : staleMs + 1;
    if (age > staleMs) {
      staleFenceIds.push(fence.workerId);
      continue;
    }
    const weight = weights[fence.workerId];
    out.push({
      id: fence.workerId,
      hostname: "—",
      pid: 0,
      maxBots: 0,
      botCount: 0,
      startedAt: fence.createdAt,
      updatedAt: fence.createdAt,
      role: "all",
      leasedBotIds: [],
      leasedCount: 0,
      isSelf: Boolean(opts?.selfWorkerId && opts.selfWorkerId === fence.workerId),
      online: false,
      fenced: true,
      fenceReason: fence.reason,
      fencedAt: fence.createdAt,
      fencedBy: fence.byUsername || fence.byUserId || null,
      weight: weight
        ? normalizeWorkerWeight(weight.percent)
        : DEFAULT_WORKER_WEIGHT,
      weightOverride: Boolean(weight),
      weightUpdatedAt: weight?.updatedAt ?? null,
      weightBy: weight?.byUsername || weight?.byUserId || null,
      weightLastSeenAt: weight
        ? (weightSeen[weight.workerId] ?? weight.updatedAt)
        : null,
      targetShare: null,
    });
  }

  if (staleFenceIds.length) {
    // Best-effort: clear ghost fences so the row never comes back
    await Promise.all(
      staleFenceIds.map((id) => clearWorkerFence(db, id).catch(() => false)),
    );
  }

  annotateTargetShares(out, opts?.totalBots);
  return out;
}

/**
 * Fill in `targetShare` for each node: the weighted split of `totalBots`
 * across the online, unfenced nodes, capped by each node's own maxBots.
 *
 * `totalBots` defaults to what the fleet currently holds (sum of leases), so
 * the column stays meaningful without an extra Redis read; the admin API
 * passes the pollable count, which is the number actually being divided.
 *
 * Exported and pure so the admin UI's expectations are unit-testable.
 */
export function annotateTargetShares(
  nodes: FleetNodeView[],
  totalBots?: number,
): void {
  const active = nodes.filter((n) => n.online && !n.fenced);
  for (const n of nodes) n.targetShare = null;
  if (!active.length) return;

  const total = Math.max(
    0,
    Number.isFinite(totalBots as number) && (totalBots as number) >= 0
      ? Math.floor(totalBots as number)
      : active.reduce((a, n) => a + Number(n.leasedCount || 0), 0),
  );
  // Same planner the workers run, so the column is what they actually aim for.
  const targets = computeWeightedTargets(
    active.map((n) => ({ id: n.id, weight: n.weight, maxBots: n.maxBots })),
    total,
  );
  for (const n of active) n.targetShare = targets[n.id] ?? 0;
}

export async function markBotPollable(
  db: RedisStore,
  botId: string,
): Promise<void> {
  await db.redis.sadd(K.botsPollable, botId);
  await db.redis.del(K.botPaused(botId));
}

export async function unmarkBotPollable(
  db: RedisStore,
  botId: string,
): Promise<void> {
  await db.redis.srem(K.botsPollable, botId);
}

/** Admin "stop worker" without deactivating the bot account. */
export async function pauseBotPolling(
  db: RedisStore,
  botId: string,
): Promise<void> {
  await db.redis.set(K.botPaused(botId), "1");
  await db.redis.srem(K.botsPollable, botId);
  await forceReleaseBotLease(db, botId);
}

export async function resumeBotPolling(
  db: RedisStore,
  botId: string,
): Promise<void> {
  // unpause + mark pollable in one round trip; forceReleaseBotLease also has
  // to clean the previous owner's workerBots set, so it stays a separate call
  await Promise.all([
    db.redis.pipeline().del(K.botPaused(botId)).sadd(K.botsPollable, botId).exec(),
    forceReleaseBotLease(db, botId),
  ]);
  await publishWorkerWake(db, botId);
}

export async function isBotPollingPaused(
  db: RedisStore,
  botId: string,
): Promise<boolean> {
  return (await db.redis.exists(K.botPaused(botId))) === 1;
}

export async function listPollableBotIds(db: RedisStore): Promise<string[]> {
  return (await db.redis.smembers(K.botsPollable)) as string[];
}

export async function getBotLeaseOwner(
  db: RedisStore,
  botId: string,
): Promise<string | null> {
  return (await db.redis.get(K.botLease(botId))) as string | null;
}

/** Map botId → workerId for all currently leased bots. */
export async function listLeasedBots(
  db: RedisStore,
): Promise<Record<string, string>> {
  const workerIds = (await db.redis.smembers(K.workersReg)) as string[];
  if (!workerIds.length) return {};
  const lists = await db.smembersMany(
    workerIds.map((id) => K.workerBots(id)),
  );
  const out: Record<string, string> = {};
  workerIds.forEach((wid, i) => {
    for (const botId of lists[i] ?? []) {
      out[botId] = wid;
    }
  });
  return out;
}

export async function listLeasedBotIds(db: RedisStore): Promise<string[]> {
  return Object.keys(await listLeasedBots(db));
}

export async function listWorkerMetas(db: RedisStore): Promise<WorkerMeta[]> {
  const ids = (await db.redis.smembers(K.workersReg)) as string[];
  if (!ids.length) return [];
  const rows = await db.mgetJson<WorkerMeta>(
    ids.map((id) => K.workerMeta(id)),
  );
  return rows.filter((m): m is WorkerMeta => Boolean(m));
}

/**
 * Try to claim up to `slots` pollable bots for this worker (SET NX + EX).
 * Uses pipelines so hundreds of bots are a few RTTs (critical on Upstash).
 * Returns newly claimed bot ids (not ones already owned).
 */
export async function claimBotLeases(
  db: RedisStore,
  workerId: string,
  slots: number,
  ttlSec: number,
): Promise<string[]> {
  if (slots <= 0) return [];
  const pollable = (await db.redis.smembers(K.botsPollable)) as string[];
  if (!pollable.length) return [];

  // Mild shuffle so multiple workers don't always race the same prefix
  for (let i = pollable.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const t = pollable[i]!;
    pollable[i] = pollable[j]!;
    pollable[j] = t;
  }

  const claimed: string[] = [];
  const batchSize = 80;
  let offset = 0;
  while (claimed.length < slots && offset < pollable.length) {
    const need = slots - claimed.length;
    // Over-fetch a bit: some SET NX will miss (already leased)
    const take = Math.min(batchSize, Math.max(need, Math.min(need * 2, batchSize)));
    const batch = pollable.slice(offset, offset + take);
    offset += batch.length;
    if (!batch.length) break;

    const pipe = db.redis.pipeline();
    for (const botId of batch) {
      pipe.set(K.botLease(botId), workerId, "EX", ttlSec, "NX");
    }
    const res = await pipe.exec();
    const got: string[] = [];
    batch.forEach((botId, i) => {
      const row = res?.[i];
      // ioredis: [err, result]; SET NX → "OK" | null
      if (row && !row[0] && row[1] === "OK") got.push(botId);
    });
    if (got.length) {
      const keep = got.slice(0, slots - claimed.length);
      if (keep.length) {
        await db.redis.sadd(K.workerBots(workerId), ...keep);
        claimed.push(...keep);
      }
      // Released extras we won but don't need (capacity)
      const extra = got.slice(keep.length);
      if (extra.length) {
        await releaseOwnedLeasesBatch(db, workerId, extra);
      }
    }
  }
  return claimed;
}

// The ownership check and mutation must execute together. A GET followed by
// SET/DEL (even in pipelines) lets a delayed old node overwrite or delete a
// successor's lease after expiry/rebalance. EXPIRE also cannot resurrect an
// expired lease. These scripts run on the same shared Redis as the bot data.
const RENEW_BOT_LEASE = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('EXPIRE', KEYS[1], ARGV[3])
end
redis.call('SREM', KEYS[2], ARGV[2])
return 0
`;

const RELEASE_BOT_LEASE = `
redis.call('SREM', KEYS[2], ARGV[2])
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
end
return 0
`;

/** Do not report a Redis command error or missing reply as a successful write. */
function leaseResults(
  rows: Array<[Error | null, unknown]> | null,
  count: number,
): boolean[] {
  if (!rows || rows.length !== count) {
    throw new Error("Incomplete bot lease results");
  }
  return rows.map(([error, value]) => {
    if (error) throw error;
    if (value !== 0 && value !== 1) throw new Error("Invalid bot lease result");
    return value === 1;
  });
}

/** Renew leases we still own; drop local ownership if stolen/expired. */
export async function renewOwnedLeases(
  db: RedisStore,
  workerId: string,
  botIds: string[],
  ttlSec: number,
): Promise<{ renewed: string[]; lost: string[] }> {
  const renewed: string[] = [];
  const lost: string[] = [];
  if (!botIds.length) return { renewed, lost };

  const pipe = db.redis.pipeline();
  for (const botId of botIds) {
    pipe.eval(
      RENEW_BOT_LEASE,
      2,
      K.botLease(botId),
      K.workerBots(workerId),
      workerId,
      botId,
      ttlSec,
    );
  }
  const results = leaseResults(await pipe.exec(), botIds.length);
  botIds.forEach((botId, i) => (results[i] ? renewed : lost).push(botId));
  return { renewed, lost };
}

/**
 * Rebuild `wa:bots:pollable` for active bots that have credentials and are not paused.
 * Few RTTs even for hundreds of bots (MGET/pipeline EXISTS + SADD).
 */
export async function rebuildPollableSet(
  db: RedisStore,
  bots: Array<{ id: string; status: string }>,
  hasToken: (botId: string) => boolean,
  pausedFlags: boolean[],
): Promise<number> {
  const toMark: string[] = [];
  bots.forEach((b, i) => {
    if (b.status !== "active") return;
    if (!hasToken(b.id)) return;
    if (pausedFlags[i]) return;
    toMark.push(b.id);
  });
  if (!toMark.length) return 0;
  // SADD accepts multiple members; chunk for very large fleets
  const chunk = 500;
  for (let i = 0; i < toMark.length; i += chunk) {
    const part = toMark.slice(i, i + chunk);
    await db.redis.sadd(K.botsPollable, ...part);
  }
  return toMark.length;
}

export async function releaseBotLease(
  db: RedisStore,
  workerId: string,
  botId: string,
): Promise<void> {
  await db.redis.eval(
    RELEASE_BOT_LEASE,
    2,
    K.botLease(botId),
    K.workerBots(workerId),
    workerId,
    botId,
  );
}

/**
 * Batch-release leases we still own (rebalance shed).
 * Only deletes lease keys when current owner == workerId.
 * Returns bot ids successfully released.
 */
export async function releaseOwnedLeasesBatch(
  db: RedisStore,
  workerId: string,
  botIds: string[],
): Promise<string[]> {
  if (!botIds.length) return [];
  const pipe = db.redis.pipeline();
  for (const botId of botIds) {
    pipe.eval(
      RELEASE_BOT_LEASE,
      2,
      K.botLease(botId),
      K.workerBots(workerId),
      workerId,
      botId,
    );
  }
  const results = leaseResults(await pipe.exec(), botIds.length);
  return botIds.filter((_, i) => results[i]);
}

/**
 * How many bots this worker should shed for the configured fleet distribution.
 * Uses heartbeat botCount of online peers + localCount (more accurate for self).
 *
 * Weights (percent, 100 = default) scale each node's fair share. With every
 * node at the default this is exactly the old even split, so untuned fleets
 * keep their previous behavior.
 */
export function computeWeightedShedCount(opts: {
  localCount: number;
  /** This node's admin weight percent (default 100) */
  localWeight?: number;
  /** Online peers: leased count + their weight percent */
  peers: Array<{ count: number; weight?: number }>;
  /** Tolerate this much above fair share before shedding */
  slack?: number;
  /** Cap releases in one tick */
  maxPerTick?: number;
}): number {
  const maxPerTick = Math.max(1, opts.maxPerTick ?? 50);
  const peers = opts.peers.filter(
    (p) => Number.isFinite(p.count) && p.count >= 0,
  );
  const n = 1 + peers.length;
  if (n < 2) return 0;
  const total = opts.localCount + peers.reduce((a, p) => a + p.count, 0);
  if (total <= 0) return 0;

  const localWeight = normalizeWorkerWeight(
    opts.localWeight ?? DEFAULT_WORKER_WEIGHT,
  );
  const totalWeight =
    localWeight +
    peers.reduce(
      (a, p) => a + normalizeWorkerWeight(p.weight ?? DEFAULT_WORKER_WEIGHT),
      0,
    );

  const fair = weightedShare(total, localWeight, totalWeight, n);
  return shedAboveTarget({
    localCount: opts.localCount,
    target: fair,
    // A drained node (0%) must reach zero: the usual slack would pin it above.
    slack: totalWeight > 0 && localWeight === 0 ? 0 : opts.slack,
    maxPerTick,
  });
}

/**
 * Releases needed to bring `localCount` down to `target + slack`.
 * The single place claim and shed agree on: a node claims up to the same
 * `target + slack` it sheds back to, so neither fights the other.
 */
export function shedAboveTarget(opts: {
  localCount: number;
  target: number;
  slack?: number;
  maxPerTick?: number;
}): number {
  const slack = Math.max(0, opts.slack ?? 2);
  const maxPerTick = Math.max(1, opts.maxPerTick ?? 50);
  const targetMax = Math.max(0, opts.target) + slack;
  if (opts.localCount <= targetMax) return 0;
  return Math.min(opts.localCount - targetMax, maxPerTick);
}

/** Upper bound on what a node may hold: its planned target plus slack. */
export function claimCapForTarget(target: number, slack?: number): number {
  return Math.max(0, target) + Math.max(0, slack ?? 2);
}

/**
 * Even-split shed count (no weights) — thin wrapper kept for callers and
 * tests that predate per-node load weights.
 */
export function computeRebalanceShedCount(opts: {
  localCount: number;
  peerCounts: number[];
  slack?: number;
  maxPerTick?: number;
}): number {
  return computeWeightedShedCount({
    localCount: opts.localCount,
    peers: opts.peerCounts.map((count) => ({ count })),
    slack: opts.slack,
    maxPerTick: opts.maxPerTick,
  });
}

/** What one node should be holding, and how far it may overshoot. */
export interface NodeLoadPlan {
  /** Bots this node should hold under the current weights */
  target: number;
  /** Hard ceiling for claiming this tick (`target + slack`) */
  claimCap: number;
  /** Slack actually applied — 0 for a drained node, which must reach zero */
  slack: number;
  /** True when this node is at 0% while some peer still takes work */
  drained: boolean;
  /** Bots no online node has capacity for (fleet over-subscribed) */
  unplaceable: number;
}

/**
 * Single source of truth for one node's claim ceiling and shed floor.
 *
 * Both come from the same `computeWeightedTargets` plan, so a node never
 * claims a bot it will shed on the next tick.
 */
export function planNodeLoad(opts: {
  selfId: string;
  /** Online, unfenced nodes including self */
  nodes: WeightedTargetNode[];
  /** Bots that want polling fleet-wide */
  total: number;
  slack?: number;
}): NodeLoadPlan {
  const total = Math.max(0, Math.floor(opts.total));
  const targets = computeWeightedTargets(opts.nodes, total);
  const target = targets[opts.selfId] ?? 0;

  const selfWeight = normalizeWorkerWeight(
    opts.nodes.find((n) => n.id === opts.selfId)?.weight ??
      DEFAULT_WORKER_WEIGHT,
  );
  const totalWeight = opts.nodes.reduce(
    (a, n) => a + normalizeWorkerWeight(n.weight ?? DEFAULT_WORKER_WEIGHT),
    0,
  );
  // Only a real drain: at 0% while the fleet still has somewhere to put work.
  const drained = selfWeight === 0 && totalWeight > 0;
  const slack = drained ? 0 : Math.max(0, opts.slack ?? 2);

  const placed = Object.values(targets).reduce((a, v) => a + v, 0);
  return {
    target,
    claimCap: claimCapForTarget(target, slack),
    slack,
    drained,
    unplaceable: Math.max(0, total - placed),
  };
}

/** Drop lease regardless of owner (pause / rebind / admin restart). */
export async function forceReleaseBotLease(
  db: RedisStore,
  botId: string,
): Promise<void> {
  const owner = await db.redis.get(K.botLease(botId));
  const pipe = db.redis.pipeline();
  pipe.del(K.botLease(botId));
  if (owner) pipe.srem(K.workerBots(owner), botId);
  await pipe.exec();
}

export async function registerWorker(
  db: RedisStore,
  meta: WorkerMeta,
  ttlSec: number,
): Promise<void> {
  // Runs on every heartbeat (~15s per node). SADD stays idempotent-but-present:
  // reapDeadWorkers / forceOfflineWorker SREM us from another process, so we
  // must keep re-asserting membership rather than doing it once at boot.
  await db.redis
    .pipeline()
    .sadd(K.workersReg, meta.id)
    .set(K.workerMeta(meta.id), JSON.stringify(meta), "EX", Math.max(1, ttlSec))
    .exec();
}

export async function unregisterWorker(
  db: RedisStore,
  workerId: string,
): Promise<void> {
  const bots = (await db.redis.smembers(K.workerBots(workerId))) as string[];
  if (bots.length) {
    await releaseOwnedLeasesBatch(db, workerId, bots);
  }
  await db.redis
    .pipeline()
    .del(K.workerBots(workerId), K.workerMeta(workerId))
    .srem(K.workersReg, workerId)
    .exec();
}

export interface WorkerFence {
  workerId: string;
  reason: string;
  byUserId: string | null;
  byUsername: string | null;
  createdAt: string;
}

export async function getWorkerFence(
  db: RedisStore,
  workerId: string,
): Promise<WorkerFence | null> {
  return db.getJson<WorkerFence>(K.workerFence(workerId));
}

export async function isWorkerFenced(
  db: RedisStore,
  workerId: string,
): Promise<boolean> {
  return (await db.redis.exists(K.workerFence(workerId))) === 1;
}

export async function setWorkerFence(
  db: RedisStore,
  fence: WorkerFence,
  ttlSec: number = WORKER_STALE_SEC,
): Promise<void> {
  // TTL so ghost force-offline rows auto-expire (same window as heartbeat stale).
  // Admin can still clear early via clear-fence. Process rejoins after expiry.
  const ttl = Math.max(15, ttlSec);
  await db.setJson(K.workerFence(fence.workerId), fence, ttl);
  await db.redis.sadd(K.workersFenced, fence.workerId);
}

/**
 * Drop force-offline fences older than staleSec when the worker is no longer
 * registered (no heartbeat meta). Returns how many fences were cleared.
 */
export async function purgeStaleWorkerFences(
  db: RedisStore,
  staleSec: number = WORKER_STALE_SEC,
): Promise<number> {
  const fences = await listWorkerFences(db);
  if (!fences.length) return 0;
  const reg = new Set(
    (await db.redis.smembers(K.workersReg)) as string[],
  );
  const now = Date.now();
  const maxAgeMs = Math.max(15, staleSec) * 1000;
  let cleared = 0;
  for (const fence of fences) {
    if (reg.has(fence.workerId)) continue;
    const t = Date.parse(fence.createdAt);
    const age = Number.isFinite(t) ? now - t : maxAgeMs + 1;
    if (age <= maxAgeMs) continue;
    if (await clearWorkerFence(db, fence.workerId)) cleared++;
  }
  return cleared;
}

export async function clearWorkerFence(
  db: RedisStore,
  workerId: string,
): Promise<boolean> {
  const existed = (await db.redis.exists(K.workerFence(workerId))) === 1;
  await db.del(K.workerFence(workerId));
  await db.redis.srem(K.workersFenced, workerId);
  return existed;
}

export async function listFencedWorkerIds(db: RedisStore): Promise<string[]> {
  return (await db.redis.smembers(K.workersFenced)) as string[];
}

export async function listWorkerFences(
  db: RedisStore,
): Promise<WorkerFence[]> {
  const ids = await listFencedWorkerIds(db);
  if (!ids.length) return [];
  const rows = await db.mgetJson<WorkerFence>(
    ids.map((id) => K.workerFence(id)),
  );
  const out: WorkerFence[] = [];
  ids.forEach((id, i) => {
    const row = rows[i];
    if (row) out.push(row);
    else {
      // index orphan
      void db.redis.srem(K.workersFenced, id);
    }
  });
  return out;
}

/**
 * Force a fleet node offline:
 * 1) write fence so the process will not re-claim / re-register
 * 2) release all its bot leases
 * 3) remove from workers registry
 * 4) wake peers to claim
 */
export async function forceOfflineWorker(
  db: RedisStore,
  workerId: string,
  opts?: {
    reason?: string;
    byUserId?: string | null;
    byUsername?: string | null;
  },
): Promise<{ released: number; fence: WorkerFence }> {
  const id = workerId.trim();
  if (!id) throw new Error("workerId required");

  const fence: WorkerFence = {
    workerId: id,
    reason: (opts?.reason || "admin force offline").slice(0, 200),
    byUserId: opts?.byUserId ?? null,
    byUsername: opts?.byUsername ?? null,
    createdAt: nowIso(),
  };
  await setWorkerFence(db, fence);

  const bots = (await db.redis.smembers(K.workerBots(id))) as string[];
  let released = 0;
  if (bots.length) {
    const ok = await releaseOwnedLeasesBatch(db, id, bots);
    released = ok.length;
  }
  // Drop any leftover ownership keys even if lease already gone
  await db.redis.del(K.workerBots(id), K.workerMeta(id));
  await db.redis.srem(K.workersReg, id);
  await publishWorkerWake(db);
  return { released, fence };
}

export async function listWorkerOwnedBots(
  db: RedisStore,
  workerId: string,
): Promise<string[]> {
  return (await db.redis.smembers(K.workerBots(workerId))) as string[];
}

export async function publishWorkerWake(
  db: RedisStore,
  botId?: string,
): Promise<void> {
  const payload = JSON.stringify({
    botId: botId ?? null,
    at: nowIso(),
  });
  try {
    await db.redis.publish(K.workerWake, payload);
  } catch {
    /* pub/sub optional on some Redis setups */
  }
}

export async function enqueueInbound(
  db: RedisStore,
  job: InboundJob,
  maxLen = 50_000,
): Promise<boolean> {
  const len = await db.redis.llen(K.inbox);
  if (len >= maxLen) return false;
  await db.redis.rpush(K.inbox, JSON.stringify(job));
  return true;
}

/**
 * Blocking pop one job. Returns null on timeout.
 * Uses a dedicated connection when provided (BLPOP blocks the client).
 */
export async function dequeueInbound(
  redis: { blpop: (...args: [string, number]) => Promise<[string, string] | null> },
  timeoutSec: number,
): Promise<InboundJob | null> {
  const res = await redis.blpop(K.inbox, timeoutSec);
  if (!res) return null;
  const raw = res[1];
  try {
    return JSON.parse(raw) as InboundJob;
  } catch {
    return null;
  }
}

export async function requeueInbound(
  db: RedisStore,
  job: InboundJob,
): Promise<void> {
  await db.redis.lpush(K.inbox, JSON.stringify(job));
}

export async function inboxDepth(db: RedisStore): Promise<number> {
  return db.redis.llen(K.inbox);
}
