import { fileURLToPath } from "node:url";
import { loadConfig } from "../config";
import { openDb, Store } from "../store/db";
import { EventBus } from "../harness/bus";
import { Supervisor, cleanupStaleProcesses } from "../harness/supervisor";
import { Admission } from "../harness/admission";
import { Broker } from "../permissions/broker";
import { ClaudeDriver } from "../drivers/claude";
import { createServer } from "./http";

export function main(): void {
  const cfg = loadConfig();
  cleanupStaleProcesses(cfg.pidsDir);

  const store = new Store(openDb(cfg.dbPath));
  const bus = new EventBus();
  const supervisor = new Supervisor({ idleMs: cfg.idleMs, pidsDir: cfg.pidsDir });
  const admission = new Admission(cfg.globalConcurrency);
  const broker = new Broker({
    store,
    home: cfg.home,
    timeoutMs: cfg.approvalTimeoutMs,
    currentTurnId: (threadId) => supervisor.getTurn(threadId),
  });
  const driver = new ClaudeDriver();
  const proxyEntry = fileURLToPath(new URL("../permissions/proxy.mjs", import.meta.url));

  const server = createServer({ cfg, store, bus, supervisor, admission, broker, driver, proxyEntry });

  void broker.start().then(() => {
    server.listen(cfg.port, cfg.host, () => {
      console.log(`violet listening on http://${cfg.host}:${cfg.port}`);
    });
  });

  const shutdown = () => {
    supervisor.stopAll();
    broker.stop();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main();

