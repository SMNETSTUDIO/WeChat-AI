import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { openDatabase, type RedisStore } from "./client.js";
import { K } from "./keys.js";
import { deleteBotAccount, setBotCursor } from "./repos.js";
import type { InboundJob } from "./worker-fleet.js";
import {
  persistInbound, claimInbound, renewInbound, saveInboundSteps,
  acknowledgeInbound, inboundQueueKeys, inboundQueueStats,
  listFailedInbound, retryFailedInbound, type InboundClaim,
} from "./inbound-queue.js";

const redisUrl = process.env.WECHAT_AI_TEST_REDIS_URL;
describe("durable inbound delivery (real Redis)", { skip: !redisUrl }, () => {
  let db: RedisStore;
  const prefix = `inbox-test-${randomUUID()}`;
  const jobs: InboundJob[] = [];
  const bots: string[] = [];
  before(async () => { db = openDatabase(redisUrl!); await db.ping(); });
  after(async () => {
    if (!db) return;
    try {
      for (const bot of bots) await db.redis.del(K.bot(bot), K.botLease(bot), ...Object.values(inboundQueueKeys(bot)));
      for (const job of jobs) await db.redis.del(K.inboundSeen(job.id), inboundQueueKeys(job.botId).peers + job.peerId);
    } finally { await db.close(); }
  });
  async function bot() {
    const id = `${prefix}-${bots.length}`;
    bots.push(id);
    await db.redis.set(K.bot(id), "{}");
    await db.redis.set(K.botLease(id), "a", "EX", 45);
    return id;
  }
  function job(botId: string, peerId = "peer"): InboundJob {
    const value = { id: `${prefix}-job-${jobs.length}`, botId, peerId, text: "hello", contextToken: "private-context", mediaOnly: false, enqueuedAt: new Date().toISOString() };
    jobs.push(value);
    return value;
  }
  async function expire(claim: InboundClaim) {
    await db.redis.zadd(inboundQueueKeys(claim.job.botId).active, 0, claim.job.peerId);
  }

  it("atomically deduplicates acceptance and leaves rejected messages replayable", async () => {
    const id = await bot(), first = job(id), second = job(id);
    const results = await Promise.all([persistInbound(db, "a", first, 1), persistInbound(db, "a", first, 1)]);
    assert.deepEqual(results.sort(), ["accepted", "duplicate"]);
    await assert.rejects(persistInbound(db, "a", second, 1), /full/);
    assert.equal(await db.redis.exists(K.inboundSeen(second.id)), 0);
    const claim = (await claimInbound(db, id, "a"))!;
    await acknowledgeInbound(db, claim);
    assert.equal(await persistInbound(db, "a", second, 1), "accepted");
    assert.equal(await persistInbound(db, "a", first, 1), "duplicate");
  });

  it("keeps same-peer order across handoff while allowing other peers to progress", async () => {
    const id = await bot(), first = job(id), second = job(id), other = job(id, "other");
    for (const item of [first, second, other]) await persistInbound(db, "a", item, 10);
    const old = (await claimInbound(db, id, "a"))!;
    assert.equal(old.job.id, first.id);
    await db.redis.set(K.botLease(id), "b", "EX", 45);
    assert.equal(await claimInbound(db, id, "a"), null);
    const parallel = (await claimInbound(db, id, "b"))!;
    assert.equal(parallel.job.id, other.id);
    assert.equal(await claimInbound(db, id, "b"), null);
    assert.equal(await renewInbound(db, old), true, "old in-flight job may finish independently of polling ownership");
    await expire(old);
    const recovered = (await claimInbound(db, id, "b"))!;
    assert.equal(recovered.job.id, first.id);
    assert.equal(recovered.attempts, 2);
    await assert.rejects(acknowledgeInbound(db, old), /lease lost/);
    await assert.rejects(saveInboundSteps(db, old), /lease lost/);
    await acknowledgeInbound(db, recovered);
    const next = (await claimInbound(db, id, "b"))!;
    assert.equal(next.job.id, second.id);
    await acknowledgeInbound(db, next);
    await acknowledgeInbound(db, parallel);
    assert.deepEqual(await inboundQueueStats(db, [id]), { pending: 0, failed: 0 });
  });

  it("recovers media coordinates and completed generation/send checkpoints after a lost worker", async () => {
    const id = await bot();
    const item = { ...job(id), mediaRefs: [{ kind: "image", aesKey: "private-media-key", encryptQueryParam: "private-query" }] };
    await persistInbound(db, "a", item, 10);
    const old = (await claimInbound<typeof item>(db, id, "a"))!;
    old.steps.chat = { value: { text: "generated once" } };
    old.steps["send:0:sendText"] = { value: { ret: 0 } };
    await saveInboundSteps(db, old);
    await expire(old);
    await db.close();
    db = openDatabase(redisUrl!);
    await db.redis.set(K.botLease(id), "b", "EX", 45);
    const recovered = (await claimInbound<typeof item>(db, id, "b"))!;
    assert.deepEqual(recovered.job, item);
    assert.deepEqual(recovered.steps, old.steps);
    assert.equal(await persistInbound(db, "b", item, 10), "duplicate");
    await acknowledgeInbound(db, recovered);
  });

  it("retains exhausted work for inspection and explicit retry without exposing payloads", async () => {
    const id = await bot(), item = job(id);
    await persistInbound(db, "a", item, 10);
    for (let n = 0; n < 3; n++) {
      const claim = (await claimInbound(db, id, "a"))!;
      assert.equal(claim.attempts, n + 1);
      await expire(claim);
    }
    assert.equal(await claimInbound(db, id, "a"), null);
    assert.deepEqual(await inboundQueueStats(db, [id]), { pending: 0, failed: 1 });
    const failed = await listFailedInbound(db, id);
    assert.equal(failed[0]!.id, item.id);
    assert.ok(!JSON.stringify(failed).includes(item.contextToken));
    assert.ok(!Object.hasOwn(failed[0]!, "text"));
    assert.equal(await retryFailedInbound(db, id, item.id), true);
    assert.equal(await retryFailedInbound(db, id, item.id), false);
    const retried = (await claimInbound(db, id, "a"))!;
    assert.equal(retried.attempts, 1);
    await acknowledgeInbound(db, retried);
    assert.equal(await db.redis.hlen(inboundQueueKeys(id).jobs), 0);
  });

  it("never renews an expired processing claim or accepts from a stale polling node", async () => {
    const id = await bot(), item = job(id);
    await persistInbound(db, "a", item, 10);
    const claim = (await claimInbound(db, id, "a"))!;
    await expire(claim);
    assert.equal(await renewInbound(db, claim), false);
    await db.redis.set(K.botLease(id), "b", "EX", 45);
    const next = job(id);
    await assert.rejects(persistInbound(db, "a", next, 10), /lease lost/);
    assert.equal(await db.redis.hexists(inboundQueueKeys(id).jobs, next.id), 0);
  });

  it("deletes queued, active and failed payloads with the bot and fences old processors", async () => {
    const id = await bot();
    const active = job(id, "active"), queued = job(id, "queued"), failed = job(id, "failed");
    for (const item of [active, queued, failed]) await persistInbound(db, "a", item, 10);
    const first = (await claimInbound(db, id, "a"))!;
    const second = (await claimInbound(db, id, "a"))!;
    const third = (await claimInbound(db, id, "a"))!;
    third.steps.chat = { value: "sensitive generated reply" };
    await saveInboundSteps(db, third);
    await expire(third);
    assert.equal(await claimInbound(db, id, "a", 120_000, 1), null);
    assert.equal((await listFailedInbound(db, id)).length, 1);
    await persistInbound(db, "a", job(id, "unstarted"), 10);
    assert.equal(await deleteBotAccount(db, id), true);
    assert.equal(await renewInbound(db, first), false);
    await assert.rejects(acknowledgeInbound(db, second), /lease lost/);
    for (const item of jobs.filter((x) => x.botId === id)) {
      assert.equal(await db.redis.exists(inboundQueueKeys(id).peers + item.peerId), 0);
    }
    for (const key of Object.values(inboundQueueKeys(id))) assert.equal(await db.redis.exists(key), 0);
    await db.redis.set(K.botLease(id), "a", "EX", 45); // delayed stale owner
    await assert.rejects(persistInbound(db, "a", active, 10), /lease lost/);
    assert.equal(await claimInbound(db, id, "a"), null);
    await assert.rejects(setBotCursor(db, id, "stale", "a"), /lease lost/);
    assert.equal(await db.redis.exists(K.bot(id)), 0);
  });

  it("fences cursor commits after polling ownership changes", async () => {
    const id = await bot();
    await setBotCursor(db, id, "accepted", "a");
    await db.redis.set(K.botLease(id), "b", "EX", 45);
    await assert.rejects(setBotCursor(db, id, "stale", "a"), /lease lost/);
    assert.equal((await db.getJson<{ updates_cursor: string }>(K.bot(id)))!.updates_cursor, "accepted");
    await setBotCursor(db, id, "successor", "b");
    assert.equal((await db.getJson<{ updates_cursor: string }>(K.bot(id)))!.updates_cursor, "successor");
  });
});
