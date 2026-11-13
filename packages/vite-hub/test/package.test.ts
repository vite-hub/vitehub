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
import * as ownerAgentMcp from "@vite-hub/agent/mcp";
import * as ownerAgentProcessRuntime from "@vite-hub/agent/process";
import * as ownerAgentVite from "@vite-hub/agent/vite";
import * as ownerAgentVue from "@vite-hub/agent/vue";
import ownerAuthHandler from "@vite-hub/auth/server";
import * as ownerAuthVue from "@vite-hub/auth/vue";
import * as ownerBlobClient from "@vite-hub/blob/client";
import * as ownerBlobMedia from "@vite-hub/blob/media";
import * as ownerBlobVue from "@vite-hub/blob/vue";
import { setActiveCloudflareEnv as ownerCloudflareEnvSetter } from "@vite-hub/database/runtime/cloudflare-env";
import { setActiveCloudflareEnv as ownerDatabaseStateSetter } from "@vite-hub/database/runtime/state";
import * as ownerRateLimit from "@vite-hub/rate-limit";
import * as ownerWebContainer from "@vite-hub/web-container";
import * as ownerWebContainerConnect from "@vite-hub/web-container/connect";
import * as framework from "vite-hub";
import * as frameworkAgent from "vite-hub/agent";
import * as frameworkCapabilities from "vite-hub/agent/capabilities";
import * as frameworkAgentMcp from "vite-hub/agent/mcp";
import * as frameworkAgentProcessRuntime from "vite-hub/agent/process";
import * as frameworkAgentVite from "vite-hub/agent/vite";
import * as frameworkAgentVue from "vite-hub/agent/vue";
import * as consoleAuth from "vite-hub/console/auth";
import frameworkAuthHandler from "vite-hub/auth/server";
import * as frameworkAuthVue from "vite-hub/auth/vue";
import * as frameworkBlobClient from "vite-hub/blob/client";
import * as frameworkBlobMedia from "vite-hub/blob/media";
import * as frameworkBlobVue from "vite-hub/blob/vue";
import * as frameworkRateLimit from "vite-hub/rate-limit";
import * as frameworkWebContainer from "vite-hub/web-container";
import * as frameworkWebContainerConnect from "vite-hub/web-container/connect";
import * as frameworkRuntimeNode from "vite-hub/runtime/node";
import * as ownerRuntimeNode from "@vite-hub/runtime/node";
import { distributionBinEntries, distributionEntriesFromManifest } from "../vite.config.ts";
import { setActiveCloudflareEnv as frameworkDatabaseStateSetter } from "../src/internal/database-runtime-state.ts";
import { hostManagedAuthorize } from "./support/console-authorize.ts";

const packageRoot = fileURLToPath(new URL("..", import.meta.url));
// The vite-hub build writes the prebuilt Console app to @vite-hub/console-client.
const packagesRoot = fileURLToPath(new URL("../..", import.meta.url));
const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
const execFileAsync = promisify(execFile);

interface DistributionManifest {
  bin: Record<string, string>;
  dependencies: Record<string, string>;
  exports: Record<string, string | { import: string; types?: string }>;
  peerDependencies: Record<string, string>;
}

function parseDistributionManifest(text: string): DistributionManifest {
  const value: unknown = JSON.parse(text);
  if (Object(value) !== value) throw new TypeError("Expected a package manifest object.");
  const bin = Reflect.get(Object(value), "bin");
  const dependencies = Reflect.get(Object(value), "dependencies");
  const exports = Reflect.get(Object(value), "exports");
  const peerDependencies = Reflect.get(Object(value), "peerDependencies");
  if (Object(bin) !== bin || Object(dependencies) !== dependencies || Object(exports) !== exports || Object(peerDependencies) !== peerDependencies) {
    throw new TypeError("Expected package manifest maps.");
  }
  // SAFETY: The checked package.json fields are the string maps exercised by these distribution tests.
  return { bin, dependencies, exports, peerDependencies } as DistributionManifest;
}

const manifest = parseDistributionManifest(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
);

describe("Console Auth package exports", () => {
  it("exports only defineConsoleAuthorize, without Better Auth", () => {
    expect(Object.keys(consoleAuth)).toEqual(["defineConsoleAuthorize"]);
  });
});

