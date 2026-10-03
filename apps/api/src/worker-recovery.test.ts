import assert from "node:assert/strict";
import { after, before, describe, it, mock } from "node:test";
import { randomUUID } from "node:crypto";
import {
  openDatabase, K, inboundQueueKeys, inboundQueueStats, deleteInboundQueue,
  type Db, type InboundJob,
} from "@wechat-ai/db";
import { ILinkClient, type WeixinMessage } from "@wechat-ai/ilink";
import type { ChatService, InboundChatResult } from "@wechat-ai/core";
import { BotWorkerManager } from "./worker.js";

// Exercise the real worker paths with Redis and controlled external services.
interface Internals {
  workerId: string;
  loops: Map<string, Promise<void>>;
  loopGen: Map<string, number>;
  clients: Map<string, ILinkClient>;
  replyWorkers: Promise<void>[];
  inboxScanAfter: number;
  inboxMaxLen: number;
  enqueueFromMessage(bot: string, client: ILinkClient, msg: WeixinMessage): Promise<void>;
  shedLeases(n: number, local: number, ctx: { target: number; slack: number }): Promise<void>;
  runReplyConsumer(n: number): Promise<void>;
  runPollLoop(bot: string, gen: number): Promise<void>;
}
const redisUrl = process.env.WECHAT_AI_TEST_REDIS_URL;
const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
async function until(check: () => boolean | Promise<boolean>) {
  const end = Date.now() + 8000;
  while (!await check()) {
    assert.ok(Date.now() < end, "worker condition timed out");
    await pause(20);
  }
}
function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}

