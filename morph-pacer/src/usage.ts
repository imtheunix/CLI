import type { Usage } from './pacer.js';

interface RawOpenAiUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number };
  completion_tokens_details?: { reasoning_tokens?: number };
}

interface RawAnthropicUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

const ANTHROPIC_FIELDS = [
  'input_tokens',
  'output_tokens',
  'cache_read_input_tokens',
  'cache_creation_input_tokens',
] as const;

function isAnthropicUsage(raw: Record<string, unknown>): boolean {
  return ANTHROPIC_FIELDS.some((field) => field in raw);
}

function toOpenAiUsage(raw: RawOpenAiUsage | undefined): Usage | null {
  if (!raw) return null;
  return {
    promptTokens: Number(raw.prompt_tokens ?? 0),
    completionTokens: Number(raw.completion_tokens ?? 0),
    cachedTokens: Number(raw.prompt_tokens_details?.cached_tokens ?? 0),
    reasoningTokens: Number(raw.completion_tokens_details?.reasoning_tokens ?? 0),
  };
}

/**
 * Anthropic usage separates the uncached input (`input_tokens`) from cache reads and cache writes.
 * The pacer works on total prompt tokens minus the cached read share, so cache creation counts as
 * uncached input (it is fresh processing) and cache reads are the only cached input.
 */
function toAnthropicUsage(raw: RawAnthropicUsage): Usage {
  const input = Number(raw.input_tokens ?? 0);
  const cacheRead = Number(raw.cache_read_input_tokens ?? 0);
  const cacheCreation = Number(raw.cache_creation_input_tokens ?? 0);
  return {
    promptTokens: input + cacheCreation + cacheRead,
    completionTokens: Number(raw.output_tokens ?? 0),
    cachedTokens: cacheRead,
    reasoningTokens: 0,
  };
}

function toUsage(raw: Record<string, unknown> | undefined): Usage | null {
  if (!raw) return null;
  if (isAnthropicUsage(raw)) return toAnthropicUsage(raw as RawAnthropicUsage);
  return toOpenAiUsage(raw as RawOpenAiUsage);
}

export function parseJsonUsage(body: Buffer | string): Usage | null {
  try {
    const parsed = JSON.parse(typeof body === 'string' ? body : body.toString('utf8')) as {
      usage?: Record<string, unknown>;
    };
    return toUsage(parsed.usage);
  } catch {
    return null;
  }
}

export class SseUsageParser {
  private buffer = '';
  private anthropic: RawAnthropicUsage | null = null;
  private openai: RawOpenAiUsage | null = null;

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
      const parsed = JSON.parse(data) as {
        usage?: Record<string, unknown>;
        message?: { usage?: Record<string, unknown> };
      };
      this.addUsage(parsed.usage);
      this.addUsage(parsed.message?.usage);
    } catch {
      return;
    }
  }

  private addUsage(raw: Record<string, unknown> | undefined): void {
    if (!raw) return;
    if (isAnthropicUsage(raw)) {
      const target = (this.anthropic ??= {});
      for (const field of ANTHROPIC_FIELDS) {
        const value = raw[field];
        if (typeof value === 'number') target[field] = value;
      }
      return;
    }
    this.openai = raw as RawOpenAiUsage;
  }

  flush(): void {
    if (this.buffer.length > 0) {
      this.parseLine(this.buffer.replace(/\r$/, ''));
      this.buffer = '';
    }
  }

  get usage(): Usage | null {
    if (this.anthropic) return toAnthropicUsage(this.anthropic);
    return toOpenAiUsage(this.openai ?? undefined);
  }
}
