import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ClaudeDriver, writeMcpConfig } from "../src/drivers/claude";
import { tempHome } from "./helpers";

describe("claude driver", () => {
  const driver = new ClaudeDriver();

  it("maps approval modes to CLI flags", () => {
    const ask = driver.spawnPlan({
      command: "claude", workspace: "/ws", model: null, approvalMode: "ask",
      resumeSessionId: "s1", mcpConfigPath: "/tmp/mcp.json",
    });
    expect(ask.args).toContain("--permission-prompt-tool");
    expect(ask.args).toContain("--mcp-config");
    expect(ask.args).toContain("--resume");
    expect(ask.args).toContain("default");
    const full = driver.spawnPlan({ command: "claude", workspace: "/ws", model: null, approvalMode: "full" });
    expect(full.args).toContain("bypassPermissions");
    expect(full.args).not.toContain("--mcp-config");
  });

  it("encodes user messages as stream-json user frames", () => {
    const line = driver.encodeMessage("你好");
    const frame = JSON.parse(line);
    expect(frame.type).toBe("user");
    expect(frame.message.content[0].text).toBe("你好");
  });

  it("normalizes stream-json output frames", () => {
    const events = [
      ...driver.decodeLine(JSON.stringify({ type: "system", subtype: "init", session_id: "s9" })),
      ...driver.decodeLine(JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "hi" }, { type: "tool_use", name: "Bash", input: { cmd: "ls" } }] } })),
      ...driver.decodeLine(JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", content: "ok" }] } })),
      ...driver.decodeLine(JSON.stringify({ type: "result", subtype: "success", result: "done" })),
    ];
    expect(events).toEqual([
      { kind: "session", sessionId: "s9" },
      { kind: "text.delta", text: "hi" },
      { kind: "tool.use", name: "Bash", input: { cmd: "ls" } },
      { kind: "tool.result", content: "ok" },
      { kind: "result", text: "done", isError: false },
    ]);
  });

  it("writes and cleans up 0600 mcp config", () => {
    const home = tempHome();
    const { filePath, cleanup } = writeMcpConfig("proxy.mjs", "\\\\.\\pipe\\violet-x", home, { botId: "b", threadId: "t" });
    const config = JSON.parse(fs.readFileSync(filePath, "utf8"));
    expect(config.mcpServers.violet.args).toEqual(["proxy.mjs", "\\\\.\\pipe\\violet-x"]);
    expect(config.mcpServers.violet.env.VIOLET_THREAD_ID).toBe("t");
    cleanup();
    expect(fs.existsSync(filePath)).toBe(false);
  });
});

