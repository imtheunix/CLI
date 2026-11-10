import { useCallback, useEffect, useState } from 'react';

import { api } from '@/shared/api';
import { Badge, Card, CardContent, CardHeader, CardTitle, ScrollArea } from '@/shared/ui';

/** One goal block from the hub's goals.md. */
type StatusGoal = {
  title: string;
  status: string;
  updated: string | null;
  now: string | null;
  next: string | null;
  jobs: string[];
  needs: string | null;
};

/** A job as the status page shows it. */
type StatusJob = {
  id: string;
  title: string;
  backend: string | null;
  model: string | null;
  state: string;
  mergeStep: string;
  tier: string | null;
  ageMs: number | null;
  waitingMs: number | null;
  step: string | null;
  at: string | null;
  reason: string | null;
};

/** One efficiency window (rolling 1 h or 24 h). */
type StatusEfficiencyWindow = {
  windowMs: number;
  deepseek: { capUseAvg: number; capUseP90: number; activeMinutes: number; slotOccupancy: number };
  kimi: {
    outputByRole: { hub: number; planner: number; jobs: number; compaction: number };
    reasoningShare: number;
    cacheHit: number;
    uncachedInputPerHubCall: number;
  };
  flow: {
    leadTimeMedianMs: number | null;
    reviewWaitMedianMs: number | null;
    reviewWaitMaxMs: number | null;
    fixRoundRate: number;
    reviewTiers: { gate: number; refute: number; deep: number };
    mergedPerHour: number;
    tokensPerMergedJob: number;
  };
  waste: { compactionTokens: number; cancelledJobs: number; pacerWaitMs: number; retries429: number };
};

/** The JSON `GET /api/orchestrator/status` returns. */
type StatusSnapshot = {
  at: string;
  needsYou: { goals: string[]; jobs: Array<{ id: string; title: string; reason: string }> };
  goals: StatusGoal[];
  jobs: { running: StatusJob[]; review: StatusJob[]; queue: StatusJob[]; merged: StatusJob[]; failed: StatusJob[] };
  capacity: {
    morph: {
      source: string;
      groups: Record<'kimi' | 'deepseek', { uncachedIn: number; out: number; caps: { uncachedIn: number; out: number } }>;
    };
    loads: Record<string, number>;
    caps: Record<string, number>;
    quota: Record<string, string | null>;
  };
  hub: { sessionId: string | null; provider: string | null; model: string | null; effort: string | null; agent: string | null; lastWakeAt: string | null };
  efficiency: { hour: StatusEfficiencyWindow; day: StatusEfficiencyWindow };
};

const REFRESH_MS = 30_000;
const BACKENDS = ['claude', 'codex', 'glm', 'agy', 'zcode', 'morph'];

