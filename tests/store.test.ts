import { describe, expect, it } from "vitest";
import { openDb, Store, type BotRow } from "../src/store/db";
import { tempHome } from "./helpers";

function makeBot(overrides: Partial<BotRow> = {}): BotRow {
  return {
    id: crypto.randomUUID(),
    name: "test",
    avatar: null,
    persona: "测试人格",
    driver: "claude",
    model: null,
    approval_mode: "ask",
    workspace: "/tmp/ws",
    status: "active",
    created_at: new Date().toISOString(),
    ...overrides,
  };
}

describe("store", () => {
  it("roundtrips bots", () => {
    const store = new Store(openDb(`${tempHome()}/violet.db`));
    const bot = makeBot();
    store.createBot(bot);
    expect(store.getBot(bot.id)?.name).toBe("test");
    store.updateBot(bot.id, { name: "renamed" });
    expect(store.getBot(bot.id)?.name).toBe("renamed");
    store.deleteBot(bot.id);
    expect(store.getBot(bot.id)).toBeUndefined();
  });

  it("appends events with per-thread seq", () => {
    const store = new Store(openDb(`${tempHome()}/violet.db`));
    const bot = makeBot();
    store.createBot(bot);
    const threadId = crypto.randomUUID();
    store.createThread({ id: threadId, bot_id: bot.id, cli_session_id: null, title: null, created_at: "", last_active_at: "" });
    const first = store.appendEvent(threadId, null, "message", { text: "a" });
    const second = store.appendEvent(threadId, null, "message", { text: "b" });
    const other = store.appendEvent(crypto.randomUUID(), null, "message", {});
    expect([first.seq, second.seq, other.seq]).toEqual([1, 2, 1]);
    expect(JSON.parse(store.listEvents(threadId)[0]!.payload_json)).toEqual({ text: "a" });
  });

  it("tracks approvals as pending until decided", () => {
    const store = new Store(openDb(`${tempHome()}/violet.db`));
    const id = crypto.randomUUID();
    store.createApproval({
      id, bot_id: "b", thread_id: "t", turn_id: null, tool: "Bash",
      input_json: "{}", decision: null, source: null,
      requested_at: new Date().toISOString(), decided_at: null,
    });
    expect(store.pendingApprovals()).toHaveLength(1);
    const row = store.decideApproval(id, "allow", "user");
    expect(row?.decision).toBe("allow");
    expect(store.pendingApprovals()).toHaveLength(0);
    expect(store.decideApproval(id, "deny", "user")).toBeUndefined();
  });
});

