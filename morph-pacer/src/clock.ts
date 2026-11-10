export interface Clock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

export class RealClock implements Clock {
  now(): number {
    return Date.now();
  }

  sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
  }
}

interface FakeTimer {
  at: number;
  resolve: () => void;
}

async function flush(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

export class FakeClock implements Clock {
  private current = 0;
  private timers: FakeTimer[] = [];

  now(): number {
    return this.current;
  }

  sleep(ms: number): Promise<void> {
    return new Promise<void>((resolve) => {
      this.timers.push({ at: this.current + Math.max(0, ms), resolve });
    });
  }

  get pending(): number {
    return this.timers.length;
  }

  async advance(ms: number): Promise<void> {
    const target = this.current + Math.max(0, ms);
    for (;;) {
      const due = this.timers
        .filter((timer) => timer.at <= target)
        .sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      this.timers = this.timers.filter((timer) => timer !== due);
      this.current = due.at;
      due.resolve();
      await flush();
    }
    this.current = target;
    await flush();
  }
}
