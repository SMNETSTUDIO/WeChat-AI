import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { randomUUID } from "node:crypto";
import Fastify from "fastify";
import {
  openDatabase, K, createLocalUser, createAppSession, deleteUserAccount,
  resolveSuperAdminId, persistInbound, claimInbound, inboundQueueKeys,
  deleteInboundQueue, type Db, type User,
} from "@wechat-ai/db";
import { loadConfig } from "./config.js";
import { registerRoutes, type RouteContext } from "./routes.js";

const redisUrl = process.env.WECHAT_AI_TEST_REDIS_URL;
describe("inbound recovery admin API", { skip: !redisUrl }, () => {
  let db: Db;
  const app = Fastify();
  const id = `inbound-admin-${randomUUID()}`;
  const users: User[] = [];
  const cookies = new Map<string, string>();
  let superId: string;
  const url = `/api/v1/admin/bots/${id}/inbox`;
  const retryUrl = `${url}/${id}/retry`;
  before(async () => {
    db = openDatabase(redisUrl!);
    await db.ping();
    for (let i = 0; i < 3; i++) {
      const user = await createLocalUser(db, {
        username: `it_${randomUUID().replaceAll("-", "").slice(0, 16)}`,
        passwordHash: "unused-test-hash", forceAdmin: i < 2,
      }, new Set());
      users.push(user);
      cookies.set(user.id, `wa_session=${await createAppSession(db, user.id)}`);
    }
    superId = (await resolveSuperAdminId(db))!;
    assert.ok(users.some((u) => u.id === superId), "use a dedicated test Redis database");
    await db.redis.set(K.bot(id), JSON.stringify({ id, status: "active" }));
    await db.redis.set(K.botLease(id), "worker", "EX", 45);
    await persistInbound(db, "worker", {
      id, botId: id, peerId: "peer", text: "private-message",
      contextToken: "private-context", mediaOnly: false, enqueuedAt: new Date().toISOString(),
      ...{ mediaRefs: [{ aesKey: "private-media-key" }] },
    }, 100);
    await claimInbound(db, id, "worker");
    await db.redis.zadd(inboundQueueKeys(id).active, 0, "peer");
    await claimInbound(db, id, "worker", 120_000, 1);
    await registerRoutes(app, {
      db, cfg: loadConfig({}), chat: {}, tryChat: {}, worker: {}, loginSessions: {},
    } as RouteContext);
    await app.ready();
  });
  after(async () => {
    await app.close();
    if (!db) return;
    await deleteInboundQueue(db, id);
    await db.redis.del(K.bot(id), K.botLease(id));
    for (const row of await db.redis.lrange(K.audit, 0, -1)) {
      if (users.some((u) => u.id === JSON.parse(row).actor)) await db.redis.lrem(K.audit, 0, row);
    }
    for (const user of users) await deleteUserAccount(db, user.id);
    await db.close();
  });

  it("requires the super-admin session for both inspection and retry", async () => {
    for (const [method, path] of [["GET", url], ["POST", retryUrl]] as const) {
      assert.equal((await app.inject({ method, url: path })).statusCode, 401);
      for (const user of users.filter((u) => u.id !== superId)) {
        assert.equal((await app.inject({ method, url: path, headers: { cookie: cookies.get(user.id)! } })).statusCode, 403);
      }
    }
    assert.equal(await db.redis.zcard(inboundQueueKeys(id).failed), 1);
  });

  it("returns only failure metadata and retries with an audit record", async () => {
    const headers = { cookie: cookies.get(superId)! };
    const response = await app.inject({ method: "GET", url, headers });
    assert.equal(response.statusCode, 200);
    assert.match(response.headers["cache-control"]!, /no-store/);
    assert.equal(response.json().failed, 1);
    assert.equal(response.json().failedJobs[0].id, id);
    for (const secret of ["private-message", "private-context", "private-media-key"]) assert.ok(!response.body.includes(secret));
    assert.equal((await app.inject({ method: "POST", url: retryUrl, headers })).statusCode, 200);
    assert.equal(await db.redis.zcard(inboundQueueKeys(id).failed), 0);
    assert.equal(await db.redis.llen(inboundQueueKeys(id).peers + "peer"), 1);
    const audit = (await db.redis.lrange(K.audit, 0, -1)).map((x) => JSON.parse(x));
    const record = audit.find((x) => x.action === "admin_inbound_retry" && x.actor === superId);
    assert.deepEqual(JSON.parse(record.meta_json), { botId: id, jobId: id });
    assert.equal((await app.inject({ method: "POST", url: retryUrl, headers })).statusCode, 404);
    assert.equal((await app.inject({ method: "GET", url: `/api/v1/admin/bots/${id}-missing/inbox`, headers })).statusCode, 404);
  });
});
