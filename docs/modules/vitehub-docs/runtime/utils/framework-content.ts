import {
  createFwVariant,
  getFwVariantIdFromProps,
  getFwVariantsFromProps,
  matchesFwVariant,
  type UsageMode,
} from "./fw-variants";
import type { MDCComment, MDCElement, MDCNode, MDCRoot, MDCText } from "@nuxtjs/mdc";
import { frameworkPattern, type Framework } from "./frameworks";

export type NodeProps = Record<string, unknown>;
export type ContentNode = string | [string, NodeProps?, ...ContentNode[]];
export type AstTextNode = MDCText;
export type AstCommentNode = MDCComment;
export type AstElementNode = MDCElement;
export type AstNode = MDCNode;
export type MdcAstTextNode = MDCText;
export type MdcAstCommentNode = MDCComment;
export type MdcAstElementNode = MDCElement;
export type MdcAstNode = MDCNode;
export type FrameworkGroupBody = MDCRoot;

export type TocLink = { id: string; depth: number; text: string; children?: TocLink[] };
export type BodyToc = { depth?: number; links?: TocLink[]; searchDepth?: number; title?: string; [key: string]: unknown };
export type PageBody = { toc?: BodyToc; type: "root"; value?: ContentNode[]; children?: MdcAstNode[]; [key: string]: unknown };
export type NormalizedPage = { path: string; body: PageBody | null; [key: string]: unknown };
export type DocsRenderOptions = { framework: Framework; mode: UsageMode; renderMode: "single" | "all"; tocMode: "current-selection" };

// --- Generic node accessor interface ---

type NodeAccessor<N> = {
  isText(node: N): boolean;
  isElement(node: N): boolean;
  getText(node: N): string;
  getTag(node: N): string;
  getProps(node: N): NodeProps;
  getChildren(node: N): N[];
  withChildren(node: N, children: N[]): N;
  createGroup(items: Array<{ id: string; body?: unknown }>, buffer: N[]): N;
};

// --- ContentNode (tuple) accessor ---

function isNodeTuple(node: ContentNode): node is [string, NodeProps?, ...ContentNode[]] {
  return Array.isArray(node) && typeof node[0] === "string";
}

function hasNodeProps(node: [string, NodeProps?, ...ContentNode[]]) {
  const props = node[1];
  return Boolean(props && typeof props === "object" && !Array.isArray(props));
}

const tupleAccessor: NodeAccessor<ContentNode> = {
  isText: (node) => typeof node === "string",
  isElement: (node) => isNodeTuple(node),
  getText: (node) => typeof node === "string" ? node : "",
  getTag: (node) => isNodeTuple(node) ? node[0] : "",
  getProps(node) {
    if (!isNodeTuple(node) || !hasNodeProps(node)) return {};
    return node[1] || {};
  },
  getChildren(node) {
    if (!isNodeTuple(node)) return [];
    return (hasNodeProps(node) ? node.slice(2) : node.slice(1)) as ContentNode[];
  },
  withChildren(node, children) {
    if (!isNodeTuple(node)) return node;
    const [tag] = node;
    return (hasNodeProps(node) ? [tag, node[1], ...children] : [tag, ...children]) as ContentNode;
  },
  createGroup(items, buffer) {
    return [
      "fw-group",
      {
        items: items
          .filter((item): item is { id: string } => Boolean(item?.id)),
      },
      ...buffer,
    ] as ContentNode;
  },
};

// --- AstNode accessor ---

function isAstElement(node: unknown): node is AstElementNode {
  return Boolean(node) && typeof node === "object" && !Array.isArray(node)
    && (node as AstElementNode).type === "element"
    && typeof (node as AstElementNode).tag === "string";
}

function isAstText(node: unknown): node is AstTextNode {
  return Boolean(node) && typeof node === "object" && !Array.isArray(node)
    && (node as AstTextNode).type === "text"
    && typeof (node as AstTextNode).value === "string";
}

function toMdcAstNode(node: AstNode): MdcAstNode {
  if (isAstText(node) || node.type === "comment") {
    return node;
  }

  return {
    ...node,
    props: node.props || {},
    children: node.children?.map(toMdcAstNode) || [],
  };
}

export function toFrameworkGroupBody(children: AstNode[]): FrameworkGroupBody {
  return {
    type: "root",
    children: children.map(toMdcAstNode),
  };
}

export function toMdcRootBody(body: Omit<PageBody, "children"> & { children?: AstNode[] | MdcAstNode[] }): PageBody {
  const children = body.children?.map(node => toMdcAstNode(node as AstNode));

  if (children) {
    return { ...body, type: "root", children };
  }

  return { ...body } as PageBody;
}

