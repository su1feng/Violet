import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadConfig, type VioletConfig } from "../src/config";

export function tempHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "violet-test-"));
}

export function testConfig(env: NodeJS.ProcessEnv = {}): VioletConfig {
  return loadConfig({ ...env, VIOLET_TOKEN: env.VIOLET_TOKEN ?? "test-token" });
}

