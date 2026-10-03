import { randomUUID } from "node:crypto";
import type { RedisStore } from "./client.js";
import { K } from "./keys.js";
import type { InboundJob } from "./worker-fleet.js";

export interface InboundClaim<T extends InboundJob = InboundJob> {
  job: T;
  token: string;
  attempts: number;
  steps: Record<string, { value?: unknown }>;
}

export const INBOUND_LEASE_MS = 120_000;
export const INBOUND_MAX_ATTEMPTS = 3;
const DONE_TTL_SEC = 600;

// All keys live in the existing shared, non-cluster Redis database. Peer lists
// are derived from this bot's namespace inside Lua, never from caller key names.
export function inboundQueueKeys(botId: string) {
  const base = `wa:bot:${botId}:inbound:`;
  return {
    jobs: `${base}jobs`, ready: `${base}ready`, active: `${base}active`,
    claims: `${base}claims`, attempts: `${base}attempts`, steps: `${base}steps`,
    failed: `${base}failed`, errors: `${base}errors`, sequence: `${base}seq`,
    peers: `${base}peer:`,
  };
}

const TIME = "local t=redis.call('TIME'); local now=t[1]*1000+math.floor(t[2]/1000)\n";

/** Atomically accept a message; a full/unavailable inbox never marks it seen. */
export async function persistInbound(
  db: RedisStore, workerId: string, job: InboundJob, maxLen: number,
): Promise<"accepted" | "duplicate"> {
  const q = inboundQueueKeys(job.botId);
  const result = Number(await db.redis.eval(`
if redis.call('GET',KEYS[1]) ~= ARGV[1] or redis.call('EXISTS',KEYS[8]) == 0 then return -2 end
if redis.call('HEXISTS',KEYS[2],ARGV[2]) == 1 or redis.call('EXISTS',KEYS[3]) == 1 then return 0 end
if redis.call('HLEN',KEYS[2]) >= tonumber(ARGV[5]) then return -1 end
redis.call('HSET',KEYS[2],ARGV[2],ARGV[4])
local n=redis.call('RPUSH',KEYS[4],ARGV[2])
if n == 1 and not redis.call('ZSCORE',KEYS[6],ARGV[3]) then
  redis.call('ZADD',KEYS[5],redis.call('INCR',KEYS[7]),ARGV[3])
end
return 1`, 8, K.botLease(job.botId), q.jobs, K.inboundSeen(job.id),
  q.peers + job.peerId, q.ready, q.active, q.sequence,
  K.bot(job.botId),
  workerId, job.id, job.peerId, JSON.stringify(job), maxLen));
  if (result === -2) throw new Error("Inbound bot lease lost");
  if (result === -1) throw new Error("Durable inbox full; cursor not advanced");
  return result === 1 ? "accepted" : "duplicate";
}

export async function claimInbound<T extends InboundJob>(
  db: RedisStore, botId: string, workerId: string,
  leaseMs = INBOUND_LEASE_MS, maxAttempts = INBOUND_MAX_ATTEMPTS,
): Promise<InboundClaim<T> | null> {
  const q = inboundQueueKeys(botId);
  const token = randomUUID();
  const raw = await db.redis.eval(TIME + `
if redis.call('GET',KEYS[1]) ~= ARGV[1] or redis.call('EXISTS',KEYS[11]) == 0 then return nil end
local expired=redis.call('ZRANGEBYSCORE',KEYS[3],'-inf',now,'LIMIT',0,32)
for _,peer in ipairs(expired) do
  redis.call('ZREM',KEYS[3],peer)
  redis.call('HDEL',KEYS[4],peer)
  redis.call('ZADD',KEYS[2],redis.call('INCR',KEYS[10]),peer)
end
local peers=redis.call('ZRANGE',KEYS[2],0,0)
if #peers == 0 then return nil end
local peer=peers[1]
local list=ARGV[4]..peer
local id=redis.call('LINDEX',list,0)
if not id then return redis.error_reply('Missing inbound peer queue') end
local payload=redis.call('HGET',KEYS[5],id)
if not payload then return redis.error_reply('Missing inbound payload') end
redis.call('ZREM',KEYS[2],peer)
local attempts=redis.call('HINCRBY',KEYS[6],id,1)
if attempts > tonumber(ARGV[5]) then
  redis.call('LPOP',list)
  redis.call('ZADD',KEYS[8],now,id)
  redis.call('HSET',KEYS[9],id,'retry_exhausted')
  if redis.call('LLEN',list) > 0 then redis.call('ZADD',KEYS[2],redis.call('INCR',KEYS[10]),peer) end
  return nil
end
redis.call('ZADD',KEYS[3],now+tonumber(ARGV[3]),peer)
redis.call('HSET',KEYS[4],peer,ARGV[2])
return {payload,tostring(attempts),redis.call('HGET',KEYS[7],id) or '{}'}`,
  11, K.botLease(botId), q.ready, q.active, q.claims, q.jobs, q.attempts,
  q.steps, q.failed, q.errors, q.sequence, K.bot(botId),
  workerId, token, leaseMs, q.peers, maxAttempts) as string[] | null;
  if (!raw) return null;
  return { job: JSON.parse(raw[0]!) as T, token, attempts: Number(raw[1]), steps: JSON.parse(raw[2]!) };
}

const OWNED = `
if redis.call('HGET',KEYS[1],ARGV[1]) ~= ARGV[2] then return 0 end
local deadline=redis.call('ZSCORE',KEYS[2],ARGV[1])
if not deadline or tonumber(deadline) <= now then return 0 end
`;

