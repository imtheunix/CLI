import type { LoadBalancerRepo } from '@/shared/types';

/** Turns a repository name into a literal fragment of a regular expression. */
function escapeRegExp(name: string): string {
  return name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Whether the message names the repository: its folder appears as its own word, so `tripam` is not found inside `tripam-api`. */
function names(message: string, repo: LoadBalancerRepo): boolean {
  return new RegExp(`(^|[^\\w-])${escapeRegExp(repo.name)}([^\\w-]|$)`, 'i').test(message);
}

/**
 * Used by SendToLoadBalancerButton when the session's folder is in no git
 * repository: the one repository the message names, so the usual picker is
 * skipped. A repository name inside a longer named one does not count on its
 * own (a message about `tripam-api` names one repository, not two); anything
 * else — none named, or more than one — is left to the picker, which returns
 * null for.
 */
export function inferLoadBalancerRepo(content: string, repos: LoadBalancerRepo[]): string | null {
  const mentioned = repos.filter((repo) => names(content, repo));
  const unambiguous = mentioned.filter((repo) =>
    !mentioned.some((other) => other !== repo && other.name.length > repo.name.length && other.name.includes(repo.name)));
  return unambiguous.length === 1 ? unambiguous[0].path : null;
}
