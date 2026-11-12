import path from "node:path";
import { describe, expect, it } from "vitest";
import { Supervisor, cleanupStaleProcesses } from "../src/harness/supervisor";
import { spawn } from "node:child_process";
import fs from "node:fs";
import { tempHome } from "./helpers";

const fakeCli = path.resolve("tests/fixtures/fake-cli.mjs");

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("supervisor", () => {
  it("keeps a resident process, feeds turns, and cleans up pidfiles on exit", async () => {
    const home = tempHome();
    const pidsDir = path.join(home, "pids");
    fs.mkdirSync(pidsDir, { recursive: true });
    const lines: string[] = [];
    let exited = false;
    const supervisor = new Supervisor({
      idleMs: 60_000,
      pidsDir,
      onLine: (threadId, line) => lines.push(`${threadId}|${line}`),
      onExit: () => { exited = true; },
    });
    const plan = { command: process.execPath, args: [fakeCli], cwd: home };
    supervisor.ensure("t1", plan);
    const pid = supervisor.pidOf("t1")!;
    supervisor.send("t1", JSON.stringify({ message: { content: [{ text: "hello" }] } }));
    await wait(1500);
    expect(lines.filter((l) => l.startsWith("t1|")).length).toBeGreaterThanOrEqual(3);
    expect(lines.some((l) => l.includes("echo(1): hello"))).toBe(true);
    expect(fs.readdirSync(pidsDir)).toContain(`${pid}.json`);
    supervisor.stop("t1");
    const exitDeadline = Date.now() + 9000;
    while (!exited && Date.now() < exitDeadline) {
      await wait(100);
    }
    expect(exited).toBe(true);
    expect(fs.readdirSync(pidsDir)).not.toContain(`${pid}.json`);
  });

  it("kills stale processes recorded in pidfiles at startup", async () => {
    const pidsDir = tempHome();
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { detached: process.platform !== "win32", stdio: "ignore" });
    fs.writeFileSync(path.join(pidsDir, `${child.pid}.json`), JSON.stringify({ pid: child.pid, threadId: "t" }));
    await wait(300);
    cleanupStaleProcesses(pidsDir);
    const exited = await new Promise<boolean>((resolve) => {
      const timeout = setTimeout(() => resolve(false), 8000);
      child.on("exit", () => {
        clearTimeout(timeout);
        resolve(true);
      });
    });
    expect(exited).toBe(true);
  }, 20000);
});

