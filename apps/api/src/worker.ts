import { createHash, randomUUID } from "node:crypto";
import { hostname as osHostname } from "node:os";
import {
  extractMediaRefs,
  extractText,
  ILinkClient,
  ILinkError,
  isUserInbound,
  isVisionMime,
  mediaKindLabel,
  type InboundMediaRef,
  type WeixinMessage,
} from "@wechat-ai/ilink";
import {
  type Db,
  type InboundJob,
  type InboundClaim,
  persistInbound,
  claimInbound,
  acknowledgeInbound,
  retryInbound,
  inboundQueueStats,
  K,
  claimBotLeases,
  getBotAccount,
  getBotCredentials,
  getContextToken,
  getStickerBlob,
  userCanUseStickerSlug,
  hasBotCredentialsMany,
  listBotAccounts,
  listLeasedBotIds,
  listPollableBotIds,
  listFleetNodes,
  listWorkerMetas,
  type FleetNodeView,
  computeWeightedShedCount,
  planNodeLoad,
  shedAboveTarget,
  type NodeLoadPlan,
  listWorkerWeights,
  gcWorkerWeights,
  normalizeWorkerWeight,
  hasWorkerWeightOverrides,
  DEFAULT_WORKER_WEIGHT,
  DEFAULT_WORKER_WEIGHT_TTL_SEC,
  type WorkerWeight,
  type WorkerMeta,
  isWorkerFenced,
  pauseBotPolling,
  publishWorkerWake,
  purgeStaleWorkerFences,
  rebuildPollableSet,
  registerWorker,
  releaseBotLease,
  releaseOwnedLeasesBatch,
  renewOwnedLeases,
  resumeBotPolling,
  setBotCursor,
  setWorkerUpdateStatus,
  getWorkerUpdateStatus,
  clearWorkerUpdateJob,
  unregisterWorker,
  upsertContextToken,
  WORKER_STALE_SEC,
} from "@wechat-ai/db";
import { tryApplyOtaUpdate } from "./ota-apply.js";
import {
  hasStickerTextToken,
  humanDelayMs,
  P2PService,
  sanitizePartsStripStickerJson,
  stripAllStickerJson,
  type ChatService,
  type HumanDelayOptions,
  type P2PServiceOptions,
  type PromptAttachment,
  type ReplyPart,
} from "@wechat-ai/core";
import {
  planInboundMedia,
  unreadableMediaReply,
} from "./inbound-media.js";
import { RateLimiter } from "./rate-limit.js";
import {
  ProactiveScheduler,
  type ProactiveSchedulerOptions,
} from "./proactive-scheduler.js";
import {
  BroadcastRunner,
  type AdminSendResult,
} from "./broadcast-runner.js";
import { emitActivity, previewText } from "./activity-stream.js";
import { InboundDelivery } from "./inbound-delivery.js";

/**
 * How often a node sweeps the load-weight hash (refresh live entries, delete
 * vanished ones). Slow on purpose: expiry is measured in hours, and every node
 * runs the same idempotent sweep.
 */
const WEIGHT_GC_INTERVAL_MS = 5 * 60_000;

function streamMessagePayload(
  text: string,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  const short = previewText(text, 48);
  const long = previewText(text, 2000);
  return {
    ...extra,
    preview: short.preview,
    fullText: long.preview,
    len: short.len,
    truncated: short.truncated,
  };
}

export interface ProactiveWorkerConfig {
  globalEnabled: boolean;
  defaultIdleHours: number;
  defaultMinIntervalHours: number;
  defaultMaxPerDay: number;
  defaultQuietHours: string;
  scanIntervalSec: number;
  maxPerScan: number;
  lockTtlSec: number;
  attemptCooldownHours: number;
}

export interface BroadcastWorkerConfig {
  /** Delay between outbound broadcast messages (ms) */
  intervalMs: number;
  pollIntervalMs?: number;
  lockTtlSec?: number;
}

/**
 * Inbound job plus the attachment coordinates for this message.
 *
 * Media coordinates contain CDN credentials. The durable Redis inbox has the
 * same trust boundary as bot credentials; never expose payloads via status APIs.
 */
type LocalInboundJob = InboundJob & {
  mediaRefs?: InboundMediaRef[];
};

export interface WorkerOptions {
  db: Db;
  chat: ChatService;
  peerRatePerMinute?: number;
  /** Cap concurrent long-poll loops in this process */
  maxBotsPerWorker?: number;
  /** Lease TTL / renew interval (multi-replica safe) */
  leaseTtlSec?: number;
  leaseRenewSec?: number;
  /** Shed excess leases so idle fleet nodes can claim (default on) */
  rebalanceEnabled?: boolean;
  rebalanceIntervalSec?: number;
  rebalanceSlack?: number;
  rebalanceMaxPerTick?: number;
  /** Seconds an admin load weight outlives its node before auto-delete */
  workerWeightTtlSec?: number;
  /** Concurrent reply consumers (LLM + send) */
  replyConcurrency?: number;
  /** Max retained inbound jobs per bot, including failed jobs */
  inboxMaxLen?: number;
  /** multi-bubble human-like reply */
  splitReply?: boolean;
  maxReplyChunks?: number;
  maxChunkChars?: number;
  /** typing delay tuning */
  replyDelay?: HumanDelayOptions;
  /** Allow outbound stickers/images (default true) */
  stickerSendEnabled?: boolean;
  /** Hard cap on stickers actually sent per reply (default 2) */
  maxStickersPerReply?: number;
  /**
   * Inbound image understanding. Off by default because the configured model
   * may reject image content parts outright.
   */
  visionEnabled?: boolean;
  visionMaxImages?: number;
  /** Cap per downloaded attachment, before base64 inflation */
  inboundMediaMaxBytes?: number;
  /**
   * Use WeChat's own speech-to-text for voice messages (default true).
   * Off means a voice note is answered as unreadable media.
   */
  voiceTranscriptEnabled?: boolean;
  /** Idle-based proactive outreach */
  proactive?: ProactiveWorkerConfig;
  /** Admin text broadcast jobs */
  broadcast?: BroadcastWorkerConfig;
  /** User-to-user relay via @LINUX DO username */
  p2pEnabled?: boolean;
  p2p?: Partial<P2PServiceOptions>;
  /** Optional fleet labels (NODE_LABEL / NODE_REGION / version) */
  nodeLabel?: string;
  nodeRegion?: string;
  appVersion?: string;
  /** Monorepo root for OTA file apply */
  repoRoot?: string;
  otaEnabled?: boolean;
  otaAllowInstall?: boolean;
  otaStagingDir?: string;
  log?: (msg: string, extra?: unknown) => void;
}

/** Ops snapshot for admin dashboard / system. */
export interface WorkerRuntimeStats {
  workerId: string;
  startedAt: string;
  running: boolean;
  /** Bots this process is long-polling */
  leasedLocal: number;
  /** Fleet-wide leased bots (falls back to local) */
  leasedFleet: number;
  /** Bots that should be polled (active + token + not paused) */
  pollable: number;
  maxBots: number;
  atCapacity: boolean;
  inboxDepth: number;
  inboxFailed: number;
  inboxMaxLen: number;
  inboxPeak: number;
  inboxDropped: number;
  jobsProcessed: number;
  jobsFailed: number;
  replyConcurrency: number;
  /** In-flight peer reply chains */
  peerChainsActive: number;
  clients: number;
  leaseTtlSec: number;
  leaseRenewSec: number;
  capacityHits: number;
  lastAtCapacityAt: string | null;
  lastInboxDropAt: string | null;
  /** Last worker.start() / reconcile error (if any) */
  startError: string | null;
  /** Stats scope: local process vs fleet aggregate */
  scope?: "local" | "fleet";
  /** Online deployment nodes counted into fleet aggregate */
  nodesOnline?: number;
  nodesTotal?: number;
}

/**
 * Single-process worker: API can share this process (one Docker image).
 *
 * - Redis lease: at most `maxBotsPerWorker` bots polled here; optional
 *   multi-replica of the same image shards bots without double-poll.
 * - Poll loops only getUpdates + enqueue; reply consumers do LLM/send
 *   so slow AI does not stall long-poll.
 */
export class BotWorkerManager {
  private stopped = false;
  private readonly workerId: string;
  // Admin-editable at runtime (see applyRuntimeConfig). Every one of these is
  // read per-call, so plain assignment is enough — except leaseRenewSec, which
  // also sizes the reconcile setInterval and re-arms it.
  private maxBots: number;
  private leaseTtlSec: number;
  private leaseRenewSec: number;
  private rebalanceEnabled: boolean;
  private rebalanceIntervalSec: number;
  private rebalanceSlack: number;
  private rebalanceMaxPerTick: number;
  /** Restart-only: the consumer pool is sized once in start() and cannot shrink. */
  private readonly replyConcurrency: number;
  private inboxMaxLen: number;
  private readonly startedAt: string;
  private lastRebalanceAt = 0;
  /** Admin fence: do not claim/renew/register until cleared */
  private fenced = false;
  private lastFenceLogAt = 0;
  /**
   * Admin load weight for this node (percent, 100 = default share).
   * Cached: refreshed on the rebalance cadence and invalidated by the wake
   * channel, so an admin change lands within a tick without an HGET per tick.
   */
  private weight = DEFAULT_WORKER_WEIGHT;
  private weightFetchedAt = 0;
  /** True while any node in the fleet carries a non-default weight */
  private fleetWeighted = false;
  private weightSnapshot: Record<string, WorkerWeight> = {};
  private lastWeightLogged = DEFAULT_WORKER_WEIGHT;
  private lastUnplaceableLogAt = 0;
  /** Seconds a weight survives its node's last heartbeat before auto-delete */
  private weightTtlSec: number;
  private lastWeightGcAt = 0;
  /**
   * Last load plan computed by reconcileLeases. Reused by the login/restart
   * claim path, which must not bulk-claim past this node's weighted share.
   * At most one lease tick stale, and reconcile corrects any drift.
   */
  private lastPlan: NodeLoadPlan | null = null;

  private loops = new Map<string, Promise<void>>();
  /** Bumped on stop/rebind so stale loops exit even if Map key was reused. */
  private loopGen = new Map<string, number>();
  private peerLimiter: RateLimiter;

  private claimingInbox = false;
  private inboxScanAfter = 0;
  private inboxBotOffset = 0;
  /** Serialize replies per bot:peer so bubbles stay ordered. */
  private peerChains = new Map<string, Promise<void>>();

