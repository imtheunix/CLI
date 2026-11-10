import type { Usage } from './pacer.js';

interface RawUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number };
  completion_tokens_details?: { reasoning_tokens?: number };
}

function toUsage(raw: RawUsage | undefined): Usage | null {
  if (!raw) return null;
  return {
    promptTokens: Number(raw.prompt_tokens ?? 0),
    completionTokens: Number(raw.completion_tokens ?? 0),
    cachedTokens: Number(raw.prompt_tokens_details?.cached_tokens ?? 0),
    reasoningTokens: Number(raw.completion_tokens_details?.reasoning_tokens ?? 0),
  };
}

export function parseJsonUsage(body: Buffer | string): Usage | null {
  try {
    const parsed = JSON.parse(typeof body === 'string' ? body : body.toString('utf8')) as {
      usage?: RawUsage;
    };
    return toUsage(parsed.usage);
  } catch {
    return null;
  }
}

export class SseUsageParser {
  private buffer = '';
  private lastUsage: Usage | null = null;

  push(chunk: Buffer | string): void {
    this.buffer += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    let newline = this.buffer.indexOf('\n');
    while (newline !== -1) {
      const line = this.buffer.slice(0, newline).replace(/\r$/, '');
      this.buffer = this.buffer.slice(newline + 1);
      this.parseLine(line);
      newline = this.buffer.indexOf('\n');
    }
  }

  private parseLine(line: string): void {
    if (!line.startsWith('data:')) return;
    const data = line.slice(5).trim();
    if (!data || data === '[DONE]') return;
    try {
      const parsed = JSON.parse(data) as { usage?: RawUsage };
      const usage = toUsage(parsed.usage);
      if (usage) this.lastUsage = usage;
    } catch {
      return;
    }
  }

  flush(): void {
    if (this.buffer.length > 0) {
      this.parseLine(this.buffer.replace(/\r$/, ''));
      this.buffer = '';
    }
  }

  get usage(): Usage | null {
    return this.lastUsage;
  }
}
