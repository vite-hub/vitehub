#!/usr/bin/env node
// Finds the public API that a branch removes and searches your consumer projects for it.
// Run it before you open a pull request that removes an export, a subpath, a config key, a flag or an env var.
//
//   node scripts/consumer-check.mjs                         compare HEAD with origin/main
//   node scripts/consumer-check.mjs --base <ref> --head <ref>
//   node scripts/consumer-check.mjs --name <text> ...       also search text the diff cannot find:
//                                                           config keys, CLI flags (--name=--flag), env vars, codes
//
// It reads commits, not uncommitted changes. The surfaces are the `package.json` export subpaths of public packages
// that the branch removes (with the `vite-hub/<pkg>/<sub>` facade form) and the names that their entry files stop
// exporting. A removed default export searches its module specifier. Each consumer root is searched with `rg`
// (or `git grep --no-index` when rg is missing) and, when it is
// a Git checkout, with `git grep` on its default branch as last fetched.
//
// The list of consumer projects stays on your machine. Give it in VITEHUB_CONSUMER_ROOTS (paths separated by ":"),
// in a file named by VITEHUB_CONSUMER_ROOTS_FILE, or in ~/.config/vitehub/consumer-roots (one path per line, # for comments).
//
// Exit status: 0 no use, 1 a project uses a removed surface, 2 setup error or incomplete search.
import { spawnSync } from "node:child_process"
import { existsSync, readFileSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { delimiter, posix, resolve } from "node:path"
import { parseArgs } from "node:util"

import ts from "typescript"

const usage = "Usage: node scripts/consumer-check.mjs [--base <ref>] [--head <ref>] [--name <text>]..."
const defaultRootsFile = resolve(homedir(), ".config/vitehub/consumer-roots")
const ignoredDirectories = [".cache", ".data", ".git", ".nuxt", ".output", ".vitehub", ".worktree", ".worktrees", ".wrangler", "dist", "node_modules"]
const lockfiles = ["bun.lock", "bun.lockb", "package-lock.json", "pnpm-lock.yaml", "yarn.lock"]
const sourceSuffixes = [".ts", "/index.ts"]
const shownHitsPerSurface = 20
const maxBuffer = 512 * 1024 * 1024

function stop(message) {
  console.error(message)
  process.exit(2)
}

function run(command, args, cwd) {
  return spawnSync(command, args, { cwd, encoding: "utf8", maxBuffer })
}

function git(cwd, args) {
  const result = run("git", args, cwd)
  if (result.status !== 0) stop(`git ${args.join(" ")} failed:\n${(result.stderr || result.error?.message || "").trim()}`)
  return result.stdout
}

function readOptions() {
  try {
    return parseArgs({
      options: {
        base: { default: "origin/main", type: "string" },
        head: { default: "HEAD", type: "string" },
        help: { short: "h", type: "boolean" },
        name: { default: [], multiple: true, type: "string" },
      },
    }).values
  }
  catch (error) {
    return stop(`${error.message}\n${usage}`)
  }
}

function expandHome(path) {
  return path === "~" || path.startsWith("~/") ? homedir() + path.slice(1) : path
}

function consumerRoots(env) {
  const listed = env.VITEHUB_CONSUMER_ROOTS?.trim()
    ? env.VITEHUB_CONSUMER_ROOTS.split(delimiter)
    : readRootsFile(env.VITEHUB_CONSUMER_ROOTS_FILE || defaultRootsFile)
  return [...new Set(listed.map(path => path.trim()).filter(Boolean).map(path => resolve(expandHome(path))))]
}

function readRootsFile(path) {
  if (!existsSync(path)) return []
  return readFileSync(path, "utf8").split(/\r?\n/).filter(line => !line.trim().startsWith("#"))
}

// The surface: what the branch removes from public packages.

function listFiles(repo, ref) {
  return new Set(git(repo, ["ls-tree", "-r", "--name-only", ref, "--", "packages"]).split("\n").filter(Boolean))
}

function readManifest(repo, ref, directory, files) {
  const path = `packages/${directory}/package.json`
  return files.has(path) ? JSON.parse(git(repo, ["show", `${ref}:${path}`])) : undefined
}

function importTarget(value) {
  if (typeof value === "string") return value
  if (!value || typeof value !== "object") return undefined
  return importTarget(value.import) ?? importTarget(value.default)
}

// `./dist/<path>.js` is built from `src/<path>.ts` or `src/<path>/index.ts` in every ViteHub package.
function exportEntries(manifest, directory, files) {
  const entries = new Map()
  for (const [subpath, value] of Object.entries(manifest.exports ?? {})) {
    const built = /^\.\/dist\/(.+)\.js$/.exec(importTarget(value) ?? "")?.[1]
    entries.set(subpath, built && sourceSuffixes.map(suffix => `packages/${directory}/src/${built}${suffix}`).find(path => files.has(path)))
  }
  return entries
}

function hasModifier(node, kind) {
  return ts.canHaveModifiers(node) && (ts.getModifiers(node) ?? []).some(modifier => modifier.kind === kind)
}

function addBindingNames(name, names) {
  if (ts.isIdentifier(name)) {
    names.add(name.text)
    return
  }
  for (const element of name.elements) {
    if (!ts.isOmittedExpression(element)) addBindingNames(element.name, names)
  }
}

function moduleExports(repo, ref, path, cache) {
  const key = `${ref}:${path}`
  const cached = cache.get(key)
  if (cached) return cached
  const source = ts.createSourceFile(path, git(repo, ["show", key]), ts.ScriptTarget.Latest, false, ts.ScriptKind.TS)
  const exports = { names: new Set(), stars: [] }
  for (const statement of source.statements) {
    if (ts.isExportAssignment(statement)) {
      if (!statement.isExportEquals) exports.names.add("default")
      continue
    }
    if (ts.isExportDeclaration(statement)) {
      const clause = statement.exportClause
      if (!clause) {
        if (statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier)) exports.stars.push(statement.moduleSpecifier.text)
      }
      else if (ts.isNamespaceExport(clause)) {
        exports.names.add(clause.name.text)
      }
      else {
        for (const element of clause.elements) exports.names.add(element.name.text)
      }
      continue
    }
    if (!hasModifier(statement, ts.SyntaxKind.ExportKeyword)) continue
    if (hasModifier(statement, ts.SyntaxKind.DefaultKeyword)) {
      exports.names.add("default")
      continue
    }
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) addBindingNames(declaration.name, exports.names)
    }
    else if (statement.name && ts.isIdentifier(statement.name)) {
      exports.names.add(statement.name.text)
    }
  }
  cache.set(key, exports)
  return exports
}

