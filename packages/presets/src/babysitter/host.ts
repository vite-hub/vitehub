import { execFile } from "node:child_process";
import { lstat, mkdtemp, readdir, readFile, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { channelEnv } from "@vite-hub/agent/channels";
import { defineAgent } from "@vite-hub/agent";
import type { AgentInput, AgentCallbackContext } from "@vite-hub/agent";
import { hasRuntimeType, isRuntimeRecord } from "../internal/runtime-type.ts";
import { registerAgentProcessHostIntake, type AgentProcessHostContext, type AgentProcessHostInstance } from "@vite-hub/agent/process";
import { createProcessAgentHost } from "@vite-hub/agent/process";
import { createGitHubAppCredentials, createGitHubHost, type GitHubAppEnvironment } from "../github/index.ts";
import { createBabysitterPreflight } from "./preflight.ts";
import { babysitterQueueHealth } from "./queue-health.ts";
import { presetsBuildRevision } from "../internal/build-revision.ts";
import { fileURLToPath } from "node:url";
import { createBabysitterRuntime } from "./server.ts";
import { budgetParks } from "./inbox/store.ts";
import { babysitterRepositories } from "./repositories.ts";
import { createBabysitterAdmission, resolveBabysitterAdmissionLimits, type BabysitterAdmissionOptions } from "./admission.ts";
import { createPullRequestWorkspaces, type BabysitterWarmWorkspaces, type PullRequestWorkspaceStatus } from "./pr-workspaces.ts";

declare const __VITEHUB_PRESETS_BUILD_REVISION__: string;

/** Reads a plain or sealed Server Env value. */
export function envString(value: unknown): string | undefined {
  const plain = isRuntimeRecord(value) && hasRuntimeType(value.unseal, "function") ? value.unseal() : value;
  if (hasRuntimeType(plain, "number")) return String(plain);
  return hasRuntimeType(plain, "string") && plain.trim() ? plain.trim() : undefined;
}

/** Accept PEM secrets from systemd and dotenv files that encode newlines as `\\n`. */
function normalizePrivateKey(value: string | undefined): string | undefined {
  return value?.replace(/\\n/g, "\n");
}

/**
 * Remove the persistent checkout pool created by older Babysitter releases.
 *
 * Current GitHub hosts use a disposable checkout for each pass. The old pool
 * retained merged and closed PR workspaces, including installed dependencies,
 * under the owning process host data directory; remove that pool as one unit.
 */
export async function cleanupLegacyBabysitterCheckouts(dataDir: string): Promise<number> {
  const root = join(dataDir, "checkouts");
  const info = await lstat(root, { bigint: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (!info) return 0;
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new Error(`[vitehub] Refusing to clean unsafe Babysitter checkout pool: ${root}`);
  }
  const quarantine = await mkdtemp(join(dataDir, ".checkouts-cleanup-"));
  const claimed = join(quarantine, "checkouts");
  await rename(root, claimed);
  const claimedInfo = await lstat(claimed, { bigint: true });
  if (!claimedInfo.isDirectory() || claimedInfo.dev !== info.dev || claimedInfo.ino !== info.ino) {
    throw new Error(`[vitehub] Refusing to clean replaced Babysitter checkout pool: ${claimed}`);
  }
  const entries = await readdir(claimed, { withFileTypes: true });
  await promisify(execFile)(process.execPath, ["--input-type=module", "--eval", `
    import { lstat, readdir, rm } from "node:fs/promises";
    const info = await lstat(".", { bigint: true });
    if (String(info.dev) !== process.argv[1] || String(info.ino) !== process.argv[2]) {
      throw new Error("Refusing to clean replaced Babysitter checkout pool");
    }
    for (const entry of await readdir(".")) {
      await rm(entry, { force: true, recursive: true, maxRetries: 5, retryDelay: 100 });
    }
  `, String(info.dev), String(info.ino)], { cwd: claimed });
  const remaining = await lstat(claimed, { bigint: true });
  if (remaining.dev !== info.dev || remaining.ino !== info.ino) {
    throw new Error(`[vitehub] Refusing to clean replaced Babysitter checkout pool: ${claimed}`);
  }
  return entries.length;
}

/** GitHub App settings from `env.server.github` or the VITEHUB_GITHUB_* variables. */
export async function readGitHubAppEnvironment(context: Pick<AgentCallbackContext, "cloudflare"> = {}) {
  // SAFETY: channelEnv reads only the Cloudflare bindings from its context; Node hosts have none.
  const env = await channelEnv("github", context as AgentCallbackContext);
  const appId = Number(envString(env.appId));
  const keyPath = envString(env.privateKeyPath);
  const privateKey = normalizePrivateKey(envString(env.privateKey) ?? (keyPath ? (await readFile(keyPath, "utf8")).trim() : undefined));
  const installation = envString(env.installationId);
  if (!Number.isSafeInteger(appId) || appId <= 0 || !privateKey) {
    throw new Error("[vitehub] The Babysitter needs a GitHub App: set VITEHUB_GITHUB_APP_ID and VITEHUB_GITHUB_PRIVATE_KEY (or VITEHUB_GITHUB_PRIVATE_KEY_PATH).");
  }
  const app: GitHubAppEnvironment = { appId, privateKey };
  if (installation) app.installationId = Number(installation);
  app.owner = envString(env.appOwner)?.toLowerCase();
  const configuredInstallations = envString(env.appInstallations);
  if (configuredInstallations) {
    const mappings: unknown = JSON.parse(configuredInstallations);
    if (!isRuntimeRecord(mappings) || Array.isArray(mappings)) throw new Error("VITEHUB_GITHUB_APP_INSTALLATIONS must be an owner-to-installation object.");
    app.installations = Object.fromEntries(Object.entries(mappings).map(([owner, id]) => {
      const installationId = Number(id);
      if (!Number.isSafeInteger(installationId) || installationId <= 0) throw new Error(`Invalid GitHub installation for ${owner}.`);
      return [owner.toLowerCase(), installationId];
    }));
  }
  if (!app.owner) delete app.installationId;
  return app;
}

// A `.cleanup-<pid>-<time>` suffix is left by earlier releases that renamed a checkout before removal.
const passWorkspace = /^(?:vitehub-provider-(?:launch-|tmp-|inspection-)?[A-Za-z0-9]{6}|vitehub-baseline-[A-Za-z0-9]{6}|vitehub-[\w.-]+-pr-\d+-[A-Za-z0-9]{6}(?:\.meta\.json|\.cleanup-\d+-\d+)?|t3-provider-runtime-[A-Za-z0-9]{6})$/;

/**
 * Removes pass workspaces that an interrupted process left in `root`. It sweeps only a temporary
 * directory inside the service's working directory, which no other process shares, and keeps
 * anything this process created.
 */
export async function sweepBabysitterWorkspaces(root = tmpdir(), startedAt = performance.timeOrigin, cwd = process.cwd()): Promise<number> {
  if (!resolve(root).startsWith(`${resolve(cwd)}${sep}`)) return 0;
  let removed = 0;
  for (const entry of await readdir(root, { withFileTypes: true }).catch(() => [])) {
    if (!passWorkspace.test(entry.name)) continue;
    const path = join(root, entry.name);
    const info = await lstat(path).catch(() => undefined);
    if (!info || info.mtimeMs >= startedAt) continue;
    await rm(path, { force: true, recursive: true, maxRetries: 3 }).then(() => removed++, () => {});
  }
  return removed;
}

/** Builds the GitHub host, process host, inbox, and reconciler for one discovered Babysitter Agent. */
export async function createBabysitterProcessHost(context: AgentProcessHostContext): Promise<AgentProcessHostInstance> {
  // SAFETY: the Babysitter preset attaches this contribution only to its own configured definitions.
const agent = context.agent as AgentInput & { options: { filter: unknown; concurrency: number; driver?: string; admission: BabysitterAdmissionOptions; install?: import("../babysitter.ts").BabysitterInstall; capacity?: import("../babysitter.ts").BabysitterOptions["capacity"]; placement?: import("../babysitter.ts").BabysitterPlacement; warmWorkspaces?: boolean | BabysitterWarmWorkspaces } };
  await cleanupLegacyBabysitterCheckouts(context.dataDir);
  const app = await readGitHubAppEnvironment();
  const credentials = createGitHubAppCredentials(app);
  const repositories = babysitterRepositories(agent.options.filter, () => credentials.repositories());
  const identity = await credentials.identity();
  const github = createGitHubHost({ credentials: credentials.credentials, identity });
  let runtime: ReturnType<typeof createBabysitterRuntime> | undefined;
  const host = await createProcessAgentHost({
    name: context.agentName,
    dataDir: context.dataDir,
    invocations: agent.invocations,
    invocationAgentName: `${context.agentName}-worker`,
    // A webhook claim owns a PR until its provider pass finishes or records a
    // durable wait. Keep transient provider pressure in this host queue rather
    // than failing the claim, while bounding how long a checkout can be held.
    capacity: {
      ...agent.options.capacity,
      ...(agent.options.placement?.remoteActive ? { remoteActive: () => agent.options.placement?.remoteActive?.() ?? 0 } : {}),
      concurrency: agent.options.concurrency,
      queue: {
        maxPending: agent.options.concurrency,
        timeout: 36e5,
      },
    },
    intervalMs: 10_000,
    run: async (reason, run, accepting) => await runtime?.reconcile(reason, run, accepting),
  });
  // Placement telemetry does not guarantee that every lease is remote:
  // place() may still return a local lease, which uses hostInstall(). Keep
  // host prerequisites in admission for all placement configurations.
  const preflight = createBabysitterPreflight(agent.options.install ?? true);
  const buildRevision = typeof __VITEHUB_PRESETS_BUILD_REVISION__ === "undefined" ? presetsBuildRevision(fileURLToPath(new URL("../../", import.meta.url))) : __VITEHUB_PRESETS_BUILD_REVISION__;
  const admission = createBabysitterAdmission({
    invocations: host.invocations,
    limits: resolveBabysitterAdmissionLimits(agent.options.admission),
    check: async () => (await preflight()).pause ?? await agent.options.admission?.check?.(),
  });
  let admissionPrerequisiteSample: string | undefined;
  // Workers share the assigned journal and keep provider sessions in the host directory.
  const worker = defineAgent({
    extends: agent,
    invocations: host.invocations,
    driver: { capacity: host.capacity, sessionStorePath: host.providerSessionStorePath },
  });
  // One kept workspace per open PR. The TMPDIR sweep and the legacy checkout cleanup never reach this root.
  const warmWorkspaces = agent.options.warmWorkspaces;
  const workspaces = warmWorkspaces ? createPullRequestWorkspaces({ root: join(context.dataDir, "pr-workspaces"), ...(warmWorkspaces === true ? {} : warmWorkspaces) }) : undefined;
  runtime = createBabysitterRuntime({
    workspaces,
    agent: worker,
    agentName: context.agentName,
    github,
    inboxStorage: context.state.extension("babysitter"),
    inboxScope: context.agentName,
    repositories,
    concurrency: agent.options.concurrency,
    activityAuthors: [identity.login],
    event: host.event,
    error: host.error,
    wake: () => host.wake(),
    admission,
  });
  const inbox = runtime.inbox;
  // No pass runs yet, so workspaces from an earlier process are garbage.
  const swept = await sweepBabysitterWorkspaces();
  const workspaceStatus = async (repository: string, number: number): Promise<PullRequestWorkspaceStatus> => {
    if (!repositories.known().includes(repository.toLowerCase())) return "unknown";
    const snapshot = await inbox.get(repository, number);
    return !snapshot ? "unknown" : snapshot.status === "terminal" ? "terminal" : "open";
  };
  const sweepWorkspaces = (reason: string) => workspaces?.sweep(workspaceStatus).then(
    result => host.event("babysitter.workspaces.pruned", { reason, removed: result.removed.length, reasons: result.removed.map(entry => entry.reason), keptBytes: result.keptBytes, kept: result.kept }),
    error => host.error("babysitter.workspaces.prune_failed", error, { reason }),
  );
  let workspaceSweep: ReturnType<typeof setInterval> | undefined;
  return {
    start() {
      registerAgentProcessHostIntake(context.agentName, async ({ deliveryId, event, payload }) => {
        // Installing the App on a repository enrolls it when no allow list is configured.
        const enrolled = repositories.observe(event, payload);
        if (enrolled) host.event("babysitter.repositories.changed", { event, repositories: repositories.known().length });
        const result = await inbox.ingest(deliveryId, event, payload);
        if (result.updated.length || enrolled || event === "installation" || event === "installation_repositories") host.wake("webhook");
        return Response.json(result, { status: 202 });
      });
      // Bring over an inbox file from a hand-wired Babysitter once, before the first claim.
      // This process owns the inbox scope, so no lease from an earlier process belongs to a running pass.
      void inbox.importLegacyFile(".vitehub/pull-request-inbox.sqlite")
        .catch(error => host.error("babysitter.legacy-import.failed", error))
        .then(() => inbox.releaseLeases())
        .then(released => { if (released) host.event("babysitter.leases.released", { released }) },
          error => host.error("babysitter.leases.release-failed", error))
        .finally(() => {
          if (swept) host.event("babysitter.workspaces.swept", { removed: swept });
          host.start();
          if (workspaces) {
            void sweepWorkspaces("startup");
            if (workspaces.sweepMs > 0) {
              workspaceSweep = setInterval(() => void sweepWorkspaces("interval"), workspaces.sweepMs);
              workspaceSweep.unref();
            }
          }
        });
    },
    async close() {
      clearInterval(workspaceSweep);
      registerAgentProcessHostIntake(context.agentName, undefined);
      await host.close();
      await inbox.close();
    },
    wake: reason => host.wake(reason),
    status: () => host.status(),
    async health() {
      const health = await host.health();
      const queue = await inbox.summary();
      // Refresh prerequisites before admission so both health surfaces describe one sample.
      const prerequisites = await preflight();
      if (admissionPrerequisiteSample !== prerequisites.checkedAt) {
        admissionPrerequisiteSample = prerequisites.checkedAt;
        admission.invalidate();
      }
      const guard = await admission.health();
      const lastSkip = await inbox.meta("admission-skipped");
      return { ...health, status: prerequisites.pause ? "degraded" as const : health.status, diagnostics: [...health.diagnostics, ...prerequisites.diagnostics], release: agent.version, framework: { buildRevision }, concurrency: agent.options.concurrency, repositories: repositories.known(), repositorySource: repositories.source, queue: { ...babysitterQueueHealth(queue), parked: budgetParks(queue) }, admission: {
        accepting: guard.accepting,
        hostOnly: guard.hostOnly,
        reason: guard.reason,
        retryAt: guard.retryAt,
        detail: guard.detail,
        // Retained for existing clients. lastSkip is historical; accepting is current.
        lastSkip,
        history: { lastSkip },
      }, budget: {
        accounting: guard.accounting,
        observedAt: new Date(guard.observedAt).toISOString(),
        hourly: { inputTokens: guard.state.hourlyInputTokens, limit: guard.limits.hourlyInputTokens, resetsAt: guard.state.windows.hourEnd },
        daily: { inputTokens: guard.state.dailyInputTokens, limit: guard.limits.dailyInputTokens, resetsAt: guard.state.windows.dayEnd },
        tmp: { dir: guard.state.tmpDir, freeBytes: guard.state.freeTmpBytes, minFreeBytes: guard.limits.minFreeTmpBytes },
        pause: guard.state.pause,
        errors: guard.state.errors,
      } };
    },
  };
}
