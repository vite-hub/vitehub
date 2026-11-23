/** The files that the Console serves for apps of one ViteHub version: the public skills and the page tools pill parts. */
export interface ConsoleAssets {
  /** The page tools pill parts, by file name, such as `page-tool.js` and `account.js`, with a hash of each content. */
  page: Record<string, { hash: string, source: string }>
  /** The skills below `.well-known/skills`, by path, such as `index.json` and `vitehub/SKILL.md`. */
  skills: Record<string, string>
  /** The version of `vite-hub` that the files come from. */
  version: string
}

const scriptHeaders = {
  "access-control-allow-origin": "*",
  "content-type": "text/javascript; charset=utf-8",
  "cross-origin-resource-policy": "cross-origin",
  "x-content-type-options": "nosniff",
}
const immutable = "public, max-age=31536000, immutable"
const shortCache = "public, max-age=300"

function notFound(message: string): Response {
  return Response.json({ code: "NOT_FOUND", message, ok: false, status: 404 }, { headers: { "access-control-allow-origin": "*", "cache-control": "no-store" }, status: 404 })
}

function readOnly(request: Request): Response | undefined {
  if (request.method === "GET" || request.method === "HEAD") return undefined
  return new Response(null, { headers: { allow: "GET, HEAD" }, status: 405 })
}

function body(request: Request, source: string): string | null {
  return request.method === "HEAD" ? null : source
}

function skillType(path: string): string {
  if (path.endsWith(".json")) return "application/json; charset=utf-8"
  if (path.endsWith(".md")) return "text/markdown; charset=utf-8"
  return "text/plain; charset=utf-8"
}

function decodedPath(path: string): string | undefined {
  try {
    return decodeURIComponent(path)
  }
  catch {
    return undefined
  }
}

/**
 * Serve the skills of the Console's ViteHub version in the well-known format that `npx skills add` reads:
 * `/.well-known/skills/<file>` and `/skills/latest/.well-known/skills/<file>` name the current version, and
 * `/skills/<version>/.well-known/skills/<file>` names one version. The Console serves one version, so another version is
 * not found.
 */
export function serveConsoleSkills(request: Request, assets: ConsoleAssets): Response {
  const refused = readOnly(request)
  if (refused) return refused
  const match = /^(?:\/skills\/([^/]+))?\/\.well-known\/skills\/(.+)$/.exec(new URL(request.url).pathname)
  if (!match) return notFound("Not found.")
  const [, version, encoded = ""] = match
  if (version !== undefined && version !== "latest" && version !== assets.version) {
    return notFound(`This Console serves the skills of ViteHub ${assets.version}. Use /skills/${assets.version} or /skills/latest.`)
  }
  const path = decodedPath(encoded)
  const source = path === undefined ? undefined : Object.hasOwn(assets.skills, path) ? assets.skills[path] : undefined
  if (path === undefined || source === undefined) return notFound("The skills have no such file.")
  return new Response(body(request, source), {
    headers: { "access-control-allow-origin": "*", "cache-control": shortCache, "content-type": skillType(path), "x-content-type-options": "nosniff" },
  })
}

/**
 * Serve the page tools pill parts for apps. `/page/<version>/<file>` moves to `/page/<version>/<hash>/<file>`, the URL of
 * the current content, which never changes and is cached for a year. The move keeps the query, so `page-tool.js` keeps its
 * `base`. An app on another ViteHub version gets the Console's version: the Console serves one version of each part.
 */
export function serveConsolePageAsset(request: Request, assets: ConsoleAssets): Response {
  const refused = readOnly(request)
  if (refused) return refused
  const url = new URL(request.url)
  const match = /^\/page\/([^/]+)\/(?:([0-9a-f]+)\/)?([^/]+)$/.exec(url.pathname)
  const asset = match && Object.hasOwn(assets.page, match[3] ?? "") ? assets.page[match[3] ?? ""] : undefined
  if (!match || !asset) return notFound("The Console has no such page tools file.")
  const [, version, hash, file] = match
  if (version === assets.version && hash === asset.hash) {
    return new Response(body(request, asset.source), { headers: { ...scriptHeaders, "cache-control": immutable } })
  }
  return new Response(null, {
    headers: {
      "access-control-allow-origin": "*",
      "cache-control": version === assets.version && hash === undefined ? shortCache : "no-store",
      location: `/page/${assets.version}/${asset.hash}/${file}${url.search}`,
    },
    status: 307,
  })
}