// Follows `export * from "./relative"` inside the package. A star export of another package is that package's surface.
function entryNames(repo, ref, entry, files, cache) {
  const names = new Set()
  const seen = new Set()
  const queue = [entry]
  while (queue.length > 0) {
    const path = queue.pop()
    if (seen.has(path)) continue
    seen.add(path)
    const exports = moduleExports(repo, ref, path, cache)
    for (const name of exports.names) {
      if (name !== "default" || path === entry) names.add(name)
    }
    for (const specifier of exports.stars) {
      if (!specifier.startsWith(".")) continue
      const target = posix.join(posix.dirname(path), specifier).replace(/\.[jt]s$/, "")
      const file = sourceSuffixes.map(suffix => target + suffix).find(candidate => files.has(candidate))
      if (file) queue.push(file)
    }
  }
  return names
}

function specifierOf(packageName, subpath) {
  return subpath === "." ? packageName : packageName + subpath.slice(1)
}

function removedSurfaces(repo, base, head) {
  const baseFiles = listFiles(repo, base)
  const headFiles = listFiles(repo, head)
  const facadeExports = new Set(Object.keys(readManifest(repo, base, "vite-hub", baseFiles)?.exports ?? {}))
  const changedDirectories = new Set(git(repo, ["diff", "--name-only", base, head, "--", "packages"])
    .split("\n").filter(Boolean).map(path => path.split("/")[1]))
  const cache = new Map()
  const surfaces = []
  const add = (text, kind, detail) => {
    if (!surfaces.some(surface => surface.text === text)) surfaces.push({ detail, kind, text })
  }
  const addModule = (packageName, subpath, detail) => {
    const specifier = specifierOf(packageName, subpath)
    add(specifier, "subpath", detail)
    const facadeSubpath = packageName.startsWith("@vite-hub/") ? specifierOf(`./${packageName.slice("@vite-hub/".length)}`, subpath) : undefined
    if (facadeSubpath && facadeExports.has(facadeSubpath)) add(specifierOf("vite-hub", facadeSubpath), "subpath", `facade form of ${specifier}`)
  }

  for (const directory of [...changedDirectories].sort()) {
    const baseManifest = readManifest(repo, base, directory, baseFiles)
    if (!baseManifest || baseManifest.private === true) continue
    const headManifest = readManifest(repo, head, directory, headFiles)
    const baseEntries = exportEntries(baseManifest, directory, baseFiles)
    const headEntries = headManifest?.name === baseManifest.name ? exportEntries(headManifest, directory, headFiles) : new Map()
    for (const [subpath, baseEntry] of baseEntries) {
      const specifier = specifierOf(baseManifest.name, subpath)
      if (!headEntries.has(subpath)) {
        addModule(baseManifest.name, subpath, "export subpath")
        continue
      }
      const headEntry = headEntries.get(subpath)
      if (!baseEntry || !headEntry) continue
      const kept = entryNames(repo, head, headEntry, headFiles, cache)
      for (const name of entryNames(repo, base, baseEntry, baseFiles, cache)) {
        if (kept.has(name)) continue
        if (name === "default") addModule(baseManifest.name, subpath, "default export")
        else add(name, "name", `export of ${specifier}`)
      }
    }
  }
  return { add, surfaces }
}

