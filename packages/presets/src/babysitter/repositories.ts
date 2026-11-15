import type { GitHubAppRepository } from "@vite-hub/forge";
import { hasRuntimeType, isRuntimeRecord } from "../internal/runtime-type.ts";
import { presetsErrorDiagnostics } from "../error-diagnostics.ts";

/** How long the installation repository list stays fresh without an installation webhook. */
const installationRepositoriesTtlMs = 10 * 60_000;

const repositoryName = /^[\w.-]+\/[\w.-]+$/;

/** The repositories that one Babysitter serves, as lowercase `owner/name`. */
export interface BabysitterRepositories {
  /** `"allow"` for `filter.repository.allow`, `"installations"` for every repository the GitHub App can access. */
  readonly source: "allow" | "installations";
  /** The list without a GitHub read. */
  known(): readonly string[];
  /** The list, read again from the App installations when it is stale. A failed read keeps the last list and rejects. */
  current(): Promise<readonly string[]>;
  /**
   * Notes a signed delivery. Installation events update the list and make it stale. An event from a
   * repository the list does not have yet adds it, because GitHub sends only events of installed repositories.
   * Returns whether the list changed.
   */
  observe(event: string, payload: unknown): boolean;
}

function lowercaseNames(values: unknown): string[] {
  return Array.isArray(values) ? values.filter((value): value is string => hasRuntimeType(value, "string")).map(value => value.toLowerCase()) : [];
}

/**
 * Resolves `filter.repository`. A non-empty `allow` list is used as given. Without one, the Babysitter
 * serves every repository that `read` returns, except archived ones and those in `deny`.
 */
export function babysitterRepositories(
  filter: unknown,
  read: () => Promise<readonly GitHubAppRepository[]>,
  { ttlMs = installationRepositoriesTtlMs, now = Date.now }: { ttlMs?: number; now?: () => number } = {},
): BabysitterRepositories {
  const rules = isRuntimeRecord(filter) && isRuntimeRecord(filter.repository) ? filter.repository : undefined;
  const allow = Array.isArray(rules?.allow) ? rules.allow : [];
  if (allow.length) {
    const repositories = allow.filter((value): value is string => hasRuntimeType(value, "string") && repositoryName.test(value)).map(value => value.toLowerCase());
    if (!repositories.length) throw presetsErrorDiagnostics.PRESETS_BABYSITTER_REPOSITORIES_INVALID();
    return { source: "allow", known: () => repositories, current: async () => repositories, observe: () => false };
  }
  const deny = new Set(lowercaseNames(rules?.deny));
  const accepted = (repository: string) => repositoryName.test(repository) && !deny.has(repository);
  let repositories: string[] = [];
  let loadedAt: number | undefined;
  let refreshing: Promise<readonly string[]> | undefined;
  // Installation deliveries during a read make its result stale.
  let installationEvents = 0;
  const set = (next: Iterable<string>) => {
    const sorted = [...new Set(next)].sort();
    const changed = sorted.length !== repositories.length || sorted.some((repository, index) => repository !== repositories[index]);
    repositories = sorted;
    return changed;
  };
  const refresh = () => refreshing ??= (async () => {
    try {
      const events = installationEvents;
      const installed = await read();
      if (events !== installationEvents) return repositories;
      set(installed.filter(item => !item.archived).map(item => item.repository.toLowerCase()).filter(accepted));
      loadedAt = now();
      return repositories;
    } finally {
      refreshing = undefined;
    }
  })();
  return {
    source: "installations",
    known: () => repositories,
    async current() {
      if (loadedAt !== undefined && now() - loadedAt < ttlMs) return repositories;
      return await refresh();
    },
    observe(event, payload) {
      if (!isRuntimeRecord(payload)) return false;
      if (event === "installation" || event === "installation_repositories") {
        // The next read lists the installations again; the delivery's own lists apply at once.
        loadedAt = undefined;
        installationEvents++;
        const names = (value: unknown) => Array.isArray(value) ? lowercaseNames(value.map(item => isRuntimeRecord(item) ? item.full_name : undefined)) : [];
        const removed = new Set([...names(payload.repositories_removed), ...(["deleted", "suspend"].includes(String(payload.action)) ? names(payload.repositories) : [])]);
        const added = [...names(payload.repositories_added), ...(["created", "unsuspend"].includes(String(payload.action)) ? names(payload.repositories) : [])].filter(accepted);
        return set([...repositories.filter(repository => !removed.has(repository)), ...added]);
      }
      const repository = isRuntimeRecord(payload.repository) ? payload.repository : undefined;
      const name = hasRuntimeType(repository?.full_name, "string") ? repository.full_name.toLowerCase() : undefined;
      if (!name || !isRuntimeRecord(payload.installation) || repository?.archived === true || !accepted(name) || repositories.includes(name)) return false;
      return set([...repositories, name]);
    },
  };
}
