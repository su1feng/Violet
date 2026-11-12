import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import { loadConfig, type VioletConfig } from "../src/config";
import { openDb, Store } from "../src/store/db";
import { EventBus } from "../src/harness/bus";
import { Supervisor } from "../src/harness/supervisor";
import { Admission } from "../src/harness/admission";
import { Broker } from "../src/permissions/broker";
import { ClaudeDriver } from "../src/drivers/claude";
import { createServer } from "../src/server/http";
import { tempHome } from "./helpers";

interface ThreadEvent {
  seq: number;
  type: string;
  payload: Record<string, unknown>;
}

describe("api integration", () => {
  let cfg: VioletConfig;
  let server: ReturnType<typeof createServer>;
  let base: string;
  let botId: string;
  let threadId: string;
  let broker: Broker;
  let supervisor: Supervisor;

  beforeAll(async () => {
    const home = tempHome();
    cfg = loadConfig({
      VIOLET_HOME: home,
      VIOLET_TOKEN: "test-token",
      VIOLET_CLAUDE_CMD: process.execPath,
      VIOLET_CLAUDE_ARGS: path.resolve("tests/fixtures/fake-cli.mjs"),
      VIOLET_IDLE_MS: "60000",
    });
    const store = new Store(openDb(cfg.dbPath));
    const bus = new EventBus();
    supervisor = new Supervisor({ idleMs: cfg.idleMs, pidsDir: cfg.pidsDir });
    const admission = new Admission(cfg.globalConcurrency);
    broker = new Broker({
      store,
      home: cfg.home,
      timeoutMs: cfg.approvalTimeoutMs,
      currentTurnId: (thread) => supervisor.getTurn(thread),
    });
    const driver = new ClaudeDriver();
    server = createServer({
      cfg, store, bus, supervisor, admission, broker, driver,
      proxyEntry: path.resolve("src/permissions/proxy.mjs"),
      webDist: path.resolve("src/web"),
    });
    await broker.start();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;
    base = `http://127.0.0.1:${port}`;
  });

  afterAll(() => {
    supervisor.stopAll();
    broker.stop();
    server.close();
  });

  const call = async (route: string, init?: RequestInit): Promise<Response> =>
    fetch(`${base}${route}`, {
      ...init,
      headers: { "content-type": "application/json", authorization: "Bearer test-token", ...(init?.headers ?? {}) },
    });

  async function waitEvent(thread: string, type: string, timeoutMs = 10000): Promise<ThreadEvent> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const events = (await call(`/api/threads/${thread}/events`).then((r) => r.json())) as ThreadEvent[];
      const match = events.find((e) => e.type === type);
      if (match) return match;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    const events = (await call(`/api/threads/${thread}/events`).then((r) => r.json())) as ThreadEvent[];
    throw new Error(`timed out waiting for ${type}; events so far: ${JSON.stringify(events.map((e) => ({ type: e.type, payload: e.payload })))}`);
  }

  it("runs a full turn end to end with a resident fake CLI", async () => {
    const bot = (await call("/api/bots", {
      method: "POST",
      body: JSON.stringify({ name: "测试", persona: "测试人格", approvalMode: "ask" }),
    }).then((r) => r.json())) as { id: string };
    botId = bot.id;
    expect(botId).toBeTruthy();

    const thread = (await call(`/api/bots/${botId}/threads`, {
      method: "POST",
      body: "{}",
    }).then((r) => r.json())) as { id: string };
    threadId = thread.id;

    const unauthorized = await call("/api/bots", { headers: { authorization: "Bearer wrong" } });
    expect(unauthorized.status).toBe(401);

    const submitted = await call(`/api/threads/${threadId}/messages`, {
      method: "POST",
      body: JSON.stringify({ text: "hello" }),
    });
    expect(submitted.status).toBe(202);

    const userEvent = await waitEvent(threadId, "message");
    expect(userEvent.payload).toMatchObject({ role: "user", text: "hello" });
    await waitEvent(threadId, "turn.completed");
    const events = (await call(`/api/threads/${threadId}/events`).then((r) => r.json())) as ThreadEvent[];
    const reply = events.find((e) => e.type === "message.delta");
    expect(reply?.payload).toMatchObject({ role: "assistant", text: "echo(1): hello" });

    const threads = (await call(`/api/bots/${botId}/threads`).then((r) => r.json())) as Array<{ cli_session_id: string | null }>;
    expect(threads[0]?.cli_session_id).toBe("fake-session-1");

    await call(`/api/threads/${threadId}/messages`, { method: "POST", body: JSON.stringify({ text: "again" }) });
    await waitEvent(threadId, "turn.completed");
    const after = (await call(`/api/threads/${threadId}/events`).then((r) => r.json())) as ThreadEvent[];
    const second = after.filter((e) => e.type === "message.delta").at(-1);
    expect(second?.payload).toMatchObject({ text: "echo(2): again" });

    const approvals = (await call("/api/approvals/pending").then((r) => r.json())) as unknown[];
    expect(approvals).toHaveLength(0);

    const ndjsonPath = path.join(cfg.home, "threads", `${threadId}.ndjson`);
    const ndjsonLines = (await import("node:fs")).readFileSync(ndjsonPath, "utf8").trim().split("\n");
    expect(ndjsonLines.length).toBeGreaterThan(0);
  });

  it("serves the web UI with the token injected", async () => {
    const home = await fetch(`${base}/`);
    expect(home.status).toBe(200);
    const html = await home.text();
    expect(html).toContain("window.__VIOLET_TOKEN__");
    expect(html).toContain("test-token");
  });
});