// The search: every consumer root, working tree and default branch.

const wordCharacter = /[\w$]/

// A fixed-string hit counts only when it is not part of a longer identifier or package specifier.
function matchIndex(line, surface) {
  const { kind, text } = surface
  for (let index = line.indexOf(text); index !== -1; index = line.indexOf(text, index + 1)) {
    const before = line[index - 1] ?? ""
    const after = line[index + text.length] ?? ""
    const ok = kind === "subpath"
      ? !/[\w$@/.-]/.test(before) && !/[\w$/-]/.test(after) && !(after === "." && /\w/.test(line[index + text.length + 1] ?? ""))
      : !(wordCharacter.test(text[0]) && wordCharacter.test(before)) && !(wordCharacter.test(text.at(-1)) && wordCharacter.test(after))
    if (ok) return index
  }
  return -1
}

function defaultBranch(root) {
  if (run("git", ["rev-parse", "--git-dir"], root).status !== 0) return undefined
  const head = run("git", ["symbolic-ref", "-q", "--short", "refs/remotes/origin/HEAD"], root).stdout?.trim()
  if (head) return head
  return ["origin/main", "origin/master"].find(ref => run("git", ["rev-parse", "-q", "--verify", `${ref}^{commit}`], root).status === 0)
}

const excludedPathspecs = [
  ...ignoredDirectories.map(name => `:(exclude,glob)**/${name}/**`),
  ...lockfiles.map(name => `:(exclude,glob)**/${name}`),
]

// rg prints `file\0line:text`; git grep -z prints `file\0line\0text`.
function parseGrep(output, prefix = "") {
  return output.split("\n").filter(Boolean).flatMap((record) => {
    const match = /^([^\0]*)\0(\d+)[:\0](.*)$/s.exec(record)
    if (!match) return []
    const file = match[1].startsWith(prefix) ? match[1].slice(prefix.length) : match[1]
    return [{ file, line: Number(match[2]), text: match[3] }]
  })
}

function searchOutput(result, command, root) {
  if (result.error || (result.status !== 0 && result.status !== 1)) {
    const detail = result.error?.message || result.stderr || `exit status ${result.status}, signal ${result.signal}`
    stop(`Consumer search failed in ${root} (${command}):\n${detail.trim()}`)
  }
  return result.stdout
}

function searchRoot(root, texts) {
  // Hidden source and config count; exclude only known generated directories and nested worktree folders.
  const rg = run("rg", [
    "--hidden", "--no-heading", "--with-filename", "--line-number", "--null", "--fixed-strings",
    ...[...ignoredDirectories, ...lockfiles].flatMap(name => ["--glob", `!${name}`]),
    ...texts.map(text => `--regexp=${text}`),
    // With no path, rg searches stdin when stdin is not a terminal.
    ".",
  ], root)
  const lines = rg.error?.code === "ENOENT"
    ? parseGrep(searchOutput(run("git", ["grep", "--no-index", "--exclude-standard", "-I", "-n", "-z", "-F", ...texts.flatMap(text => ["-e", text]), "--", ".", ...excludedPathspecs], root), "git grep --no-index", root))
    : parseGrep(searchOutput(rg, "rg", root), "./")
  const results = lines.map(line => ({ ...line, where: "working tree" }))

  const ref = defaultBranch(root)
  if (ref) {
    const branch = run("git", ["grep", "-I", "-n", "-z", "-F", ...texts.flatMap(text => ["-e", text]), ref, "--", ".", ...excludedPathspecs], root)
    results.push(...parseGrep(searchOutput(branch, `git grep ${ref}`, root), `${ref}:`).map(line => ({ ...line, where: ref })))
  }
  return results
}

