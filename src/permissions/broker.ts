import net from "node:net";
import path from "node:path";
import fs from "node:fs";
import type { ApprovalRow, Store } from "../store/db";

export interface AskInput {
  botId: string;
  threadId: string;
  tool: string;
  input: unknown;
}

export interface Decision {
  behavior: "allow" | "deny";
  updatedInput?: unknown;
  message?: string;
}

interface PendingEntry {
  approval: ApprovalRow;
  timer: NodeJS.Timeout;
  resolve: (decision: Decision) => void;
}

export interface BrokerOptions {
  store: Store;
  home: string;
  timeoutMs: number;
  pipePath?: string;
  onPendingChange?: () => void;
  currentTurnId?: (threadId: string) => string | null;
}

export function makePipePath(home: string): string {
  const suffix = crypto.randomUUID().slice(0, 8);
  if (process.platform === "win32") return `\\\\.\\pipe\\violet-${suffix}`;
  const dir = path.join(home, "run");
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, `violet-${suffix}.sock`);
}

export class Broker {
  private server: net.Server | undefined;
  private pending = new Map<string, PendingEntry>();
  readonly pipePath: string;
  onPendingChange: (() => void) | undefined;

  constructor(private opts: BrokerOptions) {
    this.pipePath = opts.pipePath ?? makePipePath(opts.home);
  }

  start(): Promise<void> {
    this.server = net.createServer((socket) => {
      let buffer = "";
      socket.on("data", (chunk) => {
        buffer += chunk.toString("utf8");
        let idx: number;
        while ((idx = buffer.indexOf("\n")) !== -1) {
          const line = buffer.slice(0, idx).trim();
          buffer = buffer.slice(idx + 1);
          if (line) void this.handleWireLine(line, socket);
        }
      });
      socket.on("error", () => socket.destroy());
    });
    if (process.platform !== "win32") {
      try {
        fs.rmSync(this.pipePath, { force: true });
      } catch {
        /* ignore */
      }
    }
    return new Promise((resolve, reject) => {
      this.server!.listen(this.pipePath, () => {
        if (process.platform !== "win32") fs.chmodSync(this.pipePath, 0o600);
        resolve();
      });
      this.server!.on("error", reject);
    });
  }

  private async handleWireLine(line: string, socket: net.Socket): Promise<void> {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    const decision = await this.ask({
      botId: String(msg.botId ?? ""),
      threadId: String(msg.threadId ?? ""),
      tool: String(msg.tool ?? "unknown"),
      input: msg.input ?? {},
    });
    socket.write(JSON.stringify(decision) + "\n");
  }

  async ask(input: AskInput): Promise<Decision> {
    const id = crypto.randomUUID();
    const turnId = this.opts.currentTurnId?.(input.threadId) ?? null;
    const approval: ApprovalRow = {
      id,
      bot_id: input.botId,
      thread_id: input.threadId,
      turn_id: turnId,
      tool: input.tool,
      input_json: JSON.stringify(input.input ?? {}),
      decision: null,
      source: null,
      requested_at: new Date().toISOString(),
      decided_at: null,
    };
    const failClosed = (source: string, message: string): Decision => {
      this.opts.store.decideApproval(id, "deny", source);
      this.onPendingChange?.();
      return { behavior: "deny", message };
    };
    if (this.pending.has(id)) return failClosed("duplicate", "重复的审批请求");
    if (turnId === null) {
      return failClosed("closed", "turn 已结束,自动拒绝");
    }
    this.opts.store.createApproval(approval);
    this.onPendingChange?.();
    return new Promise<Decision>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve(failClosed("timeout", "审批超时,自动拒绝"));
      }, this.opts.timeoutMs);
      this.pending.set(id, { approval, timer, resolve });
    });
  }

  decide(approvalId: string, decision: "allow" | "deny"): Decision | undefined {
    const entry = this.pending.get(approvalId);
    if (!entry) return undefined;
    clearTimeout(entry.timer);
    this.pending.delete(approvalId);
    const stored = this.opts.store.decideApproval(approvalId, decision, "user");
    this.onPendingChange?.();
    if (!stored) return undefined;
    const result: Decision = { behavior: decision };
    entry.resolve(result);
    return result;
  }

  pendingApprovals(): ApprovalRow[] {
    return this.opts.store.pendingApprovals();
  }

  stop(): void {
    for (const [id, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.resolve({ behavior: "deny", message: "服务已关闭" });
      this.pending.delete(id);
    }
    this.server?.close();
  }
}

