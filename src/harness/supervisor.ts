import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import type { SpawnPlan } from "../drivers/types";

interface Proc {
  threadId: string;
  child: ChildProcess;
  turnId: string | null;
  cancelRequested: boolean;
  idleTimer: NodeJS.Timeout;
}

export interface SupervisorOptions {
  idleMs: number;
  pidsDir: string;
  onLine?: (threadId: string, line: string) => void;
  onExit?: (threadId: string, code: number | null, wasCancelled: boolean) => void;
}

export class Supervisor {
  private procs = new Map<string, Proc>();
  onCancel: ((threadId: string) => void) | undefined;

  constructor(private opts: SupervisorOptions) {}

  setHandlers(handlers: NonNullable<Pick<SupervisorOptions, "onLine" | "onExit">>): void {
    this.opts.onLine = handlers.onLine;
    this.opts.onExit = handlers.onExit;
  }

  ensure(threadId: string, plan: SpawnPlan): Proc {
    const existing = this.procs.get(threadId);
    if (existing) return existing;

    const child = spawn(plan.command, plan.args, {
      cwd: plan.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });
    const proc: Proc = {
      threadId,
      child,
      turnId: null,
      cancelRequested: false,
      idleTimer: setTimeout(() => this.stop(threadId), this.opts.idleMs),
    };
    this.procs.set(threadId, proc);
    this.writePidfile(child.pid, threadId);

    readline.createInterface({ input: child.stdout!, terminal: false }).on("line", (line) => {
      this.touch(threadId);
      this.opts.onLine?.(threadId, line);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      for (const line of chunk.toString("utf8").split("\n")) {
        if (line.trim()) console.error(`[cli ${threadId}] ${line}`);
      }
    });
    child.on("exit", (code) => {
      clearTimeout(proc.idleTimer);
      this.procs.delete(threadId);
      this.removePidfile(child.pid);
      this.opts.onExit?.(threadId, code, proc.cancelRequested);
      proc.turnId = null;
    });
    return proc;
  }

  setTurn(threadId: string, turnId: string | null): void {
    const proc = this.procs.get(threadId);
    if (proc) proc.turnId = turnId;
  }

  getTurn(threadId: string): string | null {
    return this.procs.get(threadId)?.turnId ?? null;
  }

  has(threadId: string): boolean {
    return this.procs.has(threadId);
  }

  pidOf(threadId: string): number | undefined {
    return this.procs.get(threadId)?.child.pid;
  }

  send(threadId: string, line: string): void {
    const proc = this.procs.get(threadId);
    if (!proc) throw new Error(`thread ${threadId} has no process`);
    this.touch(threadId);
    proc.child.stdin!.write(line + "\n");
  }

  private touch(threadId: string): void {
    const proc = this.procs.get(threadId);
    if (!proc) return;
    clearTimeout(proc.idleTimer);
    proc.idleTimer = setTimeout(() => this.stop(threadId), this.opts.idleMs);
  }

  interrupt(threadId: string): void {
    const proc = this.procs.get(threadId);
    if (!proc) return;
    proc.cancelRequested = true;
    this.killTree(proc);
  }

  stop(threadId: string): void {
    const proc = this.procs.get(threadId);
    if (!proc) return;
    this.killTree(proc);
  }

  private killTree(proc: Proc): void {
    const pid = proc.child.pid;
    if (pid === undefined) return;
    if (process.platform === "win32") {
      spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" });
    } else {
      try {
        process.kill(-pid, "SIGTERM");
      } catch {
        proc.child.kill("SIGTERM");
      }
      setTimeout(() => {
        if (proc.child.exitCode === null && proc.child.signalCode === null) {
          try {
            process.kill(-pid, "SIGKILL");
          } catch {
            proc.child.kill("SIGKILL");
          }
        }
      }, 5000).unref();
    }
  }

  stopAll(): void {
    for (const threadId of [...this.procs.keys()]) this.stop(threadId);
  }

  private pidfile(pid: number): string {
    return path.join(this.opts.pidsDir, `${pid}.json`);
  }

  private writePidfile(pid: number | undefined, threadId: string): void {
    if (pid === undefined) return;
    fs.writeFileSync(
      this.pidfile(pid),
      JSON.stringify({ pid, threadId, startedAt: new Date().toISOString() }),
      "utf8",
    );
  }

  private removePidfile(pid: number | undefined): void {
    if (pid === undefined) return;
    fs.rmSync(this.pidfile(pid), { force: true });
  }
}

export function cleanupStaleProcesses(pidsDir: string): void {
  let files: string[];
  try {
    files = fs.readdirSync(pidsDir);
  } catch {
    return;
  }
  for (const file of files) {
    if (!file.endsWith(".json")) continue;
    const full = path.join(pidsDir, file);
    try {
      const { pid } = JSON.parse(fs.readFileSync(full, "utf8")) as { pid: number };
      if (process.platform === "win32") {
        spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" });
      } else {
        process.kill(pid, "SIGTERM");
      }
      fs.rmSync(full, { force: true });
    } catch {
      fs.rmSync(full, { force: true });
    }
  }
}

