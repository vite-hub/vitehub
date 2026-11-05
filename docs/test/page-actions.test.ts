import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { docsMarkdownLinks } from "@vite-hub/docs";
import { describe, expect, it } from "vitest";
import config from "../nuxt.config";

const docsRoot = resolve(import.meta.dirname, "..");
const site = { name: "ViteHub", url: "https://vitehub.dev" };
// The docs module serves the MCP server at `/mcp` on the site origin.
const docsMcpUrl = "https://vitehub.dev/mcp";
const docsMcpServerName = "vitehub";

function read(path: string) {
  return readFileSync(resolve(docsRoot, path), "utf8");
}

describe("docs page actions", () => {
  it("names the ViteHub site and MCP server in the docs options", () => {
    expect(config.docs?.site).toMatchObject(site);
    expect(config.docs?.mcp).toEqual({ name: docsMcpServerName, guide: "/docs/getting-started/ai-resources/mcp-server" });
  });

  it("shows the page actions on article and landing pages", () => {
    const component = read("../packages/docs/runtime/app/components/DocsPageHeaderLinks.vue");

    expect(component).toContain("docsMarkdownLinks(site, route.path, appBase)");
    for (const page of [
      "../packages/docs/runtime/app/components/DocsArticle.vue",
      "../packages/docs/runtime/app/components/DocsLanding.vue",
    ]) {
      expect(read(page)).toContain("<DocsPageHeaderLinks />");
    }
  });

  it("documents every page action that the header renders", () => {
    const component = read("../packages/docs/runtime/app/components/DocsPageHeaderLinks.vue");
    const guide = read("content/docs/getting-started/ai-resources/markdown-pages.md");
    const labels = [...component.matchAll(/label: "([^"]+)"/g)].map((match) => match[1]!);
    const pageLabels = ["View as Markdown", "Copy Markdown URL", "Open in ChatGPT", "Open in Claude"];
    const mcpLabels = ["Copy MCP server URL", "Add MCP server to Cursor", "Add MCP server to VS Code", "Set up other AI tools"];

    // The component defines the MCP items before the page items, so compare the sets.
    expect([...labels].sort()).toEqual([...pageLabels, ...mcpLabels].sort());
    expect(guide).toContain("| Copy page |");
    for (const label of [...pageLabels, "Copy MCP server URL"]) expect(guide).toContain(`| ${label} |`);
    expect(guide).toContain("| Add MCP server to Cursor or VS Code |");
    expect(component).toContain("server.guide ? [{ label: \"Set up other AI tools\"");
    expect(guide).toContain(docsMarkdownLinks(site, "/docs/kv").prompt);
  });

  it("uses the generated MCP endpoint and server name in every setup snippet", () => {
    const guide = read("content/docs/getting-started/ai-resources/mcp-server.md");
    const endpoints = [...guide.matchAll(/https:\/\/vitehub\.dev\/mcp\b[^\s"'`)]*/g)].map(
      (match) => match[0],
    );

    expect(endpoints.length).toBeGreaterThanOrEqual(6);
    expect(new Set(endpoints)).toEqual(new Set([docsMcpUrl]));
    expect(guide).toContain(`claude mcp add --transport http ${docsMcpServerName} ${docsMcpUrl}`);
    expect(guide).toContain(`codex mcp add ${docsMcpServerName} --url ${docsMcpUrl}`);
    expect(guide).toContain(`[mcp_servers.${docsMcpServerName}]`);
    expect(guide).toContain(`"serverUrl": "${docsMcpUrl}"`);
    expect(guide).toMatch(/```json \[\.vscode\/mcp\.json\]\n\s*\{\n\s*"servers": \{/);
    expect(guide).toMatch(/```json \[\.cursor\/mcp\.json\]\n\s*\{\n\s*"mcpServers": \{/);
  });

  it("installs only the ViteHub skill from the documented site and app URLs", () => {
    const guide = read("content/docs/getting-started/ai-resources/agent-instructions-skills.md");
    const commands = [...guide.matchAll(/npx skills add (\S+) --skill (\S+) --agent (\S+)/g)];

    expect(commands.map((match) => match.slice(1))).toEqual([
      ["https://vitehub.dev", "vitehub", "claude-code"],
      ["https://vitehub.dev", "vitehub", "cursor"],
      ["https://vitehub.dev", "vitehub", "github-copilot"],
      ["https://vitehub.dev", "vitehub", "windsurf"],
      ["https://vitehub.dev", "vitehub", "codex"],
      ["http://localhost:3000/_vitehub", "vitehub", "claude-code"],
    ]);
    expect(read("skills/vitehub/SKILL.md")).toMatch(/^---\nname: vitehub\n/);
  });
});
