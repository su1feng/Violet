export interface BroadcastEvent {
  botId: string | null;
  threadId: string | null;
  turnId: string | null;
  seq?: number;
  type: string;
  payload: unknown;
  at?: string;
}

export class EventBus {
  private subscribers = new Set<(event: BroadcastEvent) => void>();

  subscribe(fn: (event: BroadcastEvent) => void): () => void {
    this.subscribers.add(fn);
    return () => this.subscribers.delete(fn);
  }

  broadcast(event: BroadcastEvent): void {
    for (const fn of this.subscribers) fn(event);
  }
}

