import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, posix, relative, resolve, sep } from "node:path";

import { ELEMENT_NODE, parse, walkSync } from "ultrahtml";

export interface DocsLinkCheckOptions {
  dir: string;
  siteUrl: string;
  appBase?: string;
  excludeLinks?: Array<string | RegExp>;
  /** Public page paths that are embedded documents rather than standalone pages. */
  excludePages?: Array<string | RegExp>;
  /** Pages whose fragment holds application state rather than an element id. */
  ignoreFragments?: Array<string | RegExp>;
  /** Accept missing output files for known server routes. Built files still have their fragments checked. */
  isRuntimePath?: (pathname: string) => boolean;
  /** Application redirects that the route rules cannot describe, such as legacy host redirects. */
  redirect?: (url: URL) => string | undefined;
}

export class DocsLinkError extends Error {
  readonly problems: string[];

  constructor(problems: string[]) {
    super(`Broken docs links:\n${problems.map((problem) => `- ${problem}`).join("\n")}`);
    this.name = "DocsLinkError";
    this.problems = problems;
  }
}

/**
 * Tests a value against paths, globs, and regular expressions. A site passes one path per page, and a large site checks
 * thousands of links against them, so a plain path is a set lookup and only a pattern with glob characters, extglobs
 * such as `@(a|b)` included, is a glob.
 */
function matcher(patterns: Array<string | RegExp> | undefined): (value: string) => boolean {
  const paths = new Set<string>();
  const tests: Array<(value: string) => boolean> = [];
  for (const pattern of patterns ?? []) {
    if (typeof pattern !== "string")
      tests.push((value) => {
        pattern.lastIndex = 0;
        return pattern.test(value);
      });
    else {
      paths.add(pattern);
      if (/[*?[\]{}(]/.test(pattern)) tests.push((value) => posix.matchesGlob(value, pattern));
    }
  }
  return (value) => paths.has(value) || tests.some((test) => test(value));
}

/** Check built HTML against the files and fragment ids in the same output, without fetching remote URLs. */
export function checkDocsLinks(options: DocsLinkCheckOptions): { pages: number } {
  const root = resolve(options.dir);
  if (!existsSync(root)) throw new Error(`Docs output does not exist: ${root}`);
  const origin = new URL(options.siteUrl).origin;
  const appBase = `/${(options.appBase ?? "/").replace(/^\/+|\/+$/g, "")}`.replace(/\/$/, "");
  const excludedPage = matcher(options.excludePages);
  const excludedLink = matcher(options.excludeLinks);
  const ignoredFragment = matcher(options.ignoreFragments);
  const cache = new Map<string, { ids: Set<string>; links: string[]; base?: string }>();
  const document = (file: string) => {
    const cached = cache.get(file);
    if (cached) return cached;
    const result: { ids: Set<string>; links: string[]; base?: string } = {
      ids: new Set(),
      links: [],
    };
    walkSync(parse(readFileSync(file, "utf8")), (node) => {
      if (node.type !== ELEMENT_NODE) return;
      for (const key of ["id", "name"])
        if (node.attributes[key]) result.ids.add(decode(node.attributes[key]));
      if (node.name === "base" && node.attributes.href && !result.base)
        result.base = decode(node.attributes.href);
      if (node.name !== "base" && node.attributes.href)
        result.links.push(decode(node.attributes.href));
      if (
        /^(audio|embed|iframe|img|input|script|source|track|video)$/.test(node.name) &&
        node.attributes.src
      )
        result.links.push(decode(node.attributes.src));
    });
    cache.set(file, result);
    return result;
  };
  const fileOf = (pathname: string) => {
    if (appBase && pathname !== appBase && !pathname.startsWith(`${appBase}/`)) return;
    let path: string;
    try {
      path = decodeURIComponent(pathname.slice(appBase.length));
    } catch {
      return;
    }
    const page = path.replace(/\/$/, "");
    return [path, `${page}.html`, `${page}/index.html`]
      .map((candidate) =>
        resolve(root, `.${candidate.startsWith("/") ? candidate : `/${candidate}`}`),
      )
      .find(
        (file) => file.startsWith(`${root}${sep}`) && existsSync(file) && statSync(file).isFile(),
      );
  };
  const files = readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".html"))
    .map((entry) => join(entry.parentPath, entry.name));
  const problems = new Set<string>();
  let pages = 0;
  for (const file of files) {
    const path = `${appBase}/${relative(root, file).replaceAll("\\", "/")}`
      .replace(/\/index\.html$/, "/")
      .replace(/\.html$/, "");
    if (excludedPage(path)) continue;
    pages++;
    const page = document(file);
    const pageUrl = new URL(path, origin);
    const base = page.base ? new URL(page.base, pageUrl) : pageUrl;
    for (const link of page.links) {
      let url: URL;
      try {
        url = new URL(link, base);
      } catch {
        problems.add(`${path} has an invalid URL: ${link}`);
        continue;
      }
      if (
        url.origin !== origin ||
        excludedLink(link) ||
        excludedLink(url.pathname) ||
        excludedLink(url.pathname + url.hash)
      )
        continue;
      const redirect = options.redirect?.(url);
      if (redirect) {
        problems.add(`${path} links to ${url.pathname}${url.hash}, which redirects to ${redirect}`);
        continue;
      }
      const target = fileOf(url.pathname);
      if (!target) {
        if (options.isRuntimePath?.(url.pathname)) continue;
        problems.add(`${path} links to ${url.pathname}, which has no page or file`);
        continue;
      }
      if (
        url.hash.length <= 1 ||
        !target.endsWith(".html") ||
        ignoredFragment(url.pathname)
      )
        continue;
      let id: string;
      try {
        id = decodeURIComponent(url.hash.slice(1));
      } catch {
        problems.add(`${path} has an invalid fragment: ${link}`);
        continue;
      }
      if (!document(target).ids.has(id))
        problems.add(
          `${path} links to ${url.pathname}${url.hash}, but that page has no element with id "${id}"`,
        );
    }
  }
  if (problems.size) throw new DocsLinkError([...problems].sort());
  return { pages };
}

function decode(text: string): string {
  const named: Record<string, string> = {
    amp: "&",
    quot: '"',
    apos: "'",
    lt: "<",
    gt: ">",
    nbsp: "\u00a0",
  };
  return text.replace(/&(#x[\da-f]+|#\d+|amp|quot|apos|lt|gt|nbsp);/gi, (entity, code: string) => {
    if (!code.startsWith("#")) return named[code.toLowerCase()] ?? entity;
    const value =
      code[1]?.toLowerCase() === "x" ? Number.parseInt(code.slice(2), 16) : Number(code.slice(1));
    return value > 0 && value <= 0x10ffff ? String.fromCodePoint(value) : "\ufffd";
  });
}
