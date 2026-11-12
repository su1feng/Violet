import fs from "node:fs";
import path from "node:path";

export class NdjsonWriter {
  private stream: fs.WriteStream | undefined;

  constructor(private file: string) {}

  append(value: unknown): void {
    if (!this.stream) {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      this.stream = fs.createWriteStream(this.file, { flags: "a" });
    }
    this.stream.write(JSON.stringify(value) + "\n");
  }

  close(): void {
    this.stream?.end();
    this.stream = undefined;
  }
}

