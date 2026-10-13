import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  cursorMcpInstallUrl,
  docsMcpServerName,
  docsMcpUrl,
  pageActionLinks,
  pageChatPrompt,
  vscodeMcpInstallUrl,
} from "../modules/vitehub-docs/runtime/utils/page-actions";

const docsRoot = resolve(import.meta.dirname, "..");

function read(path: string) {
  return readFileSync(resolve(docsRoot, path), "utf8");
}

describe("docs page actions", () => {
  it("maps trailing-slash and bare docs routes to one raw Markdown page", () => {
    for (const route of [
      "/docs/getting-started/ai-resources/mcp-server",
      "/docs/getting-started/ai-resources/mcp-server/",
    ]) {
      expect(pageActionLinks(route)).toMatchObject({
        markdownPath: "/raw/docs/getting-started/ai-resources/mcp-server.md",
        markdownUrl: "https://vitehub.dev/raw/docs/getting-started/ai-resources/mcp-server.md",
      });
    }
    expect(pageActionLinks("/docs/")?.markdownPath).toBe("/raw/docs.md");
    expect(pageActionLinks("/docs")?.markdownUrl).toBe("https://vitehub.dev/raw/docs.md");
    expect(pageActionLinks("/examples/")).toBeNull();
    expect(pageActionLinks("/")).toBeNull();
  });

  it("opens ChatGPT and Claude with a prompt that references the canonical raw URL", () => {
    const links = pageActionLinks("/docs/kv/");
    const prompt = pageChatPrompt("https://vitehub.dev/raw/docs/kv.md");

    expect(prompt).toBe(
      "Read https://vitehub.dev/raw/docs/kv.md from the ViteHub documentation. Use it as context to answer my questions and to help me apply it in my project.",
    );
    expect(links?.prompt).toBe(prompt);

    const chatGpt = new URL(links!.chatGptUrl);
    expect(chatGpt.origin).toBe("https://chatgpt.com");
    expect(chatGpt.searchParams.get("hints")).toBe("search");
    expect(chatGpt.searchParams.get("q")).toBe(prompt);

    const claude = new URL(links!.claudeUrl);
    expect(`${claude.origin}${claude.pathname}`).toBe("https://claude.ai/new");
    expect(claude.searchParams.get("q")).toBe(prompt);
  });

  it("builds MCP install links for the docs endpoint", () => {
    expect(docsMcpUrl).toBe("https://vitehub.dev/mcp");

    const cursor = new URL(cursorMcpInstallUrl());
    expect(`${cursor.protocol}//${cursor.host}${cursor.pathname}`).toBe(
      "cursor://anysphere.cursor-deeplink/mcp/install",
    );
    expect(cursor.searchParams.get("name")).toBe(docsMcpServerName);
    expect(JSON.parse(atob(cursor.searchParams.get("config")!))).toEqual({
      type: "http",
      url: docsMcpUrl,
    });

    const vscode = vscodeMcpInstallUrl();
    expect(vscode.startsWith("vscode:mcp/install?")).toBe(true);
    expect(JSON.parse(decodeURIComponent(vscode.slice("vscode:mcp/install?".length)))).toEqual({
      name: docsMcpServerName,
      type: "http",
      url: docsMcpUrl,
    });
  });

  it("replaces the Docus header actions on every docs page", () => {
    const component = read("app/components/DocsPageHeaderLinks.vue");

    expect(component).toContain("pageActionLinks(route.path)");
    for (const page of [
      "app/pages/docs/index.vue",
      "app/components/DocsArticle.vue",
      "app/components/DocsProductLanding.vue",
      "app/components/SupportMatrix.vue",
    ]) {
      expect(read(page)).toContain("<DocsPageHeaderLinks />");
    }
  });

  it("documents every page action that the header renders", () => {
    const component = read("app/components/DocsPageHeaderLinks.vue");
    const guide = read("content/docs/getting-started/ai-resources/markdown-pages.md");
    const labels = [...component.matchAll(/label: "([^"]+)"/g)].map((match) => match[1]!);

    expect(labels).toEqual([
      "View as Markdown",
      "Copy Markdown URL",
      "Open in ChatGPT",
      "Open in Claude",
      "Copy MCP server URL",
      "Add MCP server to Cursor",
      "Add MCP server to VS Code",
      "Set up other AI tools",
    ]);
    expect(guide).toContain("| Copy page |");
    for (const label of labels.slice(0, 5)) expect(guide).toContain(`| ${label} |`);
    expect(guide).toContain("| Add MCP server to Cursor or VS Code |");
    expect(component).toContain('to: "/docs/getting-started/ai-resources/mcp-server"');
    expect(guide).toContain(pageChatPrompt("https://vitehub.dev/raw/docs/kv.md"));
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

  it("installs only the ViteHub skill from the site URL for each documented agent", () => {
    const guide = read("content/docs/getting-started/ai-resources/agent-instructions-skills.md");
    const commands = [...guide.matchAll(/npx skills add (\S+) --skill (\S+) --agent (\S+)/g)];

    expect(commands.map((match) => match[3])).toEqual([
      "claude-code",
      "cursor",
      "github-copilot",
      "windsurf",
      "codex",
    ]);
    for (const [, source, skill] of commands) {
      expect(source).toBe("https://vitehub.dev");
      expect(skill).toBe("vitehub");
    }
    expect(read("skills/vitehub/SKILL.md")).toMatch(/^---\nname: vitehub\n/);
  });
});
