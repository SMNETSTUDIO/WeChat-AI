import { createHash } from "node:crypto";
import {
  INBOUND_LEASE_MS, renewInbound, saveInboundSteps,
  type Db, type InboundClaim,
} from "@wechat-ai/db";
import type { ILinkClient } from "@wechat-ai/ilink";

/** Checkpoints belong to the job, not the node that currently processes it. */
export class InboundDelivery {
  private lost = false;
  private timer: ReturnType<typeof setInterval>;

  constructor(private db: Db, readonly claim: InboundClaim) {
    this.timer = setInterval(() => {
      void this.assertActive().catch(() => { this.lost = true; });
    }, INBOUND_LEASE_MS / 3);
    this.timer.unref();
  }

  close(): void { clearInterval(this.timer); }

  async assertActive(): Promise<void> {
    if (this.lost) throw new Error("Inbound processing lease lost");
    try {
      if (!await renewInbound(this.db, this.claim)) throw new Error("Inbound processing lease lost");
    } catch (err) {
      this.lost = true;
      throw err;
    }
  }

  clientId(step: string): string {
    return `wa-${createHash("sha256").update(`${this.claim.job.id}:${step}`).digest("hex").slice(0, 40)}`;
  }

  async step<T>(name: string, run: () => Promise<T>): Promise<T> {
    if (Object.hasOwn(this.claim.steps, name)) return this.claim.steps[name]!.value as T;
    await this.assertActive();
    const value = await run();
    this.claim.steps[name] = { value };
    await saveInboundSteps(this.db, this.claim);
    return value;
  }

  /** Already-confirmed bubbles are skipped; ambiguous retries reuse client_id. */
  client(raw: ILinkClient, scope = "send"): ILinkClient {
    let sequence = 0;
    return new Proxy(raw, {
      get: (target, property) => {
        if (property === "sendText" || property === "sendImage") {
          return (params: Record<string, unknown>) => {
            const name = `${scope}:${sequence++}:${property}`;
            return this.step(name, () => Reflect.apply(target[property], target, [{
              ...params, clientId: this.clientId(name),
            }]));
          };
        }
        const value = Reflect.get(target, property);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  }
}
