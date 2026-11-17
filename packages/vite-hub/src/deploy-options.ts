import { createHash } from "node:crypto"
import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"

import { viteHubErrorDiagnostics } from "./error-diagnostics.ts"
import { defaultHealthRoute, type HealthOptions } from "./health-vite.ts"

import type { DeploymentDeployManifest } from "@vite-hub/internal/build/deployment-plan-output"

export interface DeployOptions {
  /**
   * Paths that `vitehub deploy` requests on the deployed URL after each deploy, such as `["/", "/api/products"]`. Each
   * one must answer with a 2xx status, or the deploy exits with `SETUP_DEPLOY_CHECK_FAILED` and prints the command
   * that rolls production back. With `health`, the health route is checked too.
   */
  check?: string | readonly string[]
  /**
   * After each production deploy that passes its checks, `vitehub deploy` sends the URLs of `<publicUrl>/sitemap.xml`
   * to IndexNow, so Bing, Yandex, Seznam, Naver, and Yep crawl them again. The build serves the IndexNow key file.
   * Needs a string `publicUrl`. Default: `false`.
   */
  indexNow?: boolean
}

function checkPath(path: string): string {
  // A path on the deployed origin: no other origin, no protocol-relative URL, and no white space.
  if (!path.startsWith("/") || path.startsWith("//") || /\s/u.test(path)) throw viteHubErrorDiagnostics.VITE_HUB_DEPLOY_CHECK_INVALID({ value: JSON.stringify(path) })
  return path
}

/**
 * The IndexNow key of a site. IndexNow accepts 8 to 128 characters of a-z, A-Z, 0-9 and `-`. The key is public: the
 * site serves it at `/<key>.txt`, and it only lets a sender submit URLs of that site. It comes from the origin, so
 * every build of the site serves the same key and no file needs to be kept.
 */
export function indexNowKey(publicUrl: string): string {
  return createHash("sha256").update(`vitehub-indexnow:${publicUrl}`).digest("hex").slice(0, 32)
}

/** What `vitehub deploy` does after the upload, for `deployment.json`. Undefined when it does nothing. */
export function resolveDeployManifest(input: { deploy: DeployOptions | undefined, health: boolean | HealthOptions | undefined, publicUrl: string | undefined }): DeploymentDeployManifest | undefined {
  const configured = typeof input.deploy?.check === "string" ? [input.deploy.check] : input.deploy?.check ?? []
  const health = input.health ? [input.health === true ? defaultHealthRoute : input.health.route ?? defaultHealthRoute] : []
  const check = [...new Set([...health, ...configured].map(checkPath))]
  let indexNow: DeploymentDeployManifest["indexNow"]
  if (input.deploy?.indexNow) {
    if (input.publicUrl === undefined) throw viteHubErrorDiagnostics.VITE_HUB_DEPLOY_INDEX_NOW_PUBLIC_URL_MISSING()
    indexNow = { key: indexNowKey(input.publicUrl), url: input.publicUrl }
  }
  if (!check.length && !indexNow) return
  return { check, ...(indexNow ? { indexNow } : {}) }
}

/** Writes `<key>.txt`, with the key as its only content, into a folder of its own that Nitro serves at the site root. */
export function writeIndexNowKeyFile(generatedRoot: string, key: string): string {
  const dir = join(generatedRoot, "indexnow")
  rmSync(dir, { force: true, recursive: true })
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, `${key}.txt`), key)
  return dir
}
