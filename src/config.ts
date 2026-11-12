import fs from "node:fs";
import path from "node:path";
import os from "node:os";

export interface VioletConfig {
  home: string;
  dbPath: string;
  pidsDir: string;
  tokenPath: string;
  token: string;
  host: string;
  port: number;
  claudeCmd: string;
  claudeArgs: string[];
  approvalTimeoutMs: number;
  idleMs: number;
  globalConcurrency: number;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): VioletConfig {
  const home = env.VIOLET_HOME ?? path.join(os.homedir(), ".violet");
  fs.mkdirSync(home, { recursive: true });
  const tokenPath = path.join(home, "token");
  const token =
    env.VIOLET_TOKEN ??
    (fs.existsSync(tokenPath) ? fs.readFileSync(tokenPath, "utf8").trim() : undefined) ??
    crypto.randomUUID().replaceAll("-", "");
  if (!env.VIOLET_TOKEN) fs.writeFileSync(tokenPath, token + "\n", { mode: 0o600 });
  const pidsDir = path.join(home, "pids");
  fs.mkdirSync(pidsDir, { recursive: true });
  return {
    home,
    dbPath: path.join(home, "violet.db"),
    pidsDir,
    tokenPath,
    token,
    host: env.VIOLET_HOST ?? "127.0.0.1",
    port: Number(env.VIOLET_PORT ?? 5178),
    claudeCmd: env.VIOLET_CLAUDE_CMD ?? "claude",
    claudeArgs: (env.VIOLET_CLAUDE_ARGS ?? "").split(" ").filter(Boolean),
    approvalTimeoutMs: Number(env.VIOLET_APPROVAL_TIMEOUT_MS ?? 15 * 60_000),
    idleMs: Number(env.VIOLET_IDLE_MS ?? 10 * 60_000),
    globalConcurrency: Number(env.VIOLET_GLOBAL_CONCURRENCY ?? 3),
  };
}

