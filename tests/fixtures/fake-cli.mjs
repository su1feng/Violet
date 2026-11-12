import readline from "node:readline";

const SESSION = "fake-session-1";
console.log(JSON.stringify({ type: "system", subtype: "init", session_id: SESSION }));

const rl = readline.createInterface({ input: process.stdin, terminal: false });
let n = 0;
rl.on("line", (line) => {
  if (!line.trim()) return;
  n += 1;
  const frame = JSON.parse(line);
  const text = frame.message?.content?.[0]?.text ?? "";
  console.log(
    JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "text", text: `echo(${n}): ${text}` }] },
    }),
  );
  console.log(JSON.stringify({ type: "result", subtype: "success", session_id: SESSION, result: `done ${n}` }));
});

