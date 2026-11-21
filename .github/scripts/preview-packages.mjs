#!/usr/bin/env node

import { writeFile } from "node:fs/promises"
import { resolve } from "node:path"
import { pathToFileURL } from "node:url"

import { listReleasePackages } from "./release-packages.mjs"

export function previewVersion(sha) {
  if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error(`Expected a full commit SHA, got "${sha}".`)
  return `0.0.0-preview-${sha.slice(0, 7)}`
}

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