export async function renewInbound(db: RedisStore, claim: InboundClaim, leaseMs = INBOUND_LEASE_MS): Promise<boolean> {
  const q = inboundQueueKeys(claim.job.botId);
  return Number(await db.redis.eval(TIME + OWNED + `
redis.call('ZADD',KEYS[2],now+tonumber(ARGV[3]),ARGV[1]); return 1`,
  2, q.claims, q.active, claim.job.peerId, claim.token, leaseMs)) === 1;
}

export async function saveInboundSteps(db: RedisStore, claim: InboundClaim): Promise<void> {
  const q = inboundQueueKeys(claim.job.botId);
  const ok = await db.redis.eval(TIME + OWNED + `
redis.call('HSET',KEYS[3],ARGV[3],ARGV[4]); return 1`,
  3, q.claims, q.active, q.steps, claim.job.peerId, claim.token,
  claim.job.id, JSON.stringify(claim.steps));
  if (Number(ok) !== 1) throw new Error("Inbound processing lease lost");
}

/** ACK is the only normal path that deletes a pending payload. */
export async function acknowledgeInbound(db: RedisStore, claim: InboundClaim): Promise<void> {
  const q = inboundQueueKeys(claim.job.botId);
  const ok = await db.redis.eval(TIME + OWNED + `
if redis.call('LINDEX',KEYS[3],0) ~= ARGV[3] then return 0 end
redis.call('LPOP',KEYS[3])
redis.call('HDEL',KEYS[1],ARGV[1]); redis.call('ZREM',KEYS[2],ARGV[1])
for i=4,7 do redis.call('HDEL',KEYS[i],ARGV[3]) end
redis.call('SET',KEYS[8],'1','EX',ARGV[4])
if redis.call('LLEN',KEYS[3]) > 0 then redis.call('ZADD',KEYS[9],redis.call('INCR',KEYS[10]),ARGV[1]) end
return 1`, 10, q.claims, q.active, q.peers + claim.job.peerId,
  q.jobs, q.steps, q.attempts, q.errors, K.inboundSeen(claim.job.id), q.ready, q.sequence,
  claim.job.peerId, claim.token, claim.job.id, DONE_TTL_SEC);
  if (Number(ok) !== 1) throw new Error("Inbound acknowledgement lease lost");
}

/** Retain payload/checkpoints, release the peer after a bounded retry delay. */
export async function retryInbound(db: RedisStore, claim: InboundClaim, delayMs = 2000): Promise<void> {
  const q = inboundQueueKeys(claim.job.botId);
  await db.redis.eval(TIME + OWNED + `
redis.call('HSET',KEYS[3],ARGV[3],'processing_failed')
redis.call('ZADD',KEYS[2],now+tonumber(ARGV[4]),ARGV[1]); return 1`,
  3, q.claims, q.active, q.errors, claim.job.peerId, claim.token, claim.job.id, delayMs);
}

export async function inboundQueueStats(db: RedisStore, botIds: string[]): Promise<{ pending: number; failed: number }> {
  if (!botIds.length) return { pending: 0, failed: 0 };
  const pipe = db.redis.pipeline();
  for (const id of botIds) {
    const q = inboundQueueKeys(id);
    pipe.hlen(q.jobs).zcard(q.failed);
  }
  const rows = await pipe.exec();
  if (!rows) throw new Error("Missing inbox stats");
  for (const [err] of rows) if (err) throw err;
  let pending = 0, failed = 0;
  for (let i = 0; i < rows.length; i += 2) {
    const count = Number(rows[i + 1]![1]);
    pending += Number(rows[i]![1]) - count;
    failed += count;
  }
  return { pending, failed };
}

export async function listFailedInbound(db: RedisStore, botId: string) {
  const q = inboundQueueKeys(botId);
  const ids = await db.redis.zrange(q.failed, 0, 99);
  if (!ids.length) return [];
  const [jobs, errors] = await Promise.all([db.redis.hmget(q.jobs, ...ids), db.redis.hmget(q.errors, ...ids)]);
  return ids.map((id, i) => {
    const job = jobs[i] ? JSON.parse(jobs[i]!) as InboundJob : null;
    return { id, peerId: job?.peerId, enqueuedAt: job?.enqueuedAt, error: errors[i] };
  });
}

export async function retryFailedInbound(db: RedisStore, botId: string, id: string): Promise<boolean> {
  const q = inboundQueueKeys(botId);
  return Number(await db.redis.eval(`
local raw=redis.call('HGET',KEYS[1],ARGV[1])
if not raw or not redis.call('ZSCORE',KEYS[2],ARGV[1]) then return 0 end
local job=cjson.decode(raw); local list=ARGV[2]..job.peerId
redis.call('ZREM',KEYS[2],ARGV[1]); redis.call('HDEL',KEYS[3],ARGV[1]); redis.call('HDEL',KEYS[4],ARGV[1])
local n=redis.call('RPUSH',list,ARGV[1])
if n == 1 and not redis.call('ZSCORE',KEYS[6],job.peerId) then
  redis.call('ZADD',KEYS[5],redis.call('INCR',KEYS[7]),job.peerId)
end
return 1`, 7, q.jobs, q.failed, q.attempts, q.errors, q.ready, q.active, q.sequence, id, q.peers)) === 1;
}

/** Called after deleting the bot record; also invalidates in-flight claim tokens. */
export async function deleteInboundQueue(db: RedisStore, botId: string): Promise<void> {
  const q = inboundQueueKeys(botId);
  const keys = [q.ready, q.active, q.jobs, q.claims, q.attempts, q.steps, q.failed, q.errors, q.sequence];
  await db.redis.eval(`
for i=1,2 do
  for _,peer in ipairs(redis.call('ZRANGE',KEYS[i],0,-1)) do redis.call('DEL',ARGV[1]..peer) end
end
for _,key in ipairs(KEYS) do redis.call('DEL',key) end
return 1`, keys.length, ...keys, q.peers);
}
