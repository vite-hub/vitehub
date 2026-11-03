import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { hubBlob } from "@vite-hub/blob/vite";
import { createAgentCliContributor } from "@vite-hub/agent/cli";
import { runViteHubCli } from "@vite-hub/cli";
import { createCmsCliContributor } from "@vite-hub/cms/vite";
import { createContentCliContributor } from "@vite-hub/content/cli";
import { createDbCliContributor } from "@vite-hub/database/cli";
import { hubEmail } from "@vite-hub/email/vite";
import { hubEnv } from "@vite-hub/env/vite";
import { hubKv } from "@vite-hub/kv/vite";
import { hubQueue } from "@vite-hub/queue/vite";
import { hubRateLimit } from "@vite-hub/rate-limit/vite";
import { hubWorkflow } from "@vite-hub/workflow/vite";
import { hubSchedule } from "@vite-hub/schedule/vite";
import { hubWorkspace } from "@vite-hub/workspace/vite";
import { describe, expect, it } from "vitest";

import { createSandboxCliNamespace } from "../src/sandbox-cli.ts";
import { createConsoleCliNamespace } from "../src/console/cli.ts";
import { viteHubTypesPlugin } from "../src/internal/types.ts";
import { consoleOperations } from "../src/console/runtime/server/operations.ts";
import { taskOperations } from "../src/task/operations.ts";
import { viteHubTaskPlugin } from "../src/task/vite.ts";

const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
const cliReference = join(repoRoot, "docs/content/docs/development/cli.md");
const evalFixtureRoot = join(repoRoot, "packages/agent/test/fixtures");

function stream() {
  let value = "";
  return {
    output: () => value,
    write(chunk: string | Uint8Array) {
      value += String(chunk);
    },
  };
}

function helpNames(output: string, heading: string): string[] {
  const section = output.split(`${heading}\n`, 2)[1];
  if (section === undefined) throw new TypeError(`Missing CLI help heading: ${heading}`);
  return [...section.matchAll(/^ {2}(\S+)(?:\s{2,}|$)/gm)].map((match) => match[1]!);
}

function documentedCommands(): string[] {
  const source = readFileSync(cliReference, "utf8");
  return [...source.matchAll(/^\| `vitehub ([a-z0-9-]+) ([a-z0-9-]+)`\s+\|/gm)]
    .map((match) => `${match[1]} ${match[2]}`)
    .sort();
}

function documentedNamespaces(): string[] {
  const source = readFileSync(cliReference, "utf8");
  const sample = source.split("Available namespaces:\n", 2)[1]?.split("```", 1)[0];
  if (sample === undefined) throw new TypeError("Missing sample CLI help output.");
  return helpNames(`Available namespaces:\n${sample}`, "Available namespaces:").sort();
}

describe("CLI documentation contract", () => {
  it("indexes every command from the live package contributors", async () => {
    const blobPlugin: unknown = hubBlob();
    const agent = createAgentCliContributor({ rootDir: evalFixtureRoot });
    const database = createDbCliContributor();
    if (!agent || !database) throw new TypeError("Expected the default CLI contributors.");
    const emailPlugin: unknown = hubEmail({ driver: "resend" });
    const schedulePlugin: unknown = hubSchedule();
    const workspacePlugin: unknown = hubWorkspace();
    const workflowPlugin: unknown = hubWorkflow();
    const typesPlugin: unknown = viteHubTypesPlugin();
    const plugins: unknown[] = [
      blobPlugin,
      { vitehub: { cli: agent } },
      { vitehub: { cli: database } },
      { vitehub: { cli: { namespaces: [createConsoleCliNamespace()] } } },
      { vitehub: { cli: createContentCliContributor() } },
      // `hubCms()` contributes this only for an app with server/content.ts.
      { vitehub: { cli: createCmsCliContributor() } },
      hubEnv(),
      emailPlugin,
      hubKv(),
      hubQueue(),
      hubRateLimit(),
      schedulePlugin,
      workflowPlugin,
      workspacePlugin,
      viteHubTaskPlugin(),
      // The task plugin contributes these only for an app that has tasks.
      { vitehub: { operations: [{ export: "taskOperations", load: async () => taskOperations, module: "vite-hub/_internal/task/operations" }] } },
      // The Console plugin contributes every Console operation; the reference documents the Database ones.
      { vitehub: { operations: [{ export: "consoleOperations", load: async () => consoleOperations.filter((operation) => operation.name.startsWith("databases.")), module: "vite-hub/console/server" }] } },
      typesPlugin,
    ];
    const loadConfig = async () => ({ plugins, root: repoRoot });
    const rootHelp = stream();
    const runtimeNamespaces = [createSandboxCliNamespace()];

    await expect(
      runViteHubCli({ args: ["--help"], loadConfig, runtimeNamespaces, stdout: rootHelp }),
    ).resolves.toBe(0);
    const namespaces = helpNames(rootHelp.output(), "Available namespaces:");
    const commands: string[] = [];

    for (const namespace of namespaces) {
      const namespaceHelp = stream();
      await expect(
        runViteHubCli({
          args: [namespace, "--help"],
          loadConfig,
          runtimeNamespaces,
          stdout: namespaceHelp,
        }),
      ).resolves.toBe(0);
      for (const feature of helpNames(namespaceHelp.output(), "Available features:")) {
        commands.push(`${namespace} ${feature}`);
      }
    }

    expect(documentedNamespaces()).toEqual([...namespaces].sort());
    expect(documentedCommands()).toEqual(commands.sort());
  });
});
