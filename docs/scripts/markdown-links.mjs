import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, extname, join, relative, resolve, sep } from "node:path";
import remarkGfm from "remark-gfm";
import remarkMdc from "remark-mdc";
import remarkParse from "remark-parse";
import { unified } from "unified";

const siteOrigin = "https://vitehub.dev";
const contentCollectionPrefixes = new Map([
  ["blog", "blog"],
  ["docs", "docs"],
  ["trust", ""],
]);

function walk(directory, predicate) {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name))
    .flatMap((entry) => {
      const path = join(directory, entry.name);
      return entry.isDirectory() ? walk(path, predicate) : predicate(path) ? [path] : [];
    });
}

function parseMarkdown(markdown) {
  const parser = unified().use(remarkParse).use(remarkGfm).use(remarkMdc);
  return parser.runSync(parser.parse(markdown));
}

function visit(node, callback) {
  callback(node);
  for (const child of node.children ?? []) visit(child, callback);
}

function nodeText(node) {
  if (typeof node.value === "string") return node.value;
  if (node.type === "image") return node.alt ?? "";
  return (node.children ?? []).map(nodeText).join("");
}

function rawMarkdownSlug(value) {
  return value
    .toLowerCase()
    .trim()
    .replace(/<[^>]+>/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/[^\p{L}\p{N}\p{M} _-]/gu, "")
    .replace(/ /g, "-");
}

function markdownSlug(value) {
  return value
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .replace(/^(\d)/, "_$1");
}

export function markdownAnchors(markdown) {
  const anchors = new Set();
  const occurrences = new Map();
  visit(parseMarkdown(markdown), (node) => {
    if (node.type !== "heading") return;
    const rawBase = rawMarkdownSlug(nodeText(node));
    if (!rawBase) return;
    let rawAnchor = rawBase;
    while (occurrences.has(rawAnchor)) {
      const count = (occurrences.get(rawBase) ?? 0) + 1;
      occurrences.set(rawBase, count);
      rawAnchor = `${rawBase}-${count}`;
    }
    const anchor = markdownSlug(rawAnchor);
    if (!anchor) return;
    anchors.add(anchor);
    occurrences.set(rawAnchor, 0);
  });
  return anchors;
}

export function markdownLinks(markdown) {
  const tree = parseMarkdown(markdown);
  const definitions = new Map();
  const links = [];
  visit(tree, (node) => {
    if (node.type === "definition") definitions.set(node.identifier, node.url);
  });
  visit(tree, (node) => {
    if (node.type === "link" || node.type === "image") links.push(node.url);
    if (node.type === "linkReference" || node.type === "imageReference") {
      const destination = definitions.get(node.identifier);
      if (destination) links.push(destination);
    }
    if (node.type === "containerComponent" || node.type === "leafComponent" || node.type === "textComponent") {
      const destination = node.fmAttributes?.to ?? node.attributes?.to;
      if (typeof destination === "string") links.push(destination);
    }
    if (node.type === "html" && !node.value.startsWith("<!--")) {
      for (const match of node.value.matchAll(/<(?:a\b[^>]*?\shref|img\b[^>]*?\ssrc)\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s>]+))/gi)) {
        links.push(match[1] ?? match[2] ?? match[3]);
      }
    }
  });
  const frontmatter = markdown.match(/^---\s*\n([\s\S]*?)\n---(?:\s*\n|$)/)?.[1];
  if (frontmatter) {
    for (const match of frontmatter.matchAll(/^\s*(?:image|src):\s*(?:"([^"]+)"|'([^']+)'|([^\s#]+))/gmi)) {
      links.push(match[1] ?? match[2] ?? match[3]);
    }
  }
  return links;
}