const forwarderExportLine = /^export (?:type )?(?:\*|\{[^}]+\}) from "([^"]+)"$/;

const consolidatedOwnerExports = new Set(["@vite-hub/docs/navigation"]);

const lowLevelOwnerExports = new Set([
  // Message utilities stay available on the standalone Agent package.
  "@vite-hub/agent/messages",
  // The Console reads the hashed entry names of the prebuilt Console app.
  "@vite-hub/console-client/manifest.json",
  "@vite-hub/comments/testing",
  // Comments imports the guard of public writes; apps use defineForm().
  "@vite-hub/forms/guard",
  "@vite-hub/agent/cloudflare/state",
  "@vite-hub/agent/env-identity",
  "@vite-hub/agent/observability/host",
  "@vite-hub/agent/observability/posthog",
  "@vite-hub/blob/served",
  "@vite-hub/comments/client",
  "@vite-hub/comments/testing",
  "@vite-hub/sandbox/ssh",
  "@vite-hub/database/config",
  "@vite-hub/database/connect",
  "@vite-hub/database/connect/node",
  "@vite-hub/docs/server",
  "@vite-hub/env/seal",
  "@vite-hub/ui/playground",
  "@vite-hub/ui/playground-container",
  "@vite-hub/ui/playground-render",
  "@vite-hub/ui/primitive-rail",
  // The design system: surfaces import the theme and its shared parts from @vite-hub/ui directly.
  "@vite-hub/ui/theme",
  "@vite-hub/ui/theme.css",
  "@vite-hub/ui/copy-button",
  "@vite-hub/ui/status",
  "@vite-hub/ui/browser-support-notice",
  "@vite-hub/ui/connect-panel",
  "@vite-hub/ui/workspace",
  "@vite-hub/ui/workspace-boot-status",
  "@vite-hub/ui/workspace-editor",
  "@vite-hub/ui/workspace-file-tree",
  "@vite-hub/ui/workspace-preview",
  "@vite-hub/ui/workspace-shell",
  "@vite-hub/ui/workspace-terminal",
  "@vite-hub/web-container/env",
  "@vite-hub/web-container/snapshot",
  "@vite-hub/workspace/source-metadata",
]);

const generatedRuntimeOwnerExports = new Set([
  // The generated durability boot plugin of a Node server imports each primitive's reporter by file.
  "@vite-hub/agent/durability",
  "@vite-hub/blob/durability",
  "@vite-hub/database/durability",
  "@vite-hub/kv/durability",
  "@vite-hub/queue/durability",
  "@vite-hub/rate-limit/durability",
  "@vite-hub/realtime/durability",
  "@vite-hub/schedule/durability",
  "@vite-hub/workflow/durability",
  "@vite-hub/workspace/durability",
  "@vite-hub/mcp/runtime",
  "@vite-hub/runtime/shutdown",
  // The generated Agent Invocations plugin installs the default journal; apps configure it with `agent.invocations`.
  // It loads the libSQL driver only when the build can select SQLite or libSQL.
  "@vite-hub/agent/invocations/app",
  "@vite-hub/agent/internal/default-invocations",
  "@vite-hub/agent/internal/default-invocations-core",
  "@vite-hub/agent/internal/default-invocations-libsql",
  "@vite-hub/auth/runtime/console",
  "@vite-hub/auth/runtime/console",
  "@vite-hub/blob/runtime/state",
  "@vite-hub/comments/runtime/connect",
  "@vite-hub/comments/runtime/connect/node",
  // Generated code imports these through `vite-hub` forwarders by path. The forwarders are not package exports.
  "@vite-hub/comments/realtime",
  "@vite-hub/comments/runtime/auth",
  "@vite-hub/connections/agent",
  "@vite-hub/database/runtime/cloudflare-env",
  "@vite-hub/database/runtime/libsql-drizzle",
  "@vite-hub/database/runtime/request-stats",
  "@vite-hub/database/runtime/state",
  "@vite-hub/email/runtime/console",
  "@vite-hub/kv/runtime/redis-driver",
  "@vite-hub/kv/runtime/upstash-driver",
  "@vite-hub/queue/runtime/hosted",
  "@vite-hub/rate-limit/runtime",
  "@vite-hub/sandbox/task/runtime/empty-registry",
  "@vite-hub/sandbox/task/runtime/provider-loader",
  "@vite-hub/sandbox/task/runtime/state",
  "@vite-hub/schedule/runtime/static",
  "@vite-hub/workflow/runtime/openworkflow",
  "@vite-hub/workflow/runtime/state",
]);

