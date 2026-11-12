import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, sseUrl } from "./api";

interface Bot {
  id: string;
  name: string;
  persona: string;
  model: string | null;
  approval_mode: string;
}

interface Thread {
  id: string;
  bot_id: string;
  title: string | null;
  last_active_at: string;
}

interface ThreadEvent {
  seq: number;
  type: string;
  payload: Record<string, unknown>;
  turnId?: string | null;
  at: string;
}

interface Approval {
  id: string;
  bot_id: string;
  thread_id: string;
  tool: string;
  input: unknown;
}

const emptyBotForm = { name: "", persona: "", model: "", approvalMode: "ask" as string };

export function App() {
  const [bots, setBots] = useState<Bot[]>([]);
  const [botId, setBotId] = useState<string | null>(null);
  const [threads, setThreads] = useState<Thread[]>([]);
  const [threadId, setThreadId] = useState<string | null>(null);
  const [events, setEvents] = useState<ThreadEvent[]>([]);
  const [approvals, setApprovals] = useState<Approval[]>([]);
  const [draft, setDraft] = useState("");
  const [showBotForm, setShowBotForm] = useState(false);
  const [form, setForm] = useState({ ...emptyBotForm });
  const [editingBot, setEditingBot] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const chatRef = useRef<HTMLDivElement>(null);

  const refreshApprovals = useCallback(() => {
    api<Approval[]>("/api/approvals/pending").then(setApprovals).catch(() => {});
  }, []);

  useEffect(() => {
    api<Bot[]>("/api/bots").then((rows) => {
      setBots(rows);
      if (rows.length > 0) setBotId((current) => current ?? rows[0]!.id);
    }).catch((err) => setError(String(err)));
    refreshApprovals();
    const source = new EventSource(sseUrl);
    source.onmessage = (msg) => {
      const event = JSON.parse(msg.data) as {
        botId: string | null;
        threadId: string | null;
        type: string;
        payload: Record<string, unknown>;
        turnId?: string | null;
        at?: string;
      };
      if (event.type === "approvals.updated") {
        refreshApprovals();
        return;
      }
      setEvents((current) => [...current, {
        seq: 0,
        type: event.type,
        payload: event.payload,
        turnId: event.turnId ?? null,
        at: event.at ?? new Date().toISOString(),
      }]);
    };
    source.onerror = () => source.close();
    return () => source.close();
  }, [refreshApprovals]);

  useEffect(() => {
    if (!botId) return;
    api<Thread[]>(`/api/bots/${botId}/threads`).then((rows) => {
      setThreads(rows);
      setThreadId((current) => (rows.some((t) => t.id === current) ? current : rows[0]?.id ?? null));
    }).catch(() => setThreads([]));
  }, [botId]);

  useEffect(() => {
    if (!threadId) return;
    api<ThreadEvent[]>(`/api/threads/${threadId}/events`).then(setEvents).catch(() => setEvents([]));
  }, [threadId]);

  useEffect(() => {
    chatRef.current?.scrollTo({ top: chatRef.current.scrollHeight });
  }, [events]);

  const messages = useMemo(() => {
    const out: Array<{ role: "user" | "assistant"; text: string; tools?: string[] }> = [];
    let assistant: { role: "assistant"; text: string; tools?: string[] } | null = null;
    for (const event of events) {
      if (event.type === "message") {
        out.push({ role: "user", text: String(event.payload.text ?? "") });
        assistant = null;
      } else if (event.type === "message.delta") {
        if (!assistant) {
          assistant = { role: "assistant", text: "", tools: [] };
          out.push(assistant);
        }
        assistant.text += String(event.payload.text ?? "");
      } else if (event.type === "tool.use") {
        if (!assistant) {
          assistant = { role: "assistant", text: "", tools: [] };
          out.push(assistant);
        }
        assistant.tools?.push(String(event.payload.name ?? "tool"));
      }
    }
    return out;
  }, [events]);

  async function send() {
    const text = draft.trim();
    if (!text || !threadId) return;
    setDraft("");
    try {
      await api(`/api/threads/${threadId}/messages`, { method: "POST", body: JSON.stringify({ text }) });
    } catch (err) {
      setError(String(err));
    }
  }

  async function createThread() {
    if (!botId) return;
    const thread = await api<Thread>(`/api/bots/${botId}/threads`, { method: "POST", body: "{}" });
    setThreads((current) => [thread, ...current]);
    setThreadId(thread.id);
  }

  function openBotForm(bot?: Bot) {
    setError(null);
    if (bot) {
      setEditingBot(bot.id);
      setForm({ name: bot.name, persona: bot.persona, model: bot.model ?? "", approvalMode: bot.approval_mode });
    } else {
      setEditingBot(null);
      setForm({ ...emptyBotForm });
    }
    setShowBotForm(true);
  }

  async function submitBotForm() {
    try {
      const body = JSON.stringify({
        name: form.name,
        persona: form.persona,
        model: form.model || undefined,
        approvalMode: form.approvalMode,
      });
      if (editingBot) {
        const updated = await api<Bot>(`/api/bots/${editingBot}`, { method: "PATCH", body });
        setBots((current) => current.map((bot) => (bot.id === updated.id ? updated : bot)));
      } else {
        const bot = await api<Bot>("/api/bots", { method: "POST", body });
        setBots((current) => [...current, bot]);
        setBotId(bot.id);
      }
      setShowBotForm(false);
    } catch (err) {
      setError(String(err));
    }
  }

  async function deleteBot(id: string) {
    if (!confirm("删除这个助手?(工作区会保留)")) return;
    await api(`/api/bots/${id}`, { method: "DELETE" });
    const rest = bots.filter((bot) => bot.id !== id);
    setBots(rest);
    if (botId === id) {
      setBotId(rest[0]?.id ?? null);
      setThreadId(null);
    }
  }

  async function decide(approvalId: string, decision: "allow" | "deny") {
    try {
      await api(`/api/approvals/${approvalId}/decision`, { method: "POST", body: JSON.stringify({ decision }) });
    } catch (err) {
      setError(String(err));
    }
    refreshApprovals();
  }

  const bot = bots.find((b) => b.id === botId);

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="sidebar-header">
          <h1>Violet</h1>
          <button onClick={() => openBotForm()}>+ 助手</button>
        </div>
        <ul className="bot-list">
          {bots.map((b) => (
            <li key={b.id} className={b.id === botId ? "active" : ""}>
              <button className="bot-name" onClick={() => setBotId(b.id)}>{b.name}</button>
              <span className="bot-actions">
                <button title="编辑" onClick={() => openBotForm(b)}>✎</button>
                <button title="删除" onClick={() => deleteBot(b.id)}>×</button>
              </span>
            </li>
          ))}
        </ul>
        {bot && (
          <div className="threads">
            <div className="threads-header">
              <span>对话</span>
              <button onClick={createThread}>+ 新对话</button>
            </div>
            <ul>
              {threads.map((t) => (
                <li key={t.id} className={t.id === threadId ? "active" : ""}>
                  <button onClick={() => setThreadId(t.id)}>{t.title ?? "新对话"}</button>
                </li>
              ))}
            </ul>
          </div>
        )}
        <div className="sidebar-footer">{bot?.approval_mode === "ask" ? "审批:ask" : "审批:full"}</div>
      </aside>

      <main className="chat">
        <div className="chat-header">
          <span>{bot?.name ?? "选择一个助手"}</span>
          {threadId && (
            <button className="danger" onClick={() => api(`/api/threads/${threadId}/cancel`, { method: "POST" })}>
              停止
            </button>
          )}
        </div>
        <div className="messages" ref={chatRef}>
          {messages.length === 0 && <div className="empty">发一条消息开始对话</div>}
          {messages.map((m, index) => (
            <div key={index} className={`bubble ${m.role}`}>
              {m.tools && m.tools.length > 0 && (
                <div className="tools">{m.tools.map((tool, i) => <span key={i}>🔧 {tool}</span>)}</div>
              )}
              <div className="text">{m.text || (m.tools?.length ? "" : "…")}</div>
            </div>
          ))}
        </div>
        <div className="composer">
          <textarea
            value={draft}
            placeholder={threadId ? "发消息…(Enter 发送,Shift+Enter 换行)" : "先创建助手"}
            disabled={!threadId}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void send();
              }
            }}
          />
          <button onClick={() => void send()} disabled={!threadId || !draft.trim()}>发送</button>
        </div>
      </main>

      {approvals.length > 0 && (
        <div className="approvals">
          {approvals.map((a) => (
            <div key={a.id} className="approval-card">
              <div className="approval-title">审批:{a.tool}</div>
              <pre>{JSON.stringify(a.input, null, 2)}</pre>
              <div className="approval-actions">
                <button className="allow" onClick={() => decide(a.id, "allow")}>Allow</button>
                <button className="deny" onClick={() => decide(a.id, "deny")}>Deny</button>
              </div>
            </div>
          ))}
        </div>
      )}

      {showBotForm && (
        <div className="modal" onClick={() => setShowBotForm(false)}>
          <div className="modal-card" onClick={(e) => e.stopPropagation()}>
            <h2>{editingBot ? "编辑助手" : "新建助手"}</h2>
            <label>名字<input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></label>
            <label>人格<textarea rows={5} value={form.persona} onChange={(e) => setForm({ ...form, persona: e.target.value })} /></label>
            <label>模型(可选)<input value={form.model} onChange={(e) => setForm({ ...form, model: e.target.value })} placeholder="留空用 CLI 默认" /></label>
            <label>审批档位
              <select value={form.approvalMode} onChange={(e) => setForm({ ...form, approvalMode: e.target.value })}>
                <option value="ask">ask(工具先问)</option>
                <option value="full">full(全自动)</option>
              </select>
            </label>
            {error && <div className="error">{error}</div>}
            <div className="modal-actions">
              <button onClick={() => setShowBotForm(false)}>取消</button>
              <button className="allow" disabled={!form.name.trim() || !form.persona.trim()} onClick={() => void submitBotForm()}>
                保存
              </button>
            </div>
          </div>
        </div>
      )}
      {error && !showBotForm && <div className="toast" onClick={() => setError(null)}>{error}</div>}
    </div>
  );
}

