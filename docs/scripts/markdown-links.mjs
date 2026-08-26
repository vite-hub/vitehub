import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, extname, join, relative, resolve, sep } from "node:path";

const siteOrigin = "https://vitehub.dev";

function walk(directory, predicate) {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name))
    .flatMap((entry) => {
      const path = join(directory, entry.name);
      return entry.isDirectory() ? walk(path, predicate) : predicate(path) ? [path] : [];
    });
}

function withoutFencedCode(markdown) {
  let fence;
  return markdown.split("\n").map((line) => {
    const delimiter = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (!fence && delimiter) {
      fence = delimiter;
      return "";
    }
    if (fence) {
      if (delimiter?.[0] === fence[0] && delimiter.length >= fence.length && /^\s*$/.test(line.slice(line.indexOf(delimiter) + delimiter.length))) {
        fence = undefined;
      }
      return "";
    }
    return line;
  }).join("\n");
}

function withoutCode(markdown) {
  const withoutFences = withoutFencedCode(markdown)
    .split("\n")
    .map((line) => /^(?: {4}|\t)/.test(line) ? "" : line)
    .join("\n");
  return withoutFences.split(/(\n[ \t]*\n)/).map((block, index) => {
    if (index % 2 === 1) return block;
    return withoutCodeSpans(block);
  }).join("");
}

