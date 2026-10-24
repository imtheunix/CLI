import { Button, Dialog, DialogContent, DialogTitle } from '@/shared/ui';
import type { LoadBalancerRepo } from '@/shared/types';

/**
 * Rendered by SendToLoadBalancerButton when the session's folder is in no git
 * repository (a workspace holding many of them): asks which repository the
 * job is for. The list comes ordered from the server — the session's own
 * repository first when it has one, then recently used ones — and every row
 * keeps a phone-friendly 44 px target. Esc, a click outside and Cancel close
 * it without sending; the message stays where it was.
 */
export default function LoadBalancerRepoPickerDialog({ repos, onPick, onCancel }: {
  repos: LoadBalancerRepo[];
  onPick: (repoPath: string) => void;
  onCancel: () => void;
}) {
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onCancel();
      }}
    >
      <DialogContent aria-describedby="load-balancer-repo-description" className="p-5">
        <DialogTitle className="not-sr-only text-base font-semibold text-foreground">
          Which repository is this job for?
        </DialogTitle>

        <p id="load-balancer-repo-description" className="mt-1 text-sm text-muted-foreground">
          This session&rsquo;s folder is not a git repository, so the job needs one to work in.
        </p>

        <ul className="mt-4 max-h-[50vh] space-y-1 overflow-y-auto">
          {repos.map((repo) => (
            <li key={repo.path}>
              <button
                type="button"
                aria-label={`Send the job to ${repo.name}`}
                onClick={() => onPick(repo.path)}
                className="flex min-h-11 w-full flex-col justify-center rounded-md border px-3 py-2 text-left hover:bg-accent"
              >
                <span className="text-sm font-medium">{repo.name}</span>
                <span className="w-full truncate text-xs text-muted-foreground">{repo.path}</span>
              </button>
            </li>
          ))}
        </ul>

        <div className="mt-4 flex justify-end">
          <Button type="button" variant="outline" onClick={onCancel}>Cancel</Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
