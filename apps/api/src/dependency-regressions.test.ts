import assert from "node:assert/strict";
import { it } from "node:test";
import { createRequire } from "node:module";
import { connect } from "node:http2";
import Fastify from "fastify";

const require = createRequire(import.meta.url);
const fromFastify = createRequire(require.resolve("fastify"));
const fromCompiler = createRequire(fromFastify.resolve("@fastify/ajv-compiler"));
const fromAjv = createRequire(fromCompiler.resolve("ajv"));

it("normalizes encoded host case in both installed fast-uri major versions", () => {
  for (const uri of [fromCompiler("fast-uri"), fromAjv("fast-uri")]) {
    for (const encoded of ["//%41.com", "//%4a.com"]) {
      const canonical = encoded.replace("%41", "a").replace("%4a", "j");
      assert.equal(uri.parse(encoded).host, uri.parse(canonical).host);
      assert.equal(uri.equal(encoded, canonical), true);
    }
    assert.equal(uri.equal("//A.com", "//a.com"), true);
  }
});

it("keeps mailto recipients and reserved headers stable through a round trip", () => {
  const uri = fromCompiler("fast-uri");
  for (const query of ["%74o=other@example.com", "%73ubject=hello", "%62ody=hello", "subject=hello%20world"]) {
    const parsed = uri.parse(`mailto:user@example.com?${query}`);
    const reparsed = uri.parse(uri.serialize(parsed));
    assert.deepEqual(reparsed.to, parsed.to);
    assert.equal(reparsed.subject, parsed.subject);
    assert.equal(reparsed.body, parsed.body);
  }
});

it("serves an HTTP/2 trailer response without an uncaught header exception", { timeout: 10_000 }, async () => {
  const app = Fastify({ http2: true });
  app.get("/", async (_request, reply) => {
    reply.trailer("x-checksum", async () => "ok");
    return "hello";
  });
  const address = await app.listen({ host: "127.0.0.1", port: 0 });
  const session = connect(address);
  try {
    const body = await new Promise<string>((resolve, reject) => {
      session.once("error", reject);
      const request = session.request({ ":path": "/" });
      let text = "";
      request.setEncoding("utf8");
      request.on("data", (chunk) => { text += chunk; });
      request.once("error", reject);
      request.once("end", () => resolve(text));
      request.end();
    });
    assert.equal(body, "hello");
  } finally {
    session.destroy();
    await app.close();
  }
});
