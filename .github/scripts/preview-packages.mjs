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
  if (range === "*" || range === "workspace:*" || range === "workspace:") return version
  if (range === "workspace:^" || range === "workspace:~") return `${range.slice(-1)}${version}`
  return range.replace(/^workspace:/, "")
}

export async function writePreviewManifests(workspace, sha, publishedVersion) {
  const version = previewVersion(sha)
  if (!/^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/.test(publishedVersion)) {
    throw new Error(`Expected a stable published ViteHub version, got "${publishedVersion}".`)
  }
  const packages = await listReleasePackages(workspace)
  const packageNames = new Set(packages.map(pkg => pkg.name))
  for (const { manifest, path } of packages) {
    manifest.version = version
    const peers = manifest.peerDependencies ?? {}
    for (const [name, range] of Object.entries(peers)) {
      if (packageNames.has(name)) peers[name] = `${packedRange(range, publishedVersion)} || ${version}`
    }
    await writeFile(path, `${JSON.stringify(manifest, null, 2)}\n`)
  }
  return version
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const version = await writePreviewManifests(process.cwd(), process.argv[2] ?? "", process.argv[3] ?? "")
  console.log(`Preview packages have the version ${version}.`)
}