function formatDuration(ms: number | null): string {
  if (ms === null) return '-';
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, '0')}m`;
}

function formatPercent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function formatTokens(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return String(Math.round(value));
}

function jobWhere(job: StatusJob): string {
  if (job.step) return `ci:${job.step}`;
  return job.mergeStep !== 'none' ? `ci:${job.mergeStep}` : job.state;
}

function JobRow({ job }: { job: StatusJob }) {
  const extra = job.ageMs !== null
    ? formatDuration(job.ageMs)
    : job.waitingMs !== null
      ? `waiting ${formatDuration(job.waitingMs)}`
      : job.at
        ? job.at.slice(0, 16).replace('T', ' ')
        : '';
  return (
    <li className="flex flex-wrap items-baseline gap-x-2 gap-y-1 border-b border-border/40 py-1.5 text-sm last:border-0">
      <span className="font-mono text-xs text-muted-foreground">{job.id}</span>
      <Badge variant="secondary" className="text-[10px]">{job.backend ?? '-'}</Badge>
      {job.tier && <Badge variant="outline" className="text-[10px]">tier:{job.tier}</Badge>}
      <span className="text-xs text-muted-foreground">{jobWhere(job)}</span>
      {extra && <span className="text-xs text-muted-foreground">{extra}</span>}
      <span className="min-w-0 flex-1 truncate">{job.title}</span>
      {job.reason && <span className="w-full text-xs text-destructive">{job.reason}</span>}
    </li>
  );
}

function JobSection({ title, jobs }: { title: string; jobs: StatusJob[] }) {
  return (
    <div>
      <h4 className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{title}</h4>
      {jobs.length === 0 ? <p className="text-sm text-muted-foreground">none</p> : <ul>{jobs.map((job) => <JobRow key={job.id} job={job} />)}</ul>}
    </div>
  );
}

function EfficiencyCard({ label, window }: { label: string; window: StatusEfficiencyWindow }) {
  const roles = window.kimi.outputByRole;
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm">Efficiency ({label})</CardTitle>
      </CardHeader>
      <CardContent className="space-y-1 text-sm">
        <p>DeepSeek cap use: avg {formatPercent(window.deepseek.capUseAvg)}, p90 {formatPercent(window.deepseek.capUseP90)} over {window.deepseek.activeMinutes} active min; slots {formatPercent(window.deepseek.slotOccupancy)}</p>
        <p>Kimi output: hub {formatTokens(roles.hub)}, planner {formatTokens(roles.planner)}, jobs {formatTokens(roles.jobs)}, compaction {formatTokens(roles.compaction)}</p>
        <p>Kimi reasoning {formatPercent(window.kimi.reasoningShare)}, cache hit {formatPercent(window.kimi.cacheHit)}, uncached/hub call {formatTokens(window.kimi.uncachedInputPerHubCall)}</p>
        <p>Flow: lead {formatDuration(window.flow.leadTimeMedianMs)}, review wait {formatDuration(window.flow.reviewWaitMedianMs)} (max {formatDuration(window.flow.reviewWaitMaxMs)}), fix rounds {formatPercent(window.flow.fixRoundRate)}, tiers gate {window.flow.reviewTiers.gate} refute {window.flow.reviewTiers.refute} deep {window.flow.reviewTiers.deep}, merged/h {window.flow.mergedPerHour.toFixed(2)}, tokens/merged {formatTokens(window.flow.tokensPerMergedJob)}</p>
        <p>Waste: compaction {formatTokens(window.waste.compactionTokens)}, cancelled {window.waste.cancelledJobs}, pacer wait {formatDuration(window.waste.pacerWaitMs)}, 429 retries {window.waste.retries429}</p>
      </CardContent>
    </Card>
  );
}

/** Used by the project-workspace module's Status tab to show goals, jobs, capacity, hub and efficiency. */
export default function StatusView() {
  // The last snapshot and whether a fetch is in flight; the view refreshes every 30 s.
  const [snapshot, setSnapshot] = useState<StatusSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      const response = await api.orchestrator.status();
      const body = await response.json() as { success?: boolean; data?: { status?: StatusSnapshot }; error?: { message?: string } };
      if (!response.ok || !body.success || !body.data?.status) {
        throw new Error(body.error?.message ?? `status request failed (${response.status})`);
      }
      setSnapshot(body.data.status);
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => void load(), REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [load]);

  if (loading && !snapshot) {
    return <div className="p-6 text-sm text-muted-foreground">Loading status…</div>;
  }

  if (!snapshot) {
    return <div className="p-6 text-sm text-destructive">{error ?? 'Status unavailable'}</div>;
  }

  const needs = [
    ...snapshot.needsYou.goals.map((need) => ({ key: `goal:${need}`, text: need })),
    ...snapshot.needsYou.jobs.map((job) => ({ key: `job:${job.id}`, text: `${job.id} ${job.title}: ${job.reason}` })),
  ];
  const morph = snapshot.capacity.morph;

  return (
    <ScrollArea className="h-full">
      <div className="mx-auto max-w-5xl space-y-4 p-4">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold">Status</h2>
          <span className="text-xs text-muted-foreground">
            {new Date(snapshot.at).toLocaleString()}{error ? ` · refresh failed: ${error}` : ''}
          </span>
        </div>

        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-sm">Needs you</CardTitle></CardHeader>
          <CardContent>
            {needs.length === 0 ? <p className="text-sm text-muted-foreground">nothing</p> : (
              <ul className="list-disc space-y-1 pl-5 text-sm">
                {needs.map((need) => <li key={need.key}>{need.text}</li>)}
              </ul>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-sm">Goals</CardTitle></CardHeader>
          <CardContent className="space-y-3">
            {snapshot.goals.length === 0 ? <p className="text-sm text-muted-foreground">none</p> : snapshot.goals.map((goal) => (
              <div key={goal.title} className="space-y-1 border-b border-border/40 pb-2 last:border-0 last:pb-0">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">{goal.title}</span>
                  <Badge variant={goal.status === 'running' ? 'default' : 'secondary'}>{goal.status}</Badge>
                  {goal.updated && <span className="text-xs text-muted-foreground">updated {goal.updated}</span>}
                </div>
                {goal.now && <p className="text-sm"><span className="text-muted-foreground">now:</span> {goal.now}</p>}
                {goal.next && <p className="text-sm"><span className="text-muted-foreground">next:</span> {goal.next}</p>}
                <p className="text-xs text-muted-foreground">jobs: {goal.jobs.length > 0 ? goal.jobs.join(' ') : 'none'}</p>
                {goal.needs && <p className="text-xs text-destructive">needs: {goal.needs}</p>}
              </div>
            ))}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-sm">Jobs</CardTitle></CardHeader>
          <CardContent className="space-y-3">
            <JobSection title="Running" jobs={snapshot.jobs.running} />
            <JobSection title="At review" jobs={snapshot.jobs.review} />
            <JobSection title="CI/CD queue" jobs={snapshot.jobs.queue} />
            <JobSection title="Merged (24h)" jobs={snapshot.jobs.merged} />
            <JobSection title="Failed (24h)" jobs={snapshot.jobs.failed} />
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-sm">Capacity</CardTitle></CardHeader>
          <CardContent className="space-y-1 text-sm">
            <p>{BACKENDS.map((backend) => `${backend}: ${snapshot.capacity.loads[backend] ?? 0}/${snapshot.capacity.caps[backend] ?? 0}`).join('  ')}</p>
            <p>
              morph: kimi out {formatTokens(morph.groups.kimi.out)}/{formatTokens(morph.groups.kimi.caps.out)} in {formatTokens(morph.groups.kimi.uncachedIn)}/{formatTokens(morph.groups.kimi.caps.uncachedIn)}
              {' | '}deepseek out {formatTokens(morph.groups.deepseek.out)}/{formatTokens(morph.groups.deepseek.caps.out)} in {formatTokens(morph.groups.deepseek.uncachedIn)}/{formatTokens(morph.groups.deepseek.caps.uncachedIn)}
            </p>
            {Object.entries(snapshot.capacity.quota).filter(([, until]) => until).map(([backend, until]) => (
              <p key={backend} className="text-xs text-destructive">{backend}: quota-exhausted until {until}</p>
            ))}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-sm">Hub</CardTitle></CardHeader>
          <CardContent className="space-y-1 text-sm">
            {snapshot.hub.sessionId ? (
              <>
                <p>session: <span className="font-mono text-xs">{snapshot.hub.sessionId}</span></p>
                <p>{[snapshot.hub.provider, snapshot.hub.model, snapshot.hub.effort, snapshot.hub.agent].filter(Boolean).join(' · ')}</p>
                <p className="text-xs text-muted-foreground">last wake: {snapshot.hub.lastWakeAt ?? 'never'}</p>
              </>
            ) : <p className="text-muted-foreground">no hub session configured</p>}
          </CardContent>
        </Card>

        <EfficiencyCard label="1h" window={snapshot.efficiency.hour} />
        <EfficiencyCard label="24h" window={snapshot.efficiency.day} />
      </div>
    </ScrollArea>
  );
}
