import { useState } from 'react';
import { Shell } from '@/modules/shell';
import type { Project, ProjectSession, ShellTarget } from '@/shared/types';

const TARGETS = [
  ['workstation', 'Workstation shell'], ['archsv', 'archsv shell'],
  ['claude', 'Claude Code'], ['codex', 'Codex'], ['agy', 'Antigravity'],
] as const;

/** Used by StandaloneShell for the workspace Shell tab; login modals retain their own commands. */
export default function ShellTargetPicker({ project, session, isActive, autoConnect }: {
  project: Project; session: ProjectSession | null; isActive: boolean; autoConnect: boolean;
}) {
  const storageKey = `shell-target:${session?.id ?? `project:${project.fullPath || project.path}`}`;
  // Each conversation remembers its terminal choice across tab changes and reloads.
  const [target, setTarget] = useState<ShellTarget>(() => {
    try {
      const saved = localStorage.getItem(storageKey);
      return TARGETS.some(([value]) => value === saved) ? saved as ShellTarget : 'workstation';
    } catch { return 'workstation'; }
  });
  return (
    <div className="flex h-full min-h-0 flex-col">
      <label className="flex flex-wrap items-center gap-2 border-b p-2 text-sm">Open terminal
        <select aria-label="Shell target" className="min-h-11 rounded border bg-background px-3 text-base" value={target} onChange={(event) => {
          const next = event.target.value as ShellTarget;
          try { localStorage.setItem(storageKey, next); } catch { /* Choice still works without storage. */ }
          setTarget(next);
        }}>
          {TARGETS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </select>
      </label>
      <div className="min-h-0 flex-1">
        <Shell key={target} launchTarget={target} selectedProject={project} selectedSession={session} isActive={isActive} autoConnect={autoConnect} />
      </div>
    </div>
  );
}
