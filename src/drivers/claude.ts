import fs from "node:fs";
import path from "node:path";
import type { ApprovalMode, Driver, DriverEvent, SpawnPlan } from "./types";

const PERMISSION_TOOL = "mcp__violet__permission_prompt";

export class ClaudeDriver implements Driver {
  readonly kind = "claude";
  readonly capabilities = {
    multiTurn: true,
    resume: "session-id" as const,
    stream: "stream-json" as const,
    approval: "permission-tool" as const,
  };

  spawnPlan(opts: {
    command: string;
    extraArgs?: string[];
    workspace: string;
    model: string | null;
    approvalMode: ApprovalMode;
    resumeSessionId?: string | null;
    mcpConfigPath?: string | null;
  }): SpawnPlan {
    const args: string[] = [...(opts.extraArgs ?? [])];
    args.push(
      "--input-format", "stream-json",
      "--output-format", "stream-json",
      "--verbose",
      "--permission-mode", opts.approvalMode === "full" ? "bypassPermissions" : "default",
      "--strict-mcp-config",
      "--setting-sources", "project",
    );
    if (opts.approvalMode === "ask") {
      args.push("--permission-prompt-tool", PERMISSION_TOOL);
      if (opts.mcpConfigPath) args.push("--mcp-config", opts.mcpConfigPath);
    }
    if (opts.model) args.push("--model", opts.model);
    if (opts.resumeSessionId) args.push("--resume", opts.resumeSessionId);
    return { command: opts.command, args, cwd: opts.workspace };
  }

  encodeMessage(text: string): string {
    return JSON.stringify({
      type: "user",
      message: { role: "user", content: [{ type: "text", text }] },
    });
  }

  decodeLine(line: string): DriverEvent[] {
    let frame: unknown;
    try {
      frame = JSON.parse(line);
    } catch {
      return [];
    }
    if (typeof frame !== "object" || frame === null) return [];
    const f = frame as Record<string, unknown>;
    switch (f.type) {
      case "system":
        if (f.subtype === "init" && typeof f.session_id === "string") {
          return [{ kind: "session", sessionId: f.session_id }];
        }
        return [];
      case "assistant": {
        const events: DriverEvent[] = [];
        const message = f.message as { content?: Array<Record<string, unknown>> } | undefined;
        for (const block of message?.content ?? []) {
          if (block.type === "text" && typeof block.text === "string") {
            events.push({ kind: "text.delta", text: block.text });
          } else if (block.type === "tool_use") {
            events.push({ kind: "tool.use", name: String(block.name), input: block.input ?? {} });
          }
        }
        return events;
      }
      case "user": {
        const events: DriverEvent[] = [];
        const message = f.message as { content?: Array<Record<string, unknown>> } | undefined;
        for (const block of message?.content ?? []) {
          if (block.type === "tool_result") {
            const content = typeof block.content === "string"
              ? block.content
              : JSON.stringify(block.content ?? "");
            events.push({ kind: "tool.result", content });
          }
        }
        return events;
      }
      case "result": {
        const isError = f.subtype !== "success";
        const text = typeof f.result === "string" ? f.result : undefined;
        const events: DriverEvent[] = [{ kind: "result", text, isError }];
        if (isError && typeof f.error === "string") {
          events.push({ kind: "error", message: f.error });
        }
        return events;
      }
      default:
        return [];
    }
  }
}

export function writeMcpConfig(
  proxyEntry: string,
  pipePath: string,
  home: string,
  context: { botId: string; threadId: string },
): { filePath: string; cleanup(): void } {
  const config = JSON.stringify({
    mcpServers: {
      violet: {
        command: process.execPath,
        args: [proxyEntry, pipePath],
        env: {
          VIOLET_BOT_ID: context.botId,
          VIOLET_THREAD_ID: context.threadId,
        },
      },
    },
  });
  const filePath = path.join(home, `mcp-${crypto.randomUUID()}.json`);
  fs.writeFileSync(filePath, config, { mode: 0o600 });
  return { filePath, cleanup: () => fs.rmSync(filePath, { force: true }) };
}

