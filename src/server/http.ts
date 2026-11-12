import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { VioletConfig } from "../config";
import type { BotRow, Store, ThreadRow } from "../store/db";
import { NdjsonWriter } from "../store/ndjson";
import type { EventBus } from "../harness/bus";
import type { Supervisor } from "../harness/supervisor";
import type { Admission } from "../harness/admission";
import type { Broker } from "../permissions/broker";
import type { ApprovalMode, Driver } from "../drivers/types";
import { writeMcpConfig } from "../drivers/claude";
import { initWorkspace, writeClaudeMd } from "../bots/workspace";

export interface ServerDeps {
  cfg: VioletConfig;
  store: Store;
  bus: EventBus;
  supervisor: Supervisor;
  admission: Admission;
  broker: Broker;
  driver: Driver;
  proxyEntry: string;
  webDist?: string;
}

interface TurnOutcome {
  ok?: boolean;
  text?: string;
  error?: string;
  crashed?: boolean;
  cancelled?: boolean;
}

const botInput = z.object({
  name: z.string().min(1).max(100),
  persona: z.string().min(1).max(20000),
  avatar: z.string().max(4096).optional(),
  model: z.string().max(200).optional(),
  approvalMode: z.enum(["ask", "full"]),
});

const botPatch = botInput.partial();
const messageInput = z.object({ text: z.string().min(1).max(200000) });
const decisionInput = z.object({ decision: z.enum(["allow", "deny"]) });

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".css": "text/css",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".json": "application/json",
};