  private leaseTimer: ReturnType<typeof setInterval> | null = null;
  private replyWorkers: Promise<void>[] = [];
  private clients = new Map<string, ILinkClient>();
  /** True once start() has begun (even while first reconcile is in flight). */
  private runtimeActive = false;
  private startError: string | null = null;
  private proactive: ProactiveScheduler | null = null;
  private broadcast: BroadcastRunner | null = null;
  /** Dedicated Redis connection for SUBSCRIBE (cannot share with command client). */
  private wakeSub: ReturnType<Db["redis"]["duplicate"]> | null = null;
  private wakeDebounce: ReturnType<typeof setTimeout> | null = null;

  /** Counters for admin observability */
  private inboxDropped = 0;
  private jobsProcessed = 0;
  private jobsFailed = 0;
  private capacityHits = 0;
  private inboxPeak = 0;
  private lastAtCapacityAt: string | null = null;
  private lastInboxDropAt: string | null = null;
  private lastCapacityLogAt = 0;
  private p2p: P2PService | null = null;
  private p2pEnabled: boolean;
  /** Prevent concurrent OTA apply on the same process */
  private otaInFlight = false;

  constructor(private opts: WorkerOptions) {
    this.workerId =
      process.env.WORKER_ID?.trim() ||
      `w_${osHostname().slice(0, 24)}_${process.pid}_${randomUUID().slice(0, 8)}`;
    this.maxBots = Math.max(1, opts.maxBotsPerWorker ?? 500);
    this.leaseTtlSec = Math.max(15, opts.leaseTtlSec ?? 45);
    this.leaseRenewSec = Math.max(5, opts.leaseRenewSec ?? 15);
    this.rebalanceEnabled = opts.rebalanceEnabled !== false;
    this.rebalanceIntervalSec = Math.max(15, opts.rebalanceIntervalSec ?? 60);
    this.rebalanceSlack = Math.max(0, opts.rebalanceSlack ?? 2);
    this.rebalanceMaxPerTick = Math.max(1, opts.rebalanceMaxPerTick ?? 50);
    this.weightTtlSec = Math.max(
      60,
      opts.workerWeightTtlSec ?? DEFAULT_WORKER_WEIGHT_TTL_SEC,
    );
    this.replyConcurrency = Math.max(1, opts.replyConcurrency ?? 16);
    this.inboxMaxLen = Math.max(100, opts.inboxMaxLen ?? 20_000);
    this.startedAt = new Date().toISOString();
    this.peerLimiter = new RateLimiter(opts.peerRatePerMinute ?? 20, 60_000);
    this.p2pEnabled = opts.p2pEnabled !== false;
    if (this.p2pEnabled) {
      this.p2p = new P2PService(opts.db, opts.p2p ?? {});
    }
  }

  getWorkerId(): string {
    return this.workerId;
  }

  /**
   * Apply admin-editable settings in place (runtime settings reload).
   *
   * The clamps mirror the constructor's — a settings write must not be able to
   * install a value the constructor would have rejected (e.g. leaseRenewSec=0
   * spinning the event loop).
   *
   * Not covered here, by design: `replyConcurrency` (the consumer pool is
   * sized once in start() and has no per-consumer cancellation, so shrinking
   * it needs a restart) and `workerEnabled` (start() runs once at boot).
   */
  /**
   * Worker-side hard cap on stickers per reply. Kept in sync with the
   * ChatService budget — a literal here would silently defeat the panel.
   */
  private maxStickersPerReply(): number {
    return Math.max(0, this.opts.maxStickersPerReply ?? 2);
  }

  applyRuntimeConfig(patch: {
    stickerSendEnabled?: boolean;
    maxStickersPerReply?: number;
    visionEnabled?: boolean;
    visionMaxImages?: number;
    inboundMediaMaxBytes?: number;
    voiceTranscriptEnabled?: boolean;
    splitReply?: boolean;
    replyDelay?: HumanDelayOptions;
    peerRatePerMinute?: number;
    maxBotsPerWorker?: number;
    leaseTtlSec?: number;
    leaseRenewSec?: number;
    rebalanceEnabled?: boolean;
    rebalanceIntervalSec?: number;
    rebalanceSlack?: number;
    rebalanceMaxPerTick?: number;
    workerWeightTtlSec?: number;
    inboxMaxLen?: number;
    proactive?: ProactiveWorkerConfig;
    broadcast?: BroadcastWorkerConfig;
    p2pEnabled?: boolean;
    p2p?: Partial<P2PServiceOptions>;
    nodeLabel?: string;
    nodeRegion?: string;
    otaEnabled?: boolean;
    otaAllowInstall?: boolean;
    otaStagingDir?: string;
  }): void {
    // Read lazily off this.opts on every use — plain assignment is enough.
    if (patch.stickerSendEnabled !== undefined) {
      this.opts.stickerSendEnabled = patch.stickerSendEnabled;
    }
    if (patch.maxStickersPerReply !== undefined) {
      this.opts.maxStickersPerReply = patch.maxStickersPerReply;
    }
    if (patch.visionEnabled !== undefined) {
      this.opts.visionEnabled = patch.visionEnabled;
    }
    if (patch.visionMaxImages !== undefined) {
      this.opts.visionMaxImages = Math.max(1, patch.visionMaxImages);
    }
    if (patch.inboundMediaMaxBytes !== undefined) {
      this.opts.inboundMediaMaxBytes = Math.max(
        64 * 1024,
        patch.inboundMediaMaxBytes,
      );
    }
    if (patch.voiceTranscriptEnabled !== undefined) {
      this.opts.voiceTranscriptEnabled = patch.voiceTranscriptEnabled;
    }
    if (patch.splitReply !== undefined) this.opts.splitReply = patch.splitReply;
    if (patch.replyDelay !== undefined) this.opts.replyDelay = patch.replyDelay;
    if (patch.nodeLabel !== undefined) this.opts.nodeLabel = patch.nodeLabel;
    if (patch.nodeRegion !== undefined) this.opts.nodeRegion = patch.nodeRegion;
    if (patch.otaEnabled !== undefined) this.opts.otaEnabled = patch.otaEnabled;
    if (patch.otaAllowInstall !== undefined) {
      this.opts.otaAllowInstall = patch.otaAllowInstall;
    }
    if (patch.otaStagingDir !== undefined) {
      this.opts.otaStagingDir = patch.otaStagingDir;
    }

    if (patch.peerRatePerMinute !== undefined) {
      this.peerLimiter.setLimits(patch.peerRatePerMinute, 60_000);
    }
    if (patch.maxBotsPerWorker !== undefined) {
      this.maxBots = Math.max(1, patch.maxBotsPerWorker);
    }
    if (patch.leaseTtlSec !== undefined) {
      this.leaseTtlSec = Math.max(15, patch.leaseTtlSec);
    }
    if (patch.rebalanceEnabled !== undefined) {
      this.rebalanceEnabled = patch.rebalanceEnabled;
    }
    if (patch.rebalanceIntervalSec !== undefined) {
      this.rebalanceIntervalSec = Math.max(15, patch.rebalanceIntervalSec);
    }
    if (patch.rebalanceSlack !== undefined) {
      this.rebalanceSlack = Math.max(0, patch.rebalanceSlack);
    }
    if (patch.rebalanceMaxPerTick !== undefined) {
      this.rebalanceMaxPerTick = Math.max(1, patch.rebalanceMaxPerTick);
    }
    if (patch.workerWeightTtlSec !== undefined) {
      this.weightTtlSec = Math.max(60, patch.workerWeightTtlSec);
    }
    if (patch.inboxMaxLen !== undefined) {
      this.inboxMaxLen = Math.max(100, patch.inboxMaxLen);
    }

    // The reconcile timer's period is baked into setInterval — re-arm it.
    if (patch.leaseRenewSec !== undefined) {
      const next = Math.max(5, patch.leaseRenewSec);
      if (next !== this.leaseRenewSec) {
        this.leaseRenewSec = next;
        if (this.leaseTimer) {
          clearInterval(this.leaseTimer);
          this.leaseTimer = setInterval(() => {
            void this.reconcileLeases().catch((err) => {
              const msg = err instanceof Error ? err.message : String(err);
              this.startError = msg;
              this.opts.log?.(`[worker] lease reconcile error: ${msg}`);
            });
          }, this.leaseRenewSec * 1000);
        }
      }
    }

    if (patch.proactive) {
      this.opts.proactive = patch.proactive;
      if (this.proactive) {
        this.proactive.applyRuntimeOptions({
          globalEnabled: patch.proactive.globalEnabled,
          defaultIdleHours: patch.proactive.defaultIdleHours,
          defaultMinIntervalHours: patch.proactive.defaultMinIntervalHours,
          defaultMaxPerDay: patch.proactive.defaultMaxPerDay,
          defaultQuietHours: patch.proactive.defaultQuietHours,
          scanIntervalSec: patch.proactive.scanIntervalSec,
          maxPerScan: patch.proactive.maxPerScan,
          lockTtlSec: patch.proactive.lockTtlSec,
          attemptCooldownHours: patch.proactive.attemptCooldownHours,
        });
      } else if (this.runtimeActive) {
        // Booted with proactive off: the scheduler was never constructed.
        this.startProactiveScheduler();
      }
    }

    if (patch.broadcast) {
      this.opts.broadcast = patch.broadcast;
      this.broadcast?.applyRuntimeOptions(patch.broadcast);
    }

    if (patch.p2p) {
      this.opts.p2p = { ...(this.opts.p2p ?? {}), ...patch.p2p };
      this.p2p?.applyRuntimeOptions(patch.p2p);
    }
    if (patch.p2pEnabled !== undefined) {
      this.p2pEnabled = patch.p2pEnabled;
      if (this.p2pEnabled && !this.p2p) {
        // Booted with P2P off: construct on first enable.
        this.p2p = new P2PService(this.opts.db, this.opts.p2p ?? {});
      }
    }
  }

  /** Whether this process is under an admin force-offline fence. */
  isFenced(): boolean {
    return this.fenced;
  }

  /** Fleet-wide deployment nodes for admin (Redis worker metas). */
  async listFleetNodes(opts?: { totalBots?: number }): Promise<FleetNodeView[]> {
    return listFleetNodes(this.opts.db, {
      selfWorkerId: this.workerId,
      onlineWithinSec: WORKER_STALE_SEC,
      totalBots: opts?.totalBots,
    });
  }

