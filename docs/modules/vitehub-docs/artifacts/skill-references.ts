import { readdirSync, readFileSync, statSync } from "node:fs";
import { relative, resolve } from "node:path";
import { rawMarkdownUrl } from "../runtime/utils/llms-links";
import { toRawMarkdown } from "./raw-markdown";

const siteOrigin = "https://vitehub.dev";

export type SkillReference = {
  /** File name under `skills/vitehub/references/primitives/`, without `.md`. */
  name: string;
  /** Docs source path, relative to the docs root. */
  source: string;
  markdown: string;
};

function listMarkdown(root: string): string[] {
  return readdirSync(root).flatMap((entry) => {
    const path = resolve(root, entry);
    if (statSync(path).isDirectory()) return listMarkdown(path);
    return path.endsWith(".md") ? [path] : [];
  }).sort();
}

function frontmatterTitle(source: string) {
  return source.match(/^---\n[\s\S]*?^title:\s*(.+)$/m)?.[1]?.trim().replace(/^(["'])(.*)\1$/, "$2");
}

/**
 * Top-level `::agent-only{skill="name"}` blocks. An optional `title` attribute replaces the page title.
 * Fences and nested directives stay inside the block.
 */
export function skillBlocks(source: string) {
  const blocks: Array<{ name: string, title?: string, content: string }> = [];
  let current: { name: string, title?: string, lines: string[] } | null = null;
  let depth = 0;
  let fence: string | null = null;

  for (const line of source.split("\n")) {
    if (!current) {
      const attributes = line.match(/^::agent-only\{([^}]*)\}\s*$/)?.[1] || "";
      const name = attributes.match(/\bskill="([a-z0-9-]+)"/)?.[1];
      if (name) current = { name, title: attributes.match(/\btitle="([^"]+)"/)?.[1], lines: [] };
      continue;
    }

    const fenceRun = line.match(/^\s*(`{3,}|~{3,})/)?.[1];
    if (fence) {
      if (fenceRun && fenceRun[0] === fence[0] && fenceRun.length >= fence.length) fence = null;
    }
    else if (fenceRun) fence = fenceRun;
    else if (/^\s*:{2,}\s*$/.test(line)) {
      if (depth === 0) {
        blocks.push({ name: current.name, title: current.title, content: current.lines.join("\n") });
        current = null;
        continue;
      }
      depth--;
    }
    else if (/^\s*:{2,}[a-z]/i.test(line)) depth++;
    current.lines.push(line);
  }

  return blocks;
}

function rawPageUrl(docsRoot: string, absolutePath: string) {
  const path = relative(resolve(docsRoot, "content"), absolutePath).replace(/\\/g, "/").replace(/(?:\/index)?\.md$/, "");
  return rawMarkdownUrl(`/${path}`, siteOrigin);
}

/** Skill references built from `::agent-only{skill="..."}` blocks, so the skill and the docs page share one source. */
export function createSkillReferences(docsRoot: string): SkillReference[] {
  const references: SkillReference[] = [];
  for (const absolutePath of listMarkdown(resolve(docsRoot, "content/docs"))) {
    const source = readFileSync(absolutePath, "utf8");
    const title = frontmatterTitle(source);
    for (const block of skillBlocks(source)) {
      const body = toRawMarkdown(block.content).replace(
        /\]\((https:\/\/vitehub\.dev\/[^)\s]+)\)/g,
        (_match, href: string) => `](${rawMarkdownUrl(href, siteOrigin)})`,
      );
      const sourcePath = relative(docsRoot, absolutePath).replace(/\\/g, "/");
      references.push({
        name: block.name,
        source: sourcePath,
        markdown: [
          `# ${block.title || title || block.name}`,
          `<!-- Generated from docs/${sourcePath}. Edit the agent-only block there. -->`,
          `Source page: ${rawPageUrl(docsRoot, absolutePath)}`,
          body.trim(),
        ].join("\n\n") + "\n",
      });
    }
  }
  return references.sort((a, b) => a.name.localeCompare(b.name));
}
