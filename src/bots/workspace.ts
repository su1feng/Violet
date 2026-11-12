import fs from "node:fs";
import path from "node:path";
import type { BotRow } from "../store/db";

export function botWorkspaceDir(home: string, botId: string): string {
  return path.join(home, "bots", botId, "workspace");
}

export function initWorkspace(home: string, bot: Pick<BotRow, "id" | "name" | "persona">): string {
  const dir = botWorkspaceDir(home, bot.id);
  fs.mkdirSync(dir, { recursive: true });
  writeClaudeMd(dir, bot);
  const memory = path.join(dir, "MEMORY.md");
  if (!fs.existsSync(memory)) fs.writeFileSync(memory, `# ${bot.name} 的记忆\n`, "utf8");
  return dir;
}

export function writeClaudeMd(dir: string, bot: Pick<BotRow, "name" | "persona">): void {
  const content = renderClaudeMd(bot);
  fs.writeFileSync(path.join(dir, "CLAUDE.md"), content, "utf8");
}

export function renderClaudeMd(bot: Pick<BotRow, "name" | "persona">): string {
  return [
    `# ${bot.name}`,
    "",
    bot.persona.trim(),
    "",
    "## 工作区规则",
    "",
    "- 你的持久记忆在 MEMORY.md:把重要的偏好、事实和决定写进去,以便跨对话生效。",
    "- 只在本工作区目录内读写文件。",
    "- 有副作用的动作,先等用户批准。",
  ].join("\n");
}

