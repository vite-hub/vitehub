import {
  createFwVariant,
  getFwVariantIdFromProps,
  getFwVariantsFromProps,
  matchesFwVariant,
  type UsageMode,
} from "./fw-variants";
import { frameworkPattern, type Framework } from "./frameworks";

export type NodeProps = Record<string, unknown>;
export type ContentNode = string | [string, NodeProps?, ...ContentNode[]];

export type TocLink = { id: string; depth: number; text: string; children?: TocLink[] };
export type BodyToc = { depth?: number; links?: TocLink[]; searchDepth?: number; title?: string; [key: string]: unknown };
export type PageBody = { toc?: BodyToc; value?: ContentNode[]; [key: string]: unknown };
export type NormalizedPage = { path: string; body: PageBody | null; [key: string]: unknown };
export type DocsRenderOptions = { framework: Framework; mode: UsageMode; renderMode: "single" | "all"; tocMode: "current-selection" };

// --- Tuple helpers ---

function isTuple(node: ContentNode): node is [string, NodeProps?, ...ContentNode[]] {
  return Array.isArray(node) && typeof node[0] === "string";
}

function hasProps(node: [string, NodeProps?, ...ContentNode[]]) {
  const props = node[1];
  return Boolean(props && typeof props === "object" && !Array.isArray(props));
}

function getTag(node: ContentNode) { return isTuple(node) ? node[0] : ""; }

function getProps(node: ContentNode): NodeProps {
  if (!isTuple(node) || !hasProps(node)) return {};
  return node[1] || {};
}

function getChildren(node: ContentNode): ContentNode[] {
  if (!isTuple(node)) return [];
  return (hasProps(node) ? node.slice(2) : node.slice(1)) as ContentNode[];
}

function withChildren(node: ContentNode, children: ContentNode[]): ContentNode {
  if (!isTuple(node)) return node;
  const [tag] = node;
  return (hasProps(node) ? [tag, node[1], ...children] : [tag, ...children]) as ContentNode;
}

// --- Node operations ---

function extractText(nodes: ContentNode[]): string {
  return nodes
    .map(node => typeof node === "string" ? node : isTuple(node) ? extractText(getChildren(node)) : "")
    .join("").replace(/\s+/g, " ").trim();
}

function flushGroup(buffer: ContentNode[], output: ContentNode[]) {
  if (buffer.length >= 2) {
    const items = buffer
      .filter(node => isTuple(node))
      .map((node) => {
        const id = getFwVariantIdFromProps(getProps(node));
        return id ? { id } : null;
      })
      .filter(Boolean) as Array<{ id: string }>;
    output.push(["fw-group", { items }, ...buffer] as ContentNode);
    return;
  }
  if (buffer.length === 1) output.push(buffer[0] as ContentNode);
}

function groupNodes(nodes: ContentNode[]) {
  const grouped: ContentNode[] = [];
  const buffer: ContentNode[] = [];

  for (const node of nodes) {
    if (typeof node === "string") {
      if (buffer.length > 0 && node.trim() === "") continue;
      flushGroup(buffer, grouped);
      buffer.length = 0;
      grouped.push(node);
      continue;
    }
    if (isTuple(node) && getTag(node) === "fw") {
      buffer.push(node);
      continue;
    }
    flushGroup(buffer, grouped);
    buffer.length = 0;
    grouped.push(node);
  }

  flushGroup(buffer, grouped);
  return grouped;
}

function normalizeNodes(nodes: ContentNode[], options: Pick<DocsRenderOptions, "framework" | "mode" | "renderMode">): ContentNode[] {
  const normalized: ContentNode[] = [];
  const currentVariant = createFwVariant(options.framework, options.mode);

  for (const node of nodes) {
    if (typeof node === "string") { normalized.push(node); continue; }
    if (!isTuple(node)) continue;

    const children = normalizeNodes(getChildren(node), options);

    if (getTag(node) === "fw") {
      const variants = getFwVariantsFromProps(getProps(node));
      if (options.renderMode === "single" && !matchesFwVariant(variants, currentVariant)) continue;
    }

    normalized.push(withChildren(node, children));
  }

  return options.renderMode === "all" ? groupNodes(normalized) : normalized;
}

function collectHeadings(nodes: ContentNode[], headings: TocLink[] = []) {
  for (const node of nodes) {
    if (!isTuple(node)) continue;
    const tag = getTag(node);
    const props = getProps(node);
    const headingId = typeof props.id === "string" ? props.id : null;

    if (/^h[2-6]$/.test(tag) && headingId) {
      headings.push({ id: headingId, depth: Number(tag.slice(1)), text: extractText(getChildren(node)) });
      continue;
    }
    collectHeadings(getChildren(node), headings);
  }
  return headings;
}

function buildTocTree(headings: TocLink[]) {
  const roots: TocLink[] = [];
  const stack: TocLink[] = [];

  for (const heading of headings) {
    const link: TocLink = { id: heading.id, depth: heading.depth, text: heading.text };

    while (stack.length) {
      const current = stack[stack.length - 1];
      if (!current || current.depth < link.depth) break;
      stack.pop();
    }

    if (stack.length) {
      const parent = stack[stack.length - 1]!;
      parent.children ||= [];
      parent.children.push(link);
    } else {
      roots.push(link);
    }

    stack.push(link);
  }

  return roots;
}

// --- Public API ---

export function getFrameworkFromContentPath(path: string): Framework | null {
  const match = path.match(new RegExp(`^/docs/(${frameworkPattern})(?:/|$)`));
  return (match?.[1] as Framework | undefined) || null;
}

export function normalizeFrameworkPage(page: NormalizedPage | null, options?: DocsRenderOptions) {
  if (!page || !options || !page.body || !Array.isArray(page.body.value)) return page;

  const value = normalizeNodes(page.body.value, options);
  const tocNodes = options.tocMode === "current-selection"
    ? normalizeNodes(page.body.value, { ...options, renderMode: "single" })
    : value;

  return {
    ...page,
    body: {
      ...page.body,
      value,
      toc: page.body.toc
        ? { ...page.body.toc, links: buildTocTree(collectHeadings(tocNodes)) }
        : page.body.toc,
    },
  };
}