export function createServer(deps: ServerDeps): http.Server {
  const { cfg, store, bus, supervisor, admission, broker, driver } = deps;
  const sseClients = new Set<http.ServerResponse>();
  const ndjson = new Map<string, NdjsonWriter>();
  const pendingTurns = new Map<string, (outcome: TurnOutcome) => void>();

  supervisor.setHandlers({
    onLine: (threadId, line) => handleLine(threadId, line),
    onExit: (threadId, code, wasCancelled) => {
      const resolve = pendingTurns.get(threadId);
      if (!resolve) return;
      pendingTurns.delete(threadId);
      resolve(
        wasCancelled
          ? { cancelled: true }
          : { crashed: true, error: `CLI 进程意外退出(code ${code ?? "null"})` },
      );
    },
  });

  broker.onPendingChange = () => {
    bus.broadcast({
      botId: null,
      threadId: null,
      turnId: null,
      type: "approvals.updated",
      payload: { count: store.pendingApprovals().length },
    });
  };

  function ndjsonFor(threadId: string): NdjsonWriter {
    let writer = ndjson.get(threadId);
    if (!writer) {
      writer = new NdjsonWriter(path.join(cfg.home, "threads", `${threadId}.ndjson`));
      ndjson.set(threadId, writer);
    }
    return writer;
  }

  function publish(bot: BotRow, thread: ThreadRow, turnId: string | null, type: string, payload: unknown): void {
    const row = store.appendEvent(thread.id, turnId, type, payload);
    const event = {
      botId: bot.id,
      threadId: thread.id,
      turnId,
      seq: row.seq,
      type,
      payload: JSON.parse(row.payload_json),
      at: row.at,
    };
    bus.broadcast(event);
    ndjsonFor(thread.id).append(event);
  }

  function lookup(threadId: string): { bot: BotRow; thread: ThreadRow } | undefined {
    const thread = store.getThread(threadId);
    if (!thread) return undefined;
    const bot = store.getBot(thread.bot_id);
    if (!bot) return undefined;
    return { bot, thread };
  }

  function handleLine(threadId: string, line: string): void {
    const ctx = lookup(threadId);
    if (!ctx) return;
    for (const evt of driver.decodeLine(line)) {
      const turnId = supervisor.getTurn(threadId);
      switch (evt.kind) {
        case "session":
          store.setThreadSession(threadId, evt.sessionId);
          break;
        case "text.delta":
          publish(ctx.bot, ctx.thread, turnId, "message.delta", { role: "assistant", text: evt.text });
          break;
        case "tool.use":
          publish(ctx.bot, ctx.thread, turnId, "tool.use", { name: evt.name, input: evt.input });
          break;
        case "tool.result":
          publish(ctx.bot, ctx.thread, turnId, "tool.result", { content: evt.content });
          break;
        case "result": {
          const resolve = pendingTurns.get(threadId);
          if (resolve) {
            pendingTurns.delete(threadId);
            resolve(evt.isError ? { crashed: true, error: evt.text ?? "CLI 返回失败" } : { ok: true, text: evt.text });
          }
          break;
        }
        case "error":
          publish(ctx.bot, ctx.thread, turnId, "error", { message: evt.message });
          break;
      }
    }
  }

  function buildPlan(bot: BotRow, thread: ThreadRow): { plan: ReturnType<Driver["spawnPlan"]>; mcp: ReturnType<typeof writeMcpConfig> | null } {
    const ask = bot.approval_mode === "ask";
    const mcp = ask
      ? writeMcpConfig(deps.proxyEntry, broker.pipePath, cfg.home, { botId: bot.id, threadId: thread.id })
      : null;
    const plan = driver.spawnPlan({
      command: cfg.claudeCmd,
      extraArgs: cfg.claudeArgs,
      workspace: bot.workspace,
      model: bot.model,
      approvalMode: bot.approval_mode as ApprovalMode,
      resumeSessionId: thread.cli_session_id,
      mcpConfigPath: mcp?.filePath ?? null,
    });
    return { plan, mcp };
  }

  function runTurn(bot: BotRow, thread: ThreadRow, turnId: string, text: string): void {
    store.setTurnStatus(turnId, "running");
    publish(bot, thread, turnId, "message", { role: "user", text });
    publish(bot, thread, turnId, "turn.started", {});
    store.touchThread(thread.id);
    const { plan, mcp } = buildPlan(bot, thread);
    try {
      supervisor.ensure(thread.id, plan);
    } catch (err) {
      mcp?.cleanup();
      store.setTurnStatus(turnId, "failed", { error: String(err) });
      publish(bot, thread, turnId, "turn.failed", { error: String(err) });
      return;
    }
    mcp?.cleanup();
    supervisor.setTurn(thread.id, turnId);
    void (async () => {
      const outcome = await new Promise<TurnOutcome>((resolve) => pendingTurns.set(thread.id, resolve));
      pendingTurns.delete(thread.id);
      supervisor.setTurn(thread.id, null);
      if (outcome.cancelled) {
        store.setTurnStatus(turnId, "cancelled");
        publish(bot, thread, turnId, "turn.cancelled", {});
      } else if (outcome.ok) {
        store.setTurnStatus(turnId, "completed", { stopReason: "result" });
        publish(bot, thread, turnId, "turn.completed", { text: outcome.text });
      } else {
        const error = outcome.error ?? "未知错误";
        store.setTurnStatus(turnId, "failed", { error });
        publish(bot, thread, turnId, "turn.failed", { error });
      }
    })();
    supervisor.send(thread.id, driver.encodeMessage(text));
  }

  function json(res: http.ServerResponse, status: number, body: unknown): void {
    res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify(body));
  }

  function readJson(req: http.IncomingMessage): unknown {
    return new Promise((resolve, reject) => {
      let data = "";
      req.on("data", (chunk) => {
        data += chunk;
        if (data.length > 1_000_000) reject(new Error("body too large"));
      });
      req.on("end", () => {
        if (!data) return resolve({});
        try {
          resolve(JSON.parse(data));
        } catch (err) {
          reject(err);
        }
      });
      req.on("error", reject);
    });
  }

  function serveStatic(res: http.ServerResponse, pathname: string): void {
    const webDist = deps.webDist ?? path.resolve("dist/web");
    let file = path.join(webDist, pathname === "/" ? "index.html" : decodeURIComponent(pathname).replace(/^\/+/, ""));
    if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(webDist, "index.html");
    if (!fs.existsSync(file)) {
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      res.end("Web UI 未构建:请先运行 npm run build");
      return;
    }
    if (file.endsWith(".html")) {
      const html = fs
        .readFileSync(file, "utf8")
        .replace("</head>", `<script>window.__VIOLET_TOKEN__=${JSON.stringify(cfg.token)}</script></head>`);
      res.writeHead(200, { "content-type": MIME[".html"]!, "cache-control": "no-store" });
      res.end(html);
      return;
    }
    res.writeHead(200, { "content-type": MIME[path.extname(file)] ?? "application/octet-stream" });
    fs.createReadStream(file).pipe(res);
  }

  const server = http.createServer(async (req, res) => {
    try {
      await route(req, res);
    } catch (err) {
      json(res, 500, { error: err instanceof Error ? err.message : String(err) });
    }
  });

  const heartbeat = setInterval(() => {
    for (const client of sseClients) client.write(": ping\n\n");
  }, 15000);
  heartbeat.unref();

  bus.subscribe((event) => {
    for (const client of sseClients) {
      client.write(`data: ${JSON.stringify(event)}\n\n`);
    }
  });

  async function route(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://localhost");
    const pathname = url.pathname;
    const segments = pathname.split("/").filter(Boolean);

    if (pathname.startsWith("/api")) {
      const authHeader = req.headers.authorization;
      const okHeader = authHeader === `Bearer ${cfg.token}`;
      const okQuery = pathname === "/api/events" && url.searchParams.get("token") === cfg.token;
      if (!okHeader && !okQuery) {
        json(res, 401, { error: "unauthorized" });
        return;
      }
    }

    const [api, a, b, c] = segments;
    if (api !== "api") {
      if (req.method === "GET") {
        serveStatic(res, pathname);
        return;
      }
      json(res, 404, { error: "not found" });
      return;
    }

    if (a === "health" && req.method === "GET") {
      json(res, 200, { ok: true });
      return;
    }

    if (a === "bots") {
      if (!b && req.method === "GET") {
        json(res, 200, store.listBots());
        return;
      }
      if (!b && req.method === "POST") {
        const input = botInput.parse(await readJson(req));
        const id = crypto.randomUUID();
        const bot: BotRow = {
          id,
          name: input.name,
          avatar: input.avatar ?? null,
          persona: input.persona,
          driver: driver.kind,
          model: input.model ?? null,
          approval_mode: input.approvalMode,
          workspace: "",
          status: "active",
          created_at: new Date().toISOString(),
        };
        bot.workspace = initWorkspace(cfg.home, bot);
        store.createBot(bot);
        json(res, 201, bot);
        return;
      }
      const bot = store.getBot(b!);
      if (!bot) {
        json(res, 404, { error: "bot not found" });
        return;
      }
      if (c === undefined && req.method === "PATCH") {
        const patch = botPatch.parse(await readJson(req));
        const row: Partial<BotRow> = {};
        if (patch.name !== undefined) row.name = patch.name;
        if (patch.avatar !== undefined) row.avatar = patch.avatar;
        if (patch.persona !== undefined) row.persona = patch.persona;
        if (patch.model !== undefined) row.model = patch.model;
        if (patch.approvalMode !== undefined) row.approval_mode = patch.approvalMode;
        store.updateBot(bot.id, row);
        const updated = store.getBot(bot.id)!;
        if (patch.persona !== undefined || patch.name !== undefined) {
          writeClaudeMd(updated.workspace, updated);
        }
        json(res, 200, updated);
        return;
      }
      if (c === undefined && req.method === "DELETE") {
        for (const thread of store.listThreads(bot.id)) {
          if (supervisor.has(thread.id)) supervisor.interrupt(thread.id);
        }
        store.deleteEventsOfBot(bot.id);
        store.deleteThreadsOfBot(bot.id);
        store.deleteBot(bot.id);
        json(res, 200, { ok: true });
        return;
      }
      if (c === "threads" && req.method === "GET") {
        json(res, 200, store.listThreads(bot.id));
        return;
      }
      if (c === "threads" && req.method === "POST") {
        const thread: ThreadRow = {
          id: crypto.randomUUID(),
          bot_id: bot.id,
          cli_session_id: null,
          title: null,
          created_at: new Date().toISOString(),
          last_active_at: new Date().toISOString(),
        };
        store.createThread(thread);
        json(res, 201, thread);
        return;
      }
    }

    if (a === "threads" && b) {
      const ctx = lookup(b);
      if (!ctx) {
        json(res, 404, { error: "thread not found" });
        return;
      }
      if (c === "events" && req.method === "GET") {
        json(res, 200, store.listEvents(b).map((row) => ({
          seq: row.seq,
          turnId: row.turn_id,
          type: row.type,
          payload: JSON.parse(row.payload_json),
          at: row.at,
        })));
        return;
      }
      if (c === "messages" && req.method === "POST") {
        const input = messageInput.parse(await readJson(req));
        const turnId = crypto.randomUUID();
        store.createTurn({ id: turnId, thread_id: b, status: "queued", started_at: null, ended_at: null, stop_reason: null, error: null });
        admission.submit(ctx.bot.id, { run: () => Promise.resolve(runTurn(ctx.bot, ctx.thread, turnId, input.text)) });
        json(res, 202, { turnId });
        return;
      }
      if (c === "cancel" && req.method === "POST") {
        supervisor.interrupt(b);
        json(res, 200, { ok: true });
        return;
      }
    }

    if (a === "approvals") {
      if (b === "pending" && req.method === "GET") {
        json(res, 200, broker.pendingApprovals().map((row) => ({ ...row, input: JSON.parse(row.input_json) })));
        return;
      }
      if (b && c === "decision" && req.method === "POST") {
        const input = decisionInput.parse(await readJson(req));
        const decision = broker.decide(b, input.decision);
        if (!decision) {
          json(res, 404, { error: "审批不存在或已处理" });
          return;
        }
        json(res, 200, decision);
        return;
      }
    }

    if (a === "events" && req.method === "GET") {
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-store",
        connection: "keep-alive",
      });
      res.write(": connected\n\n");
      sseClients.add(res);
      req.on("close", () => sseClients.delete(res));
      return;
    }

    json(res, 404, { error: "not found" });
  }

  return server;
}

