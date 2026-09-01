import { execFile } from "node:child_process";
import { existsSync, globSync, readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

import * as ownerAgent from "@vite-hub/agent";
import * as ownerCapabilities from "@vite-hub/agent/capabilities";
import * as ownerAgentEve from "@vite-hub/agent/eve";
import * as ownerAgentMcp from "@vite-hub/agent/mcp";
import * as ownerAgentProcessRuntime from "@vite-hub/agent/runtime/process";
import * as ownerAgentVue from "@vite-hub/agent/vue";
import ownerAuthHandler from "@vite-hub/auth/server";
import * as ownerAuthVue from "@vite-hub/auth/vue";
import * as ownerBlobContentType from "@vite-hub/blob/content-type";
import { setActiveCloudflareEnv as ownerCloudflareEnvSetter } from "@vite-hub/database/runtime/cloudflare-env";
import { setActiveCloudflareEnv as ownerDatabaseStateSetter } from "@vite-hub/database/runtime/state";
import * as ownerRateLimit from "@vite-hub/rate-limit";
import * as framework from "vite-hub";
import * as frameworkAgent from "vite-hub/agent";
import * as frameworkAgentEve from "vite-hub/_internal/agent/eve";
import * as frameworkCapabilities from "vite-hub/agent/capabilities";
import * as frameworkAgentMcp from "vite-hub/agent/mcp";
import * as frameworkAgentProcessRuntime from "vite-hub/agent/runtime/process";
import * as frameworkAgentVue from "vite-hub/agent/vue";
import frameworkAuthHandler from "vite-hub/auth/server";
import * as frameworkAuthVue from "vite-hub/auth/vue";
import * as frameworkBlobContentType from "vite-hub/blob/content-type";
import * as frameworkRateLimit from "vite-hub/rate-limit";
import * as frameworkRuntimeNode from "vite-hub/runtime/node";
import { setActiveCloudflareEnv as frameworkDatabaseStateSetter } from "vite-hub/_internal/database/runtime/state";
import * as ownerRuntimeNode from "@vite-hub/runtime/node";
import { distributionBinEntries, distributionEntriesFromManifest } from "../vite.config.ts";

const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
const execFileAsync = promisify(execFile);

interface DistributionManifest {
  bin: Record<string, string>;
  dependencies: Record<string, string>;
  exports: Record<string, string | { import: string; types?: string }>;
}

function parseDistributionManifest(text: string): DistributionManifest {
  const value: unknown = JSON.parse(text);
  if (Object(value) !== value) throw new TypeError("Expected a package manifest object.");
  const bin = Reflect.get(Object(value), "bin");
  const dependencies = Reflect.get(Object(value), "dependencies");
  const exports = Reflect.get(Object(value), "exports");
  if (Object(bin) !== bin || Object(dependencies) !== dependencies || Object(exports) !== exports) {
    throw new TypeError("Expected package manifest maps.");
  }
  // SAFETY: The checked package.json fields are the string maps exercised by these distribution tests.
  return { bin, dependencies, exports } as DistributionManifest;
}

const manifest = parseDistributionManifest(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
);

const forwarderExportLine = /^export (?:type )?(?:\*|\{[^}]+\}) from "([^"]+)"$/;

const consolidatedOwnerExports = new Set(["@vite-hub/blob/ensure", "@vite-hub/workspace/ai"]);

const lowLevelOwnerExports = new Set([
  "@vite-hub/agent/ai-sdk",
  "@vite-hub/agent/cloudflare/state",
  "@vite-hub/agent/eve",
  "@vite-hub/agent/mcp/stdio",
  "@vite-hub/agent/messages",
  "@vite-hub/agent/output",
  "@vite-hub/agent/server/github",
  "@vite-hub/agent/server/workspace",
  "@vite-hub/blob/config",
  "@vite-hub/blob/errors",
  "@vite-hub/database/config",
  "@vite-hub/kv/errors",
  "@vite-hub/workspace/source-metadata",
]);

const generatedRuntimeOwnerExports = new Set([
  "@vite-hub/agent/runtime/empty-registry",
  "@vite-hub/agent/runtime/workflow",
  "@vite-hub/blob/runtime/cloudflare-vite",
  "@vite-hub/blob/runtime/state",
  "@vite-hub/blob/runtime/vercel-vite",
  "@vite-hub/database/runtime/agent",
  "@vite-hub/database/runtime/cloudflare-env",
  "@vite-hub/database/runtime/cloudflare-vite",
  "@vite-hub/database/runtime/hosted",
  "@vite-hub/database/runtime/state",
  "@vite-hub/database/runtime/vercel-vite",
  "@vite-hub/database/runtime/virtual-databases",
  "@vite-hub/database/runtime/virtual-schema",
  "@vite-hub/kv/runtime/cloudflare-kv",
  "@vite-hub/kv/runtime/upstash-driver",
  "@vite-hub/queue/runtime/hosted",
  "@vite-hub/rate-limit/runtime",
  "@vite-hub/sandbox/runtime/empty-registry",
  "@vite-hub/sandbox/runtime/provider-loader",
  "@vite-hub/sandbox/runtime/state",
  "@vite-hub/schedule/runtime/state",
  "@vite-hub/schedule/runtime/static",
  "@vite-hub/workflow/runtime/cloudflare-runner",
  "@vite-hub/workflow/runtime/cloudflare-shared",
  "@vite-hub/workflow/runtime/cloudflare-vite",
  "@vite-hub/workflow/runtime/execute",
  "@vite-hub/workflow/runtime/openworkflow",
  "@vite-hub/workflow/runtime/openworkflow-worker",
  "@vite-hub/workflow/runtime/state",
  "@vite-hub/workflow/runtime/vercel-vite",
]);

