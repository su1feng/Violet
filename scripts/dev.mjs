import { spawn } from "node:child_process";

const procs = [
  ["server", "npx", ["tsx", "watch", "src/server/index.ts"]],
  ["web", "npx", ["vite"]],
];

for (const [name, cmd, args] of procs) {
  const child = spawn(cmd, args, { stdio: ["ignore", "inherit", "inherit"], shell: true });
  child.on("exit", (code) => {
    console.log(`[${name}] exited with ${code}`);
    for (const other of procs) if (other[0] !== name) process.exit(code ?? 0);
  });
}

