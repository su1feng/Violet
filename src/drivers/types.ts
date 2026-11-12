import type { BotRow } from "../store/db";

export type ApprovalMode = "ask" | "full";

export interface SpawnPlan {
  command: string;
  args: string[];
  cwd: string;
}

export type DriverEvent =
  | { kind: "session"; sessionId: string }
  | { kind: "text.delta"; text: string }
  | { kind: "tool.use"; name: string; input: unknown }
  | { kind: "tool.result"; content: string }
  | { kind: "result"; text?: string; isError?: boolean }
  | { kind: "error"; message: string };

export interface Driver {
  readonly kind: string;
  readonly capabilities: {
    multiTurn: boolean;
    resume: "session-id" | "none";
    stream: "stream-json" | "acp";
    approval: "permission-tool" | "none";
  };
  spawnPlan(opts: {
    command: string;
    extraArgs?: string[];
    workspace: string;
    model: string | null;
    approvalMode: ApprovalMode;
    resumeSessionId?: string | null;
    mcpConfigPath?: string | null;
  }): SpawnPlan;
  encodeMessage(text: string): string;
  decodeLine(line: string): DriverEvent[];
}

export interface BotLike extends Pick<BotRow, "id" | "name" | "persona"> {}

