import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { createAgentCliContributor } from "@vite-hub/agent/cli";
import { runViteHubCli } from "@vite-hub/cli";
import { createDbCliContributor } from "@vite-hub/database/cli";
import { hubWorkspace } from "@vite-hub/workspace/vite";
import { describe, expect, it } from "vitest";

import { createConsoleCliNamespace } from "../src/console/cli.ts";
import { viteHubTypesPlugin } from "../src/internal/types.ts";

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
  return [...source.matchAll(/^\| `vitehub ([a-z0-9-]+) ([a-z0-9-]+)` \|/gm)]
    .map((match) => `${match[1]} ${match[2]}`)
    .sort();
}

describe("CLI documentation contract", () => {
  it("indexes every command from the live package contributors", async () => {
    const agent = createAgentCliContributor({ rootDir: evalFixtureRoot });
    const database = createDbCliContributor();
    if (!agent || !database) throw new TypeError("Expected the default CLI contributors.");
    const plugins = [
      { vitehub: { cli: agent } },
      { vitehub: { cli: database } },
      { vitehub: { cli: { namespaces: [createConsoleCliNamespace()] } } },
      hubWorkspace(),
      viteHubTypesPlugin(),
    ];
    const loadConfig = async () => ({ plugins, root: repoRoot });
    const rootHelp = stream();

    await expect(runViteHubCli({ args: ["--help"], loadConfig, stdout: rootHelp })).resolves.toBe(
      0,
    );
    const namespaces = helpNames(rootHelp.output(), "Available namespaces:");
    const commands: string[] = [];

    for (const namespace of namespaces) {
      const namespaceHelp = stream();
      await expect(
        runViteHubCli({ args: [namespace, "--help"], loadConfig, stdout: namespaceHelp }),
      ).resolves.toBe(0);
      for (const feature of helpNames(namespaceHelp.output(), "Available features:")) {
        commands.push(`${namespace} ${feature}`);
      }
    }

    expect(documentedCommands()).toEqual(commands.sort());
  });
});