describe("worker recovery through real polling/reply paths", { skip: !redisUrl }, () => {
  let db: Db;
  const prefix = `worker-recovery-${randomUUID()}`;
  const bots: string[] = [];
  const managers: BotWorkerManager[] = [];
  const jobs = new Set<string>();
  before(async () => { db = openDatabase(redisUrl!); await db.ping(); });
  after(async () => {
    mock.restoreAll();
    for (const manager of managers) await manager.stopAsync(1000);
    for (const bot of bots) {
      await deleteInboundQueue(db, bot);
      await db.redis.del(K.bot(bot), K.botLease(bot), K.botCreds(bot), K.contextToken(bot, "peer"));
    }
    for (const id of jobs) await db.redis.del(K.inboundSeen(id));
    await db.close();
  });
  async function bot() {
    const id = `${prefix}-${bots.length}`;
    bots.push(id);
    await db.redis.set(K.bot(id), JSON.stringify({ id, status: "active", updates_cursor: "before" }));
    return id;
  }
  function manager(handle: (p: { text: string }) => Promise<InboundChatResult>) {
    const m = new BotWorkerManager({
      db, chat: { handleInbound: handle } as unknown as ChatService, p2pEnabled: false,
      replyDelay: { msPerChar: 0, minMs: 0, maxMs: 0, firstMinMs: 0, firstMaxMs: 0, thinkExtraMs: 0 },
    });
    managers.push(m);
    const inner = m as unknown as Internals;
    inner.workerId = `${prefix}-node-${managers.length}`;
    return { m, inner };
  }
  function client(send: (p: { text: string; clientId?: string }) => Promise<void>) {
    return {
      async startTyping() {}, async stopTyping() {},
      async sendText(p: { text: string; clientId?: string }) { await send(p); return { ret: 0 }; },
    } as unknown as ILinkClient;
  }
  async function own(inner: Internals, id: string, sender: ILinkClient) {
    await db.redis.set(K.botLease(id), inner.workerId, "EX", 45);
    await db.redis.sadd(K.workerBots(inner.workerId), id);
    inner.loops.set(id, Promise.resolve());
    inner.clients.set(id, sender);
  }
  function message(text: string, time = 1): WeixinMessage {
    return { message_type: 1, from_user_id: "peer", context_token: "private-context", create_time_ms: time, item_list: [{ type: 1, text_item: { text } }] };
  }
  async function enqueue(inner: Internals, id: string, sender: ILinkClient, text: string, time = 1) {
    await inner.enqueueFromMessage(id, sender, message(text, time));
    for (const key of await db.redis.hkeys(inboundQueueKeys(id).jobs)) jobs.add(key);
  }
  function consume(inner: Internals) { inner.replyWorkers.push(inner.runReplyConsumer(0)); }
  async function empty(id: string) { return (await inboundQueueStats(db, [id])).pending === 0; }

  it("replies to persisted messages after rebalance removes the receiving node's client", async () => {
    const id = await bot(), sent: string[] = [];
    const sender = client(async (p) => { sent.push(p.text); });
    const a = manager(async () => { throw new Error("old node must not generate"); });
    const b = manager(async () => ({ kind: "reply", text: "recovered" }));
    await own(a.inner, id, sender);
    await enqueue(a.inner, id, sender, "hello");
    await a.inner.shedLeases(1, 1, { target: 0, slack: 0 });
    assert.equal(a.inner.clients.has(id), false);
    await own(b.inner, id, sender);
    consume(b.inner);
    await until(() => empty(id));
    assert.deepEqual(sent, ["recovered"]);
  });

  it("lets an in-flight old owner finish and keeps the successor's next reply ordered", async () => {
    const id = await bot(), sent: string[] = [], started = gate(), finish = gate();
    const sender = client(async (p) => { sent.push(p.text); });
    const a = manager(async () => { started.release(); await finish.promise; return { kind: "reply", text: "first" }; });
    const b = manager(async () => ({ kind: "reply", text: "second" }));
    try {
      await own(a.inner, id, sender);
      await enqueue(a.inner, id, sender, "one");
      await enqueue(a.inner, id, sender, "two", 2);
      consume(a.inner);
      await started.promise;
      await a.inner.shedLeases(1, 1, { target: 0, slack: 0 });
      await own(b.inner, id, sender);
      consume(b.inner);
      await pause(150);
      assert.deepEqual(sent, []);
      finish.release();
      await until(() => empty(id));
      assert.deepEqual(sent, ["first", "second"]);
    } finally { finish.release(); }
  });

  it("retries a failed bubble without regenerating or resending earlier parts after settings change", async () => {
    const id = await bot(), sent: { text: string; clientId?: string }[] = [];
    let generated = 0;
    const sender = client(async (p) => {
      sent.push(p);
      if (sent.length === 2) throw new Error("ambiguous second send");
    });
    const a = manager(async () => { generated++; return { kind: "reply", bubbles: ["first", "second", "third"] }; });
    await own(a.inner, id, sender);
    await enqueue(a.inner, id, sender, "hello");
    consume(a.inner);
    await until(() => sent.length === 2);
    a.m.applyRuntimeConfig({ splitReply: false });
    await until(() => empty(id));
    assert.equal(generated, 1);
    assert.deepEqual(sent.map((p) => p.text), ["first", "second", "second", "third"]);
    assert.equal(sent[1]!.clientId, sent[2]!.clientId);
    assert.notEqual(sent[0]!.clientId, sent[1]!.clientId);
  });

  it("gracefully ACKs started work and leaves unstarted work for another node", async () => {
    const id = await bot(), sent: string[] = [], started = gate(), finish = gate();
    const sender = client(async (p) => { sent.push(p.text); });
    const a = manager(async () => { started.release(); await finish.promise; return { kind: "reply", text: "drained" }; });
    try {
      await own(a.inner, id, sender);
      await enqueue(a.inner, id, sender, "one");
      await enqueue(a.inner, id, sender, "two", 2);
      consume(a.inner);
      await started.promise;
      const stopping = a.m.stopAsync(3000);
      finish.release();
      await stopping;
      assert.deepEqual(sent, ["drained"]);
      assert.equal((await inboundQueueStats(db, [id])).pending, 1);
      const b = manager(async () => ({ kind: "reply", text: "remaining" }));
      await own(b.inner, id, sender);
      consume(b.inner);
      await until(() => empty(id));
      assert.deepEqual(sent, ["drained", "remaining"]);
    } finally { finish.release(); }
  });

  it("does not advance the poll cursor when only part of a batch fits in Redis", async () => {
    const id = await bot();
    const a = manager(async () => ({ kind: "skip" }));
    const sender = client(async () => {});
    await own(a.inner, id, sender);
    await db.redis.set(K.botCreds(id), JSON.stringify({ botToken: "test-token" }));
    a.inner.inboxMaxLen = 1;
    a.inner.loopGen.set(id, 1);
    const getUpdates = mock.method(ILinkClient.prototype, "getUpdates", async () => ({
      msgs: [message("first"), message("second", 2)], get_updates_buf: "after",
    }));
    const startTyping = mock.method(ILinkClient.prototype, "startTyping", async () => {});
    const polling = a.inner.runPollLoop(id, 1);
    try {
      await until(async () => (await db.redis.hlen(inboundQueueKeys(id).jobs)) === 1);
      a.inner.loopGen.set(id, 2);
      await polling;
      const row = JSON.parse((await db.redis.get(K.bot(id)))!);
      assert.equal(row.updates_cursor, "before");
      const pending = (await db.redis.hvals(inboundQueueKeys(id).jobs)).map((x) => JSON.parse(x) as InboundJob);
      assert.equal(pending[0]!.text, "first");
      assert.equal(await db.redis.exists(K.inboundSeen(pending[0]!.id)), 0);
      jobs.add(pending[0]!.id);
    } finally {
      a.inner.loopGen.set(id, 2);
      getUpdates.mock.restore(); startTyping.mock.restore();
      await polling;
    }
  });
});
