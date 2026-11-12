import net from "node:net";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { Broker, makePipePath } from "../src/permissions/broker";
import { openDb, Store } from "../src/store/db";
import { tempHome } from "./helpers";

function makeBroker(overrides: Partial<ConstructorParameters<typeof Broker>[0]> = {}): Broker {
  const home = tempHome();
  const store = new Store(openDb(`${home}/violet.db`));
  return new Broker({ store, home, timeoutMs: overrides.timeoutMs ?? 5000, ...overrides });
}

function askOverPipe(pipePath: string, payload: Record<string, unknown>): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(pipePath);
    let buffer = "";
    socket.on("connect", () => socket.write(JSON.stringify(payload) + "\n"));
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      const idx = buffer.indexOf("\n");
      if (idx !== -1) {
        socket.end();
        resolve(JSON.parse(buffer.slice(0, idx)));
      }
    });
    socket.on("error", reject);
  });
}

async function waitFor(fn: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!fn()) {
    if (Date.now() > deadline) throw new Error("waitFor timeout");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe("broker", () => {
  it("resolves allow and deny decisions from the user", async () => {
    const broker = makeBroker({ currentTurnId: () => "turn-1" });
    await broker.start();
    const replyPromise = askOverPipe(broker.pipePath, { botId: "b", threadId: "t", tool: "Bash", input: { cmd: "ls" } });
    await waitFor(() => broker.pendingApprovals().length === 1);
    const approvals = broker.pendingApprovals();
    expect(approvals).toHaveLength(1);
    expect(approvals[0]!.turn_id).toBe("turn-1");
    expect(broker.decide(approvals[0]!.id, "allow")).toEqual({ behavior: "allow" });
    await expect(replyPromise).resolves.toEqual({ behavior: "allow" });

    const reply2 = askOverPipe(broker.pipePath, { botId: "b", threadId: "t", tool: "Bash", input: {} });
    await waitFor(() => broker.pendingApprovals().length === 1);
    const approvals2 = broker.pendingApprovals();
    expect(approvals2).toHaveLength(1);
    expect(broker.decide(approvals2[0]!.id, "deny")).toEqual({ behavior: "deny" });
    await expect(reply2).resolves.toEqual({ behavior: "deny" });
    broker.stop();
  });

  it("denies after timeout", async () => {
    const broker = makeBroker({ timeoutMs: 50, currentTurnId: () => "turn-1" });
    await broker.start();
    const result = await broker.ask({ botId: "b", threadId: "t", tool: "Bash", input: {} });
    expect(result.behavior).toBe("deny");
    expect(result.message).toContain("超时");
    broker.stop();
  });

  it("fail-closes when no turn is running", async () => {
    const broker = makeBroker({ currentTurnId: () => null });
    await broker.start();
    const result = await broker.ask({ botId: "b", threadId: "t", tool: "Bash", input: {} });
    expect(result.behavior).toBe("deny");
    expect(result.message).toContain("结束");
    broker.stop();
  });

  it("generates a platform pipe path", () => {
    const home = tempHome();
    const pipe = makePipePath(home);
    if (process.platform === "win32") {
      expect(pipe).toMatch(/^\\\\\.\\pipe\\violet-/);
    } else {
      expect(pipe).toContain(path.sep);
      expect(pipe).toContain("violet-");
    }
  });
});

