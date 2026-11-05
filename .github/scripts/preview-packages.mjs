#!/usr/bin/env node
// Prepares the package manifests for a pkg.pr.new preview. Run it after the build and before `pkg-pr-new publish`.
//
// pkg.pr.new changes ViteHub dependencies to preview URLs, but ViteHub peers keep the npm version. pnpm 10 and 11
// install an optional peer that is elsewhere in the graph from npm at the version they find there, so a preview graph
// got npm releases next to the preview packages. A preview version that npm does not have stops this. Each ViteHub
// peer also keeps its npm range, because npm stops when it cannot fetch a peer version from the registry.

import { writeFile } from "node:fs/promises"
import { resolve } from "node:path"
import { pathToFileURL } from "node:url"

import { listReleasePackages } from "./release-packages.mjs"

export function previewVersion(sha) {
  if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error(`Expected a full commit SHA, got "${sha}".`)
  return `0.0.0-preview-${sha.slice(0, 7)}`
}

// The range that `pnpm pack` writes for a `workspace:` range.
function packedRange(range, version) {
  if (range === "workspace:*" || range === "workspace:") return version
  if (range === "workspace:^" || range === "workspace:~") return `${range.slice(-1)}${version}`
  return range.replace(/^workspace:/, "")
}

export async function writePreviewManifests(workspace, sha) {
  const version = previewVersion(sha)
  const packages = await listReleasePackages(workspace)
  const releaseVersions = new Map(packages.map(pkg => [pkg.name, pkg.version]))
  for (const { manifest, path } of packages) {
    manifest.version = version
    const peers = manifest.peerDependencies ?? {}
    for (const [name, range] of Object.entries(peers)) {
      if (releaseVersions.has(name)) peers[name] = `${packedRange(range, releaseVersions.get(name))} || ${version}`
    }
    await writeFile(path, `${JSON.stringify(manifest, null, 2)}\n`)
  }
  return version
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const version = await writePreviewManifests(process.cwd(), process.argv[2] ?? "")
  console.log(`Preview packages have the version ${version}.`)
}
