import { describe, expect, it } from "vitest";
import { Admission } from "../src/harness/admission";

describe("admission", () => {
  it("serializes jobs per bot and caps global concurrency", async () => {
    const admission = new Admission(2);
    const log: string[] = [];
    let running = 0;
    let maxRunning = 0;
    const track = (bot: string, tag: string) => async () => {
      running++;
      maxRunning = Math.max(maxRunning, running);
      log.push(`${bot}:${tag}`);
      await new Promise((resolve) => setTimeout(resolve, 20));
      running--;
    };

    for (let i = 1; i <= 3; i++) admission.submit("a", { run: track("a", String(i)) });
    for (let i = 1; i <= 3; i++) admission.submit("b", { run: track("b", String(i)) });

    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(log).toHaveLength(6);
    expect(maxRunning).toBeLessThanOrEqual(2);
    const orderA = log.filter((l) => l.startsWith("a:"));
    expect(orderA).toEqual(["a:1", "a:2", "a:3"]);
    const orderB = log.filter((l) => l.startsWith("b:"));
    expect(orderB).toEqual(["b:1", "b:2", "b:3"]);
    expect(log.slice(0, 2)).toEqual(["a:1", "b:1"]);
  });
});

