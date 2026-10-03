import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  openDatabase, K, persistInbound, claimInbound, acknowledgeInbound,
  inboundQueueKeys, deleteInboundQueue, type Db, type InboundJob,
} from "@wechat-ai/db";
import type { ILinkClient } from "@wechat-ai/ilink";
import { InboundDelivery } from "./inbound-delivery.js";

const redisUrl = process.env.WECHAT_AI_TEST_REDIS_URL;
describe("reply checkpoints (Redis + controlled iLink sender)", { skip: !redisUrl }, () => {
  let db: Db;
  const prefix = `delivery-test-${randomUUID()}`;
  const jobs: InboundJob[] = [];
  before(async () => { db = openDatabase(redisUrl!); await db.ping(); });
  after(async () => {
    for (const job of jobs) {
      await deleteInboundQueue(db, job.botId);
      await db.redis.del(K.bot(job.botId), K.botLease(job.botId), K.inboundSeen(job.id));
    }
    await db.close();
  });
  async function setup() {
    const id = `${prefix}-${jobs.length}`;
    const job = { id, botId: id, peerId: "peer", contextToken: "context", text: "hello", mediaOnly: false, enqueuedAt: new Date().toISOString() };
    jobs.push(job);
    await db.redis.set(K.bot(id), "{}");
    await db.redis.set(K.botLease(id), "a", "EX", 45);
    await persistInbound(db, "a", job, 100);
    return job;
  }

  it("does not regenerate or resend confirmed bubbles after a crash before ACK", async () => {
    const job = await setup();
    let generated = 0;
    const sent: string[] = [];
    const client = { async sendText(p: { text: string }) { sent.push(p.text); return { ret: 0 }; } } as unknown as ILinkClient;
    const first = (await claimInbound(db, job.botId, "a"))!;
    const a = new InboundDelivery(db, first);
    const response = await a.step("chat", async () => { generated++; return "reply"; });
    await a.client(client).sendText({ text: response, toUserId: "peer", contextToken: "context" });
    a.close(); // simulate process loss before ACK
    await db.redis.zadd(inboundQueueKeys(job.botId).active, 0, job.peerId);
    await db.redis.set(K.botLease(job.botId), "b", "EX", 45);
    const recovered = (await claimInbound(db, job.botId, "b"))!;
    const b = new InboundDelivery(db, recovered);
    try {
      const replay = await b.step("chat", async () => { generated++; return "wrong regeneration"; });
      await b.client(client).sendText({ text: replay, toUserId: "peer", contextToken: "context" });
      await acknowledgeInbound(db, recovered);
      assert.equal(generated, 1);
      assert.deepEqual(sent, ["reply"]);
    } finally { b.close(); }
  });

  it("reuses client_id when a send succeeded but its acknowledgement was lost", async () => {
    const job = await setup();
    const ids: string[] = [];
    const client = { async sendText(p: { clientId: string }) {
      ids.push(p.clientId);
      if (ids.length === 1) throw new Error("connection closed after server accepted send");
      return { ret: 0 };
    } } as unknown as ILinkClient;
    const first = (await claimInbound(db, job.botId, "a"))!;
    const a = new InboundDelivery(db, first);
    try {
      await assert.rejects(a.client(client).sendText({ text: "reply", toUserId: "peer", contextToken: "context" }));
    } finally { a.close(); }
    await db.redis.zadd(inboundQueueKeys(job.botId).active, 0, job.peerId);
    const recovered = (await claimInbound(db, job.botId, "a"))!;
    const b = new InboundDelivery(db, recovered);
    try {
      await b.client(client).sendText({ text: "reply", toUserId: "peer", contextToken: "context" });
      assert.equal(ids.length, 2);
      assert.equal(ids[0], ids[1]);
      await acknowledgeInbound(db, recovered);
    } finally { b.close(); }
  });

  it("fences a stale processor before another outbound request", async () => {
    const job = await setup();
    const claim = (await claimInbound(db, job.botId, "a"))!;
    const delivery = new InboundDelivery(db, claim);
    let sends = 0;
    const client = { async sendText() { sends++; return { ret: 0 }; } } as unknown as ILinkClient;
    await db.redis.zadd(inboundQueueKeys(job.botId).active, 0, job.peerId);
    try {
      await assert.rejects(delivery.client(client).sendText({ text: "stale", toUserId: "peer", contextToken: "context" }), /lease lost/);
      assert.equal(sends, 0);
    } finally { delivery.close(); }
  });
});
