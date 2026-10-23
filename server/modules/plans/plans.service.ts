const PLAN_IDS = new Set(['claude', 'chatgpt', 'google']);

/** Used by the plans router and tests; keeps service credentials exclusively on the server. */
export function createPlansService(env: NodeJS.ProcessEnv = process.env, request: typeof fetch = fetch) {
  let cached: { value: string; expiresAt: number } | undefined;
  let pending: Promise<string> | undefined;
  const configured = () => ['TOKEN_URL', 'TRIPAM_PLANS_CLIENT_ID', 'TRIPAM_PLANS_CLIENT_SECRET', 'TRIPAM_API_URL'].every(key => Boolean(env[key]));
  async function token(): Promise<string> {
    if (cached && cached.expiresAt > Date.now()) return cached.value;
    if (pending) return pending;
    pending = (async () => {
      const response = await request(env.TOKEN_URL!, {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15000),
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'client_credentials', client_id: env.TRIPAM_PLANS_CLIENT_ID!, client_secret: env.TRIPAM_PLANS_CLIENT_SECRET! }),
      });
      if (!response.ok) throw new Error('Plans authentication unavailable');
      const data = await response.json() as Record<string, unknown>;
      if (typeof data.access_token !== 'string' || typeof data.expires_in !== 'number' || !Number.isFinite(data.expires_in) || data.expires_in <= 0) throw new Error('Invalid plans authentication');
      cached = { value: data.access_token, expiresAt: Date.now() + Math.max(0, data.expires_in - 30) * 1000 };
      return cached.value;
    })();
    try { return await pending; } finally { pending = undefined; }
  }
  return {
    configured,
    async read(plan?: string, days = 7) {
      const accessToken = await token();
      const suffix = plan ? `/history?${new URLSearchParams({ plan, days: String(days) })}` : '';
      const url = `${env.TRIPAM_API_URL!.replace(/\/$/, '')}/api/plans/usage${suffix}`;
      const response = await request(url, { redirect: 'error', signal: AbortSignal.timeout(15000), headers: { Authorization: `Bearer ${accessToken}` } });
      if (response.status === 401) cached = undefined;
      if (!response.ok) throw new Error('Plans usage unavailable');
      const data = await response.json();
      if (!Array.isArray(data)) throw new Error('Invalid plans usage');
      // Allowlist the reading shape; never forward upstream objects or error bodies.
      const safeText = (value: unknown): string | null => typeof value === 'string' ? [accessToken, env.TRIPAM_PLANS_CLIENT_SECRET!].reduce((text, secret) => text.split(secret).join('[redacted]'), value).slice(0, 2000) : null;
      return data.filter(item => item && PLAN_IDS.has(item.plan)).map(item => ({
        plan: item.plan, at: safeText(item.at), note: safeText(item.note),
        windows: (Array.isArray(item.windows) ? item.windows : []).filter((window: unknown) => window && typeof window === 'object').map((window: Record<string, unknown>) => ({
          id: safeText(window.id), label: safeText(window.label),
          usedPercent: typeof window.usedPercent === 'number' && Number.isFinite(window.usedPercent) ? Math.max(0, Math.min(100, window.usedPercent)) : null,
          resetsAt: safeText(window.resetsAt),
        })),
      }));
    },
  };
}