function sourceForwarderTargets(source: string): string[] | undefined {
  const lines = source
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (!lines.length) return;

  const targets: string[] = [];
  for (const line of lines) {
    const target = line.match(forwarderExportLine)?.[1];
    if (!target) return;
    targets.push(target);
  }
  return targets;
}

function ownerSpecifierForDistributionSubpath(subpath: string): string {
  const [owner, ...rest] = subpath.replace(/^\.\/(?:_internal\/)?/, "").split("/");
  return [`@vite-hub/${owner}`, ...rest].join("/");
}

function ownerSpecifier(packageName: string, subpath: string): string {
  return subpath === "." ? packageName : `${packageName}${subpath.slice(1)}`;
}

function distributionSubpath(packageName: string, subpath: string): string {
  const owner = packageName.slice("@vite-hub/".length);
  return subpath === "." ? `./${owner}` : `./${owner}${subpath.slice(1)}`;
}

function ownerOnlyReason(packageName: string, subpath: string): string | undefined {
  const specifier = ownerSpecifier(packageName, subpath);
  const path = subpath.replace(/^\.\//, "");

  if (subpath === "./package.json") return "package metadata";
  if (packageName === "@vite-hub/cli") return "framework tooling";
  if (/^(?:cli|mountx|nitro|nuxt|test|tsconfig|virtual|vite)(?:\/|$)/.test(path))
    return "integration or test tooling";
  if (/(?:^|\/)_?internal(?:\/|$)/.test(path)) return "internal implementation";
  if (/^(?:drivers|providers|sandbox\/providers)(?:\/|$)/.test(path))
    return "direct provider adapter";
  if (consolidatedOwnerExports.has(specifier)) return "available from the feature root";
  if (lowLevelOwnerExports.has(specifier)) return "low-level package integration";
  if (generatedRuntimeOwnerExports.has(specifier)) return "generated or provider runtime";
}

describe("framework package contract", () => {
  it("keeps the root export intentionally small", () => {
    expect(Object.keys(framework)).toEqual(["vitehub"]);
  });

  it("forwards feature APIs from their owner packages", () => {
    expect(frameworkAgent.defineAgent).not.toBe(ownerAgent.defineAgent);
    expect(frameworkAgentEve.eveExtensionCapability).toBe(ownerAgentEve.eveExtensionCapability);
    expect(frameworkAgentProcessRuntime.createProcessAgentCapacity).toBe(
      ownerAgentProcessRuntime.createProcessAgentCapacity,
    );
    expect(frameworkCapabilities.email).toBe(ownerCapabilities.email);
    expect(frameworkCapabilities.executor).toBe(ownerCapabilities.executor);
    expect(frameworkCapabilities.workspaceShell).toBe(ownerCapabilities.workspaceShell);
    expect(frameworkAgentMcp.remoteMcpServer).toBe(ownerAgentMcp.remoteMcpServer);
    expect(frameworkAgentVue.useAgent).toBe(ownerAgentVue.useAgent);
    expect(frameworkAgentVue.useChat).toBe(ownerAgentVue.useChat);
    expect(frameworkAuthHandler).toBe(ownerAuthHandler);
    expect(frameworkAuthVue.authClient).toBe(ownerAuthVue.authClient);
    expect(frameworkAuthVue.useUserSession).toBe(ownerAuthVue.useUserSession);
    expect(frameworkBlobContentType.detectContentType).toBe(ownerBlobContentType.detectContentType);
    expect(frameworkRateLimit.requireRateLimit).toBe(ownerRateLimit.requireRateLimit);
    expect(frameworkRateLimit.createRateLimiter).toBe(ownerRateLimit.createRateLimiter);
    expect(frameworkRuntimeNode.nodeRuntimeResources).toBe(ownerRuntimeNode.nodeRuntimeResources);
  });

  it("keeps the Database environment setter on its owner runtime instance", () => {
    expect(ownerCloudflareEnvSetter).toBe(ownerDatabaseStateSetter);
    expect(frameworkDatabaseStateSetter).toBe(ownerDatabaseStateSetter);
  });

  it("keeps every source forwarder owned by its matching package export", () => {
    const manifestEntries = Object.entries(manifest.exports).flatMap(([subpath, target]) =>
      distributionEntriesFromManifest(target).map((source) => ({ source, subpath })),
    );
    const manifestForwarders = manifestEntries.flatMap(({ source, subpath }) => {
      const targets = sourceForwarderTargets(readFileSync(`${packageRoot}/${source}`, "utf8"));
      return targets ? [{ source, subpath, targets }] : [];
    });
    const sourceForwarders = globSync("src/**/*.ts", { cwd: packageRoot })
      .filter((source) => !source.endsWith(".d.ts"))
      .filter((source) => sourceForwarderTargets(readFileSync(`${packageRoot}/${source}`, "utf8")))
      .sort();
    const exportedForwarders = new Set(manifestForwarders.map(({ source }) => source));

    expect(sourceForwarders).toEqual([...exportedForwarders].sort());
    expect(
      manifestEntries
        .filter(({ source }) => !exportedForwarders.has(source))
        .map(({ subpath }) => subpath)
        .sort(),
    ).toEqual([
      ".",
      "./_internal/database/runtime/state",
      "./_internal/kv/runtime/disabled-upstash",
      "./agent",
      "./console",
      "./console/blob",
      "./console/definitions",
      "./console/kv",
      "./console/sections",
      "./console/server",
      "./database/drizzle",
      "./nuxt",
      "./source",
      "./source/vite",
    ]);

    for (const { subpath, targets } of manifestForwarders) {
      const ownerSpecifier = ownerSpecifierForDistributionSubpath(subpath);
      const ownerPackage = ownerSpecifier.split("/").slice(0, 2).join("/");
      expect([...new Set(targets)], subpath).toEqual([ownerSpecifier]);
      expect(manifest.dependencies[ownerPackage], subpath).toBeDefined();
    }
  });

  it("classifies every owner-package export", () => {
    const unclassified: string[] = [];

    for (const packageName of Object.keys(manifest.dependencies).filter((name) =>
      name.startsWith("@vite-hub/"),
    )) {
      const packageDirectory = packageName.slice("@vite-hub/".length);
      const ownerManifest: unknown = JSON.parse(
        readFileSync(`${repoRoot}/packages/${packageDirectory}/package.json`, "utf8"),
      );
      if (Object(ownerManifest) !== ownerManifest)
        throw new TypeError("Expected an owner manifest.");
      const ownerExports = Reflect.get(Object(ownerManifest), "exports");
      if (ownerExports !== undefined && Object(ownerExports) !== ownerExports) {
        throw new TypeError("Expected an owner export map.");
      }

      for (const subpath of Object.keys(Object(ownerExports))) {
        if (manifest.exports[distributionSubpath(packageName, subpath)]) continue;
        if (ownerOnlyReason(packageName, subpath)) continue;
        unclassified.push(ownerSpecifier(packageName, subpath));
      }
    }

    expect(unclassified.sort()).toEqual([]);
  });

  it("ships every declared export and both CLI names", () => {
    expect(manifest.exports).not.toHaveProperty("./bin");
    expect(manifest.bin).toEqual({
      "vite-hub": "./dist/bin.js",
      vitehub: "./dist/bin.js",
    });

    for (const value of Object.values(manifest.exports)) {
      const target = String(value) === value ? value : Reflect.get(Object(value), "import");
      if (String(target) !== target) throw new TypeError("Expected an export target.");
      if (target === "./package.json") continue;
      expect(existsSync(`${packageRoot}/${target}`), target).toBe(true);
    }

    expect(readFileSync(`${packageRoot}/${manifest.bin.vitehub}`, "utf8")).toMatch(
      /^#!\/usr\/bin\/env node/,
    );
    expect(readFileSync(`${packageRoot}/dist/env.d.ts`, "utf8")).toContain(
      'import "@vite-hub/env/vite"',
    );
    expect(readFileSync(`${packageRoot}/dist/cloudflare-types.d.ts`, "utf8")).toContain(
      "@cloudflare/workers-types",
    );
    const consolePage = readFileSync(
      `${packageRoot}/dist/console/runtime/components/console-app.vue`,
      "utf8",
    );
    const consoleFrame = readFileSync(
      `${packageRoot}/dist/console/runtime/components/console-frame.vue`,
      "utf8",
    );
    expect(consolePage).toMatch(
      /\[data-slot="invocation"\],[\s\S]*?\[data-slot="invocation-inspector"\]\s*\{[\s\S]*?height: 100%;[\s\S]*?width: 100%;[\s\S]*?\}/,
    );
    expect(consolePage).toContain('from "../console-route"');
    expect(consolePage).toContain('from "./console-session-bootstrap"');
    expect(
      existsSync(`${packageRoot}/dist/console/runtime/components/console-session-bootstrap.ts`),
    ).toBe(true);
    expect(existsSync(`${packageRoot}/dist/console/runtime/console-route.js`)).toBe(true);
    expect(existsSync(`${packageRoot}/dist/console/runtime/sections.js`)).toBe(true);
    expect(existsSync(`${packageRoot}/dist/console/runtime/client/request.js`)).toBe(true);
    expect(existsSync(`${packageRoot}/dist/console/runtime/client/request.d.ts`)).toBe(true);
    expect(existsSync(`${packageRoot}/dist/console/runtime/client/time.js`)).toBe(true);
    expect(existsSync(`${packageRoot}/dist/console/runtime/client/time.d.ts`)).toBe(true);
    expect(manifest.exports).not.toHaveProperty("./console/runtime/console-route");
    expect(manifest.exports).not.toHaveProperty("./console/runtime/sections");
    expect(manifest.exports).not.toHaveProperty("./console/runtime/client/request");
    expect(manifest.exports).not.toHaveProperty("./console/runtime/client/time");
    expect(consolePage).toContain("AgentInvocationList");
    expect(consolePage).toContain('invocation.annotations?.["agent.model.provider"]');
    expect(consolePage).toContain("ConsoleSessionInspector");
    expect(consolePage).toContain("ConsoleHealth");
    const consoleSessionCss = readFileSync(
      `${packageRoot}/dist/console/runtime/components/console-session.css`,
      "utf8",
    );
    expect(consoleSessionCss).toMatch(/\.session-inspector\s*\{[\s\S]*?height: 100%;/);
    expect(consolePage).toContain("limit: 10");
    expect(consolePage).toContain("const initialSessionLoading = computed");
    expect(consolePage).toContain(
      "[() => detail.invocation.value?.id, () => detail.invocation.value?.status]",
    );
    expect(consolePage).toMatch(
      /const detailStatus = selectedDetailStatus\.value;[\s\S]*?detailStatus\?\.id === selectedInvocationId\.value[\s\S]*?\? detailStatus\.status[\s\S]*?: undefined/,
    );
    expect(consolePage).not.toContain(": selectedSummary.value?.status");
    expect(consolePage).toContain('v-if="initialSessionLoading"');
    expect(consolePage).toContain(':loading="refreshing"');
    expect(consolePage).toContain("<template #loading />");
    expect(consolePage).toContain('status === "completed" || status === "failed" || status === "cancelled"');
    expect(consolePage).toContain('label="Load older sessions"');
    expect(consolePage).not.toContain('@end-reached="list.loadMore()"');
    expect(consolePage).toContain(':loading="list.isLoading.value || list.isLoadingMore.value"');
    expect(consolePage).toContain("immediate: pageVisible.value && !isUsageRoute.value");
    expect(consolePage).not.toContain("initialListPending");
    expect(consolePage).toContain(
      "isUsageRoute.value ? Promise.resolve() : list.refresh()",
    );
    expect(consolePage).toContain("watch: false");
    expect(consolePage).toContain("const initialBootstrapPending = ref(!selectedAgentName.value)");
    expect(consolePage).toContain("if (!requestedAgent && !agentName)");
    expect(consolePage).toContain("if (!firstInvocation) return");
    expect(consolePage).toContain("selectedInvocationId.value = firstInvocation.id");
    expect(consolePage).toContain("invocation: firstInvocation.id");
    expect(consolePage).toContain("if (!requestedAgent && bootstrapPending) return");
    expect(consolePage).toContain("currentAgent && names.includes(currentAgent)");
    expect(consolePage.indexOf("if (pageVisible.value) void loadAgents();")).toBeLessThan(
      consolePage.indexOf("onMounted(() =>"),
    );
    expect(consolePage).toContain(
      'v-else-if="isDesktop && detailsOpen && (selectedInvocationId || initialSessionLoading)"',
    );
    expect(consolePage).toContain(
      'v-if="isDesktop && detailsOpen && detailsMaximized && selectedInvocationId"',
    );
    expect(consolePage).toContain("detail.isLoading.value || initialSessionLoading");
    expect(consolePage).toContain('@toggle-maximized="detailsMaximized = false"');
    expect(consolePage).not.toContain("min-height: 32rem");
    expect(consoleFrame).toContain("min-height: 0");
    expect(consoleFrame).not.toContain("min-height: 32rem");
    expect(consolePage).toContain("<ConsoleSessionNavbar");
    expect(consolePage).toMatch(/<template #thread>[\s\S]*?<ConsoleSessionNavbar/);
    expect(consolePage).toContain('@inspect="inspectSession"');
    expect(consolePage).toContain("function inspectSession");
    const consoleSessionNavbar = readFileSync(
      `${packageRoot}/dist/console/runtime/components/console-session-navbar.vue`,
      "utf8",
    );
    const consoleSessionLoading = readFileSync(
      `${packageRoot}/dist/console/runtime/components/console-session-loading.vue`,
      "utf8",
    );
    expect(consoleSessionLoading).toContain(
      ":aria-label=\"props.error ? 'Session load failed' : 'Loading session'\"",
    );
    expect(consoleSessionLoading).toContain(":role=\"props.error ? 'alert' : 'status'\"");
    expect(consoleSessionLoading).toContain("surface === 'inspector'");
    expect(consoleSessionLoading).toContain('icon="i-lucide-panel-right-close"');
    expect(consoleSessionLoading).toContain(':disabled="!props.maximizable"');
    expect(consoleSessionLoading).toContain('class="session-inspector__header"');
    expect(consoleSessionLoading).toContain("emit('toggleMaximized')");
    expect(consolePage).toContain(':maximizable="Boolean(selectedInvocationId)"');
    expect(consoleSessionNavbar).toContain('data-slot="session-details-toggle"');
    expect(consoleSessionNavbar).toContain(':disabled="!hasSelection"');
    expect(consoleSessionNavbar).toContain('icon: "i-lucide-github"');
    expect(consoleSessionNavbar).toContain('label: "Open on GitHub"');
    expect(consolePage).toMatch(/scrollbar-width: none;/);
    expect(consolePage).toMatch(/::-webkit-scrollbar[\s\S]*?display: none;/);
    const consoleClientMain = readFileSync(
      `${packageRoot}/src/console/runtime/client/main.js`,
      "utf8",
    );
    expect(consoleClientMain).toContain("void loadSections().then((installed) => {");
    expect(consoleClientMain).not.toContain("const installed = await loadSections()");
    const sessionInspector = readFileSync(
      `${packageRoot}/dist/console/runtime/components/console-session-inspector.vue`,
      "utf8",
    );
    expect(sessionInspector).toContain("Workspace unavailable");
    expect(sessionInspector).toContain(':show-status="false"');
    expect(sessionInspector).toContain(':show-timeline="false"');
    expect(sessionInspector).toContain('...(props.workspaceBase ? (["workspace"] as const) : [])');
    expect(sessionInspector).toContain('if (tab.value === "workspace") void loadWorkspace();');
    expect(sessionInspector).toContain("workspaceLoading.value = false;");
    expect(sessionInspector).toContain("workspaceRequest = undefined;");
    expect(sessionInspector).toContain('<button v-if="props.workspaceBase"');
    expect(sessionInspector).toMatch(
      /const invocationId = props\.invocation\.id;[\s\S]*?if \(!workspace\.value\) await loadWorkspace\(\);[\s\S]*?if \(props\.invocation\.id !== invocationId\) return;/,
    );
    expect(sessionInspector).toContain("if (workspaceLoad) return workspaceLoad;");
    expect(sessionInspector).toMatch(
      /const loadedWorkspace = parseWorkspaceDescriptor\([\s\S]*?if \(workspaceRequest !== controller\) return;[\s\S]*?workspace\.value = loadedWorkspace;/,
    );
    expect(sessionInspector).toContain("invocationUsage.totalTokens");
    expect(sessionInspector).toContain("workspace.pullRequest !== undefined");
    expect(sessionInspector).toContain("hasPullRequest && (pullRequest === undefined");
    expect(sessionInspector).toContain('openViews.value.includes("workspace")');
    expect(sessionInspector).toContain("list: 'w-max min-w-0 gap-1 bg-transparent p-0'");
    expect(consoleSessionCss).toMatch(
      /\.session-inspector__tabstrip \{[\s\S]*?display: flex;[\s\S]*?overflow: hidden;/,
    );
    expect(consoleSessionCss).toMatch(
      /\.session-inspector__tabs \{[\s\S]*?flex: 0 1 auto;[\s\S]*?max-width: calc\(100% - 2rem\);[\s\S]*?width: max-content;/,
    );
    expect(consoleSessionCss).toMatch(
      /\.session-inspector__tabs \[data-slot="list"\] \{[\s\S]*?min-width: 0;[\s\S]*?width: max-content;/,
    );
    const sessionTrace = readFileSync(
      `${packageRoot}/dist/console/runtime/components/console-session-trace.vue`,
      "utf8",
    );
    const sessionTraceModel = readFileSync(
      `${packageRoot}/dist/console/runtime/components/console-session-trace-model.ts`,
      "utf8",
    );
    expect(
      existsSync(`${packageRoot}/dist/console/runtime/components/console-session-trace-model.ts`),
    ).toBe(true);
    expect(sessionTrace).toContain("session-trace__waterfall");
    expect(sessionTrace).toContain("<USplitter");
    expect(sessionTrace).toContain('orientation="vertical"');
    expect(sessionTrace).toContain("<template #detail>");
    expect(sessionTrace).toContain("<template #resize-handle>");
    expect(consoleSessionCss).not.toContain(
      "grid-template-columns: minmax(20rem, 1.45fr) minmax(15rem, 0.95fr);",
    );
    expect(consoleSessionCss).toMatch(
      /\.session-trace__detail \{[\s\S]*?overflow: auto;[\s\S]*?overscroll-behavior: contain;/,
    );
    expect(consoleSessionCss).toMatch(
      /\.session-trace__fields \{[\s\S]*?min-height: 0;\s*\}/,
    );
    expect(sessionTrace).toContain('start.name === "agent.approval.request"');
    expect(sessionTraceModel).toContain('"completed",');
    expect(sessionTraceModel).toContain('"error",');
    expect(sessionTraceModel).toContain('"failed",');
    expect(sessionTrace).toContain("traceSpanEndMs(");
    expect(sessionTrace).toContain("const traceWindowMs = computed");
    expect(sessionTrace).not.toContain("const traceDurationMs = computed");
    expect(sessionTrace).toContain("isTerminalToolObservation");
    expect(
      readFileSync(
        `${packageRoot}/dist/console/runtime/components/console-session-code-preview.vue`,
        "utf8",
      ),
    ).toContain("highlightingFailed");
    expect(consoleSessionCss).toMatch(
      /\.session-code-preview \.shiki,[\s\S]*?\.session-code-preview__plain[\s\S]*?font-size: 0\.6875rem;/,
    );
    expect(
      readFileSync(`${packageRoot}/dist/console/runtime/components/console-health.vue`, "utf8"),
    ).toContain("<h1>Health</h1>");
    expect(
      readFileSync(`${packageRoot}/dist/console/runtime/components/console-health.vue`, "utf8"),
    ).not.toContain("Babysitter");
    expect(
      existsSync(`${packageRoot}/dist/console/runtime/components/console-health-model.ts`),
    ).toBe(true);
    expect(consolePage).toContain("agentInvocationTitle");
    expect(consoleSessionNavbar).toContain("<UDashboardNavbar");
    expect(consoleSessionNavbar).toContain('class="md:hidden"');
    expect(consoleSessionNavbar).not.toContain('class="lg:hidden"');
    expect(consolePage).toContain(':header="false"');
    expect(consolePage).toContain('auto-save-id="vitehub-agent-session-layout-v2"');
    expect(consolePage).toMatch(
      /id: "thread",[\s\S]*?defaultSize: 720,[\s\S]*?id: "details",[\s\S]*?defaultSize: 440,/,
    );
    expect(consolePage).toContain(':continuation-key="list.cursor.value"');
    expect(consolePage).not.toContain(':retry-key="invocationPaginationKey"');
    expect(consolePage).toContain("list.loadMoreError.value");
    expect(consolePage).toContain("Retry loading older sessions");
    expect(consolePage).toContain('@click="list.loadMore"');
    expect(consolePage).toContain("Switch Agent");
    expect(consolePage).toContain("agentMenuItems");
    expect(consolePage).toContain("invocation.agentName !== selectedAgentName.value");
    expect(consolePage).toContain("invocation.agentName === agentName");
    expect(consolePage).toContain(
      'resolveConsoleRouteName(route.name, "vitehub-console-invocation")',
    );
    expect(consolePage).toContain("encodeAgentRouteParam(agentName)");
    expect(consolePage).toContain("decodeAgentRouteParam(route.params.agent)");
    expect(consoleSessionNavbar).toContain('data-slot="mobile-session-navigation"');
    expect(consolePage).toContain('window.matchMedia("(min-width: 981px)")');
    expect(consolePage).toContain("root: 'md:flex'");
    expect(consolePage).toContain("content: 'md:hidden'");
    expect(consolePage).toContain("detailsOpen.value = isDesktop.value");
    expect(consolePage).toContain("}, 60_000);");
    expect(consolePage).toContain(
      "if (isRetryableConsoleRequestError(error)) scheduleAgentsRetry();",
    );
    expect(consolePage).toContain("}, 5_000);");
    expect(consolePage).toContain("isRetryableConsoleRequestError(selectedDetailError.value)");
    expect(consolePage.indexOf("const selectedDetailError")).toBeLessThan(
      consolePage.indexOf("const detailPollInterval"),
    );
    expect(consolePage.indexOf("const detailPollInterval")).toBeLessThan(
      consolePage.indexOf("const detail = useAgentInvocation"),
    );
    expect(consolePage).toContain('{ flush: "sync", immediate: true }');
    expect(consoleSessionNavbar).toContain('class="vitehub-console__session-navbar"');
    expect(consolePage).toContain('class="vitehub-console__session-panel"');
    expect(consolePage).toContain('class="flex h-full min-h-0 w-full flex-col overflow-hidden"');
    expect(consolePage).toMatch(
      /\.vitehub-console__session-panel > \[data-slot="body"\][\s\S]*?padding: 0 !important;/,
    );
    expect(consolePage).toContain("minSize: 360");
    expect(consolePage).toContain("defaultSize: 720");
    expect(consolePage).toContain("maxSize: 1080");
    expect(consolePage).toContain("defaultSize: 440");
    expect(consolePage).toContain("max-width: 48rem");
    expect(consolePage).not.toContain("route.query.agent");
    expect(consolePage).not.toContain("groupConsoleSessions");
    expect(consolePage).not.toContain("<UApp");
    expect(consolePage).toContain(".vitehub-console");
    const consoleRoute = readFileSync(
      `${packageRoot}/dist/console/runtime/pages/agents.vue`,
      "utf8",
    );
    expect(consoleRoute).toContain('import { useHead, useRuntimeConfig } from "#imports"');
    expect(consoleRoute).toContain("<ClientOnly>");
    expect(consoleRoute).toContain("<ConsoleProvider>");
    expect(consoleRoute).toContain('aria-label="Loading ViteHub Console"');
    expect(consoleRoute).toContain("lg:grid-rows-[auto_auto_1fr]");
    const consoleIndexRoute = readFileSync(
      `${packageRoot}/dist/console/runtime/pages/index.vue`,
      "utf8",
    );
    expect(consoleIndexRoute).toContain("<ConsoleHome");
    expect(consoleIndexRoute).toContain(":sections-base=");
    expect(existsSync(`${packageRoot}/dist/console/runtime/pages/blob.vue`)).toBe(true);
    expect(existsSync(`${packageRoot}/dist/console/runtime/components/console-blob.vue`)).toBe(
      true,
    );
    expect(existsSync(`${packageRoot}/dist/console/runtime/pages/databases.vue`)).toBe(true);
    expect(existsSync(`${packageRoot}/dist/console/runtime/pages/kv.vue`)).toBe(true);
    const consoleKVRoute = readFileSync(`${packageRoot}/dist/console/runtime/pages/kv.vue`, "utf8");
    expect(consoleKVRoute).toContain(`sections.includes("kv")`);
    expect(consoleKVRoute).toContain(`navigateTo("/_vitehub")`);
    expect(consoleKVRoute).not.toContain("navigateTo(`${appBaseURL}/_vitehub`)");
    expect(consoleKVRoute).toContain(`v-if="available"`);
    expect(consoleKVRoute).toContain("Try again");
    expect(existsSync(`${packageRoot}/dist/console/runtime/components/console-kv.vue`)).toBe(true);
    const consoleKV = readFileSync(
      `${packageRoot}/dist/console/runtime/components/console-kv.vue`,
      "utf8",
    );
    expect(consoleKV).toContain("loadedStore.value === store");
    expect(existsSync(`${packageRoot}/dist/console/runtime/pages/workflows.vue`)).toBe(true);
    expect(existsSync(`${packageRoot}/dist/console/runtime/pages/queues.vue`)).toBe(true);
    expect(existsSync(`${packageRoot}/dist/console/runtime/pages/rate-limits.vue`)).toBe(true);
    expect(existsSync(`${packageRoot}/dist/console/runtime/pages/schedules.vue`)).toBe(true);
    expect(existsSync(`${packageRoot}/dist/console/runtime/pages/sandboxes.vue`)).toBe(true);
    expect(existsSync(`${packageRoot}/dist/console/runtime/pages/workspaces.vue`)).toBe(true);
    expect(
      existsSync(`${packageRoot}/dist/console/runtime/components/console-definitions.vue`),
    ).toBe(true);
    expect(existsSync(`${packageRoot}/dist/console/runtime/definitions.js`)).toBe(true);
    expect(manifest.exports).not.toHaveProperty("./console/runtime/definitions");
    const consoleProvider = readFileSync(
      `${packageRoot}/dist/console/runtime/components/console-provider.vue`,
      "utf8",
    );
    expect(consoleProvider).toContain("injectTooltipProviderContext(null)");
    expect(consoleProvider).toContain('<slot v-if="hasAppProvider" />');
    expect(consoleProvider).toContain('<UApp v-else :toaster="null">');
    const consoleSearch = readFileSync(
      `${packageRoot}/dist/console/runtime/components/console-search.vue`,
      "utf8",
    );
    expect(consoleSearch).toContain(
      'resolveConsoleRouteName(route.name, "vitehub-console-invocation")',
    );
    expect(consoleSearch).toContain('label: "All primitives"');
    expect(consoleSearch).toContain('label: "Pages"');
    expect(consoleSearch).toContain(
      'label: debouncedSearchTerm.value ? "Sessions" : "Recent sessions"',
    );
    expect(consoleSearch).not.toContain("prefix: debouncedSearchTerm.value");
    expect(consoleSearch).not.toContain("watch(debouncedSearchTerm");
    expect(consoleSearch).toContain("if (discoverContent) {");
    expect(consoleSearch).toContain("discoveredAgentNames.value = []");
    expect(consoleSearch).toContain("definitionItems.value = []");
    expect(consoleSearch).toContain("kvItems.value = []");
    expect(consoleSearch).toContain("kvSearchTruncated.value = false");
    expect(consoleSearch).toContain(`if (!value) {
    if (searchTimer) clearTimeout(searchTimer)
    searchTimer = undefined
    navigationRequest?.abort()
    sessionRequest?.abort()
    return
  }`);
    expect(consoleSearch).toContain("if (!open.value) return");
    expect(consoleSearch).toContain("if (open.value) debouncedSearchTerm.value = value.trim()");
    expect(consoleSearch).toContain("debouncedSearchTerm.value = nextSearchTerm");
    const consoleBrand = readFileSync(
      `${packageRoot}/dist/console/runtime/components/console-brand.vue`,
      "utf8",
    );
    expect(consoleBrand).toContain("<RouterLink");
    expect(consoleBrand).toContain("resolveConsoleRouteName(route.name, 'vitehub-console')");
    expect(consoleBrand).toContain("subscribeConsoleNavigation(props.sectionsBase");
    const consoleHome = readFileSync(
      `${packageRoot}/dist/console/runtime/components/console-home.vue`,
      "utf8",
    );
    expect(consoleHome).toContain("loadConsoleNavigation(props.sectionsBase)");
    const consolePrimitiveSwitcher = readFileSync(
      `${packageRoot}/dist/console/runtime/components/console-primitive-switcher.vue`,
      "utf8",
    );
    expect(consolePrimitiveSwitcher).toContain("navigationFailed.value = true");
    expect(consolePrimitiveSwitcher).toContain('aria-label="Retry loading primitives"');
    expect(existsSync(`${packageRoot}/dist/console/runtime/components/console-usage.vue`)).toBe(
      true,
    );
    const consoleClientFiles = globSync("dist/console/runtime/public/console/console-*.js", {
      cwd: packageRoot,
    });
    expect(consoleClientFiles).toHaveLength(1);
    const [consoleClientFile] = consoleClientFiles;
    if (!consoleClientFile) throw new TypeError("Expected one hashed Console client asset.");
    const consoleClient = readFileSync(`${packageRoot}/${consoleClientFile}`, "utf8");
    expect(consoleClient).toContain('"robot-light":{"width":256');
    expect(consoleClient).toContain('"folder-tree":{"width":24');
    expect(consoleClient).toContain("prefers-color-scheme: dark");
    expect(consoleClient).toMatch(/classList\.toggle\(["`]dark["`]/);
    expect(consoleClient).toContain("ViteHub");
    expect(consoleClient).toContain("/agents/:agent/invocations/:invocation");
    expect(consoleClient).toContain("/blob");
    expect(consoleClient).toContain("/databases");
    expect(consoleClient).toContain("/kv");
    expect(consoleClient).toContain("/workflows");
    expect(consoleClient).toContain("/queues");
    expect(consoleClient).toContain("/rate-limits");
    expect(consoleClient).toContain("/schedules");
    expect(consoleClient).toContain("/sandboxes");
    expect(consoleClient).toContain("/workspaces");
    expect(consoleClient).toContain("currentRoute.value");
    const consoleCssFiles = globSync("dist/console/runtime/public/console/console-*.css", {
      cwd: packageRoot,
    });
    expect(consoleCssFiles).toHaveLength(1);
    const [consoleCssFile] = consoleCssFiles;
    if (!consoleCssFile) throw new TypeError("Expected one hashed Console stylesheet asset.");
    const consoleCss = readFileSync(`${packageRoot}/${consoleCssFile}`, "utf8");
    expect(consoleCss).toContain("vitehub-console");
    expect(consoleCss).toContain("--ui-bg:#fdfdfd");
    expect(consoleCss).toContain("--ui-text:#27272a");
    const consolePageSource = readFileSync(
      `${packageRoot}/dist/console/runtime/server/page.get.js`,
      "utf8",
    );
    expect(consolePageSource).toContain(`/_vitehub/assets/${consoleClientFile.split("/").at(-1)}`);
    expect(consolePageSource).toContain(`/_vitehub/assets/${consoleCssFile.split("/").at(-1)}`);
    expect(consolePageSource).not.toContain("__VITEHUB_CONSOLE_");
    expect(manifest.dependencies).toHaveProperty("@cloudflare/workers-types");
  });

  it("configures Nitro with Console files from the distributed package", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-distributed-console-"));
    try {
      await writeFile(join(root, "package.json"), "{}\n", "utf8");
      const plugin = framework
        .vitehub({
          agent: true,
          console: { exposure: "host-managed" },
          kv: true,
          preset: "node",
          queue: true,
          schedule: true,
          workflow: true,
        })
        .find((candidate) => Reflect.get(Object(candidate), "name") === "vite-hub/console");
      if (!plugin) throw new TypeError("Expected the distributed Console plugin.");
      const configHook = Reflect.get(Object(plugin), "config");
      const configHandler = Reflect.get(Object(configHook), "handler") || configHook;
      if (!(configHandler instanceof Function))
        throw new TypeError("Expected the Console config hook.");
      const config = { root };

      await Reflect.apply(configHandler, plugin, [
        config,
        { command: "build", mode: "production" },
      ]);

      const nitro = Reflect.get(config, "nitro");
      const handlers = Reflect.get(Object(nitro), "handlers");
      const publicAssets = Reflect.get(Object(nitro), "publicAssets");
      if (!Array.isArray(handlers) || !Array.isArray(publicAssets)) {
        throw new TypeError("Expected the distributed Console Nitro configuration.");
      }
      expect(handlers).toHaveLength(10);
      expect(handlers).toContainEqual(
        expect.objectContaining({ route: "/api/_vitehub/console/usage" }),
      );
      expect(handlers).toContainEqual(
        expect.objectContaining({ route: "/api/_vitehub/console/kv" }),
      );
      for (const registration of handlers) {
        const handler = Reflect.get(Object(registration), "handler");
        if (String(handler) !== handler) throw new TypeError("Expected a Console handler path.");
        expect(handler).toContain("/dist/console/runtime/server/");
        expect(existsSync(handler), handler).toBe(true);
      }
      expect(publicAssets).toHaveLength(1);
      const publicAssetDir = Reflect.get(Object(publicAssets[0]), "dir");
      if (String(publicAssetDir) !== publicAssetDir)
        throw new TypeError("Expected a Console public asset path.");
      expect(publicAssetDir).toContain("/dist/console/runtime/public/console");
      expect(existsSync(publicAssetDir), publicAssetDir).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("runs both distributed CLI entrypoints with clean help streams", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-bin-"));
    try {
      const keepAlive = join(root, "keep-alive.mjs");
      await Promise.all([
        writeFile(
          join(root, "vite.config.mjs"),
          `
const namespaces = Array.from({ length: 4096 }, (_, index) => ({
  description: "A package-contributed command whose help output must flush before exit.",
  features: [],
  name: \`namespace-\${String(index).padStart(4, "0")}\`,
}))
export default { plugins: [{ name: "large-cli-help", vitehub: { cli: { namespaces } } }] }
`,
        ),
        writeFile(keepAlive, "setInterval(() => {}, 60_000)\n"),
      ]);
      const entrypoints = [
        `${packageRoot}/${manifest.bin.vitehub}`,
        `${repoRoot}/packages/cli/dist/index.js`,
      ];
      for (const entrypoint of entrypoints) {
        const { stderr, stdout } = await execFileAsync(process.execPath, [entrypoint, "--help"], {
          cwd: root,
          env: {
            ...process.env,
            NODE_OPTIONS: `--import=${pathToFileURL(keepAlive).href}`,
            NO_COLOR: "1",
          },
          timeout: 5_000,
        });

        expect(stdout).toContain("Usage: vitehub <namespace> <feature>");
        expect(stdout).toContain("namespace-4095");
        expect(stdout).toContain("provision");
        expect(stderr).toBe("");
      }
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("flushes direct CLI errors before exiting despite active handles", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-cli-error-"));
    try {
      const keepAlive = join(root, "keep-alive.mjs");
      await Promise.all([
        writeFile(join(root, "vite.config.mjs"), "throw new Error('config exploded')\n"),
        writeFile(keepAlive, "setInterval(() => {}, 60_000)\n"),
      ]);

      await expect(
        execFileAsync(process.execPath, [`${repoRoot}/packages/cli/dist/index.js`], {
          cwd: root,
          env: {
            ...process.env,
            NODE_OPTIONS: `--import=${pathToFileURL(keepAlive).href}`,
            NO_COLOR: "1",
          },
          timeout: 5_000,
        }),
      ).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining("config exploded") });
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("derives deduplicated binary entries from the package manifest", () => {
    expect(distributionBinEntries).toEqual({
      "vite-hub": "src/bin.ts",
      vitehub: "src/bin.ts",
    });
    expect(distributionEntriesFromManifest(manifest.bin)).toEqual(["src/bin.ts"]);
  });

  it("normalizes conditional export leaves into unique runtime entries", () => {
    expect(
      distributionEntriesFromManifest({
        ".": {
          import: {
            default: "./dist/index.js",
            node: "./dist/index.js",
          },
          types: "./dist/index.d.ts",
        },
        "./feature": [{ types: "./dist/feature.d.ts" }, { import: "./dist/feature.js" }],
        "./package.json": "./package.json",
      }),
    ).toEqual(["src/feature.ts", "src/index.ts"]);
  });
});
