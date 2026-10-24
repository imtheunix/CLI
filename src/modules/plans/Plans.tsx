import { useEffect, useState } from 'react';
import { plansApi } from '@/shared/api';
import type { PlanReading } from '@/shared/types';

const PLAN_NAMES = { claude: 'Claude', chatgpt: 'ChatGPT', google: 'Google', zai: 'Z.ai GLM' } as const;

/** Used by the sidebar as its Plans view, alongside session navigation. */
export function Plans({ isVisible = true }: { isVisible?: boolean }) {
  // Keeps the latest server readings while a visible refresh is in progress.
  const [readings, setReadings] = useState<PlanReading[]>([]);
  // History is fetched independently so a missing history endpoint does not hide current quota.
  const [history, setHistory] = useState<Partial<Record<string, PlanReading[]>>>({});
  // Communicates configuration and network failures without exposing upstream details.
  const [status, setStatus] = useState('Loading plans…');
  useEffect(() => {
    let disposed = false;
    let busy = false;
    async function refresh() {
      if (!isVisible || document.visibilityState === 'hidden' || busy) return;
      busy = true;
      try {
        const response = await plansApi.usage();
        if (!response.ok) throw new Error();
        const data = await response.json();
        if (disposed) return;
        if (data.configured === false) { setStatus('Plans is not configured.'); return; }
        if (!Array.isArray(data)) throw new Error();
        setReadings(data); setStatus('');
        const entries = await Promise.all(Object.keys(PLAN_NAMES).map(async plan => {
          try { const result = await plansApi.history(plan); return [plan, result.ok ? await result.json() : []] as const; }
          catch { return [plan, []] as const; }
        }));
        if (!disposed) setHistory(Object.fromEntries(entries));
      } catch { if (!disposed) setStatus('Plans usage unavailable. Retrying every minute.'); }
      finally { busy = false; }
    }
    void refresh();
    const interval = setInterval(() => void refresh(), 60000);
    document.addEventListener('visibilitychange', refresh);
    return () => { disposed = true; clearInterval(interval); document.removeEventListener('visibilitychange', refresh); };
  }, [isVisible]);
  return <section aria-label="Plans" className="space-y-4 p-4">
    <h2 className="text-lg font-semibold">Plans</h2>
    {status && <p role="status" className="text-sm text-muted-foreground">{status}</p>}
    {Object.entries(PLAN_NAMES).map(([id, name]) => {
      const reading = readings.find(item => item.plan === id);
      const stale = reading?.at && Date.now() - Date.parse(reading.at) > 15 * 60000;
      return <article key={id} className="space-y-3 border bg-card p-3" aria-label={name}>
        <h3 className="font-semibold">{name}</h3>
        {!reading ? <p className="text-sm text-muted-foreground">No reading yet</p> : <>
          <p className="text-xs text-muted-foreground">Read {reading.at ? new Date(reading.at).toLocaleString() : 'unknown'}{stale ? ' · Stale (over 15 minutes)' : ''}</p>
          {reading.note && <p className="text-base">{reading.note}</p>}
          {reading.windows.length === 0 && <p>Usage unavailable</p>}
          {reading.windows.map(window => <div key={window.id} className="space-y-1">
            <p className="text-base">{window.label}: {window.usedPercent === null ? 'Unavailable' : `${Math.round(window.usedPercent)}% used`}</p>
            {window.usedPercent !== null && <progress className="w-full accent-primary" aria-label={`${name} ${window.label} used`} max={100} value={window.usedPercent} />}
            <p className="text-xs text-muted-foreground">{window.resetsAt ? `Resets ${new Date(window.resetsAt).toLocaleString()}` : 'Reset time unavailable'}</p>
          </div>)}
        </>}
        <details className="text-xs"><summary className="min-h-11 cursor-pointer py-3">7-day history ({history[id]?.length ?? 0} readings)</summary>
          {history[id]?.length ? <ul className="space-y-2">{history[id]!.map((past, i) => <li key={i}>{past.at ? new Date(past.at).toLocaleString() : 'Unknown time'}: {past.windows.map(w => `${w.label} ${w.usedPercent ?? '?'}%`).join(', ')}</li>)}</ul> : <p>History unavailable</p>}
        </details>
      </article>;
    })}
  </section>;
}
