import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { initWorkspace } from "../src/bots/workspace";
import { tempHome } from "./helpers";

describe("workspace", () => {
  it("creates generated context and memory files", () => {
    const home = tempHome();
    const dir = initWorkspace(home, { id: "b1", name: "小紫", persona: "你是小紫,简洁直接。" });
    expect(dir).toBe(path.join(home, "bots", "b1", "workspace"));
    const claude = fs.readFileSync(path.join(dir, "CLAUDE.md"), "utf8");
    expect(claude).toContain("小紫");
    expect(claude).toContain("你是小紫");
    expect(claude).toContain("MEMORY.md");
    const memory = fs.readFileSync(path.join(dir, "MEMORY.md"), "utf8");
    expect(memory).toContain("小紫");
  });
});