function isPatch(file) {
  return /(?:^|\/)patches\//.test(file) || file.endsWith(".patch")
}

function snippet(text, index) {
  const start = Math.max(0, index - 60)
  const end = Math.min(text.length, index + 120)
  return `${start > 0 ? "…" : ""}${text.slice(start, end).trim()}${end < text.length ? "…" : ""}`
}

function main() {
  const options = readOptions()
  if (options.help) {
    console.log(usage)
    return 0
  }
  const roots = consumerRoots(process.env)
  if (roots.length === 0) {
    stop([
      "No consumer roots are configured, so there is nothing to search.",
      "The list of your projects stays on your machine. Give it in one of these:",
      `  VITEHUB_CONSUMER_ROOTS=/path/to/app-a${delimiter}/path/to/app-b`,
      "  VITEHUB_CONSUMER_ROOTS_FILE=/path/to/file   (one path per line, # for comments)",
      `  ${defaultRootsFile}   (the same format, read when neither variable is set)`,
    ].join("\n"))
  }
  for (const root of roots) {
    try {
      if (!statSync(root).isDirectory()) stop(`Consumer root is not a directory: ${root}`)
    }
    catch (error) {
      stop(`Cannot search consumer root ${root}: ${error.message}`)
    }
  }

  const repo = git(process.cwd(), ["rev-parse", "--show-toplevel"]).trim()
  const head = git(repo, ["rev-parse", "--verify", `${options.head}^{commit}`]).trim()
  const base = git(repo, ["merge-base", options.base, head]).trim()
  const { add, surfaces } = removedSurfaces(repo, base, head)
  for (const text of options.name) add(text, "text", "--name")
  const kindOrder = ["subpath", "name", "text"]
  surfaces.sort((a, b) => kindOrder.indexOf(a.kind) - kindOrder.indexOf(b.kind))

  console.log(`Removed between ${options.base} and ${options.head} (merge base ${base.slice(0, 10)}):`)
  if (surfaces.length === 0) {
    console.log("  nothing. Pass --name for config keys, CLI flags, env vars or codes that the diff cannot find.")
    return 0
  }
  const width = Math.max(...surfaces.map(surface => surface.text.length))
  for (const surface of surfaces) console.log(`  ${surface.text.padEnd(width)}  ${surface.detail}`)

  const hits = new Map(surfaces.map(surface => [surface, new Map()]))

  const texts = surfaces.map(surface => surface.text)
  for (const root of roots) {
    for (const result of searchRoot(root, texts)) {
      for (const surface of surfaces) {
        const index = matchIndex(result.text, surface)
        if (index === -1) continue
        const key = `${root}\0${result.file}\0${result.line}`
        const hit = hits.get(surface).get(key)
        if (hit) hit.where.add(result.where)
        else hits.get(surface).set(key, { ...result, index, root, where: new Set([result.where]) })
      }
    }
  }
  console.log(`\nSearched ${roots.length} consumer roots: working tree, and the default branch as last fetched.\n`)

  let used = 0
  let patchOnly = 0
  for (const surface of surfaces) {
    const found = [...hits.get(surface).values()].sort((a, b) => Number(isPatch(a.file)) - Number(isPatch(b.file)))
    const uses = found.filter(hit => !isPatch(hit.file))
    if (found.length === 0) {
      console.log(`${surface.text}: no use`)
      continue
    }
    if (uses.length > 0) {
      used++
      console.log(`${surface.text}: USED`)
    }
    else {
      patchOnly++
      console.log(`${surface.text}: only in patches/, needs a human read (a patch that edits this feature is a use)`)
    }
    for (const hit of found.slice(0, shownHitsPerSurface)) {
      const mark = isPatch(hit.file) ? "; patch, read it" : ""
      console.log(`  ${hit.root}:${hit.file}:${hit.line} (${[...hit.where].join(", ")}${mark})  ${snippet(hit.text, hit.index)}`)
    }
    if (found.length > shownHitsPerSurface) console.log(`  and ${found.length - shownHitsPerSurface} more`)
  }

  console.log("")
  if (patchOnly > 0) console.log(`${patchOnly} surface(s) appear only in patches/. Read those patches before the cut.`)
  if (used > 0) {
    console.log(`${used} removed surface(s) are used. Keep them, or change those projects first.`)
    return 1
  }
  console.log("No project uses a removed surface.")
  return 0
}

process.exitCode = main()
