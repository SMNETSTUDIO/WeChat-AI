import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { openDatabase, type RedisStore } from "./client.js";
import { K } from "./keys.js";
import {
  claimBotLeases,
  releaseBotLease,
  releaseOwnedLeasesBatch,
  renewOwnedLeases,
} from "./worker-fleet.js";

// Real Redis is required: mocking EVAL would merely repeat the implementation.
// Use a disposable database. Tests only remove their own keys/set members.
const redisUrl = process.env.WECHAT_AI_TEST_REDIS_URL;

describe("bot leases across a node handoff", { skip: !redisUrl }, () => {
  let db: RedisStore;
  const prefix = `lease-test-${randomUUID()}`;
  const oldWorker = `${prefix}-old`;
  const newWorker = `${prefix}-new`;
  const bots: string[] = [];

  before(async () => {
    db = openDatabase(redisUrl!);
    await db.ping();
  });

  after(async () => {
    if (!db) return;
    try {
      if (bots.length) {
        await db.redis.srem(K.botsPollable, ...bots);
        await db.redis.del(...bots.map(K.botLease));
      }
      await db.redis.del(K.workerBots(oldWorker), K.workerBots(newWorker));
    } finally {
      await db.close();
    }
  });

  async function ownBot() {
    const bot = `${prefix}-${bots.length}`;
    bots.push(bot);
    await db.redis.set(K.botLease(bot), oldWorker, "EX", 45);
    await db.redis.sadd(K.workerBots(oldWorker), bot);
    return bot;
  }

  /**
   * Reproduce a successor claiming between the old implementation's GET and
   * mutation. For a single atomic operation, hand off before it executes.
   * Ownership changes use real Redis; no Lua or Redis semantics are mocked.
   */
  function handoffDuringOperation(bot: string): RedisStore {
    let transferred = false;
    async function transfer() {
      if (transferred) return;
      transferred = true;
      await db.redis.del(K.botLease(bot));
      assert.equal(
        await db.redis.set(K.botLease(bot), newWorker, "EX", 90, "NX"),
        "OK",
      );
      await db.redis.sadd(K.workerBots(newWorker), bot);
    }
    const redis = new Proxy(db.redis, {
      get(target, property) {
        if (property === "get") return async (key: string) => {
          const result = await target.get(key);
          await transfer();
          return result;
        };
        if (property === "eval") return async (...args: unknown[]) => {
          await transfer();
          return Reflect.apply(target.eval, target, args);
        };
        if (property === "pipeline") return () => {
          const pipe = target.pipeline();
          let readsOwner = false;
          const get = pipe.get.bind(pipe);
          pipe.get = ((...args: Parameters<typeof get>) => {
            readsOwner = true;
            return get(...args);
          }) as typeof pipe.get;
          const exec = pipe.exec.bind(pipe);
          pipe.exec = (async () => {
            if (!readsOwner) await transfer();
            const result = await exec();
            if (readsOwner) await transfer();
            return result;
          }) as typeof pipe.exec;
          return pipe;
        };
        const value = Reflect.get(target, property);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    return { redis } as RedisStore;
  }

  it("does not overwrite a successor's lease when renewing", async () => {
    const bot = await ownBot();
    const result = await renewOwnedLeases(handoffDuringOperation(bot), oldWorker, [bot], 45);
    assert.equal(await db.redis.get(K.botLease(bot)), newWorker);
    assert.deepEqual(result, { renewed: [], lost: [bot] });
    assert.equal(await db.redis.sismember(K.workerBots(oldWorker), bot), 0);
    assert.equal(await db.redis.sismember(K.workerBots(newWorker), bot), 1);
    assert.ok((await db.redis.ttl(K.botLease(bot))) > 45);
  });

  it("does not delete a successor's lease on single-bot release", async () => {
    const bot = await ownBot();
    await releaseBotLease(handoffDuringOperation(bot), oldWorker, bot);
    assert.equal(await db.redis.get(K.botLease(bot)), newWorker);
    assert.equal(await db.redis.sismember(K.workerBots(oldWorker), bot), 0);
  });

  it("does not delete a successor's lease during rebalance or shutdown", async () => {
    const bot = await ownBot();
    const released = await releaseOwnedLeasesBatch(handoffDuringOperation(bot), oldWorker, [bot]);
    assert.equal(await db.redis.get(K.botLease(bot)), newWorker);
    assert.deepEqual(released, []);
    assert.equal(await db.redis.sismember(K.workerBots(oldWorker), bot), 0);
  });

  it("renews owned leases, reports expired leases, and releases only owned bots", async () => {
    const owned = await ownBot();
    const expired = await ownBot();
    await db.redis.del(K.botLease(expired));
    assert.deepEqual(await renewOwnedLeases(db, oldWorker, [owned, expired], 60), {
      renewed: [owned], lost: [expired],
    });
    assert.ok((await db.redis.ttl(K.botLease(owned))) > 45);
    assert.deepEqual(await releaseOwnedLeasesBatch(db, oldWorker, [owned, expired]), [owned]);
    assert.equal(await db.redis.get(K.botLease(owned)), null);
    assert.equal(await db.redis.sismember(K.workerBots(oldWorker), owned), 0);
    assert.equal(await db.redis.sismember(K.workerBots(oldWorker), expired), 0);
  });

  it("propagates Redis renewal errors instead of reporting a successful renewal", async () => {
    const bot = await ownBot();
    await assert.rejects(renewOwnedLeases(db, oldWorker, [bot], Number.NaN));
    assert.equal(await db.redis.get(K.botLease(bot)), oldWorker);
  });

  it("propagates Redis release errors without deleting the lease", async () => {
    const bot = await ownBot();
    await db.redis.set(K.workerBots(oldWorker), "wrong-type");
    try {
      await assert.rejects(releaseOwnedLeasesBatch(db, oldWorker, [bot]), /WRONGTYPE/);
      assert.equal(await db.redis.get(K.botLease(bot)), oldWorker);
    } finally {
      await db.redis.del(K.workerBots(oldWorker));
    }
  });

  it("does not delete a successor's overclaimed lease when trimming capacity", async () => {
    const candidates = [await ownBot(), await ownBot()];
    await db.redis.del(...candidates.map(K.botLease));
    await db.redis.srem(K.workerBots(oldWorker), ...candidates);
    await db.redis.sadd(K.botsPollable, ...candidates);
    let successorBot: string | undefined;
    const redis = new Proxy(db.redis, {
      get(target, property) {
        // Isolate this claim attempt from unrelated bots in the test database.
        if (property === "smembers") return async () => [...candidates];
        if (property === "sadd") return async (key: string, ...members: string[]) => {
          const result = await target.sadd(key, ...members);
          successorBot = candidates.find((id) => !members.includes(id))!;
          await target.set(K.botLease(successorBot), newWorker, "EX", 90);
          await target.sadd(K.workerBots(newWorker), successorBot);
          return result;
        };
        const value = Reflect.get(target, property);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const claimed = await claimBotLeases({ redis } as RedisStore, oldWorker, 1, 45);
    assert.equal(claimed.length, 1);
    assert.equal(await db.redis.get(K.botLease(claimed[0]!)), oldWorker);
    assert.ok(successorBot);
    assert.equal(await db.redis.get(K.botLease(successorBot)), newWorker);
  });
});