function sourceForwarderTargets(source: string): string[] | undefined {
  const lines = source
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("//"));
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
  const [owner, ...rest] = subpath.replace(/^\.\//, "").split("/");
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
  if (/^(?:cli|nitro|nuxt|test|tsconfig|virtual|vite|task\/vite)(?:\/|$)/.test(path))
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
    expect(frameworkAgent.defineAgent).toBe(ownerAgent.defineAgent);
    expect(frameworkAgentProcessRuntime.createProcessAgentCapacity).toBe(
      ownerAgentProcessRuntime.createProcessAgentCapacity,
    );
    expect(frameworkCapabilities.email).toBe(ownerCapabilities.email);
    expect(Object.keys(frameworkCapabilities).sort()).toEqual(Object.keys(ownerCapabilities).sort());
    for (const [name, capability] of Object.entries(ownerCapabilities)) {
      expect(Reflect.get(frameworkCapabilities, name), name).toBe(capability);
    }
    expect(frameworkCapabilities.workspaceShell).toBe(ownerCapabilities.workspaceShell);
    expect(frameworkAgentMcp.remoteMcpServer).toBe(ownerAgentMcp.remoteMcpServer);
    expect(frameworkAgentVite.agentHostRoutes).toBe(ownerAgentVite.agentHostRoutes);
    expect(frameworkAgentVue.useAgent).toBe(ownerAgentVue.useAgent);
    expect(frameworkAgentVue.useChat).toBe(ownerAgentVue.useChat);
    expect(frameworkAuthHandler).toBe(ownerAuthHandler);
    expect(frameworkAuthVue.authClient).toBe(ownerAuthVue.authClient);
    expect(frameworkAuthVue.useUserSession).toBe(ownerAuthVue.useUserSession);
    expect(frameworkBlobClient.detectContentType).toBe(ownerBlobClient.detectContentType);
    expect(frameworkBlobMedia.responsiveImage).toBe(ownerBlobMedia.responsiveImage);
    expect(frameworkBlobClient.createMultipartUploader).toBe(ownerBlobClient.createMultipartUploader);
    expect(frameworkBlobVue.useUpload).toBe(ownerBlobVue.useUpload);
    expect(frameworkBlobVue.useMultipartUpload).toBe(ownerBlobVue.useMultipartUpload);
    expect(frameworkRateLimit.requireRateLimit).toBe(ownerRateLimit.requireRateLimit);
    expect(frameworkRateLimit.createRateLimiter).toBe(ownerRateLimit.createRateLimiter);
    expect(frameworkWebContainer.bootWebContainer).toBe(ownerWebContainer.bootWebContainer);
    expect(frameworkWebContainerConnect.defineConnect).toBe(ownerWebContainerConnect.defineConnect);
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

    // This build helper is shared internally, without a public framework export.
    expect(sourceForwarderTargets(readFileSync(`${packageRoot}/src/nitro-plugin.ts`, "utf8")))
      .toEqual(["@vite-hub/internal/build/included-nitro", "@vite-hub/internal/build/included-nitro-registry"]);
    // Generated journal code imports the optional libSQL loader by path.
    expect(sourceForwarderTargets(readFileSync(`${packageRoot}/src/internal/agent-invocations-libsql.ts`, "utf8")))
      .toEqual(["@vite-hub/agent/internal/default-invocations-libsql"]);
    // The page pill ships as a browser script, `./page/pill.js`, which bundles this forwarder instead of exporting it.
    expect(sourceForwarderTargets(readFileSync(`${packageRoot}/src/page/pill.ts`, "utf8")))
      .toEqual(["@vite-hub/internal/runtime/page-pill", "@vite-hub/internal/runtime/page-tools-shared"]);
    expect(manifest.exports["./page/pill.js"]).toEqual({ default: "./dist/page/pill.iife.js" });
    // Generated code imports these forwarders by path, so an app reaches the owner without installing it.
    const generatedForwarders = ["src/comments/realtime.ts", "src/comments/runtime/auth.ts", "src/connections/agent.ts", "src/internal/agent-invocations-libsql.ts"];
    expect(sourceForwarders).toEqual([...exportedForwarders, ...generatedForwarders, "src/nitro-plugin.ts", "src/page/pill.ts"].sort());
    expect(
      manifestEntries
        .filter(({ source }) => !exportedForwarders.has(source))
        .map(({ subpath }) => subpath)
        .sort(),
    ).toEqual([
      ".",
      "./console",
      "./console/auth",
      "./console/mcp-client",
      "./console/server",
      "./console/ui",
      "./doctor",
      "./logs",
      "./logs/host",
      "./logs/memory",
      "./logs/source",
      "./nuxt",
      "./operations",
      "./skills",
      "./test",
    ]);

    for (const { subpath, targets } of manifestForwarders) {
      const ownerSpecifier = ownerSpecifierForDistributionSubpath(subpath);
      const ownerPackage = ownerSpecifier.split("/").slice(0, 2).join("/");
      const ownTargets = [...new Set(targets)].filter(
        (target) => !(consolidatedOwnerExports.has(target) && target.startsWith(`${ownerSpecifier}/`)),
      );
      expect(ownTargets, subpath).toEqual([ownerSpecifier]);
      // Opt-in features keep their owner package as an optional peer.
      expect({ ...manifest.dependencies, ...manifest.peerDependencies }[ownerPackage], subpath).toBeDefined();
    }
  });

  it("classifies every owner-package export", () => {
    const unclassified: string[] = [];

    for (const packageName of Object.keys({ ...manifest.dependencies, ...manifest.peerDependencies }).filter((name) =>
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

  it("ships every declared export and the one vitehub bin", () => {
    expect(manifest.exports).not.toHaveProperty("./bin");
    expect(manifest.bin).toEqual({
      vitehub: "./dist/bin.js",
    });

    for (const value of Object.values(manifest.exports)) {
      // A browser script, such as `./page/pill.js`, has only a `default` target.
      const target = String(value) === value ? value : Reflect.get(Object(value), "import") ?? Reflect.get(Object(value), "default");
      if (String(target) !== target) throw new TypeError("Expected an export target.");
      if (target === "./package.json") continue;
      expect(existsSync(`${packageRoot}/${target}`), target).toBe(true);
    }

    expect(readFileSync(`${packageRoot}/${manifest.bin.vitehub}`, "utf8")).toMatch(
      /^#!\/usr\/bin\/env node/,
    );
    for (const file of ["index.d.ts", "env.d.ts"]) {
      expect(readFileSync(`${packageRoot}/dist/${file}`, "utf8")).toContain(
        'import "@vite-hub/env/vite"',
      );
    }
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
    const consoleSessionBootstrap = readFileSync(
      `${packageRoot}/dist/console/runtime/components/console-session-bootstrap.ts`,
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
    expect(
      existsSync(`${packageRoot}/dist/console/runtime/components/console-workspace-file.ts`),
    ).toBe(true);
    expect(existsSync(`${packageRoot}/dist/console/runtime/console-route.js`)).toBe(true);
    expect(existsSync(`${packageRoot}/dist/console/runtime/sections.js`)).toBe(true);
    expect(existsSync(`${packageRoot}/dist/console/runtime/client/request.js`)).toBe(true);
    expect(existsSync(`${packageRoot}/dist/console/runtime/client/request.d.ts`)).toBe(true);
    expect(existsSync(`${packageRoot}/dist/console/runtime/client/format.js`)).toBe(true);
    expect(existsSync(`${packageRoot}/dist/console/runtime/client/format.d.ts`)).toBe(true);
    expect(existsSync(`${packageRoot}/dist/console/runtime/client/appearance.js`)).toBe(true);
    expect(existsSync(`${packageRoot}/dist/console/runtime/client/appearance.d.ts`)).toBe(true);
    expect(manifest.exports).not.toHaveProperty("./console/runtime/console-route");
    expect(manifest.exports).not.toHaveProperty("./console/runtime/sections");
    expect(manifest.exports).not.toHaveProperty("./console/runtime/client/request");
    expect(manifest.exports).not.toHaveProperty("./console/runtime/client/format");
    expect(manifest.exports).not.toHaveProperty("./console/runtime/client/appearance");
    expect(consolePage).toContain("AgentInvocationList");
    expect(consolePage).toMatch(/aria-label="[^"]*'Filter sessions'"/);
    expect(consolePage).toContain("selectedCapabilityId");
    expect(consolePage.match(/:workspace-base="apiBase"/g)).toHaveLength(2);
    expect(consolePage.match(/:workspace-inspectable="true"/g)).toHaveLength(1);
    expect(consolePage).toContain(
      'const view = target === "agent" ? "details" : "workspace";',
    );
    expect(consolePage).toContain('invocation.annotations?.["agent.model.provider"]');
    expect(consolePage).toContain("ConsoleSessionInspector");
    expect(consolePage).not.toContain("ConsoleHealth");
    const consoleSessionCss = readFileSync(
      `${packageRoot}/dist/console/runtime/components/console-session.css`,
      "utf8",
    );
    expect(consoleSessionCss).toMatch(/\.session-inspector\s*\{[\s\S]*?height: 100%;/);
    expect(consolePage).toContain("limit: 50");
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
    expect(consoleSessionBootstrap).toContain("options.firstInvocation");
    expect(consoleSessionBootstrap).toContain(
      "if (invocation.agentName) selectAgentName(invocation.agentName, true);",
    );
    expect(consoleSessionBootstrap).toContain("refreshAfterPreservedAgentSelection");
    expect(consoleSessionBootstrap).toContain("selectAgentName(agentNames[0]!)");
    expect(consolePage.indexOf("if (pageVisible.value) void loadAgents();")).toBeLessThan(
      consolePage.indexOf("onMounted(() =>"),
    );
    expect(consolePage).toContain(
      'v-if="isDesktop && selectedInvocationId"',
    );
    expect(consolePage).toContain("detail.isLoading.value || initialSessionLoading");
    expect(consolePage).not.toContain("min-height: 32rem");
    expect(consoleFrame).toContain("min-height: 0");
    expect(consoleFrame).not.toContain("min-height: 32rem");
    expect(consolePage).toContain("<ConsoleSessionNavbar");
    // A desktop session uses the AgentSession header. Phones keep the session navbar and its details slideover.
    expect(consolePage.split("<ConsoleSessionNavbar").length).toBe(2);
    expect(consolePage).toContain('<ConsoleSessionNavbar\n              v-if="!(isDesktop && selectedInvocationId)"');
    expect(consolePage).toContain('<ConsoleAgentSession\n            v-if="isDesktop && selectedInvocationId"');
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
    const consoleAgentSession = readFileSync(
      `${packageRoot}/dist/console/runtime/components/console-agent-session.vue`,
      "utf8",
    );
    // The AgentSession panel is the only panel, so its inspector surfaces do not maximize.
    expect(consoleAgentSession).toContain(':maximizable="false"');
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
    // The section check runs after the navigation commits, so a fast sections answer cannot miss the route it checks.
    expect(consoleClientMain).toMatch(/router\.afterEach\(\(to, _from, failure\) => \{[\s\S]*?void loadSections\(\)\.then/);
    expect(consoleClientMain.split("router.afterEach(")[0]).not.toContain("void loadSections()");
    const sessionInspector = readFileSync(
      `${packageRoot}/dist/console/runtime/components/console-session-inspector.vue`,
      "utf8",
    );
    const sessionCodePreview = readFileSync(
      `${packageRoot}/dist/console/runtime/components/console-session-code-preview.vue`,
      "utf8",
    );
    const workspaceHistory = readFileSync(
      `${packageRoot}/dist/console/runtime/components/console-workspace-history.vue`,
      "utf8",
    );
    expect(sessionInspector).toContain("Workspace unavailable");
    expect(sessionInspector).toContain(':show-status="false"');
    expect(sessionInspector).toContain(':show-timeline="false"');
    expect(sessionInspector).toContain('...(props.workspaceBase ? (["workspace"] as const) : [])');
    expect(sessionInspector).toContain('if (tab.value === "workspace") void loadWorkspace();');
    expect(sessionInspector).toContain("workspaceLoading.value = false;");
    expect(sessionInspector).toContain("workspaceRequest = undefined;");
    expect(sessionInspector).toMatch(/<UButton\s+v-if="props.workspaceBase"/);
    expect(sessionInspector).toMatch(
      /const invocationId = props\.invocation\.id;[\s\S]*?if \(!workspace\.value\) await loadWorkspace\(\);[\s\S]*?if \(props\.invocation\.id !== invocationId\) return;/,
    );
    expect(sessionInspector).toContain("if (workspaceLoad) return workspaceLoad;");
    expect(sessionInspector).toMatch(
      /const loadedWorkspace = parseWorkspaceDescriptor\([\s\S]*?if \(workspaceRequest !== controller\) return;[\s\S]*?workspace\.value = loadedWorkspace;/,
    );
    expect(sessionInspector).toContain("<template #identityActions>");
    expect(workspaceHistory).toContain("Workspace history");
    expect(sessionInspector).toContain("workspace.pullRequest !== undefined");
    expect(sessionInspector).toContain("hasPullRequest && (pullRequest === undefined");
    expect(sessionInspector).toContain('openViews.value.includes("workspace")');
    expect(sessionInspector).toContain('<TabsList class="session-inspector__tablist">');
    expect(sessionInspector).toContain('import { TabsList, TabsRoot, TabsTrigger } from "reka-ui";');
    expect(sessionInspector).toMatch(
      /<TabsTrigger[\s\S]*?<\/TabsTrigger>[\s\S]*?<UButton[\s\S]*?:aria-label="`Close \$\{item\.label\}`"/,
    );
    expect(sessionInspector).not.toContain('<template #leading="{ item }">');
    expect(sessionInspector).not.toContain("scrollIntoView");
    expect(sessionInspector).toContain("scroller.scrollLeft");
    expect(consoleSessionCss).toMatch(
      /\.session-inspector__tabstrip \{[\s\S]*?display: flex;[\s\S]*?overflow: hidden;/,
    );
    expect(consoleSessionCss).toMatch(
      /\.session-inspector__tabs \{[\s\S]*?flex: 0 1 auto;[\s\S]*?max-width: calc\(100% - 2rem\);[\s\S]*?width: max-content;/,
    );
    expect(consoleSessionCss).toMatch(
      /\.session-inspector__tablist \{[^}]*?display: flex;[^}]*?min-width: 0;[^}]*?width: max-content;/,
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
    expect(sessionCodePreview).toContain("highlightingFailed");
    expect(sessionCodePreview).toContain('class="line"');
    expect(sessionCodePreview).toContain("plainLines");
    expect(consoleSessionCss).toMatch(
      /\.session-code-preview \.shiki,[\s\S]*?\.session-code-preview__plain[\s\S]*?font-size: 0\.75rem;/,
    );
    expect(consoleSessionCss).toMatch(
      /\.session-inspector__file \{[\s\S]*?grid-template-rows: minmax\(0, 1fr\);[\s\S]*?height: 100%;/,
    );
    expect(consoleSessionCss).toContain("padding: 0.75rem 0 1.5rem;");
    expect(consolePage).not.toContain("/api/health");
    expect(existsSync(`${packageRoot}/dist/console/runtime/server/status.get.js`)).toBe(true);
    expect(consolePage).toContain("agentInvocationTitle");
    expect(consoleSessionNavbar).toContain("<UDashboardNavbar");
    expect(consoleSessionNavbar).toContain('class="md:hidden"');
    expect(consoleSessionNavbar).not.toContain('class="lg:hidden"');
    expect(consolePage).toContain(':header="false"');
    expect(consoleAgentSession).toContain('storage-key="vitehub-console:session-layout"');
    expect(consolePage).toContain(':continuation-key="list.cursor.value"');
    expect(consolePage).not.toContain(':retry-key="invocationPaginationKey"');
    expect(consolePage).toContain("list.loadMoreError.value");
    expect(consolePage).toContain("Retry loading older sessions");
    expect(consolePage).toContain('@click="list.loadMore"');
    expect(consolePage).toContain('import {\n  readConsoleAgentListOpen,');
    expect(consolePage).toContain('aria-controls="vitehub-console-agent-list"');
    expect(consolePage).toContain('group-by="recency"');
    expect(existsSync(`${packageRoot}/dist/console/runtime/components/console-agent-list.ts`)).toBe(true);
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
    expect(consolePage).toContain("content: 'md:hidden w-[calc(100vw-0.75rem)] max-w-none'");
    expect(consolePage).toContain('details: queryChoice(["closed", "open", "max"], "closed", { history: "push" })');
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
    expect(consolePage).toContain("max-width: 48rem");
    expect(consolePage).not.toContain("route.query.agent");
    expect(consolePage).not.toContain("groupConsoleSessions");
    expect(consolePage).not.toContain("<UApp");
    expect(consolePage).toContain(".vitehub-console");
    // Nuxt serves the standalone Console page, so the package ships no Nuxt pages.
    expect(existsSync(`${packageRoot}/dist/console/runtime/pages`)).toBe(false);
    expect(existsSync(`${packageRoot}/dist/console/runtime/components/console-blob.vue`)).toBe(
      true,
    );
    expect(existsSync(`${packageRoot}/dist/console/runtime/components/console-state.vue`)).toBe(true);
    for (const path of ["components/console-skills.vue", "components/console-skill-tree.vue", "components/console-skill-file.vue", "skills.js"]) {
      expect(existsSync(`${packageRoot}/dist/console/runtime/${path}`)).toBe(true);
    }
    expect(manifest.exports).not.toHaveProperty("./console/runtime/skills");
    expect(existsSync(`${packageRoot}/dist/console/runtime/components/console-kv.vue`)).toBe(true);
    const consoleKV = readFileSync(
      `${packageRoot}/dist/console/runtime/components/console-kv.vue`,
      "utf8",
    );
    expect(consoleKV).toContain("loadedStore.value === store");
    expect(
      existsSync(`${packageRoot}/dist/console/runtime/components/console-definitions.vue`),
    ).toBe(true);
    expect(existsSync(`${packageRoot}/dist/console/runtime/definitions.js`)).toBe(true);
    expect(manifest.exports).not.toHaveProperty("./console/runtime/definitions");
    expect(existsSync(`${packageRoot}/dist/console/runtime/components/console-provider.vue`)).toBe(false);
    const consoleSearch = readFileSync(
      `${packageRoot}/dist/console/runtime/components/console-search-palette.vue`,
      "utf8",
    );
    expect(consoleSearch).toContain(
      'resolveConsoleRouteName(route.name, "vitehub-console-invocation")',
    );
    expect(consoleSearch).toContain('[{ id: "actions", items: [...props.actions ?? [], ...contentActions.value, ...projectActions.value, ...themeActions.value], label: "Actions" }]');
    expect(consoleSearch).toContain('label: "Overview"');
    expect(consoleSearch).toContain('label: "Go to"');
    expect(consoleSearch).toContain("kbds: [...shortcut]");
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
    documentRequest?.abort()
    return
  }`);
    expect(consoleSearch).toContain("if (!open.value) return");
    expect(consoleSearch).toContain("if (open.value) debouncedSearchTerm.value = value.trim()");
    expect(consoleSearch).toContain("debouncedSearchTerm.value = nextSearchTerm");
    const consoleHome = readFileSync(
      `${packageRoot}/dist/console/runtime/components/console-home.vue`,
      "utf8",
    );
    expect(consoleHome).toContain("loadConsoleNavigation(props.sectionsBase)");
    const consoleRail = readFileSync(
      `${packageRoot}/dist/console/runtime/components/console-rail.vue`,
      "utf8",
    );
    expect(consoleRail).toContain("navigationFailed.value = true");
    expect(consoleRail).toContain('<PrimitiveRailItem label="Retry loading primitives" @click="loadNavigation">');
    expect(consoleRail).toContain("open('vitehub-console')");
    expect(consoleRail).toContain("subscribeConsoleNavigation(props.sectionsBase");
    expect(consoleRail).toContain('import { defineShortcuts } from "@nuxt/ui/composables";');
    expect(existsSync(`${packageRoot}/dist/console/runtime/components/console-usage.vue`)).toBe(
      true,
    );
    const consoleRpcSource = readFileSync(
      `${packageRoot}/dist/console/runtime/server/rpc.js`,
      "utf8",
    );
    expect(existsSync(`${packageRoot}/dist/console/runtime/public/console`)).toBe(false);
    expect(consoleRpcSource).not.toContain("devframe/adapters/h3");
    // Only the Nuxt cloudflare preset references these declarations, so an app that wants them installs them.
    expect(manifest.dependencies).not.toHaveProperty("@cloudflare/workers-types");
    expect(manifest.peerDependencies).toHaveProperty("@cloudflare/workers-types");
    expect(manifest.dependencies).toHaveProperty("h3");
    expect(manifest.dependencies).toHaveProperty("ocache");
    expect(manifest.dependencies).not.toHaveProperty("@google-cloud/storage");
  });

  it("configures distributed Console files without OAuth discovery for open access", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-distributed-console-"));
    try {
      await writeFile(join(root, "package.json"), "{}\n", "utf8");
      const plugin = framework
        .vitehub({
          agent: true,
          console: { auth: false, authorize: hostManagedAuthorize },
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

      // Open access is for development. A production build refuses it.
      await Reflect.apply(configHandler, plugin, [
        config,
        { command: "serve", mode: "development" },
      ]);

      const nitro = Reflect.get(config, "nitro");
      const handlers = Reflect.get(Object(nitro), "handlers");
      const publicAssets = Reflect.get(Object(nitro), "publicAssets");
      if (!Array.isArray(handlers) || !Array.isArray(publicAssets)) {
        throw new TypeError("Expected the distributed Console Nitro configuration.");
      }
      // Apps serve the Console RPC and the page tools session of the Console link only: no Console page, client script,
      // MCP, or Env management.
      expect(handlers.map((registration) => Reflect.get(Object(registration), "route"))).toEqual([
        "/_vitehub/rpc",
        "/_vitehub/page/session",
      ]);
      for (const registration of handlers) {
        const handler = Reflect.get(Object(registration), "handler");
        if (String(handler) !== handler) throw new TypeError("Expected a Console handler path.");
        expect(handler).toContain("/dist/console/runtime/server/");
        expect(existsSync(handler), handler).toBe(true);
      }
      expect(publicAssets.map((asset) => Reflect.get(Object(asset), "baseURL"))).toEqual(["/_vitehub/.well-known/skills", "/_vitehub/console/assets", "/_vitehub/page/assets"]);
      // The Console segment of the pill and the page tools loader are built files of the package.
      expect(existsSync(`${Reflect.get(Object(publicAssets[1]), "dir")}/page-tool.js`)).toBe(true);
      expect(existsSync(`${Reflect.get(Object(publicAssets[2]), "dir")}/loader.js`)).toBe(true);
      const skillsDir = Reflect.get(Object(publicAssets[0]), "dir");
      if (String(skillsDir) !== skillsDir) throw new TypeError("Expected the Console skills path.");
      // The skills CLI reads this index from `<app>/_vitehub/.well-known/skills/index.json`.
      const skillsIndex: { skills: Array<{ name: string, files: string[] }> } = JSON.parse(readFileSync(`${skillsDir}/index.json`, "utf8"));
      expect(skillsIndex.skills.map((skill) => skill.name)).toEqual(["vitehub"]);
      for (const file of skillsIndex.skills[0].files) expect(existsSync(`${skillsDir}/vitehub/${file}`), file).toBe(true);
      expect(skillsIndex.skills[0].files).toContain("SKILL.md");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("runs the distributed CLI entrypoint with clean help streams", async () => {
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
      for (const entrypoint of [`${packageRoot}/${manifest.bin.vitehub}`]) {
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
        execFileAsync(process.execPath, [`${packageRoot}/${manifest.bin.vitehub}`], {
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