const astAccessor: NodeAccessor<AstNode> = {
  isText: (node) => isAstText(node),
  isElement: (node) => isAstElement(node),
  getText: (node) => isAstText(node) ? node.value : "",
  getTag: (node) => isAstElement(node) ? node.tag : "",
  getProps: (node) => isAstElement(node) ? (node.props || {}) : {},
  getChildren: (node) => isAstElement(node) ? (node.children || []) : [],
  withChildren(node, children) {
    if (!isAstElement(node)) return node;
    return { ...node, props: node.props || {}, children };
  },
  createGroup(items, _buffer) {
    return {
      type: "element",
      tag: "fw-group",
      props: {
        items: items
          .filter((item): item is { id: string; body: FrameworkGroupBody } => Boolean(item?.id)),
      },
      children: [],
    } as AstNode;
  },
};

// --- Generic implementations ---

function extractText<N>(nodes: N[], acc: NodeAccessor<N>): string {
  return nodes
    .map(node => acc.isText(node) ? acc.getText(node) : acc.isElement(node) ? extractText(acc.getChildren(node), acc) : "")
    .join("").replace(/\s+/g, " ").trim();
}

function flushGroup<N>(buffer: N[], output: N[], acc: NodeAccessor<N>) {
  if (buffer.length >= 2) {
    const items = buffer
      .filter(node => acc.isElement(node))
      .map((node) => {
        const id = getFwVariantIdFromProps(acc.getProps(node));
        if (!id) return null;
        // For AST nodes, include body for MDCRenderer
        if (acc === astAccessor as unknown) {
          return { id, body: toFrameworkGroupBody(acc.getChildren(node) as AstNode[]) };
        }
        return { id };
      })
      .filter(Boolean) as Array<{ id: string; body?: unknown }>;
    output.push(acc.createGroup(items, buffer));
    return;
  }
  if (buffer.length === 1) output.push(buffer[0] as N);
}

function groupNodes<N>(nodes: N[], acc: NodeAccessor<N>) {
  const grouped: N[] = [];
  const buffer: N[] = [];

  for (const node of nodes) {
    if (acc.isText(node)) {
      if (buffer.length > 0 && acc.getText(node).trim() === "") continue;
      flushGroup(buffer, grouped, acc);
      buffer.length = 0;
      grouped.push(node);
      continue;
    }
    if (acc.isElement(node) && acc.getTag(node) === "fw") {
      buffer.push(node);
      continue;
    }
    flushGroup(buffer, grouped, acc);
    buffer.length = 0;
    grouped.push(node);
  }

  flushGroup(buffer, grouped, acc);
  return grouped;
}

function normalizeNodes<N>(nodes: N[], options: Pick<DocsRenderOptions, "framework" | "mode" | "renderMode">, acc: NodeAccessor<N>): N[] {
  const normalized: N[] = [];
  const currentVariant = createFwVariant(options.framework, options.mode);

  for (const node of nodes) {
    if (acc.isText(node)) { normalized.push(node); continue; }
    if (!acc.isElement(node)) continue;

    const children = normalizeNodes(acc.getChildren(node), options, acc);

    if (acc.getTag(node) === "fw") {
      const variants = getFwVariantsFromProps(acc.getProps(node));
      if (options.renderMode === "single" && !matchesFwVariant(variants, currentVariant)) continue;
    }

    normalized.push(acc.withChildren(node, children));
  }

  return options.renderMode === "all" ? groupNodes(normalized, acc) : normalized;
}

function collectHeadings<N>(nodes: N[], acc: NodeAccessor<N>, headings: TocLink[] = []) {
  for (const node of nodes) {
    if (!acc.isElement(node)) continue;
    const tag = acc.getTag(node);
    const props = acc.getProps(node);
    const headingId = typeof props.id === "string" ? props.id : null;

    if (/^h[2-6]$/.test(tag) && headingId) {
      headings.push({ id: headingId, depth: Number(tag.slice(1)), text: extractText(acc.getChildren(node), acc) });
      continue;
    }
    collectHeadings(acc.getChildren(node), acc, headings);
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
  if (!page || !options || !page.body) return page;

  if (Array.isArray(page.body.value)) {
    const value = normalizeNodes(page.body.value, options, tupleAccessor);
    const tocNodes = options.tocMode === "current-selection"
      ? normalizeNodes(page.body.value, { ...options, renderMode: "single" }, tupleAccessor)
      : value;

    return {
      ...page,
      body: toMdcRootBody({
        ...page.body,
        value,
        toc: page.body.toc
          ? { ...page.body.toc, links: buildTocTree(collectHeadings(tocNodes, tupleAccessor)) }
          : page.body.toc,
      }),
    };
  }

  if (!Array.isArray(page.body.children)) return page;

  const children = normalizeNodes(page.body.children, options, astAccessor);
  const tocNodes = options.tocMode === "current-selection"
    ? normalizeNodes(page.body.children, { ...options, renderMode: "single" }, astAccessor)
    : children;

  return {
    ...page,
    body: toMdcRootBody({
      ...page.body,
      children,
      toc: page.body.toc
        ? { ...page.body.toc, links: buildTocTree(collectHeadings(tocNodes, astAccessor)) }
        : page.body.toc,
    }),
  };
}
