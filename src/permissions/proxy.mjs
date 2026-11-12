#!/usr/bin/env node
// Violet permission-proxy: stdio MCP server bridging Claude Code permission
// prompts to the local broker over a pipe. Wire protocol is NDJSON.
import net from "node:net";
import { randomUUID } from "node:crypto";
import readline from "node:readline";

const pipePath = process.argv[2];
if (!pipePath) {
  console.error("usage: proxy.mjs <pipePath>");
  process.exit(1);
}

const TOOL = {
  name: "permission_prompt",
  description: "Ask the user to approve or deny a tool call.",
  inputSchema: {
    type: "object",
    properties: {
      tool_name: { type: "string" },
      input: { type: "object" },
    },
    required: ["tool_name"],
  },
};

const CONTEXT = {
  botId: process.env.VIOLET_BOT_ID ?? "",
  threadId: process.env.VIOLET_THREAD_ID ?? "",
};

function askBroker(payload) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(pipePath);
    let buffer = "";
    const timeout = setTimeout(() => {
      socket.destroy();
      reject(new Error("broker timeout"));
    }, 10000);
    socket.on("connect", () => {
      socket.write(
        JSON.stringify({
          botId: CONTEXT.botId,
          threadId: CONTEXT.threadId,
          tool: payload.toolName,
          input: payload.input,
        }) + "\n",
      );
    });
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      const idx = buffer.indexOf("\n");
      if (idx === -1) return;
      clearTimeout(timeout);
      socket.end();
      try {
        resolve(JSON.parse(buffer.slice(0, idx)));
      } catch (error) {
        reject(error);
      }
    });
    socket.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
  });
}

const rl = readline.createInterface({ input: process.stdin, terminal: false });

rl.on("line", (line) => {
  if (!line.trim()) return;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  void (async () => {
    const respond = (result) => {
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }) + "\n");
    };
    switch (msg.method) {
      case "initialize":
        respond({
          protocolVersion: msg.params?.protocolVersion ?? "2024-11-05",
          capabilities: { tools: {} },
          serverInfo: { name: "violet-permission-proxy", version: "0.1.0" },
        });
        break;
      case "notifications/initialized":
        break;
      case "tools/list":
        respond({ tools: [TOOL] });
        break;
      case "tools/call": {
        const args = msg.params?.arguments ?? {};
        try {
          const decision = await askBroker({
            toolName: args.tool_name,
            input: args.input ?? {},
          });
          respond({
            content: [{ type: "text", text: JSON.stringify(decision) }],
          });
        } catch (error) {
          respond({
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  behavior: "deny",
                  message: `审批通道不可用:${String(error)}`,
                }),
              },
            ],
          });
        }
        break;
      }
      default:
        if (msg.id !== undefined) {
          process.stdout.write(
            JSON.stringify({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "method not found" } }) + "\n",
          );
        }
    }
  })();
});

rl.on("close", () => process.exit(0));