function routeFromContentPath(contentRoot, path) {
  const parts = relative(contentRoot, path).split(sep);
  const collection = parts.shift();
  if (!contentCollectionPrefixes.has(collection)) return undefined;
  const clean = parts.map((part) => part.replace(/^\d+\./, ""));
  clean[clean.length - 1] = clean.at(-1).replace(/\.md$/, "");
  if (clean.at(-1) === "index") clean.pop();
  const prefix = contentCollectionPrefixes.get(collection);
  return normalizeRoute(`/${[prefix, ...clean].filter(Boolean).join("/")}`);
}

function normalizeRoute(route) {
  const normalized = route.replace(/\/index$/, "").replace(/\/{2,}/g, "/");
  return normalized.length > 1 ? normalized.replace(/\/$/, "") : normalized;
}

function publicReadmes(repoRoot) {
  return walk(join(repoRoot, "packages"), (path) => path.endsWith(`${sep}package.json`))
    .filter((packageJson) => !JSON.parse(readFileSync(packageJson, "utf8")).private)
    .map((packageJson) => join(dirname(packageJson), "README.md"))
    .filter(existsSync);
}

function staticHtmlAnchors(source) {
  return new Set([...source.matchAll(/\sid\s*=\s*["']([^"']+)["']/g)].map((match) => match[1]));
}

function appRoutes(docsRoot) {
  const pagesRoot = join(docsRoot, "app/pages");
  const componentsRoot = join(docsRoot, "app/components");
  const componentFiles = walk(componentsRoot, (path) => path.endsWith(".vue"));
  const components = new Map(componentFiles.map((path) => {
    const name = relative(componentsRoot, path).replace(/\.vue$/, "").split(sep)
      .map((part) => part.replace(/(^|-)(\w)/g, (_, _separator, letter) => letter.toUpperCase())).join("");
    return [name, path];
  }));
  const routeAnchors = new Map(walk(pagesRoot, (path) => path.endsWith(".vue")).map((path) => {
    const route = relative(join(docsRoot, "app/pages"), path)
      .split(sep).join("/").replace(/\.vue$/, "").replace(/\/index$/, "").replace(/^index$/, "");
    const anchors = new Set();
    const pending = [path];
    const visited = new Set();
    while (pending.length) {
      const file = pending.pop();
      if (visited.has(file)) continue;
      visited.add(file);
      const source = readFileSync(file, "utf8");
      for (const anchor of staticHtmlAnchors(source)) anchors.add(anchor);
      for (const [name, componentPath] of components) {
        if (new RegExp(`<${name}(?:\\s|/|>)`).test(source)) pending.push(componentPath);
      }
    }
    return [normalizeRoute(`/${route}`), anchors];
  }));
  for (const path of walk(join(docsRoot, "server/routes"), (path) => path.endsWith(".ts"))) {
    routeAnchors.set(normalizeRoute(`/${relative(join(docsRoot, "server/routes"), path).split(sep).join("/").replace(/\.ts$/, "")}`), new Set());
  }
  for (const route of ["/llms.txt", "/llms-full.txt", "/mcp"]) routeAnchors.set(route, new Set());
  return routeAnchors;
}

function decodeFragment(fragment) {
  try {
    return decodeURIComponent(fragment);
  } catch {
    return fragment;
  }
}

function splitDestination(destination) {
  const hash = destination.indexOf("#");
  const fragment = hash === -1 ? "" : decodeFragment(destination.slice(hash + 1));
  const path = (hash === -1 ? destination : destination.slice(0, hash)).split("?")[0];
  return { fragment, path };
}

