import { useEffect, useRef, useState } from 'react';
import { api } from '@/shared/api';
import type { BackgroundJob, BackgroundJobDetail } from '@/shared/types';

/** Used by the sidebar Running view to monitor external agents without process controls. */
export function BackgroundJobs({ visible }: { visible: boolean }) {
  // Records refresh only while the Running view and browser page are visible.
  const [jobs, setJobs] = useState<BackgroundJob[]>([]);
  // An open record refreshes its log and summary together with the list.
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // Details belong to a specific selection; late responses are discarded.
  const [detail, setDetail] = useState<BackgroundJobDetail | null>(null);
  // Network and path errors remain visible without hiding the last successful list.
  const [error, setError] = useState('');
  const selectedRef = useRef(selectedId);
  selectedRef.current = selectedId;
  useEffect(() => {
    if (!visible) return;
    let cancelled = false;
    let inFlight = false;
    const refresh = async () => {
      if (document.visibilityState === 'hidden' || inFlight) return;
      inFlight = true;
      try {
        const response = await api.backgroundJobs.list();
        if (!response.ok) throw new Error('Could not load background jobs');
        const body = await response.json();
        if (cancelled) return;
        setJobs(body.jobs);
        const id = selectedRef.current;
        if (id) {
          const output = await api.backgroundJobs.detail(id);
          if (!output.ok) throw new Error('Job output unavailable or path not allowed');
          const result = await output.json();
          if (!cancelled && selectedRef.current === id) setDetail(result);
        }
        if (!cancelled) setError('');
      } catch (reason) {
        if (!cancelled) setError(reason instanceof Error ? reason.message : 'Jobs unavailable');
      } finally { inFlight = false; }
    };
    void refresh();
    const timer = setInterval(() => void refresh(), 10_000);
    const onVisible = () => void refresh();
    document.addEventListener('visibilitychange', onVisible);
    return () => { cancelled = true; clearInterval(timer); document.removeEventListener('visibilitychange', onVisible); };
  }, [visible, selectedId]);
  return (
    <section aria-label="Background jobs" className="m-2 space-y-2 border-t pt-3 text-sm">
      <h3 className="font-medium">Background jobs</h3>
      {error && <p role="alert">{error}</p>}
      {!jobs.length && !error && <p className="text-muted-foreground">No job records found.</p>}
      <ul className="space-y-1">
        {jobs.map((job) => <li key={job.id}>
          <button type="button" className="min-h-11 w-full rounded border p-2 text-left hover:bg-accent" onClick={() => {
            setDetail(null); setSelectedId(job.id);
          }}>
            <span className="block break-words text-base">{job.title}</span>
            <span className="text-sm text-muted-foreground">{job.tool} · {job.machine} · {job.status}</span>
            {job.inferred && <span className="block text-xs text-muted-foreground">Activity in the last 2 minutes</span>}
          </button>
        </li>)}
      </ul>
      {selectedId && <div className="space-y-2 rounded border p-2" aria-label="Job output">
        <button type="button" className="min-h-11 rounded border px-3" onClick={() => { setSelectedId(null); setDetail(null); }}>Close job</button>
        {!detail && !error && <p>Loading output…</p>}
        {detail && <>
          <h4 className="break-words font-medium">{detail.job.title} · {detail.job.status}</h4>
          <p>Log tail</p>
          <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words bg-muted p-2 text-xs">{detail.log || 'No log output yet.'}</pre>
          {detail.summary && <><p>Summary</p><pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words bg-muted p-2 text-sm">{detail.summary}</pre></>}
        </>}
      </div>}
    </section>
  );
}
