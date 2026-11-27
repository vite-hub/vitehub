import { and, eq, inArray, ne } from "drizzle-orm"

import { consoleProjects } from "./projects.ts"

import type { ConsoleDatabase } from "./projects.ts"

/** The script of the Console frame, which `@vite-hub/comments` builds and the Console serves. */
export const commentsEmbedFrameScript = "/hosted-comments/frame.js"

const isolation = {
  "cache-control": "no-store",
  "cross-origin-embedder-policy": "require-corp",
  "cross-origin-resource-policy": "cross-origin",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
}

function attribute(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("\"", "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
}

function refused(status: number, text: string): Response {
  return new Response(text, {
    headers: { ...isolation, "content-security-policy": "default-src 'none'; frame-ancestors 'none'", "content-type": "text/plain; charset=utf-8" },
    status,
  })
}

function originOf(url: string): string | undefined {
  try {
    const origin = new URL(url).origin
    return origin === "null" ? undefined : origin
  }
  catch {
    return undefined
  }
}

/**
 * The frame of the hosted Comments embed at `/comments/<projectId>/embed`. Only the origin of the registered project URL
 * may embed it, and the frame script answers only that origin. The page holds no credential: the frame script keeps the
 * sign-in in its own tab storage.
 */
export async function serveCommentsEmbed(request: Request, db: ConsoleDatabase): Promise<Response> {
  if (request.method !== "GET" && request.method !== "HEAD") return new Response(null, { headers: { allow: "GET, HEAD" }, status: 405 })
  const match = /^\/comments\/([^/]+)\/embed$/.exec(new URL(request.url).pathname)
  let id: string | undefined
  try {
    id = match?.[1] === undefined ? undefined : decodeURIComponent(match[1])
  }
  catch {
    id = undefined
  }
  if (!id) return refused(404, "Not found.")
  const [project] = await db.select({ id: consoleProjects.id, url: consoleProjects.url }).from(consoleProjects).where(eq(consoleProjects.id, id)).limit(1)
  const origin = project ? originOf(project.url) : undefined
  if (!project || !origin) return refused(404, "No project has this id.")
  const html = `<!doctype html><html data-origin="${attribute(origin)}" data-project="${attribute(project.id)}"><head><meta charset="utf-8"><title>ViteHub Comments</title><script type="module" src="${commentsEmbedFrameScript}"></script></head></html>`
  return new Response(request.method === "HEAD" ? null : html, {
    headers: {
      ...isolation,
      "content-security-policy": `default-src 'none'; script-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors ${origin}`,
      "content-type": "text/html; charset=utf-8",
    },
  })
}

const projectKeyLimit = 8
const publicKeyPattern = /^[\w-]{43}$/

function projectAnswer(origin: string | undefined, status: number, value: unknown): Response {
  return Response.json(value, {
    headers: {
      ...origin ? { "access-control-allow-origin": origin } : {},
      "cache-control": "no-store",
      "cross-origin-resource-policy": "cross-origin",
      "vary": "origin",
      "x-content-type-options": "nosniff",
    },
    status,
  })
}

/**
 * `GET /comments/project?key=<public key>`: the project id of an app that the Console links, for the Hosted Comments
 * pill that ViteHub adds to an app without app Comments. The page names the `VITEHUB_CONSOLE_KEY_<NAME>` public keys of
 * its app, and `key` can repeat. A project answers only when one of its keys matches and the request `Origin` is the
 * origin of its URL, so another site cannot learn the project of a key. Any other request gets 404.
 */
export async function serveCommentsProject(request: Request, db: ConsoleDatabase): Promise<Response> {
  if (request.method !== "GET" && request.method !== "HEAD") return new Response(null, { headers: { allow: "GET, HEAD" }, status: 405 })
  const origin = originOf(request.headers.get("origin") ?? "")
  const keys = [...new Set(new URL(request.url).searchParams.getAll("key"))].filter(key => publicKeyPattern.test(key)).slice(0, projectKeyLimit)
  if (!origin || !keys.length) return projectAnswer(origin, 404, { error: "No project has this key on this origin." })
  const rows = await db.select({ id: consoleProjects.id, url: consoleProjects.url }).from(consoleProjects).where(and(inArray(consoleProjects.publicKey, keys), ne(consoleProjects.publicKey, "")))
  const project = rows.find(row => originOf(row.url) === origin)
  if (!project) return projectAnswer(origin, 404, { error: "No project has this key on this origin." })
  return projectAnswer(origin, 200, { id: project.id })
}
