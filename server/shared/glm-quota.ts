/** Orchestrator and ZCode plan fallback: recognize Z.ai plan exhaustion, never a generic HTTP 429. */
export function detectGlmQuotaReset(text: string, now: Date): Date | null {
  // Observed in six OpenCode APIErrors on 2026-11-02 (Z.ai code 1308, the 5-hour window) and on 2026-11-03
  // (code 1310, "Weekly/Monthly Limit Exhausted", resetting days later).
  if (!/Usage limit reached for \d+\s+(?:hour|day|week|month)s?\b|Weekly\/Monthly Limit Exhausted/i.test(text)) return null;
  const reset = /Your limit will reset at\s+(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})(Z|[+-]\d{2}:?\d{2})?/i.exec(text);
  // Z.ai's unqualified wall time is UTC+8, as confirmed against response Date headers.
  const timestamp = reset ? Date.parse(`${reset[1]}T${reset[2]}${reset[3] ?? '+08:00'}`) : NaN;
  return new Date(Number.isFinite(timestamp) && timestamp > now.getTime() ? timestamp : now.getTime() + 3_600_000);
}