  /**
   * Liveness only — no Redis. `/health/ready` is the highest-frequency
   * endpoint in the process and used to pull full getStats() (2 extra Redis
   * calls) just to read this boolean.
   */
  isRunning(): boolean {
    return this.runtimeActive && !this.stopped;
  }

  /**
   * Live worker metrics (leased / inbox / capacity).
   * Safe to call when worker is disabled (returns zeros + running=false).
   */
  async getStats(): Promise<WorkerRuntimeStats> {
    let pollable = 0;
    let leasedFleet = this.loops.size;
    try {
      pollable = (await listPollableBotIds(this.opts.db)).length;
    } catch {
      /* */
    }
    try {
      const fleet = await listLeasedBotIds(this.opts.db);
      if (fleet.length) leasedFleet = fleet.length;
    } catch {
      /* */
    }
    const leasedLocal = this.loops.size;
    const atCapacity =
      leasedLocal >= this.maxBots && pollable > leasedLocal;
    const inbox = await inboundQueueStats(this.opts.db, [...this.loops.keys()]);
    this.inboxPeak = Math.max(this.inboxPeak, inbox.pending);

    return {
      workerId: this.workerId,
      startedAt: this.startedAt,
      running: this.runtimeActive && !this.stopped,
      leasedLocal,
      leasedFleet,
      pollable,
      maxBots: this.maxBots,
      atCapacity,
      inboxDepth: inbox.pending,
      inboxFailed: inbox.failed,
      inboxMaxLen: this.inboxMaxLen,
      inboxPeak: this.inboxPeak,
      inboxDropped: this.inboxDropped,
      jobsProcessed: this.jobsProcessed,
      jobsFailed: this.jobsFailed,
      replyConcurrency: this.replyConcurrency,
      peerChainsActive: this.peerChains.size,
      clients: this.clients.size,
      leaseTtlSec: this.leaseTtlSec,
      leaseRenewSec: this.leaseRenewSec,
      capacityHits: this.capacityHits,
      lastAtCapacityAt: this.lastAtCapacityAt,
      lastInboxDropAt: this.lastInboxDropAt,
      startError: this.startError,
      scope: "local",
    };
  }

  /**
   * Fleet-wide stats for admin Workers page (all nodes' leases + capacity).
   * Inbox/job counters remain this process (HTTP hit node) — see scope.
   */
  async getFleetStats(): Promise<WorkerRuntimeStats> {
    const local = await this.getStats();
    let nodes: FleetNodeView[] = [];
    try {
      nodes = await this.listFleetNodes();
    } catch {
      return { ...local, scope: "fleet" };
    }
    const online = nodes.filter((n) => n.online && !n.fenced);
    const leasedFleet = online.reduce(
      (a, n) => a + Number(n.leasedCount || 0),
      0,
    );
    const maxBotsFleet = online.reduce(
      (a, n) => a + Number(n.maxBots || 0),
      0,
    );
    const anyAtCap = online.some(
      (n) => n.maxBots > 0 && n.leasedCount >= n.maxBots,
    );
    const pollable = local.pollable;
    const fleetLeased = leasedFleet || local.leasedFleet;
    const fleetMax = maxBotsFleet || local.maxBots;
    const atCapacity =
      anyAtCap || (fleetMax > 0 && fleetLeased >= fleetMax && pollable > fleetLeased);
    return {
      ...local,
      // Prefer fleet numbers for the main Leased / capacity cards
      leasedLocal: fleetLeased,
      leasedFleet: fleetLeased,
      maxBots: fleetMax,
      atCapacity,
      scope: "fleet",
      nodesOnline: online.length,
      nodesTotal: nodes.length,
      workerId: this.workerId,
    };
  }

