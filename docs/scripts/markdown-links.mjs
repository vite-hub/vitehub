import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, extname, join, relative, resolve, sep } from "node:path";
import GithubSlugger from "github-slugger";
import { decode } from "html-entities";
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

function parseMarkdown(markdown, { renderer = "mdc" } = {}) {
  const parser = unified().use(remarkParse).use(remarkGfm);
  if (renderer === "mdc") parser.use(remarkMdc);
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
    if (match[1].toLowerCase() === attributeName) {
      return decode(match[2] ?? match[3] ?? match[4] ?? "", { scope: "attribute" });
    }
  }
  return undefined;
}

function withoutHtmlComments(value) {
  return value.replace(/<!--[\s\S]*?-->/g, "");
}

function htmlTags(value) {
  return withoutHtmlComments(value).match(/<[a-z][^'">]*(?:"[^"]*"|'[^']*'|[^'">]*)*>/gi) ?? [];
}

function sourceSetLinks(value) {
  const asciiWhitespace = /[ \t\n\f\r]/;
  const links = [];
  let position = 0;
  while (position < value.length) {
    while (asciiWhitespace.test(value[position] ?? "") || value[position] === ",") position += 1;
    const start = position;
    while (position < value.length && !asciiWhitespace.test(value[position])) position += 1;
    let url = value.slice(start, position);
    const trailingCommas = url.match(/,+$/)?.[0].length ?? 0;
    if (trailingCommas) url = url.slice(0, -trailingCommas);
    if (url) links.push(url);
    if (trailingCommas) continue;
    let parentheses = 0;
    while (position < value.length) {
      const character = value[position++];
      if (character === "(") parentheses += 1;
      else if (character === ")") parentheses = Math.max(0, parentheses - 1);
      else if (character === "," && parentheses === 0) break;
    }
  }
  return links;
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
  visit(parseMarkdown(body, { renderer }), (node) => {
    if (renderer === "mdc" && node.type === "html") {
      for (const tag of htmlTags(node.value)) {
        const id = htmlAttribute(tag, "id");
        if (id) anchors.add(id);
        if (/^<a(?:\s|>)/i.test(tag)) {
          const name = htmlAttribute(tag, "name");
          if (name) anchors.add(name);
        }
      }
    }
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

export function markdownLinks(markdown, { renderer = "mdc" } = {}) {
  const { body, frontmatter } = splitFrontmatter(markdown);
  const tree = parseMarkdown(body, { renderer });
  const definitions = new Map();
  const links = [];
  visit(tree, (node) => {
    if (node.type === "definition" && !definitions.has(node.identifier)) definitions.set(node.identifier, node.url);
  });
  visit(tree, (node) => {
    if (node.type === "link" || node.type === "image") links.push(node.url);
    if (node.type === "linkReference" || node.type === "imageReference") {
      const destination = definitions.get(node.identifier);
      if (destination) links.push(destination);
    }
    if (node.type === "containerComponent" || node.type === "leafComponent" || node.type === "textComponent") {
      for (const attribute of ["to", "href", "src"]) {
        const destination = node.fmAttributes?.[attribute] ?? node.attributes?.[attribute];
        if (destination?.constructor === String) links.push(destination);
      }
    }
    if (node.type === "html") {
      const resourceAttributes = {
        a: ["href"],
        audio: ["src"],
        embed: ["src"],
        iframe: ["src"],
        img: ["src", "srcset"],
        input: ["src"],
        link: ["href"],
        object: ["data"],
        script: ["src"],
        source: ["src", "srcset"],
        track: ["src"],
        video: ["poster", "src"],
      };
      for (const rawTag of htmlTags(node.value)) {
        const tag = rawTag.match(/^<([a-z]+)/i)?.[1].toLowerCase();
        if (!tag) continue;
        for (const attribute of resourceAttributes[tag] ?? []) {
          const destination = htmlAttribute(rawTag, attribute);
          if (!destination) continue;
          if (attribute === "srcset") links.push(...sourceSetLinks(destination));
          else links.push(destination);
        }
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

function normalizeRenderedRoute(route) {
  return route.length > 1 ? route.replace(/\/+$/, "") || "/" : route;
}

function publicReadmes(repoRoot) {
  const packageReadmes = walk(join(repoRoot, "packages"), (path) => path.endsWith(`${sep}package.json`))
    .filter((packageJson) => !JSON.parse(readFileSync(packageJson, "utf8")).private)
    .map((packageJson) => join(dirname(packageJson), "README.md"))
    .filter(existsSync);
  return [join(repoRoot, "README.md"), ...packageReadmes].filter(existsSync);
}

function staticHtmlAnchors(source) {
  return new Set(htmlTags(source).map((tag) => htmlAttribute(tag, "id")).filter(Boolean));
}

function supportMatrixAnchors(docsRoot) {
  const path = join(docsRoot, "app/components/SupportMatrix.vue");
  if (!existsSync(path)) return undefined;
  const source = readFileSync(path, "utf8");
  const anchors = staticHtmlAnchors(source);
  for (const match of source.matchAll(/\banchor\s*:\s*["']([^"']+)["']/g)) anchors.add(match[1]);
  return anchors;
}

function isStaticApplicationRoute(route) {
  return !route.split("/").some((segment) => segment.includes("[") || segment.includes("]"));
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
  const routeAnchors = new Map(walk(pagesRoot, (path) => path.endsWith(".vue")).flatMap((path) => {
    const route = relative(join(docsRoot, "app/pages"), path)
      .split(sep).join("/").replace(/\.vue$/, "").replace(/\/index$/, "").replace(/^index$/, "");
    if (!isStaticApplicationRoute(route)) return [];
    const anchors = new Set();
    const pending = [path];
    const visited = new Set();
    while (pending.length) {
      const file = pending.pop();
      if (visited.has(file)) continue;
      visited.add(file);
      const source = readFileSync(file, "utf8");
      for (const anchor of staticHtmlAnchors(source)) anchors.add(anchor);
      const renderedSource = withoutHtmlComments(source);
      for (const [name, componentPath] of components) {
        if (new RegExp(`<${name}(?:\\s|/|>)`).test(renderedSource)) pending.push(componentPath);
      }
    }
    return [[normalizeRoute(`/${route}`), anchors]];
  }));
  for (const path of walk(join(docsRoot, "server/routes"), (path) => path.endsWith(".ts"))) {
    const route = relative(join(docsRoot, "server/routes"), path).split(sep).join("/").replace(/\.ts$/, "");
    if (isStaticApplicationRoute(route)) routeAnchors.set(normalizeRoute(`/${route}`), new Set());
  }
  for (const route of ["/llms.txt", "/llms-full.txt", "/mcp"]) routeAnchors.set(route, new Set());
  const matrixAnchors = supportMatrixAnchors(docsRoot);
  if (matrixAnchors) routeAnchors.set("/docs/frameworks-hosts/support-matrix", matrixAnchors);
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

export function docsManifestRoutes(manifest) {
  return [
    manifest.rootPage?.path,
    ...manifest.sections.flatMap((section) => section.pages.map((page) => page.path)),
  ].filter(Boolean);
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
  const anchors = new Map();
  function anchorsFor(path, renderer) {
    const key = `${renderer}:${path}`;
    if (!anchors.has(key)) anchors.set(key, markdownAnchors(readFileSync(path, "utf8"), { renderer }));
    return anchors.get(key);
  }
  const errors = [];
  let checked = 0;

  for (const sourcePath of markdownFiles) {
    const source = readFileSync(sourcePath, "utf8");
    const sourceRoute = sourcePath.startsWith(`${contentRoot}${sep}`)
      ? routeFromContentPath(contentRoot, sourcePath)
      : undefined;
    for (const destination of markdownLinks(source, {
      renderer: sourceRoute === undefined ? "github" : "mdc",
    })) {
      if (/^(?:mailto:|tel:|data:|javascript:)/i.test(destination)) continue;
      if (sourceRoute === undefined && /^\/(?!\/)/.test(destination)) continue;
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
        const renderedPath = path.startsWith("/")
          ? path
          : new URL(path, `${siteOrigin}${sourceRoute ?? "/"}`).pathname;
        targetRoute = normalizeRenderedRoute(renderedPath);
        targetFile = routeFiles.get(targetRoute);
        if (!targetFile && !renderedPath.endsWith("/")) {
          const publicFile = resolve(publicRoot, `.${renderedPath}`);
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
        const decodedPath = decodeFragment(path);
        targetFile = resolve(dirname(sourcePath), decodedPath);
        if (targetFile !== repoRoot && !targetFile.startsWith(`${repoRoot}${sep}`)) {
          errors.push(`${relative(repoRoot, sourcePath)}: file ${JSON.stringify(path)} is outside the repository`);
          continue;
        }
        if (!existsSync(targetFile)) {
          errors.push(`${relative(repoRoot, sourcePath)}: file ${JSON.stringify(path)} does not exist`);
          continue;
        }
      }

      if (fragment && targetFile) {
        if (statSync(targetFile).isDirectory()) {
          const readme = join(targetFile, "README.md");
          if (existsSync(readme)) targetFile = readme;
        }
        const targetRenderer = sourceRoute === undefined && !isSiteLink ? "github" : "mdc";
        const targetAnchors = targetRoute === "/docs/frameworks-hosts/support-matrix"
          ? applicationRoutes.get(targetRoute)
          : extname(targetFile) === ".md"
            ? anchorsFor(targetFile, targetRenderer)
            : targetRoute ? applicationRoutes.get(targetRoute) : undefined;
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