export function validateDocumentationLinks({ docsRoutes = [], repoRoot }) {
  const docsRoot = join(repoRoot, "docs");
  const contentRoot = join(docsRoot, "content");
  const publicRoot = join(docsRoot, "public");
  const contentFiles = walk(contentRoot, (path) => path.endsWith(".md"))
    .filter((path) => routeFromContentPath(contentRoot, path) !== undefined);
  const readmes = publicReadmes(repoRoot);
  const markdownFiles = [...contentFiles, ...readmes];
  const routeFiles = new Map(contentFiles.map((path) => [routeFromContentPath(contentRoot, path), path]));
  const applicationRoutes = appRoutes(docsRoot);
  const knownRoutes = new Set([...routeFiles.keys(), ...applicationRoutes.keys(), ...docsRoutes.map(normalizeRoute)]);
  for (const route of routeFiles.keys()) {
    if (route !== "/") knownRoutes.add(`/raw${route}.md`);
  }
  const anchors = new Map(markdownFiles.map((path) => [path, markdownAnchors(readFileSync(path, "utf8"))]));
  const errors = [];
  let checked = 0;

  for (const sourcePath of markdownFiles) {
    const source = readFileSync(sourcePath, "utf8");
    const sourceRoute = sourcePath.startsWith(`${contentRoot}${sep}`)
      ? routeFromContentPath(contentRoot, sourcePath)
      : undefined;
    for (const destination of markdownLinks(source)) {
      if (/^(?:mailto:|tel:|data:|javascript:)/i.test(destination)) continue;
      let local = destination;
      let isSiteLink = false;
      if (/^https?:\/\//i.test(destination)) {
        const url = new URL(destination);
        if (url.origin !== siteOrigin) continue;
        local = `${url.pathname}${url.search}${url.hash}`;
        isSiteLink = true;
      }
      if (/^[a-z][a-z\d+.-]*:/i.test(local) || local.startsWith("//")) continue;

      checked += 1;
      const { fragment, path } = splitDestination(local);
      let targetFile;
      let targetRoute;

      if (!path) {
        targetFile = sourcePath;
      } else if (sourceRoute !== undefined || isSiteLink) {
        const sourceIsIndex = /(?:^|[/\\])index\.md$/.test(sourcePath);
        const routeBase = sourceRoute === undefined
          ? "/"
          : sourceIsIndex ? sourceRoute : normalizeRoute(`${sourceRoute}/..`);
        targetRoute = path.startsWith("/")
          ? normalizeRoute(path)
          : normalizeRoute(new URL(path, `${siteOrigin}${routeBase.endsWith("/") ? routeBase : `${routeBase}/`}`).pathname);
        targetFile = routeFiles.get(targetRoute);
        if (!targetFile) {
          const publicFile = resolve(publicRoot, `.${targetRoute}`);
          if (publicFile.startsWith(`${publicRoot}${sep}`) && existsSync(publicFile) && statSync(publicFile).isFile()) {
            targetFile = publicFile;
          }
        }
        if (!targetFile && !knownRoutes.has(targetRoute)) {
          errors.push(`${relative(repoRoot, sourcePath)}: route ${JSON.stringify(targetRoute)} does not exist (${destination})`);
          continue;
        }
      } else if (path.startsWith("/")) {
        targetFile = resolve(repoRoot, `.${path}`);
        if (!existsSync(targetFile)) {
          errors.push(`${relative(repoRoot, sourcePath)}: repository path ${JSON.stringify(path)} does not exist`);
          continue;
        }
      } else {
        targetFile = resolve(dirname(sourcePath), path);
        if (!existsSync(targetFile)) {
          errors.push(`${relative(repoRoot, sourcePath)}: file ${JSON.stringify(path)} does not exist`);
          continue;
        }
      }

      if (fragment && targetFile) {
        const targetAnchors = anchors.get(targetFile)
          ?? (extname(targetFile) === ".md" ? markdownAnchors(readFileSync(targetFile, "utf8")) : undefined);
        if (targetAnchors && !targetAnchors.has(fragment)) {
          errors.push(`${relative(repoRoot, sourcePath)}: anchor #${fragment} does not exist in ${relative(repoRoot, targetFile)}`);
        }
      } else if (fragment && targetRoute) {
        const routeAnchors = applicationRoutes.get(targetRoute);
        if (!routeAnchors?.has(fragment)) {
          errors.push(`${relative(repoRoot, sourcePath)}: anchor #${fragment} does not exist for route ${JSON.stringify(targetRoute)}`);
        }
      }
    }
  }

  return { checked, errors, files: markdownFiles.length };
}
