export interface Job {
  run: () => Promise<void>;
}

/** Per-bot FIFO serialization with a global concurrency cap. */
export class Admission {
  private queues = new Map<string, Job[]>();
  private perBotRunning = new Map<string, number>();
  private globalRunning = 0;

  constructor(private globalLimit: number) {}

  submit(botId: string, job: Job): void {
    const queue = this.queues.get(botId) ?? [];
    queue.push(job);
    this.queues.set(botId, queue);
    this.drain();
  }

  private drain(): void {
    for (const [botId, queue] of this.queues) {
      if (queue.length === 0) continue;
      const botRunning = this.perBotRunning.get(botId) ?? 0;
      if (botRunning >= 1 || this.globalRunning >= this.globalLimit) continue;
      const job = queue.shift()!;
      this.perBotRunning.set(botId, botRunning + 1);
      this.globalRunning++;
      void job.run().finally(() => {
        this.globalRunning--;
        this.perBotRunning.set(botId, (this.perBotRunning.get(botId) ?? 1) - 1);
        this.drain();
      });
    }
  }
}

