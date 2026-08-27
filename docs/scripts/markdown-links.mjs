import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, extname, join, relative, resolve, sep } from "node:path";
import GithubSlugger from "github-slugger";
import remarkGfm from "remark-gfm";
import remarkMdc from "remark-mdc";
import remarkParse from "remark-parse";
import { unified } from "unified";
import { parse as parseYaml } from "yaml";

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
  if (node.type === "html") return node.value.replace(/<[^>]*>/g, "");
  if (node.value?.constructor === String) return node.value;
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

function htmlAttribute(tag, attributeName) {
  const attributes = tag.slice(tag.search(/\s/));
  for (const match of attributes.matchAll(/\s+([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g)) {
    if (match[1].toLowerCase() === attributeName) return match[2] ?? match[3] ?? match[4];
  }
  return undefined;
}

function frontmatterLinks(frontmatter) {
  const value = parseYaml(frontmatter);
  if (value?.constructor !== Object) return [];
  const links = [];
  if (value.image?.constructor === String) links.push(value.image);
  for (const link of value.links ?? []) {
    if (link?.to?.constructor === String) links.push(link.to);
  }
  for (const author of value.authors ?? []) {
    if (author?.avatar?.src?.constructor === String) links.push(author.avatar.src);
    if (author?.to?.constructor === String) links.push(author.to);
  }
  return links;
}

function splitFrontmatter(markdown) {
  const match = markdown.match(/^---\s*\n([\s\S]*?)\n---(?:\s*\n|$)/);
  return match
    ? { body: markdown.slice(match[0].length), frontmatter: match[1] }
    : { body: markdown, frontmatter: undefined };
}

export function markdownAnchors(markdown, { renderer = "mdc" } = {}) {
  const anchors = new Set();
  const occurrences = new Map();
  const githubSlugger = new GithubSlugger();
  const { body } = splitFrontmatter(markdown);
  visit(parseMarkdown(body), (node) => {
    if (node.type !== "heading") return;
    if (renderer === "github") {
      const anchor = githubSlugger.slug(nodeText(node));
      if (anchor) anchors.add(anchor);
      return;
    }
    const rawBase = rawMarkdownSlug(nodeText(node));
    if (!rawBase) return;
    const base = markdownSlug(rawBase);
    if (!base) return;
    let anchor = base;
    while (occurrences.has(anchor)) {
      const count = (occurrences.get(base) ?? 0) + 1;
      occurrences.set(base, count);
      anchor = `${base}-${count}`;
    }
    anchors.add(anchor);
    occurrences.set(anchor, 0);
  });
  return anchors;
}

export function markdownLinks(markdown) {
  const { body, frontmatter } = splitFrontmatter(markdown);
  const tree = parseMarkdown(body);
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
      if (destination?.constructor === String) links.push(destination);
    }
    if (node.type === "html" && !node.value.startsWith("<!--")) {
      for (const match of node.value.matchAll(/<(a|img)\b(?:"[^"]*"|'[^']*'|[^'">])*>/gi)) {
        const destination = htmlAttribute(match[0], match[1].toLowerCase() === "a" ? "href" : "src");
        if (destination) links.push(destination);
      }
    }
  });
  if (frontmatter) links.push(...frontmatterLinks(frontmatter));
  return links;
}

function routeFromContentPath(contentRoot, path) {
  const parts = relative(contentRoot, path).split(sep);
  const collection = parts.shift();
  if (!contentCollectionPrefixes.has(collection)) return undefined;
  const clean = collection === "docs" ? parts : parts.map((part) => part.replace(/^\d+\./, ""));
  clean[clean.length - 1] = clean.at(-1).replace(/\.md$/, "");
  if (clean.at(-1) === "index") clean.pop();
  const prefix = contentCollectionPrefixes.get(collection);
  return normalizeRoute(`/${[prefix, ...clean].filter(Boolean).join("/")}`);
}

function normalizeRoute(route) {
  const normalized = route.replace(/\/{2,}/g, "/");
  return normalized.length > 1 ? normalized.replace(/\/$/, "") : normalized;
}

function publicReadmes(repoRoot) {
  const packageReadmes = walk(join(repoRoot, "packages"), (path) => path.endsWith(`${sep}package.json`))
    .filter((packageJson) => !JSON.parse(readFileSync(packageJson, "utf8")).private)
    .map((packageJson) => join(dirname(packageJson), "README.md"))
    .filter(existsSync);
  return [join(repoRoot, "README.md"), ...packageReadmes].filter(existsSync);
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
  const anchors = new Map(markdownFiles.map((path) => [
    path,
    markdownAnchors(readFileSync(path, "utf8"), {
      renderer: path.startsWith(`${contentRoot}${sep}`) ? "mdc" : "github",
    }),
  ]));
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
      if (/^(?:https?:)?\/\//i.test(destination)) {
        const url = new URL(destination, siteOrigin);
        if (url.origin !== siteOrigin) continue;
        local = `${url.pathname}${url.search}${url.hash}`;
        isSiteLink = true;
      }
      if (/^[a-z][a-z\d+.-]*:/i.test(local)) continue;

      checked += 1;
      const { fragment, path } = splitDestination(local);
      let targetFile;
      let targetRoute;

      if (!path) {
        targetFile = sourcePath;
      } else if (sourceRoute !== undefined || isSiteLink) {
        targetRoute = path.startsWith("/")
          ? normalizeRoute(path)
          : normalizeRoute(new URL(path, `${siteOrigin}${sourceRoute ?? "/"}`).pathname);
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