  async start(): Promise<void> {
    this.stopped = false;
    this.runtimeActive = true;
    this.startError = null;

    // Reply consumers + lease timer first so admin shows running immediately
    for (let i = 0; i < this.replyConcurrency; i++) {
      this.replyWorkers.push(this.runReplyConsumer(i));
    }
    this.leaseTimer = setInterval(() => {
      void this.reconcileLeases().catch((err) => {
        const msg = err instanceof Error ? err.message : String(err);
        this.startError = msg;
        this.opts.log?.(`[worker] lease reconcile error: ${msg}`);
      });
    }, this.leaseRenewSec * 1000);

    this.startProactiveScheduler();
    this.startBroadcastRunner();
    this.startWakeSubscriber();

    this.opts.log?.(
      `[worker] runtime up id=${this.workerId} maxBots=${this.maxBots} ` +
        `replyConcurrency=${this.replyConcurrency} (bootstrapping pollable…)`,
    );

    try {
      const t0 = Date.now();
      // Honor fence before claiming anything on boot
      if (await this.applyFenceState()) {
        this.opts.log?.(
          `[worker] started under fence id=${this.workerId} — not claiming bots`,
        );
        return;
      }
      await this.markOtaDoneIfMatched();
      await this.reapDeadWorkers();
      await this.bootstrapPollable();
      // Before the first heartbeat, so peers never see a stale 100% for a
      // node the admin had already drained.
      await this.refreshWeightSnapshot(true);
      await this.heartbeat();
      await this.reconcileLeases();
      this.opts.log?.(
        `[worker] ready id=${this.workerId} leased=${this.loops.size}/${this.maxBots} ` +
          `in ${Date.now() - t0}ms`,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.startError = msg;
      this.opts.log?.(`[worker] start bootstrap/reconcile failed: ${msg}`);
      // Keep timer running — next tick will retry claim
    }
  }

  /** Drop lease sets for workers whose heartbeat meta expired (crash / kill -9). */
  private async reapDeadWorkers(): Promise<void> {
    const reg = (await this.opts.db.redis.smembers(K.workersReg)) as string[];
    let reaped = 0;
    for (const id of reg) {
      if (id === this.workerId) continue;
      const alive = await this.opts.db.redis.exists(K.workerMeta(id));
      if (!alive) {
        await unregisterWorker(this.opts.db, id);
        reaped++;
      }
    }
    if (reaped) {
      this.opts.log?.(
        `[worker] reaped ${reaped} dead worker registration(s)`,
      );
    }
    // Ghost force-offline rows: no heartbeat for WORKER_STALE_SEC → drop fence
    try {
      const cleared = await purgeStaleWorkerFences(
        this.opts.db,
        WORKER_STALE_SEC,
      );
      if (cleared) {
        this.opts.log?.(
          `[worker] purged ${cleared} stale force-offline fence(s)`,
        );
      }
    } catch {
      /* best effort */
    }
  }

  /**
   * Local poll loops only. For multi-replica admin view use
   * {@link listActiveBotIdsAsync}.
   */
  listActiveBotIds(): string[] {
    return [...this.loops.keys()];
  }

  /** Fleet-wide: bots currently under any instance lease. */
  async listActiveBotIdsAsync(): Promise<string[]> {
    try {
      const leased = await listLeasedBotIds(this.opts.db);
      if (leased.length) return leased;
    } catch {
      /* fall through */
    }
    return this.listActiveBotIds();
  }

  private nextGen(botId: string): number {
    const g = (this.loopGen.get(botId) ?? 0) + 1;
    this.loopGen.set(botId, g);
    return g;
  }

  /**
   * Ensure bot is pollable and try to claim immediately (login / admin start).
   * Does not bypass maxBots — excess stays pollable for later claim.
   */
  ensureLoop(botId: string): void {
    if (this.stopped || this.fenced) return;
    void this.resumeAndMaybeClaim(botId);
  }

  /** Stop polling a bot (delete or admin stop-worker). */
  stopBot(botId: string): void {
    void pauseBotPolling(this.opts.db, botId).catch(() => undefined);
    this.dropLocalLoop(botId);
    void releaseBotLease(this.opts.db, this.workerId, botId).catch(
      () => undefined,
    );
    this.clients.delete(botId);
  }

  /** Pause every pollable bot (admin stop-all). */
  async stopAllBots(): Promise<string[]> {
    const ids = new Set([
      ...(await listPollableBotIds(this.opts.db)),
      ...this.listActiveBotIds(),
    ]);
    for (const id of ids) this.stopBot(id);
    return [...ids];
  }

  /** Stop then re-queue for claim (after re-scan login). */
  restartBot(botId: string): void {
    if (this.fenced) {
      this.opts.log?.(
        `[worker] ignore restartBot while fenced bot=${botId}`,
      );
      return;
    }
    this.dropLocalLoop(botId);
    void this.resumeAndMaybeClaim(botId);
  }

  private startProactiveScheduler(): void {
    const p = this.opts.proactive;
    if (!p) return;
    this.proactive?.stop();
    const sendParts = async (
      client: ILinkClient,
      peerId: string,
      contextToken: string,
      parts: ReplyPart[],
      ownerUserId: string,
    ) => {
      let clean = sanitizePartsStripStickerJson(parts, this.maxStickersPerReply());
      if (!clean.length) return;
      try {
        if (this.opts.splitReply === false || clean.length === 1) {
          await this.sendReplyPart(
            client,
            peerId,
            contextToken,
            clean[0]!,
            ownerUserId,
          );
        } else {
          await this.sendHumanParts(
            client,
            peerId,
            contextToken,
            clean,
            ownerUserId,
          );
        }
      } finally {
        // sendHumanParts asserts the indicator between bubbles; without this the
        // peer would be left staring at "对方正在输入中" after an outreach that
        // nobody was waiting on.
        await client
          .stopTyping({ toUserId: peerId, contextToken })
          .catch(() => undefined);
      }
    };

    const opts: ProactiveSchedulerOptions = {
      db: this.opts.db,
      chat: this.opts.chat,
      globalEnabled: p.globalEnabled,
      defaultIdleHours: p.defaultIdleHours,
      defaultMinIntervalHours: p.defaultMinIntervalHours,
      defaultMaxPerDay: p.defaultMaxPerDay,
      defaultQuietHours: p.defaultQuietHours,
      scanIntervalSec: p.scanIntervalSec,
      maxPerScan: p.maxPerScan,
      lockTtlSec: p.lockTtlSec,
      attemptCooldownHours: p.attemptCooldownHours,
      log: this.opts.log,
      getLocalBotIds: () => this.listActiveBotIds(),
      getClient: (botId) => this.clients.get(botId),
      runOnPeerChain: (botId, peerId, fn) => this.enqueuePeerChain(botId, peerId, fn),
      sendParts,
    };
    this.proactive = new ProactiveScheduler(opts);
    this.proactive.start();
  }

  private startBroadcastRunner(): void {
    this.broadcast?.stop();
    const b = this.opts.broadcast ?? { intervalMs: 200 };
    this.broadcast = new BroadcastRunner({
      db: this.opts.db,
      workerId: this.workerId,
      intervalMs: Math.max(50, b.intervalMs ?? 200),
      pollIntervalMs: b.pollIntervalMs ?? 2_000,
      lockTtlSec: b.lockTtlSec ?? 60,
      log: this.opts.log,
      adminSendText: (botId, peerId, text) =>
        this.adminSendText(botId, peerId, text),
      runOnPeerChain: (botId, peerId, fn) =>
        this.enqueuePeerChain(botId, peerId, fn),
    });
    this.broadcast.start();
  }

  /** Wake broadcast runner after admin creates a job. */
  wakeBroadcast(): void {
    this.broadcast?.wake();
  }

  /**
   * Admin / broadcast: push plain text to (bot, peer).
   * Uses leased client when available; otherwise one-shot ILinkClient from Redis.
   */
  async adminSendText(
    botId: string,
    peerId: string,
    text: string,
    clientId?: string,
  ): Promise<AdminSendResult> {
    const body = text?.trim();
    if (!body) return { ok: false, reason: "empty" };

    // Prefer the already-leased long-poll client so we skip a Redis round-trip
    // for credentials on every broadcast send. Only fall back to context_token
    // + one-shot credentials when the bot is not leased on this worker.
    let client = this.clients.get(botId);
    let contextToken: string | null = null;

    if (client) {
      contextToken = await getContextToken(this.opts.db, botId, peerId);
      if (!contextToken) {
        return { ok: false, reason: "no_context_token" };
      }
    } else {
      const [tok, creds] = await Promise.all([
        getContextToken(this.opts.db, botId, peerId),
        getBotCredentials(this.opts.db, botId),
      ]);
      contextToken = tok;
      if (!contextToken) {
        return { ok: false, reason: "no_context_token" };
      }
      if (!creds?.botToken) {
        return { ok: false, reason: "no_credentials" };
      }
      client = new ILinkClient({
        botToken: creds.botToken,
        baseUrl: creds.baseUrl ?? undefined,
      });
    }

    try {
      await client.sendText({
        toUserId: peerId,
        text: body,
        contextToken,
        clientId,
      });
      return { ok: true };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.opts.log?.(
        `[worker] adminSendText failed bot=${botId} peer=${peerId}: ${message}`,
      );
      return { ok: false, reason: "ilink_error", error: message };
    }
  }

  /** Serialize work per bot:peer (inbound replies + proactive sends). */
  private enqueuePeerChain(
    botId: string,
    peerId: string,
    fn: () => Promise<void>,
  ): Promise<void> {
    const key = `${botId}:${peerId}`;
    const prev = this.peerChains.get(key) ?? Promise.resolve();
    const next = prev.then(fn).catch((err) => {
      this.opts.log?.(
        `[worker] peer chain error: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    });
    this.peerChains.set(key, next);
    void next.finally(() => {
      if (this.peerChains.get(key) === next) this.peerChains.delete(key);
    });
    return next;
  }

  /**
   * Synchronous teardown. Prefer `stopAsync()` on shutdown so lease release
   * actually completes before the process exits.
   */
  stop(): void {
    this.stopped = true;
    this.runtimeActive = false;
    this.proactive?.stop();
    this.proactive = null;
    this.broadcast?.stop();
    this.broadcast = null;
    this.stopWakeSubscriber();
    if (this.leaseTimer) {
      clearInterval(this.leaseTimer);
      this.leaseTimer = null;
    }
    for (const id of [...this.loopGen.keys()]) {
      this.nextGen(id);
    }
    this.loops.clear();
    this.clients.clear();
    this.unregisterPromise = unregisterWorker(
      this.opts.db,
      this.workerId,
    ).catch(() => undefined);
    void this.unregisterPromise;
  }

  private unregisterPromise: Promise<void> | null = null;

  /**
   * Release polling ownership and drain started replies within the shutdown
   * budget. Unacknowledged jobs remain recoverable in the shared inbox.
   */
  async stopAsync(timeoutMs = 25_000): Promise<void> {
    this.stop();
    let timer: ReturnType<typeof setTimeout> | undefined;
    // Queued jobs stay in Redis. Give active jobs a chance to ACK before exit;
    // any remaining processing claims expire and are recovered by another node.
    try {
      await Promise.race([
        Promise.allSettled([this.unregisterPromise, ...this.replyWorkers]),
        new Promise<void>((r) => { timer = setTimeout(r, timeoutMs); }),
      ]);
    } finally { if (timer) clearTimeout(timer); }
  }

  /** Subscribe to fleet wake channel so new bots attach without waiting full lease tick. */
  private startWakeSubscriber(): void {
    try {
      const sub = this.opts.db.redis.duplicate();
      this.wakeSub = sub;
      sub.on("error", (err: Error) => {
        if (process.env.LOG_LEVEL === "debug") {
          this.opts.log?.(`[worker] wake sub error: ${err.message}`);
        }
      });
      void sub
        .subscribe(K.workerWake)
        .then(() => {
          this.opts.log?.(`[worker] subscribed ${K.workerWake}`);
        })
        .catch((err: unknown) => {
          const msg = err instanceof Error ? err.message : String(err);
          this.opts.log?.(`[worker] wake subscribe failed: ${msg}`);
        });
      sub.on("message", (channel: string) => {
        if (channel !== K.workerWake || this.stopped) return;
        // Debounce burst of wakes (many bots login at once)
        if (this.wakeDebounce) return;
        this.wakeDebounce = setTimeout(() => {
          this.wakeDebounce = null;
          // A weight edit publishes a wake — drop the cache so the next
          // reconcile claims/sheds against the new share immediately.
          this.weightFetchedAt = 0;
          void this.reconcileLeases().catch((err) => {
            const msg = err instanceof Error ? err.message : String(err);
            this.opts.log?.(`[worker] wake reconcile error: ${msg}`);
          });
        }, 200);
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.opts.log?.(`[worker] wake subscriber unavailable: ${msg}`);
    }
  }

  private stopWakeSubscriber(): void {
    if (this.wakeDebounce) {
      clearTimeout(this.wakeDebounce);
      this.wakeDebounce = null;
    }
    const sub = this.wakeSub;
    this.wakeSub = null;
    if (!sub) return;
    try {
      void sub.unsubscribe(K.workerWake).catch(() => undefined);
      sub.disconnect();
    } catch {
      /* */
    }
  }

  // ── Lease / claim ────────────────────────────────────

  private async resumeAndMaybeClaim(botId: string): Promise<void> {
    if (this.stopped || this.fenced) return;
    try {
      // resumeBotPolling already unpauses, marks pollable, force-releases the
      // lease and publishes the wake — no need to repeat the last two here.
      await resumeBotPolling(this.opts.db, botId);

      // A drained node must not grab the bot just because the login/restart
      // happened to be handled here. The wake above already told the fleet.
      if (this.fleetWeighted && this.weight === 0) {
        this.opts.log?.(
          `[worker] weight=0%, leaving bot=${botId} for peers to claim`,
        );
        await this.heartbeat();
        return;
      }

      if (this.loops.size >= this.maxBots) {
        this.capacityHits++;
        this.lastAtCapacityAt = new Date().toISOString();
        this.opts.log?.(
          `[worker] at capacity, bot=${botId} pollable but not claimed yet`,
        );
        await this.heartbeat();
        return;
      }

      const ok = await this.opts.db.redis.set(
        K.botLease(botId),
        this.workerId,
        "EX",
        this.leaseTtlSec,
        "NX",
      );
      if (ok === "OK") {
        await this.opts.db.redis.sadd(K.workerBots(this.workerId), botId);
        this.startLoop(botId);
      }
      // Fill remaining slots if any — but never past this node's weighted
      // share, or the next rebalance would just shed what we grabbed here.
      let slots = this.maxBots - this.loops.size;
      if (this.lastPlan) {
        slots = Math.min(slots, this.lastPlan.claimCap - this.loops.size);
      }
      if (slots > 0) {
        const claimed = await claimBotLeases(
          this.opts.db,
          this.workerId,
          slots,
          this.leaseTtlSec,
        );
        for (const id of claimed) this.startLoop(id);
      }
      await this.heartbeat();
    } catch (err) {
      this.opts.log?.(
        `[worker] resume/claim ${botId}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  private async bootstrapPollable(): Promise<void> {
    const bots = await listBotAccounts(this.opts.db);
    const active = bots.filter((b) => b.status === "active");
    if (!active.length) {
      this.opts.log?.(`[worker] pollable bootstrap: 0 bot(s)`);
      return;
    }
    const ids = active.map((b) => b.id);
    // Batch credential + pause checks (2 RTTs) instead of 2N sequential Upstash calls
    const [tokenMap, pausedFlags] = await Promise.all([
      hasBotCredentialsMany(this.opts.db, ids),
      this.opts.db.existsMany(ids.map((id) => K.botPaused(id))),
    ]);
    const n = await rebuildPollableSet(
      this.opts.db,
      active,
      (botId) => Boolean(tokenMap[botId]),
      pausedFlags,
    );
    this.opts.log?.(
      `[worker] pollable bootstrap: ${n} bot(s) (active=${active.length})`,
    );
  }

  private async heartbeat(): Promise<void> {
    if (this.fenced || this.stopped) return;
    const meta: {
      id: string;
      hostname: string;
      pid: number;
      maxBots: number;
      botCount: number;
      startedAt: string;
      updatedAt: string;
      role: "all";
      label?: string;
      region?: string;
      version?: string;
      weight?: number;
    } = {
      id: this.workerId,
      hostname: osHostname(),
      pid: process.pid,
      maxBots: this.maxBots,
      botCount: this.loops.size,
      startedAt: this.startedAt,
      updatedAt: new Date().toISOString(),
      role: "all",
      // Advertised so peers can size their share straight off the heartbeat
      weight: this.weight,
    };
    const label = this.opts.nodeLabel?.trim();
    const region = this.opts.nodeRegion?.trim();
    const version = this.opts.appVersion?.trim();
    if (label) meta.label = label;
    if (region) meta.region = region;
    if (version) meta.version = version;
    // Meta TTL = stale window: 1 min without heartbeat → key expires → node reaped
    await registerWorker(this.opts.db, meta, WORKER_STALE_SEC);
  }

  /** This node's admin load weight in percent (100 = default share). */
  getWeight(): number {
    return this.weight;
  }

  /**
   * Refresh the cached weight snapshot (one HGETALL, shared by the claim cap
   * and the shed math). Untuned fleets read an empty hash and take the old
   * uncapped path, so this is the only added Redis cost for them.
   */
  private async refreshWeightSnapshot(force = false): Promise<void> {
    const now = Date.now();
    // Half the rebalance cadence: fresh enough to matter, rare enough to be
    // cheap. Admin edits publish a wake, which forces a refresh anyway.
    const ttlMs = Math.max(20_000, (this.rebalanceIntervalSec * 1000) / 2);
    if (!force && now - this.weightFetchedAt < ttlMs) return;
    this.weightFetchedAt = now;
    try {
      const snapshot = await listWorkerWeights(this.opts.db);
      this.weightSnapshot = snapshot;
      this.fleetWeighted = hasWorkerWeightOverrides(snapshot);
      const mine = snapshot[this.workerId];
      this.weight = mine
        ? normalizeWorkerWeight(mine.percent)
        : DEFAULT_WORKER_WEIGHT;
      if (this.weight !== this.lastWeightLogged) {
        this.opts.log?.(
          `[worker] load weight ${this.lastWeightLogged}% → ${this.weight}% ` +
            `id=${this.workerId}` +
            (this.weight === 0 ? " (draining: will not claim bots)" : ""),
        );
        this.lastWeightLogged = this.weight;
      }
      await this.maybeGcWeights(snapshot, now);
    } catch {
      // Keep the last known weight — a Redis blip must not silently reset a
      // drained node back to a full share.
    }
  }

  /**
   * Keep the weight hash tidy: refresh `lastSeenAt` for nodes that are still
   * heartbeating and delete the ones that have been gone past the TTL.
   *
   * Runs on any node (HSET/HDEL are idempotent), on a slow cadence, and only
   * while overrides exist — a fleet that never touches weights pays nothing.
   * Without this the hash would grow forever, because WORKER_ID defaults to a
   * fresh random id on every restart unless it is pinned in the environment.
   */
  private async maybeGcWeights(
    snapshot: Record<string, WorkerWeight>,
    now: number,
  ): Promise<void> {
    if (!Object.keys(snapshot).length) return;
    if (now - this.lastWeightGcAt < WEIGHT_GC_INTERVAL_MS) return;
    this.lastWeightGcAt = now;
    try {
      const { removed, touched, pending } = await gcWorkerWeights(this.opts.db, {
        graceSec: this.weightTtlSec,
        weights: snapshot,
        now,
      });
      if (removed.length) {
        for (const id of removed) delete this.weightSnapshot[id];
        this.fleetWeighted = hasWorkerWeightOverrides(this.weightSnapshot);
        this.opts.log?.(
          `[worker] load weight auto-cleanup: dropped ${removed.length} ` +
            `vanished node(s) after ${this.weightTtlSec}s — ${removed.join(", ")}` +
            (pending ? ` (${pending} still within grace)` : ""),
        );
      }
      void touched;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.opts.log?.(`[worker] load weight gc error: ${msg}`);
    }
  }

  /**
   * How stale a peer's heartbeat may be before we stop reserving its share.
   *
   * Tighter than WORKER_STALE_SEC on purpose: a peer that has not heartbeat in
   * longer than the lease TTL cannot still be holding valid leases, so keeping
   * a share reserved for it would leave its expired bots unclaimed until its
   * meta key finally expires. Floored at two heartbeat intervals so a healthy
   * but slow node is never dropped.
   */
  private planFreshnessMs(): number {
    return (
      Math.max(
        this.leaseRenewSec * 2,
        Math.min(this.leaseTtlSec, WORKER_STALE_SEC),
      ) * 1000
    );
  }

  /**
   * Online nodes (self included) as planner input. Self is added even when its
   * meta is briefly missing from the registry, otherwise this node would plan
   * itself a target of zero and release everything.
   */
  private onlinePlanNodes(
    metas: WorkerMeta[],
    now = Date.now(),
  ): Array<{ id: string; weight: number; maxBots: number }> {
    const out: Array<{ id: string; weight: number; maxBots: number }> = [];
    const freshMs = this.planFreshnessMs();
    let sawSelf = false;
    for (const m of metas) {
      const isSelf = m.id === this.workerId;
      const t = Date.parse(m.updatedAt);
      const fresh = Number.isFinite(t) && now - t <= freshMs;
      if (!isSelf && !fresh) continue;
      if (isSelf) sawSelf = true;
      out.push({
        id: m.id,
        weight: isSelf ? this.weight : this.weightOf(m),
        // Own maxBots is authoritative locally; a peer's comes off its heartbeat
        maxBots: isSelf ? this.maxBots : Math.max(0, Number(m.maxBots) || 0),
      });
    }
    if (!sawSelf) {
      out.push({
        id: this.workerId,
        weight: this.weight,
        maxBots: this.maxBots,
      });
    }
    return out;
  }

  private weightOf(meta: WorkerMeta): number {
    const stored = this.weightSnapshot[meta.id];
    if (stored) return normalizeWorkerWeight(stored.percent);
    return meta.weight === undefined
      ? DEFAULT_WORKER_WEIGHT
      : normalizeWorkerWeight(meta.weight);
  }

  /**
   * Honor admin force-offline fence: drop leases, leave reg, no claim/renew
   * until fence is cleared.
   */
  private async applyFenceState(): Promise<boolean> {
    let fenced = false;
    try {
      fenced = await isWorkerFenced(this.opts.db, this.workerId);
    } catch {
      return this.fenced;
    }

    if (fenced) {
      if (!this.fenced) {
        this.fenced = true;
        this.opts.log?.(
          `[worker] fenced by admin — releasing leases and leaving fleet id=${this.workerId}`,
        );
      }
      const owned = [...this.loops.keys()];
      if (owned.length) {
        try {
          await releaseOwnedLeasesBatch(this.opts.db, this.workerId, owned);
        } catch {
          /* best effort */
        }
        for (const botId of owned) {
          this.dropLocalLoop(botId);
          this.clients.delete(botId);
        }
      }
      try {
        await unregisterWorker(this.opts.db, this.workerId);
      } catch {
        /* */
      }
      const now = Date.now();
      if (now - this.lastFenceLogAt > 60_000) {
        this.lastFenceLogAt = now;
        this.opts.log?.(
          `[worker] still fenced id=${this.workerId} (clear via admin 节点 → 解除下线)`,
        );
      }
      return true;
    }

    if (this.fenced) {
      this.fenced = false;
      this.opts.log?.(
        `[worker] fence cleared — rejoining fleet id=${this.workerId}`,
      );
    }
    return false;
  }

  private async reconcileLeases(): Promise<void> {
    if (this.stopped) return;

    if (await this.applyFenceState()) {
      return;
    }

    // OTA jobs (Redis-mediated; may restart process)
    if (this.opts.otaEnabled !== false && !this.otaInFlight) {
      try {
        await this.maybeRunOta();
        if (this.stopped) return;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.opts.log?.(`[worker] ota check error: ${msg}`);
      }
    }

    const owned = [...this.loops.keys()];
    const { renewed, lost } = await renewOwnedLeases(
      this.opts.db,
      this.workerId,
      owned,
      this.leaseTtlSec,
    );
    for (const id of lost) {
      this.opts.log?.(`[worker] lost lease bot=${id}`);
      this.dropLocalLoop(id);
      this.clients.delete(id);
    }

    // Admin load weights. Only a weighted fleet pays for the peer/pollable
    // reads below — an untuned one keeps the original claim-then-shed path.
    await this.refreshWeightSnapshot();
    let plan: NodeLoadPlan | null = null;
    let pollableIds: string[] | null = null;
    if (this.fleetWeighted) {
      try {
        const [metas, pollable] = await Promise.all([
          listWorkerMetas(this.opts.db),
          listPollableBotIds(this.opts.db),
        ]);
        pollableIds = pollable;
        plan = planNodeLoad({
          selfId: this.workerId,
          nodes: this.onlinePlanNodes(metas),
          total: pollable.length,
          slack: this.rebalanceSlack,
        });
      } catch {
        // Fall back to the uncapped claim; rebalance still corrects the split.
        plan = null;
      }
    }
    this.lastPlan = plan;

    let slots = this.maxBots - this.loops.size;
    if (plan) {
      slots = Math.min(slots, plan.claimCap - this.loops.size);
    }
    if (slots > 0) {
      const claimed = await claimBotLeases(
        this.opts.db,
        this.workerId,
        slots,
        this.leaseTtlSec,
      );
      for (const id of claimed) {
        this.startLoop(id);
      }
      if (claimed.length) {
        const capNote = plan
          ? ` weight=${this.weight}% target=${plan.target} cap=${plan.claimCap}`
          : "";
        this.opts.log?.(
          `[worker] claimed ${claimed.length} bot(s) (total ${this.loops.size}/${this.maxBots})${capNote}`,
        );
      }
    }

    if (plan?.unplaceable) {
      const now = Date.now();
      if (now - this.lastUnplaceableLogAt > 60_000) {
        this.lastUnplaceableLogAt = now;
        this.opts.log?.(
          `[worker] ${plan.unplaceable} pollable bot(s) have no node with room — ` +
            `raise MAX_BOTS_PER_WORKER, add a node, or raise a node's load weight ` +
            `(admin 节点 → 负载权重)`,
        );
      }
    }

    // Multi-node: shed excess leases so underloaded peers can claim
    if (this.rebalanceEnabled) {
      try {
        await this.maybeRebalanceShed(plan);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.opts.log?.(`[worker] rebalance error: ${msg}`);
      }
    }

    // Capacity warning (rate-limited log)
    try {
      const pollable = pollableIds ?? (await listPollableBotIds(this.opts.db));
      if (pollable.length > this.maxBots && this.loops.size >= this.maxBots) {
        this.capacityHits++;
        this.lastAtCapacityAt = new Date().toISOString();
        const now = Date.now();
        if (now - this.lastCapacityLogAt > 60_000) {
          this.lastCapacityLogAt = now;
          this.opts.log?.(
            `[worker] at capacity ${this.maxBots}; pollable=${pollable.length}. ` +
              `Raise MAX_BOTS_PER_WORKER (and OS ulimit/memory) for this single process.`,
          );
        }
      }
    } catch {
      /* ignore */
    }

    await this.heartbeat();
    void renewed;
  }

  /** After reboot, mark prior OTA status done when versions match. */
  private async markOtaDoneIfMatched(): Promise<void> {
    const ver = this.opts.appVersion?.trim();
    if (!ver) return;
    try {
      const st = await getWorkerUpdateStatus(this.opts.db, this.workerId);
      if (!st) return;
      if (
        st.version === ver &&
        (st.phase === "restarting" ||
          st.phase === "applying" ||
          st.phase === "installing" ||
          st.phase === "pending" ||
          st.phase === "downloading")
      ) {
        await setWorkerUpdateStatus(this.opts.db, {
          ...st,
          phase: "done",
          error: null,
          message: "restarted",
          updatedAt: new Date().toISOString(),
        });
        await clearWorkerUpdateJob(this.opts.db, this.workerId);
        this.opts.log?.(`[ota] status done after restart version=${ver}`);
      }
    } catch {
      /* best effort */
    }
  }

  private async maybeRunOta(): Promise<void> {
    if (this.otaInFlight || this.stopped || this.fenced) return;
    const repoRoot = this.opts.repoRoot?.trim();
    if (!repoRoot) return;

    this.otaInFlight = true;
    try {
      const result = await tryApplyOtaUpdate({
        db: this.opts.db,
        workerId: this.workerId,
        repoRoot,
        appVersion: this.opts.appVersion?.trim() || "0.0.0",
        stagingDir: this.opts.otaStagingDir || ".wa-update-staging",
        allowInstall: this.opts.otaAllowInstall !== false,
        log: this.opts.log,
        beforeRestart: async () => {
          await this.stopAsync();
        },
      });
      if (result === "applied") {
        // Docker restart policy restarts same container (writable layer kept)
        setTimeout(() => process.exit(0), 200);
      }
    } finally {
      this.otaInFlight = false;
    }
  }

  /**
   * If this process holds more than fair-share + slack among online fleet
   * workers, release some leases (not pause bots). Peers claim on next tick / wake.
   */
  private async maybeRebalanceShed(plan?: NodeLoadPlan | null): Promise<void> {
    const now = Date.now();
    if (now - this.lastRebalanceAt < this.rebalanceIntervalSec * 1000) {
      return;
    }
    // Stamp the attempt here, not after a successful shed. In steady state
    // shed is always 0, so the old placement meant the interval guard never
    // engaged and listWorkerMetas ran on every reconcile tick instead.
    this.lastRebalanceAt = now;
    const localCount = this.loops.size;
    if (localCount <= 0) return;
    // A drained node (0%) must shed its last few bots too, so the usual
    // "nothing worth rebalancing" shortcut cannot apply to it.
    await this.refreshWeightSnapshot();
    if (localCount <= this.rebalanceSlack && this.weight !== 0) return;

    // The reconcile pass already planned this tick when the fleet is weighted;
    // reuse it so claim and shed cannot disagree about the target.
    if (plan) {
      const shedPlanned = shedAboveTarget({
        localCount,
        target: plan.target,
        slack: plan.slack,
        maxPerTick: this.rebalanceMaxPerTick,
      });
      if (shedPlanned <= 0) return;
      await this.shedLeases(shedPlanned, localCount, {
        target: plan.target,
        slack: plan.slack,
      });
      return;
    }

    const metas = await listWorkerMetas(this.opts.db);
    const onlineWithinMs = WORKER_STALE_SEC * 1000;
    const peers: Array<{ count: number; weight: number }> = [];
    let onlineWorkers = 0;
    for (const m of metas) {
      const t = Date.parse(m.updatedAt);
      const fresh = Number.isFinite(t) && now - t <= onlineWithinMs;
      if (!fresh && m.id !== this.workerId) continue;
      onlineWorkers++;
      if (m.id === this.workerId) continue;
      peers.push({
        count: Math.max(0, Number(m.botCount) || 0),
        weight: this.weightOf(m),
      });
    }
    // Self may be missing from reg briefly — still count local
    if (!metas.some((m) => m.id === this.workerId)) {
      onlineWorkers = Math.max(onlineWorkers + 1, 1 + peers.length);
    }
    if (onlineWorkers < 2 && peers.length < 1) return;

    const shed = computeWeightedShedCount({
      localCount,
      localWeight: this.weight,
      peers,
      slack: this.rebalanceSlack,
      maxPerTick: this.rebalanceMaxPerTick,
    });
    if (shed <= 0) return;

    const total = localCount + peers.reduce((a, p) => a + p.count, 0);
    const totalWeight = this.weight + peers.reduce((a, p) => a + p.weight, 0);
    await this.shedLeases(shed, localCount, {
      target:
        totalWeight > 0
          ? Math.floor((total * this.weight) / totalWeight)
          : Math.floor(total / (1 + peers.length)),
      slack: this.rebalanceSlack,
    });
  }

  /** Release `shed` random leases and log the resulting split. */
  private async shedLeases(
    shed: number,
    localCount: number,
    ctx: { target: number; slack: number },
  ): Promise<void> {
    const owned = [...this.loops.keys()];
    // Mild shuffle so we don't always shed the same prefix
    for (let i = owned.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      const t = owned[i]!;
      owned[i] = owned[j]!;
      owned[j] = t;
    }
    const candidates = owned.slice(0, shed);
    const released = await releaseOwnedLeasesBatch(
      this.opts.db,
      this.workerId,
      candidates,
    );
    for (const botId of released) {
      this.dropLocalLoop(botId);
      this.clients.delete(botId);
    }
    if (released.length) {
      this.opts.log?.(
        `[worker] rebalance shed ${released.length} bot(s) ` +
          `(local was ${localCount} → ~${this.loops.size}; target≈${ctx.target} ` +
          `weight=${this.weight}% slack=${ctx.slack})`,
      );
      await publishWorkerWake(this.opts.db);
    }
  }

  private dropLocalLoop(botId: string): void {
    this.nextGen(botId);
    this.loops.delete(botId);
  }

  private startLoop(botId: string): void {
    if (this.stopped || this.loops.has(botId)) return;
    const gen = this.nextGen(botId);
    // `.finally()` re-throws, so without this `.catch()` a rejection here is an
    // unhandled rejection — which kills the process, and the HTTP server with
    // it (worker and Fastify share one process). Never let a poll loop escape.
    const p = this.runPollLoop(botId, gen)
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        this.opts.log?.(`[worker] poll loop crashed bot=${botId}: ${message}`);
      })
      .finally(() => {
        if (this.loopGen.get(botId) === gen) {
          this.loops.delete(botId);
        }
      });
    this.loops.set(botId, p);
  }

  // ── Poll ─────────────────────────────────────────────

  private async loadBotToken(botId: string): Promise<{
    botToken: string;
    baseUrl?: string | null;
  } | null> {
    const fromRedis = await getBotCredentials(this.opts.db, botId);
    if (!fromRedis?.botToken) return null;
    return { botToken: fromRedis.botToken, baseUrl: fromRedis.baseUrl };
  }

  private async runPollLoop(botId: string, gen: number): Promise<void> {
    const alive = () => !this.stopped && this.loopGen.get(botId) === gen;

    // Bootstrap is outside the while-loop's try/catch, and Redis is remote with
    // maxRetriesPerRequest=2 — a blip here used to reject the whole loop.
    // Release the lease best-effort and let the next reconcile re-claim.
    let bot: Awaited<ReturnType<typeof getBotAccount>>;
    let creds: { botToken: string; baseUrl?: string | null } | null;
    try {
      [bot, creds] = await Promise.all([
        getBotAccount(this.opts.db, botId),
        this.loadBotToken(botId),
      ]);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      this.opts.log?.(`[worker] bootstrap failed bot=${botId}: ${message}`);
      await releaseBotLease(this.opts.db, this.workerId, botId).catch(() => {});
      return;
    }

    if (!bot || !alive()) {
      this.opts.log?.(`[worker] bot not found: ${botId}`);
      await releaseBotLease(this.opts.db, this.workerId, botId).catch(() => {});
      return;
    }

    if (!creds?.botToken) {
      this.opts.log?.(
        `[worker] missing token for ${botId} (Redis empty — 用户中心 → 重新扫码绑定)`,
      );
      await releaseBotLease(this.opts.db, this.workerId, botId).catch(() => {});
      return;
    }
    if (!alive()) return;

    const client = new ILinkClient({
      botToken: creds.botToken,
      baseUrl: creds.baseUrl ?? bot.base_url ?? undefined,
    });
    this.clients.set(botId, client);

    let cursor = bot.updates_cursor || "";
    // Bot row was just loaded above — don't re-read it on the first iteration
    let statusCheckAt = Date.now();

    this.opts.log?.(`[worker] polling bot=${botId}`);

    while (alive()) {
      try {
        const now = Date.now();
        // Status check every ~30s, not every long-poll (cheaper at scale)
        if (now - statusCheckAt > 30_000) {
          statusCheckAt = now;
          const live = await getBotAccount(this.opts.db, botId);
          if (!live || live.status !== "active") {
            this.opts.log?.(`[worker] bot inactive/removed, stop ${botId}`);
            await releaseBotLease(this.opts.db, this.workerId, botId);
            return;
          }
        }
        if (!alive()) return;

        const res = await client.getUpdates(cursor);
        if (!alive()) return;
        // Enqueue first so a Redis blip on setBotCursor cannot drop the batch.
        // Dedup in enqueueFromMessage absorbs any restart replay.
        const msgs = res.msgs ?? [];
        for (const msg of msgs) {
          await this.enqueueFromMessage(botId, client, msg);
        }
        // Never accept empty string — that is the first-call sentinel and would
        // rewind the stream, replaying the entire backlog as new jobs.
        const buf = res.get_updates_buf;
        if (typeof buf === "string" && buf !== "" && buf !== cursor) {
          try {
            await setBotCursor(this.opts.db, botId, buf, this.workerId);
            cursor = buf;
          } catch (e) {
            // Still advance in-memory so we don't hot-loop the same batch;
            // the dedup gate below stops a restart from re-running the LLM.
            cursor = buf;
            this.opts.log?.(
              `[worker] cursor persist failed bot=${botId}: ${
                e instanceof Error ? e.message : String(e)
              }`,
            );
          }
        } else if (msgs.length > 0) {
          this.opts.log?.(
            `[worker] getupdates returned ${msgs.length} msg(s) without advancing cursor bot=${botId} buf=${JSON.stringify(buf)}`,
          );
        }
      } catch (err: unknown) {
        if (err instanceof ILinkError) {
          this.opts.log?.(`[worker] iLink error bot=${botId}: ${err.message}`, {
            ret: err.ret,
            errcode: err.errcode,
          });
          if (err.ret === -14 || err.errcode === -14) {
            this.opts.log?.(`[worker] session expired, stop bot=${botId}`);
            await releaseBotLease(this.opts.db, this.workerId, botId);
            return;
          }
        } else {
          const message = err instanceof Error ? err.message : String(err);
          this.opts.log?.(`[worker] error bot=${botId}: ${message}`);
        }
        await sleep(2000);
      }
    }
  }

  /**
   * Synthesize a stable key for one inbound WeChat message.
   * iLink's WeixinMessage has no msg_id/svr_id — only create_time_ms + content.
   */
  private inboundDedupKey(
    botId: string,
    peerId: string,
    msg: WeixinMessage,
    text: string,
    mediaRefs: InboundMediaRef[],
  ): string {
    const mediaSig = mediaRefs
      .map((r) => `${r.kind}:${r.fileName ?? r.aesKey ?? ""}`)
      .join(",");
    const raw = [
      botId,
      peerId,
      String(msg.create_time_ms ?? 0),
      text,
      mediaSig,
      // context_token usually changes per delivery of the *same* content when
      // iLink redelivers; leave it out so redelivery collapses. Include a
      // short hash of item types as a last-ditch discriminator for empty text.
      String(msg.message_type ?? ""),
    ].join("|");
    return createHash("sha1").update(raw).digest("hex").slice(0, 32);
  }

  private async enqueueFromMessage(
    botId: string,
    client: ILinkClient,
    msg: WeixinMessage,
  ): Promise<void> {
    if (!isUserInbound(msg)) return;
    const peerId = msg.from_user_id;
    const contextToken = msg.context_token;
    if (!peerId || !contextToken) return;

    // With transcripts on (the default), extractText folds in iLink's own voice
    // transcript, so a voice note with one counts as text and never lands in the
    // media path. planInboundMedia is told the same thing so the two agree.
    const text = extractText(msg, {
      includeVoiceTranscript: this.opts.voiceTranscriptEnabled !== false,
    });
    const mediaRefs = extractMediaRefs(msg);
    const mediaOnly = !text?.trim();
    const trimmed = text?.trim() ?? "";

    const job: LocalInboundJob = {
      id: this.inboundDedupKey(botId, peerId, msg, trimmed, mediaRefs),
      botId, peerId, contextToken, text: trimmed, mediaOnly,
      enqueuedAt: new Date().toISOString(),
      ...(mediaRefs.length ? { mediaRefs } : {}),
    };
    // Persist before advancing the iLink cursor. Failure leaves the entire
    // batch replayable; previously accepted jobs deduplicate against Redis.
    const result = await persistInbound(this.opts.db, this.workerId, job, this.inboxMaxLen);
    if (result === "duplicate") return;
    this.inboxScanAfter = 0;
    void client.startTyping({ toUserId: peerId, contextToken }).catch(() => undefined);
    emitActivity({
      type: "message.in", source: this.workerId,
      summary: `in bot=${botId} peer=${peerId}`,
      data: streamMessagePayload(job.text || "[media]", { botId, peerId, jobId: job.id, role: "user" }),
    });
  }

  // Only one idle scanner per process, regardless of REPLY_CONCURRENCY.
  private async waitForJob(): Promise<InboundClaim<LocalInboundJob> | null> {
    if (this.stopped) return null;
    if (this.claimingInbox || Date.now() < this.inboxScanAfter) {
      await sleep(100);
      return null;
    }
    this.claimingInbox = true;
    try {
      const ids = [...this.loops.keys()];
      for (let i = 0; i < ids.length && !this.stopped; i++) {
        const botId = ids[this.inboxBotOffset++ % ids.length]!;
        const claim = await claimInbound<LocalInboundJob>(this.opts.db, botId, this.workerId);
        if (claim) return claim;
      }
      this.inboxScanAfter = Date.now() + 1000;
      return null;
    } finally { this.claimingInbox = false; }
  }

  private async runReplyConsumer(_idx: number): Promise<void> {
    while (!this.stopped) {
      let claim: InboundClaim<LocalInboundJob> | null = null;
      let delivery: InboundDelivery | undefined;
      try {
        claim = await this.waitForJob();
        if (!claim) continue;
        if (this.stopped) {
          await retryInbound(this.opts.db, claim, 0);
          break;
        }
        delivery = new InboundDelivery(this.opts.db, claim);
        // A bot can move to another node while this job is in progress. Its
        // independent peer claim keeps replies ordered until ACK or expiry.
        let rawClient = this.clients.get(claim.job.botId);
        if (!rawClient) {
          const creds = await this.loadBotToken(claim.job.botId);
          if (!creds) throw new Error("No credentials for queued bot");
          rawClient = new ILinkClient({ botToken: creds.botToken, baseUrl: creds.baseUrl ?? undefined });
        }
        const active = delivery;
        const job = claim.job;
        const client = rawClient;
        let succeeded = false;
        await this.enqueuePeerChain(job.botId, job.peerId, async () => {
          await this.handleJob(job, client, active);
          succeeded = true;
        });
        if (!succeeded) throw new Error("Inbound reply failed");
        await acknowledgeInbound(this.opts.db, claim);
      } catch (err) {
        delivery?.close();
        this.jobsFailed++;
        this.opts.log?.(`[worker] durable reply pending retry: ${err instanceof Error ? err.message : String(err)}`);
        if (claim) {
          await retryInbound(this.opts.db, claim).catch(() => undefined);
        }
        await sleep(1000);
      } finally { delivery?.close(); }
    }
  }

  /**
   * Every exit path clears the typing indicator.
   *
   * enqueueFromMessage fires startTyping before the job is queued, so if a
   * rejection, rate limit, P2P relay hand-off, or crash returned without a stop
   * the peer would keep seeing "对方正在输入中" until the server timed it out.
   */
  private async handleJob(job: LocalInboundJob, client: ILinkClient, delivery: InboundDelivery): Promise<void> {
    try {
      await this.handleJobInner(job, client, delivery);
    } finally {
      if (client) {
        await client
          .stopTyping({
            toUserId: job.peerId,
            contextToken: job.contextToken,
          })
          .catch(() => undefined);
      }
    }
  }

  private async handleJobInner(job: LocalInboundJob, client: ILinkClient, delivery: InboundDelivery): Promise<void> {
    const t0 = Date.now();
    // Always refresh context_token so later P2P / proactive push can reach this peer
    try {
      await upsertContextToken(
        this.opts.db,
        job.botId,
        job.peerId,
        job.contextToken,
      );
    } catch {
      /* non-fatal */
    }

    const rateKey = `${job.botId}:${job.peerId}`;
    if (!(await delivery.step("rate", async () => this.peerLimiter.tryTake(rateKey)))) {
      const rateText = "你发得太快啦，请稍等一会儿再聊～";
      await delivery.client(client, "rate-reply").sendText({
        toUserId: job.peerId,
        text: rateText,
        contextToken: job.contextToken,
      });
      this.jobsProcessed++;
      emitActivity({
        type: "message.reject",
        level: "warn",
        source: this.workerId,
        summary: `rate limit bot=${job.botId} peer=${job.peerId}`,
        data: streamMessagePayload(rateText, {
          botId: job.botId, peerId: job.peerId, role: "system",
          reason: "rate_limit", jobId: job.id, ms: Date.now() - t0,
        }),
      });
      return;
    }

    // Keep the routing decision stable if P2P settings change between retries.
    {
      try {
        const p2pResult = await delivery.step("p2p", async () => this.p2pEnabled && this.p2p ? this.p2p.handleInbound({
          botId: job.botId,
          peerId: job.peerId,
          text: job.text,
          mediaOnly: job.mediaOnly || !job.text.trim(),
        }) : { handled: false, localReplies: [], remoteSends: [] });
        if (p2pResult.handled) {
          for (const [i, text] of p2pResult.localReplies.entries()) {
            if (!text?.trim()) continue;
            await delivery.client(client, `p2p-local:${i}`).sendText({
              toUserId: job.peerId,
              text: text.trim(),
              contextToken: job.contextToken,
            });
            emitActivity({
              type: "message.out",
              source: this.workerId,
              summary: `out p2p bot=${job.botId} peer=${job.peerId}`,
              data: streamMessagePayload(text.trim(), {
                botId: job.botId,
                peerId: job.peerId,
                role: "assistant",
                channel: "p2p",
                jobId: job.id,
              }),
            });
          }
          for (const [i, remote] of p2pResult.remoteSends.entries()) {
            await delivery.step(`p2p-remote:${i}`, () => this.sendToEndpoint(
              remote.botId, remote.peerId, remote.text, delivery.clientId(`p2p-remote:${i}`),
            ));
          }
          this.jobsProcessed++;
          emitActivity({
            type: "worker.job",
            source: this.workerId,
            summary: `p2p handled bot=${job.botId} peer=${job.peerId} ${Date.now() - t0}ms`,
            data: {
              botId: job.botId,
              peerId: job.peerId,
              jobId: job.id,
              kind: "p2p",
              ms: Date.now() - t0,
            },
          });
          return;
        }
      } catch (err) {
        this.opts.log?.(
          `[worker] p2p failed peer=${job.peerId}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
        throw err;
      }
    }

    void client
      .startTyping({
        toUserId: job.peerId,
        contextToken: job.contextToken,
      })
      .catch(() => undefined);

    try {
      // Persist the decision as well as the generated reply. A recovered media
      // job must not switch to a canned response after its CDN URL expires.
      const result = await delivery.step("chat", async () => {
        const attachments = job.mediaRefs?.length
          ? await this.buildAttachments(client, job, job.mediaRefs)
          : [];
        if (!job.text.trim() && !attachments.some((a) => a.dataUri)) {
          return { kind: "reject" as const, text: unreadableMediaReply(job.mediaRefs ?? []) };
        }
        return this.opts.chat.handleInbound({
          botAccountId: job.botId, peerId: job.peerId, text: job.text.trim(),
          contextToken: job.contextToken, attachments,
        });
      });

      if (result.kind === "reject" && result.text) {
        await delivery.client(client, "reject").sendText({
          toUserId: job.peerId,
          text: result.text,
          contextToken: job.contextToken,
        });
        emitActivity({
          type: "message.reject",
          level: "warn",
          source: this.workerId,
          summary: `reject bot=${job.botId} peer=${job.peerId}`,
          data: streamMessagePayload(result.text, {
            botId: job.botId,
            peerId: job.peerId,
            role: "system",
            jobId: job.id,
            ms: Date.now() - t0,
          }),
        });
      } else if (result.kind === "reply") {
        const parts = await delivery.step("parts", async () => {
          const proposed: ReplyPart[] =
            result.parts && result.parts.length > 0
              ? result.parts
              : result.bubbles && result.bubbles.length > 0
                ? result.bubbles.map((t) => ({ kind: "text" as const, text: t }))
                : result.text
                  ? [{ kind: "text" as const, text: result.text }]
                  : [];
          // Worker-side validation: never send raw sticker JSON as text.
          const sanitized = sanitizePartsStripStickerJson(proposed, this.maxStickersPerReply());
          return this.opts.splitReply === false ? sanitized.slice(0, 1) : sanitized;
        });
        if (parts.length === 0) {
          /* empty */
        } else {
          // ChatService already loaded the bot row — it hands the owner back
          // on the result rather than making us re-read it per message.
          const ownerUserId = result.ownerUserId || "";
          if (parts.length === 1) {
            this.opts.log?.(
              `[worker] send 1 part peer=${job.peerId} kind=${parts[0]!.kind}`,
            );
            await delivery.step("part:0", () => this.sendReplyPart(
              delivery.client(client, "part:0"),
              job.peerId,
              job.contextToken,
              parts[0]!,
              ownerUserId,
            ));
          } else {
            this.opts.log?.(
              `[worker] send ${parts.length} parts peer=${job.peerId}` +
                (result.bubblesFromJson ? " (json)" : " (split)"),
            );
            await this.sendHumanParts(
              client,
              job.peerId,
              job.contextToken,
              parts,
              ownerUserId,
              delivery,
            );
          }
          const outText =
            result.text ||
            parts
              .map((p) =>
                p.kind === "text" ? p.text : `[sticker:${p.slug}]`,
              )
              .join(" ");
          emitActivity({
            type: "message.out",
            source: this.workerId,
            summary: `out bot=${job.botId} peer=${job.peerId} parts=${parts.length}`,
            data: streamMessagePayload(outText, {
              botId: job.botId,
              peerId: job.peerId,
              role: "assistant",
              parts: parts.length,
              personaId: result.personaId,
              personaSlug: result.personaSlug,
              jobId: job.id,
              ms: Date.now() - t0,
            }),
          });
          emitActivity({
            type: "llm.usage",
            source: this.workerId,
            summary: `llm reply bot=${job.botId} persona=${result.personaSlug || result.personaId || "?"} ${Date.now() - t0}ms`,
            data: {
              botId: job.botId,
              peerId: job.peerId,
              personaId: result.personaId,
              personaSlug: result.personaSlug,
              jobId: job.id,
              ms: Date.now() - t0,
              parts: parts.length,
            },
          });
        }
      }
      this.jobsProcessed++;
      emitActivity({
        type: "worker.job",
        source: this.workerId,
        summary: `job ok bot=${job.botId} peer=${job.peerId} ${Date.now() - t0}ms`,
        data: {
          botId: job.botId,
          peerId: job.peerId,
          jobId: job.id,
          kind: result.kind,
          ms: Date.now() - t0,
        },
      });
    } catch (err) {
      this.opts.log?.(
        `[worker] chat failed peer=${job.peerId}: ${(err as Error).message}`,
      );
      emitActivity({
        type: "worker.fail",
        level: "error",
        source: this.workerId,
        summary: `chat fail bot=${job.botId} peer=${job.peerId}: ${(err as Error).message}`,
        data: {
          botId: job.botId,
          peerId: job.peerId,
          jobId: job.id,
          error: (err as Error).message,
          ms: Date.now() - t0,
        },
      });
      throw err;
    }
  }

  /**
   * Turn inbound media coordinates into prompt attachments.
   * Gating rules live in inbound-media.ts; this does the I/O.
   */
  private async buildAttachments(
    client: ILinkClient,
    job: LocalInboundJob,
    refs: InboundMediaRef[],
  ): Promise<PromptAttachment[]> {
    const out: PromptAttachment[] = [];
    const maxBytes = Math.max(
      64 * 1024,
      this.opts.inboundMediaMaxBytes ?? 4 * 1024 * 1024,
    );
    const plan = planInboundMedia(refs, {
      visionEnabled: this.opts.visionEnabled === true,
      maxImages: this.opts.visionMaxImages ?? 2,
      voiceTranscriptEnabled: this.opts.voiceTranscriptEnabled !== false,
    });

    for (const { ref, download } of plan) {
      if (!download) {
        out.push({ kind: ref.kind, fileName: ref.fileName });
        continue;
      }
      try {
        const media = await client.downloadMedia(ref, { maxBytes });
        if (!isVisionMime(media.mime)) {
          this.opts.log?.(
            `[worker] image mime not usable for vision bot=${job.botId} peer=${job.peerId} mime=${media.mime ?? "unknown"}`,
          );
          out.push({ kind: "image", mime: media.mime });
          continue;
        }
        out.push({
          kind: "image",
          mime: media.mime,
          dataUri: `data:${media.mime};base64,${media.data.toString("base64")}`,
        });
      } catch (err) {
        // Media failures must never sink the reply — degrade to notice-only.
        this.opts.log?.(
          `[worker] media download failed bot=${job.botId} peer=${job.peerId} kind=${ref.kind}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
        out.push({ kind: ref.kind, fileName: ref.fileName });
      }
    }
    return out;
  }

  /**
   * Push text to an arbitrary (bot, peer) endpoint (P2P relay).
   * Uses adminSendText; logs skip reasons.
   */
  private async sendToEndpoint(
    botId: string,
    peerId: string,
    text: string,
    clientId?: string,
  ): Promise<void> {
    const result = await this.adminSendText(botId, peerId, text, clientId);
    if (!result.ok) {
      this.opts.log?.(
        `[worker] p2p send skip bot=${botId} peer=${peerId} reason=${result.reason}${
          result.error ? ` err=${result.error}` : ""
        }`,
      );
      throw new Error(`P2P delivery failed: ${result.reason}`);
    }
    this.opts.log?.(
      `[worker] p2p sent bot=${botId} peer=${peerId}`,
    );
  }

  private async sendHumanParts(
    client: ILinkClient,
    peerId: string,
    contextToken: string,
    parts: ReplyPart[],
    ownerUserId: string,
    delivery?: InboundDelivery,
  ): Promise<void> {
    const list = parts.filter(
      (p) =>
        (p.kind === "text" && p.text.trim()) ||
        (p.kind === "sticker" && p.slug.trim()),
    );
    if (!list.length) return;

    for (let i = 0; i < list.length; i++) {
      const part = list[i]!;
      const delayHint =
        part.kind === "text" ? part.text : `[表情:${part.slug}]`;
      const delay = humanDelayMs(delayHint, i, this.opts.replyDelay);
      // Re-assert between bubbles: the character is still "typing", and the
      // caller's finally clears it once the last bubble is out.
      void client
        .startTyping({ toUserId: peerId, contextToken })
        .catch(() => undefined);
      await sleep(delay);
      if (delay > 2000) {
        void client
          .startTyping({ toUserId: peerId, contextToken })
          .catch(() => undefined);
        await sleep(rand(200, 500));
      }
      const send = () => this.sendReplyPart(
        delivery ? delivery.client(client, `part:${i}`) : client,
        peerId,
        contextToken,
        part,
        ownerUserId,
      );
      if (delivery) await delivery.step(`part:${i}`, send);
      else await send();
    }
  }

  private async sendReplyPart(
    client: ILinkClient,
    peerId: string,
    contextToken: string,
    part: ReplyPart,
    ownerUserId: string,
  ): Promise<void> {
    if (part.kind === "text") {
      // A `[表情:slug]` token this far down means the parse side failed to
      // claim it as a sticker (unknown slug, malformed). stripAllStickerJson
      // removes it below — say so, because silently shipping the surrounding
      // sentence is how this went unnoticed the first time.
      if (hasStickerTextToken(part.text)) {
        this.opts.log?.(
          `[worker] stripped sticker token from text peer=${peerId}`,
        );
      }
      // Absolute guard: strip any sticker JSON residue before WeChat text send
      const text = stripAllStickerJson(part.text).trim();
      if (!text) return;
      // If somehow only JSON remained and strip emptied it — do not send
      if (/^\s*\{[\s\S]*"type"\s*:\s*"sticker"[\s\S]*\}\s*$/i.test(part.text)) {
        this.opts.log?.(
          `[worker] blocked raw sticker JSON as text peer=${peerId}`,
        );
        return;
      }
      await client.sendText({
        toUserId: peerId,
        text,
        contextToken,
      });
      return;
    }

    if (this.opts.stickerSendEnabled === false) {
      this.opts.log?.(
        `[worker] sticker disabled, skip slug=${part.slug}`,
      );
      return;
    }

    try {
      if (!ownerUserId) {
        this.opts.log?.(
          `[worker] no bot owner, skip sticker slug=${part.slug}`,
        );
        return;
      }
      const meta = await userCanUseStickerSlug(
        this.opts.db,
        ownerUserId,
        part.slug,
      );
      if (!meta) {
        this.opts.log?.(
          `[worker] sticker not allowed for owner slug=${part.slug}`,
        );
        return;
      }
      const image = await getStickerBlob(this.opts.db, meta.id);
      if (!image?.length) {
        this.opts.log?.(
          `[worker] sticker blob missing slug=${part.slug} id=${meta.id}`,
        );
        return;
      }
      await client.sendImage({
        toUserId: peerId,
        contextToken,
        image,
      });
      this.opts.log?.(
        `[worker] sent sticker slug=${part.slug} bytes=${image.length}`,
      );
    } catch (err) {
      this.opts.log?.(
        `[worker] sticker send failed slug=${part.slug}: ${(err as Error).message}`,
      );
      throw err;
    }
  }
}

function rand(a: number, b: number): number {
  return Math.round(a + Math.random() * (b - a));
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
