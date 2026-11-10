export interface UsageEvent {
  t: number;
  uncachedIn: number;
  out: number;
}

export interface WindowTotals {
  uncachedIn: number;
  out: number;
}

export class RollingWindow {
  private events: UsageEvent[] = [];

  constructor(private readonly windowMs = 60_000) {}

  add(event: UsageEvent): void {
    this.events.push(event);
  }

  private prune(now: number): void {
    const cutoff = now - this.windowMs;
    this.events = this.events.filter((event) => event.t > cutoff);
  }

  totals(now: number): WindowTotals {
    this.prune(now);
    let uncachedIn = 0;
    let out = 0;
    for (const event of this.events) {
      uncachedIn += event.uncachedIn;
      out += event.out;
    }
    return { uncachedIn, out };
  }

  snapshot(now: number): UsageEvent[] {
    this.prune(now);
    return [...this.events];
  }
}