function withoutCodeSpans(markdown) {
  let result = "";
  for (let index = 0; index < markdown.length;) {
    if (markdown[index] !== "`") {
      result += markdown[index];
      index += 1;
      continue;
    }
    const opener = /^`+/.exec(markdown.slice(index))[0];
    let closing = -1;
    for (let cursor = index + opener.length; cursor < markdown.length;) {
      const next = markdown.indexOf("`", cursor);
      if (next === -1) break;
      const delimiter = /^`+/.exec(markdown.slice(next))[0];
      if (delimiter.length === opener.length) {
        closing = next;
        break;
      }
      cursor = next + delimiter.length;
    }
    if (closing === -1) {
      result += opener;
      index += opener.length;
      continue;
    }
    index = closing + opener.length;
  }
  return result;
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
  const source = withoutFencedCode(markdown);
  for (const line of source.split("\n")) {
    const heading = /^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/.exec(line);
    if (!heading) continue;
    const rawBase = rawMarkdownSlug(heading[1]);
    if (!rawBase) continue;
    let rawAnchor = rawBase;
    while (occurrences.has(rawAnchor)) {
      const count = (occurrences.get(rawBase) ?? 0) + 1;
      occurrences.set(rawBase, count);
      rawAnchor = `${rawBase}-${count}`;
    }
    const anchor = markdownSlug(rawAnchor);
    if (!anchor) continue;
    anchors.add(anchor);
    occurrences.set(rawAnchor, 0);
  }
  return anchors;
}

export function markdownLinks(markdown) {
  const source = withoutCode(markdown);
  const definitions = new Map();
  for (const match of source.matchAll(/^\s{0,3}\[([^\]]+)\]:\s*<?([^\s>]+)>?/gm)) {
    definitions.set(match[1].trim().toLowerCase(), match[2]);
  }

  const links = [];
  for (const match of source.matchAll(/^\s*to:\s*(?:"([^"]+)"|'([^']+)'|([^#\s]\S*))/gm)) {
    links.push(match[1] ?? match[2] ?? match[3]);
  }
  for (const match of source.matchAll(/<a\s[^>]*\bhref\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s>]+))/gi)) {
    links.push(match[1] ?? match[2] ?? match[3]);
  }
  for (const match of source.matchAll(/<([a-z][a-z\d+.-]*:[^<>\s]+)>/gi)) {
    links.push(match[1]);
  }
  for (let index = 0; index < source.length; index += 1) {
    const bracket = source.indexOf("[", index);
    if (bracket === -1) break;
    const labelEnd = source.indexOf("]", bracket + 1);
    if (labelEnd === -1) break;
    const lineStart = source.lastIndexOf("\n", bracket - 1) + 1;
    if (/^\s{0,3}$/.test(source.slice(lineStart, bracket)) && source[labelEnd + 1] === ":") {
      index = labelEnd;
      continue;
    }
    if (source[labelEnd + 1] === "(") {
      let depth = 1;
      let cursor = labelEnd + 2;
      for (; cursor < source.length && depth > 0; cursor += 1) {
        if (source[cursor] === "\\") cursor += 1;
        else if (source[cursor] === "(") depth += 1;
        else if (source[cursor] === ")") depth -= 1;
      }
      if (depth === 0) {
        const raw = source.slice(labelEnd + 2, cursor - 1).trim();
        const destination = raw.startsWith("<")
          ? raw.slice(1, raw.indexOf(">"))
          : raw.split(/\s+["']/)[0];
        if (destination) links.push(destination);
        index = cursor - 1;
      }
      continue;
    }
    if (source[labelEnd + 1] === "[") {
      const referenceEnd = source.indexOf("]", labelEnd + 2);
      if (referenceEnd !== -1) {
        const key = source.slice(labelEnd + 2, referenceEnd).trim().toLowerCase()
          || source.slice(bracket + 1, labelEnd).trim().toLowerCase();
        const destination = definitions.get(key);
        if (destination) links.push(destination);
        index = referenceEnd;
      }
      continue;
    }
    const key = source.slice(bracket + 1, labelEnd).trim().toLowerCase();
    const destination = definitions.get(key);
    if (destination) links.push(destination);
    index = labelEnd;
  }
  return links;
}

function routeFromContentPath(contentRoot, path) {
  const parts = relative(contentRoot, path).split(sep);
  if (parts.length === 1) return "/";
  const collection = parts.shift();
  const clean = parts.map((part) => part.replace(/^\d+\./, ""));
  clean[clean.length - 1] = clean.at(-1).replace(/\.md$/, "");
  if (clean.at(-1) === "index") clean.pop();
  const prefix = collection === "trust" ? "" : collection;
  return normalizeRoute(`/${[prefix, ...clean].filter(Boolean).join("/")}`);
}

function normalizeRoute(route) {
  const normalized = route.replace(/\.md$/, "").replace(/\/index$/, "").replace(/\/{2,}/g, "/");
  return normalized.length > 1 ? normalized.replace(/\/$/, "") : normalized;
}

function publicReadmes(repoRoot) {
  return walk(join(repoRoot, "packages"), (path) => path.endsWith(`${sep}package.json`))
    .filter((packageJson) => !JSON.parse(readFileSync(packageJson, "utf8")).private)
    .map((packageJson) => join(dirname(packageJson), "README.md"))
    .filter(existsSync);
}

function appRoutes(docsRoot) {
  const routes = new Set(walk(join(docsRoot, "app/pages"), (path) => path.endsWith(".vue")).map((path) => {
    const route = relative(join(docsRoot, "app/pages"), path)
      .split(sep).join("/").replace(/\.vue$/, "").replace(/\/index$/, "").replace(/^index$/, "");
    return normalizeRoute(`/${route}`);
  }));
  for (const path of walk(join(docsRoot, "server/routes"), (path) => path.endsWith(".ts"))) {
    routes.add(normalizeRoute(`/${relative(join(docsRoot, "server/routes"), path).split(sep).join("/").replace(/\.ts$/, "")}`));
  }
  for (const route of ["/llms.txt", "/llms-full.txt", "/mcp"]) routes.add(route);
  return routes;
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
  const contentFiles = walk(contentRoot, (path) => path.endsWith(".md"));
  const readmes = publicReadmes(repoRoot);
  const markdownFiles = [...contentFiles, ...readmes];
  const routeFiles = new Map(contentFiles.map((path) => [routeFromContentPath(contentRoot, path), path]));
  const knownRoutes = new Set([...routeFiles.keys(), ...appRoutes(docsRoot), ...docsRoutes.map(normalizeRoute)]);
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
        if (!targetFile && path.startsWith("/")) {
          const publicFile = resolve(publicRoot, `.${path}`);
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
      }
    }
  }

  return { checked, errors, files: markdownFiles.length };
}
