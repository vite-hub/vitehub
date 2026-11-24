import { execFile } from "node:child_process"
import { createHash } from "node:crypto"
import { cp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, relative, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { parseArgs } from "node:util"

const repoRoot = resolve(import.meta.dirname, "../..")
const fixture = join(repoRoot, "fixtures/vercel-runtime-packages")
const vp = join(repoRoot, "node_modules/.bin/vp")
const hook = pathToFileURL(join(import.meta.dirname, "count-hook.mjs")).href

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    compare: { type: "boolean" },
    out: { type: "string" },
    runs: { type: "string", default: "3" },
  },
})

if (values.compare) process.exit(await compare(positionals[0], positionals[1]))

const runs = []
for (let index = 0; index < Number(values.runs); index++) runs.push(await buildOnce())
const sorted = runs.map(run => run.buildMs).sort((left, right) => left - right)
const first = runs[0]
const result = {
  buildMs: runs.map(run => run.buildMs),
  medianBuildMs: sorted[Math.floor(sorted.length / 2)],
  counts: first.counts,
  copyMs: runs.map(run => run.counts.copyMs),
  cpuMs: runs.map(run => run.counts.cpuMs),
  functionFiles: Object.keys(first.files).length,
  functionBytes: first.bytes,
  files: first.files,
}
for (const run of runs.slice(1)) {
  const differ = Object.keys({ ...first.files, ...run.files }).filter(path => first.files[path] !== run.files[path])
  if (differ.length) throw new Error(`Two runs of the same build wrote different __server.func files:\n${differ.join("\n")}`)
}
const { files: _files, ...summary } = result
console.log(JSON.stringify(summary, null, 2))
if (values.out) await writeFile(values.out, `${JSON.stringify(result, null, 2)}\n`)

async function buildOnce() {
  const root = join(tmpdir(), "vitehub-vercel-runtime-packages-bench")
  await rm(root, { force: true, recursive: true })
  const appRoot = join(root, "app")
  const countsFile = join(root, "counts.jsonl")
  try {
    await cp(fixture, appRoot, { preserveTimestamps: true, recursive: true })
    await writeFile(join(appRoot, "package.json"), JSON.stringify({ private: true, type: "module" }))
    await linkNodeModules(appRoot)
    const started = performance.now()
    await run(vp, ["build", appRoot, "--config", join(appRoot, "vite.config.ts")], {
      NODE_OPTIONS: [process.env.NODE_OPTIONS, `--import=${hook}`].filter(Boolean).join(" "),
      VITEHUB_HOST: "vercel",
      VITEHUB_RUNTIME_PACKAGE_COUNTS: countsFile,
    })
    const buildMs = Math.round(performance.now() - started)
    const counts = { copyMs: 0, copyPasses: 0, cpuMs: 0, filesCopied: 0, packageCopies: 0 }
    const lines = await readFile(countsFile, "utf8").catch(() => "")
    for (const line of lines.split("\n").filter(Boolean)) {
      const entry = JSON.parse(line)
      for (const key of Object.keys(counts)) counts[key] += entry[key]
    }
    const functionDir = join(appRoot, ".vercel/output/functions/__server.func")
    const files = {}
    let bytes = 0
    for (const path of await listFiles(functionDir)) {
      const content = await readFile(path)
      bytes += content.byteLength
      files[relative(functionDir, path)] = createHash("sha256").update(content).digest("hex")
    }
    await expectViteHubCopiesMatchBuilds(files)
    return { buildMs, bytes, counts, files }
  }
  finally {
    await rm(root, { force: true, recursive: true })
  }
}

async function linkNodeModules(appRoot) {
  const source = join(repoRoot, "node_modules")
  const target = join(appRoot, "node_modules")
  await mkdir(join(target, "@vercel"), { recursive: true })
  for (const name of await readdir(source)) {
    if (name !== "@vercel") await symlink(join(source, name), join(target, name), "dir")
  }
  for (const name of await readdir(join(source, "@vercel"))) {
    await symlink(join(source, "@vercel", name), join(target, "@vercel", name), "dir")
  }
  await symlink(join(repoRoot, "packages/workflow/node_modules/@vercel/functions"), join(target, "@vercel/functions"), "dir")
}

async function expectViteHubCopiesMatchBuilds(files) {
  const packageDirs = new Map()
  for (const name of await readdir(join(repoRoot, "packages"))) {
    const manifest = await readFile(join(repoRoot, "packages", name, "package.json"), "utf8").catch(() => undefined)
    if (manifest) packageDirs.set(JSON.parse(manifest).name, join(repoRoot, "packages", name))
  }
  const mismatched = []
  for (const [path, hash] of Object.entries(files)) {
    const match = /^node_modules\/(@vite-hub\/[^/]+)\/(.+)$/.exec(path)
    if (!match) continue
    const source = await readFile(join(packageDirs.get(match[1]), match[2]))
    if (createHash("sha256").update(source).digest("hex") !== hash) mismatched.push(path)
  }
  if (mismatched.length) throw new Error(`Copied ViteHub files differ from their package builds:\n${mismatched.join("\n")}`)
}

async function listFiles(directory) {
  const files = []
  for (const entry of await readdir(directory, { recursive: true, withFileTypes: true })) {
    if (entry.isFile() || entry.isSymbolicLink()) files.push(join(entry.parentPath, entry.name))
  }
  return files.sort()
}

function run(command, args, env) {
  return new Promise((resolvePromise, reject) => {
    execFile(command, args, { cwd: repoRoot, env: { ...process.env, ...env }, maxBuffer: 64 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) reject(new Error(`${command} ${args.join(" ")} failed:\n${stdout}\n${stderr}`))
      else resolvePromise()
    })
  })
}

async function compare(beforePath, afterPath) {
  const before = JSON.parse(await readFile(beforePath, "utf8"))
  const after = JSON.parse(await readFile(afterPath, "utf8"))
  const withoutContentHash = path => path.replace(/-[\w-]{8}(\.m?js|\.d\.ts)$/, "$1")
  const list = files => Object.keys(files).map(withoutContentHash).sort().join("\n")
  const sameList = list(before.files) === list(after.files)
  const viteHubOwned = path => path.startsWith("node_modules/@vite-hub/") || !path.startsWith("node_modules/")
  const paths = [...new Set([...Object.keys(before.files), ...Object.keys(after.files)])].sort()
  const thirdParty = paths.filter(path => !viteHubOwned(path))
  const changed = thirdParty.filter(path => before.files[path] !== after.files[path])
  const viteHubChanged = paths.filter(path => viteHubOwned(path) && before.files[path] !== after.files[path])
  for (const path of changed) console.log(`${before.files[path] ? (after.files[path] ? "changed" : "removed") : "added"} ${path}`)
  console.log(`file list (chunk content hashes aside): ${sameList ? "identical" : "different"}`)
  console.log(`third-party files: ${thirdParty.length}, ${changed.length} differ`)
  console.log(`ViteHub bundle and package files: ${paths.length - thirdParty.length}, ${viteHubChanged.length} differ`)
  return sameList && !changed.length ? 0 : 1
}
