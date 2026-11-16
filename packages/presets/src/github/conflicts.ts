import { readFile, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { parseAllDocuments } from "yaml";
import { isRuntimeRecord } from "../internal/runtime-type.ts";
import { regenerateGitHubPnpmLockfile } from "./install.ts";
import type { GitHubInstallSlots } from "./install.ts";

/** The mechanical rule the host used for one conflicted file. */
export type GitHubConflictRule = "package-json" | "pnpm-lockfile" | "markdown-union";

/** What a prepared merge conflicted on and which files the host resolved before the model starts. */
export interface GitHubConflictResolution {
  conflicted: string[];
  resolved: Array<{ path: string; rule: GitHubConflictRule }>;
  remaining: string[];
  /** Why a conflicted root pnpm lockfile stayed for the model. */
  lockfile?: string;
}

/** Runs Git in the checkout and returns raw stdout. */
export type GitHubConflictGit = (...args: string[]) => Promise<string>;

export interface GitHubConflictOptions {
  signal?: AbortSignal;
  slots?: GitHubInstallSlots;
  /** Replaces pnpm lockfile regeneration, or `false` when the host must not run a package manager. */
  regenerateLockfile?: false | ((target: string) => Promise<string>);
}

interface Stages { mode: string; blobs: Partial<Record<1 | 2 | 3, string>> }

/**
 * Resolve conflicts of a prepared merge that need no judgment, and stage each resolution.
 * Ours is the PR head and theirs is the base. Anything the rules cannot prove stays conflicted.
 */
export async function resolveGitHubMergeConflicts(target: string, git: GitHubConflictGit, options: GitHubConflictOptions = {}): Promise<GitHubConflictResolution | undefined> {
  const entries = new Map<string, Stages>();
  for (const record of (await git("ls-files", "--unmerged", "-z")).split("\0")) {
    const match = /^(\d+) ([a-f\d]+) ([123])\t(.+)$/s.exec(record);
    if (!match) continue;
    const entry = entries.get(match[4]!) ?? { mode: match[1]!, blobs: {} };
    if (entry.mode !== match[1]) entry.mode = "mixed";
    entry.blobs[Number(match[3]) as 1 | 2 | 3] = match[2]!;
    entries.set(match[4]!, entry);
  }
  if (!entries.size) return undefined;
  const conflicted = [...entries.keys()].sort();
  const resolved: GitHubConflictResolution["resolved"] = [];
  const stage = async (path: string, content: string, rule: GitHubConflictRule) => {
    await writeFile(join(target, path), content);
    await git("add", "--", path);
    resolved.push({ path, rule });
  };
  const textStages = async (entry: Stages) => {
    // Regular files present on all three sides only: no add/add, delete or mode conflicts.
    if (entry.mode !== "100644" && entry.mode !== "100755" || !entry.blobs[1] || !entry.blobs[2] || !entry.blobs[3]) return undefined;
    return await Promise.all([entry.blobs[1], entry.blobs[2], entry.blobs[3]].map(blob => git("cat-file", "blob", blob))) as [string, string, string];
  };

  for (const [path, entry] of entries) {
    options.signal?.throwIfAborted();
    const rule = basename(path) === "package.json" ? "package-json" : unionDocument(path) ? "markdown-union" : undefined;
    const sides = rule && await textStages(entry);
    if (!sides) continue;
    const merged = rule === "package-json" ? mergePackageJson(...sides) : await unionAdditions(git, entry, sides);
    if (merged !== undefined) await stage(path, merged, rule);
  }

  let lockfile: string | undefined;
  const lockEntry = entries.get("pnpm-lock.yaml");
  if (lockEntry) {
    const done = new Set(resolved.map(item => item.path));
    const blocking = conflicted.filter(path => !done.has(path) && path !== "pnpm-lock.yaml" && dependencyInput(path));
    const sides = await textStages(lockEntry);
    if (blocking.length) lockfile = `dependency inputs remain conflicted: ${blocking.join(", ")}`;
    else if (!sides) lockfile = "the lockfile was added or deleted on one side";
    else if (options.regenerateLockfile === false) lockfile = "the host does not run a package manager";
    else if (parseAllDocuments(sides[2]).some(document => document.has("pnpmfileChecksum"))) lockfile = "the lockfile depends on a pnpmfile, which the host does not run";
    else if (!await scriptSafePnpm(target)) lockfile = "the host regenerates lockfiles only with pnpm 9 or newer, whose --ignore-scripts also skips the prepare scripts of Git-hosted dependencies";
    else {
      const path = join(target, "pnpm-lock.yaml");
      const conflictedText = await readFile(path);
      let regenerated: string | undefined;
      try {
        await writeFile(path, sides[2]);
        regenerated = await (options.regenerateLockfile ?? (directory => regenerateGitHubPnpmLockfile(directory, options.signal, { slots: options.slots })))(target);
      } catch (error) {
        if (options.signal?.aborted) throw error;
        lockfile = (error instanceof Error ? error.message : String(error)).replace(/\s+/g, " ").slice(0, 300);
      }
      const lost = regenerated === undefined ? undefined : lockfileChoices(sides[0], sides[1], sides[2], regenerated);
      if (lost && !lost.length) await stage("pnpm-lock.yaml", regenerated!, "pnpm-lockfile");
      else {
        if (lost) lockfile = `the PR's lockfile choices conflict with the base or are missing after regeneration: ${lost.slice(0, 5).join(", ")}${lost.length > 5 ? ` and ${lost.length - 5} more` : ""}`;
        // The index still holds the unmerged stages; restore the markers the model resolves.
        await writeFile(path, conflictedText);
      }
    }
  }
  const done = new Set(resolved.map(item => item.path));
  return { conflicted, resolved, remaining: conflicted.filter(path => !done.has(path)), ...(lockfile ? { lockfile } : {}) };
}

/**
 * Regeneration resolves dependencies the base lockfile never listed. pnpm 7 and older run the `prepare`
 * script of a Git-hosted dependency even with --ignore-scripts, so only pnpm 9 or newer, or the host's
 * default when package.json selects none, may resolve on the host.
 */
async function scriptSafePnpm(target: string): Promise<boolean> {
  let manifest: unknown;
  try { manifest = JSON.parse(await readFile(join(target, "package.json"), "utf8")); }
  catch { return false; }
  const packageManager = isRuntimeRecord(manifest) ? manifest.packageManager : undefined;
  if (packageManager === undefined) return true;
  const major = typeof packageManager === "string" ? /^pnpm@(\d+)\./.exec(packageManager)?.[1] : undefined;
  return major !== undefined && Number(major) >= 9;
}

/** Files that pnpm reads as dependency inputs. While one is conflicted, the lockfile cannot be regenerated. */
function dependencyInput(path: string): boolean {
  return ["package.json", "pnpm-workspace.yaml", ".npmrc", ".pnpmfile.cjs", ".pnpmfile.mjs"].includes(basename(path)) || path.startsWith("patches/");
}

/** Prose where two sides adding text at the same place can both be kept. Code never qualifies. */
function unionDocument(path: string): boolean {
  return /^docs\/.+\.md$/.test(path) || /^packages\/[^/]+\/README\.md$/.test(path);
}

const markerSize = 41;
const markers = { ours: `${"<".repeat(markerSize)} ours`, base: `${"|".repeat(markerSize)} base`, split: "=".repeat(markerSize), theirs: `${">".repeat(markerSize)} theirs` };

/** Keep both sides of every conflict hunk whose merge-base side is empty: base text first, then the PR's. */
async function unionAdditions(git: GitHubConflictGit, entry: Stages, sides: readonly string[]): Promise<string | undefined> {
  const markerLines = new Set(Object.values(markers));
  if (sides.some(side => side.includes("\r") || side.split("\n").some(line => markerLines.has(line)))) return undefined;
  let output: string;
  try {
    output = await git("merge-file", "-p", "--diff3", "--object-id", `--marker-size=${markerSize}`, "-L", "ours", "-L", "base", "-L", "theirs", entry.blobs[2]!, entry.blobs[1]!, entry.blobs[3]!);
  } catch (error) {
    // A positive exit status counts conflicts; stdout still holds the merged text.
    if (!isRuntimeRecord(error) || typeof error.code !== "number" || error.code <= 0 || typeof error.stdout !== "string") throw error;
    output = error.stdout;
  }
  const lines = output.split("\n");
  const result: string[] = [];
  let state: "none" | "ours" | "base" | "theirs" = "none";
  let ours: string[] = [];
  let theirs: string[] = [];
  let hunks = 0;
  // Markdown structure of the merged text so far. A hunk is unioned only at plain block level.
  let block: Block = { kind: "plain", components: 0 };
  let afterHunk = false;
  for (const line of lines) {
    if (state === "base") {
      // A hunk that rewrote base text needs judgment.
      if (line !== markers.split) return undefined;
      state = "theirs";
    } else if (state === "none" && line === markers.ours) {
      // Frontmatter keys, code, table rows and component bodies need a choice, not both sides.
      // A hunk at the top of the file can be frontmatter itself.
      if (!plain(block) || tableRow(result.at(-1)) || !result.length) return undefined;
      [state, ours, theirs] = ["ours", [], []];
    } else if (state === "ours" && line === markers.base) state = "base";
    else if (state === "theirs" && line === markers.theirs) {
      if (competing(ours, theirs) || [ours, theirs].some(side => !plain(side.reduce((current, added) => nextBlock(current, added, false), block)))) return undefined;
      result.push(...theirs, ...ours);
      state = "none";
      afterHunk = true;
      hunks++;
    } else if (markerLines.has(line)) return undefined;
    else if (state === "none") {
      if (afterHunk && tableRow(line)) return undefined;
      afterHunk = false;
      result.push(line);
      block = nextBlock(block, line, result.length === 1);
    } else (state === "ours" ? ours : theirs).push(line);
  }
  return state === "none" && hunks ? result.join("\n") : undefined;
}

interface Block { kind: "plain" | "frontmatter" | "fence" | "html"; fence?: string; components: number }
const plain = (block: Block) => block.kind === "plain" && block.components === 0;
// GFM table rows need no leading pipe ("Key | Value"), so any unescaped pipe counts. Prose rarely has one,
// and refusing it only hands the hunk to the model.
const tableRow = (line: string | undefined) => line !== undefined && /(?:^|[^\\])\|/.test(line);
// Block markers also open inside blockquotes and list items: "> ```sh" starts a fence.
const content = (line: string) => line.replace(/^(?:\s*>)+/, "");

/** Markdown block state after one line: frontmatter, a code fence, an HTML block, or open MDC components. */
function nextBlock(block: Block, line: string, first: boolean): Block {
  if (block.kind === "frontmatter") return /^(?:---|\.\.\.)\s*$/.test(line) ? { ...block, kind: "plain" } : block;
  line = content(line);
  if (block.kind === "fence") {
    const close = /^\s*(`{3,}|~{3,})\s*$/.exec(line)?.[1];
    return close && close[0] === block.fence![0] && close.length >= block.fence!.length ? { kind: "plain", components: block.components } : block;
  }
  if (block.kind === "html") return line.trim() ? block : { kind: "plain", components: block.components };
  if (first && /^---\s*$/.test(line)) return { ...block, kind: "frontmatter" };
  const fence = /^\s*(`{3,}|~{3,})/.exec(line)?.[1];
  if (fence) return { ...block, kind: "fence", fence };
  if (/^\s*<[!?/a-zA-Z]/.test(line)) return { ...block, kind: "html" };
  if (/^\s*:{2,}[\w-]/.test(line)) return { ...block, components: block.components + 1 };
  if (/^\s*:{2,}\s*$/.test(line)) return { ...block, components: Math.max(0, block.components - 1) };
  return block;
}

/**
 * Two additions that look like versions of the same text need a choice, not both: the same heading,
 * or a sentence on one side that is nearly, but not exactly, a sentence on the other.
 */
function competing(ours: string[], theirs: string[]): boolean {
  const headings = new Set(ours.filter(line => /^#{1,6}\s/.test(line)));
  if (theirs.some(line => headings.has(line))) return true;
  const words = (line: string) => new Set(line.toLowerCase().match(/[\p{L}\p{N}`'-]+/gu));
  for (const left of ours) {
    const a = words(left);
    if (a.size < 5) continue;
    for (const right of theirs) {
      const b = words(right);
      if (right === left || b.size < 5) continue;
      const shared = [...a].filter(word => b.has(word)).length;
      if (shared / (a.size + b.size - shared) >= 0.8) return true;
    }
  }
  return false;
}

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
const conflict = Symbol("conflict");
const absent = Symbol("absent");
type Merged = Json | typeof absent | typeof conflict;
/** Keys whose object order changes meaning, such as export conditions. They merge as one value. */
const orderedKeys = new Set(["exports", "imports", "typesVersions"]);

/**
 * Merge package.json changes key by key. Unchanged against changed takes the change, equal changes
 * coalesce, and different changes to the same value leave the whole file conflicted.
 */
function mergePackageJson(base: string, ours: string, theirs: string): string | undefined {
  const texts = [base, ours, theirs];
  const parsed = texts.map(text => { try { return JSON.parse(text) as Json; } catch { return undefined; } });
  const styles = texts.map(jsonStyle);
  // Only files that serialize back byte for byte merge, so the result rewrites nothing else.
  if (parsed.some((value, index) => !isObject(value) || !styles[index] || serialize(value, styles[index]) !== texts[index])) return undefined;
  const merged = mergeValue(parsed[0]!, parsed[1]!, parsed[2]!, false);
  if (merged === conflict || merged === absent) return undefined;
  return serialize(merged, styles[1]!);
}

function mergeValue(base: Json | typeof absent, ours: Json | typeof absent, theirs: Json | typeof absent, atomic: boolean): Merged {
  if (same(ours, theirs)) return ours;
  if (same(base, ours)) return theirs;
  if (same(base, theirs)) return ours;
  if (atomic || !isObject(base) || !isObject(ours) || !isObject(theirs)) return conflict;
  // A reordered object is a change to the object as a whole.
  const order = (value: { [key: string]: Json }) => Object.keys(value).filter(key => Object.hasOwn(base, key) && Object.hasOwn(ours, key) && Object.hasOwn(theirs, key)).join("\0");
  if (order(ours) !== order(base) && order(theirs) !== order(base)) return conflict;
  const keys = keyOrder(order(ours) !== order(base) ? ours : theirs, order(ours) !== order(base) ? theirs : ours);
  const entries: Array<[string, Json]> = [];
  for (const key of keys) {
    const value = mergeValue(read(base, key), read(ours, key), read(theirs, key), orderedKeys.has(key));
    if (value === conflict) return conflict;
    if (value !== absent) entries.push([key, value]);
  }
  return Object.fromEntries(entries);
}

/** Key order of the primary side, with keys only the other side has inserted after their nearest preceding key. */
function keyOrder(primary: { [key: string]: Json }, other: { [key: string]: Json }): string[] {
  const keys = Object.keys(primary);
  let previous: string | undefined;
  for (const key of Object.keys(other)) {
    if (!keys.includes(key)) keys.splice(previous === undefined ? 0 : keys.indexOf(previous) + 1, 0, key);
    previous = key;
  }
  return keys;
}

const read = (value: { [key: string]: Json }, key: string): Json | typeof absent => Object.hasOwn(value, key) ? value[key]! : absent;
const same = (left: Json | typeof absent, right: Json | typeof absent) => left === absent || right === absent ? left === right : JSON.stringify(left) === JSON.stringify(right);
const isObject = (value: unknown): value is { [key: string]: Json } => typeof value === "object" && value !== null && !Array.isArray(value);

function jsonStyle(text: string): { indent: string; newline: boolean } | undefined {
  const indent = /^\{\r?\n([ \t]+)"/.exec(text)?.[1];
  if (indent === undefined) return text.trim() === "{}" ? { indent: "  ", newline: text.endsWith("\n") } : undefined;
  return { indent, newline: text.endsWith("\n") };
}

const serialize = (value: Json, style: { indent: string; newline: boolean }) => `${JSON.stringify(value, null, style.indent)}${style.newline ? "\n" : ""}`;

/**
 * Lockfile choices the PR made against the merge base that the merge cannot keep: the base changed the
 * same entry differently, or the regenerated lockfile resolves it differently. An entry that left the
 * graph, such as a package the base upgraded away, holds no choice. Undefined when a lockfile does not parse.
 */
function lockfileChoices(ancestor: string, ours: string, theirs: string, regenerated: string): string[] | undefined {
  const [before, pr, base, after] = [ancestor, ours, theirs, regenerated].map(lockfileResolutions);
  if (!before || !pr || !base || !after) return undefined;
  const differs = (side: Map<string, string>, key: string, value: string) => side.has(key) && side.get(key) !== value;
  return [...pr].filter(([key, value]) => before.get(key) !== value
    && (differs(base, key, value) && base.get(key) !== before.get(key) || differs(after, key, value))).map(([key]) => key.replaceAll("\0", " "));
}

/**
 * Every choice in a pnpm lockfile: importer and catalog resolutions, package sources and the
 * dependency edges of each snapshot. Versions drop their peer suffix, which changes whenever a peer moves.
 */
function lockfileResolutions(text: string): Map<string, string> | undefined {
  const resolutions = new Map<string, string>();
  const edgeVersions = new Map<string, string[]>();
  const documents = parseAllDocuments(text);
  if (documents.some(document => document.errors.length)) return undefined;
  const version = (value: unknown) => typeof value === "string" ? value.split("(")[0]! : JSON.stringify(value);
  for (const [index, document] of documents.entries()) {
    const data: unknown = document.toJS();
    if (!isRuntimeRecord(data)) continue;
    // pnpm writes its environment lockfile as a document before the project lockfile.
    const prefix = index === documents.length - 1 ? "" : `env${index}\0`;
    const dependency = (value: unknown) => isRuntimeRecord(value) && typeof value.version === "string"
      ? `${String(value.specifier ?? "")} ${version(value.version)}` : JSON.stringify(value);
    const each = (section: unknown, visit: (key: string, value: unknown) => void) => {
      if (isRuntimeRecord(section)) for (const [key, value] of Object.entries(section)) visit(key, value);
    };
    each(data.importers, (importer, fields) => each(fields, (field, dependencies) => {
      if (isRuntimeRecord(dependencies)) each(dependencies, (name, value) => resolutions.set(`${prefix}${importer}\0${field}\0${name}`, dependency(value)));
    }));
    each(data.catalogs, (catalog, dependencies) => each(dependencies, (name, value) => resolutions.set(`${prefix}catalog:${catalog}\0${name}`, dependency(value))));
    each(data.packages, (name, value) => resolutions.set(`${prefix}package\0${name}`, JSON.stringify(isRuntimeRecord(value) ? value.resolution : value)));
    // Which version each package depends on is a choice too: `pnpm update` can move only an edge.
    // Peer variants of one package share their edges, so a peer moving elsewhere renames no choice.
    each(data.snapshots, (name, snapshot) => each(snapshot, (field, edges) => {
      if (field !== "dependencies" && field !== "optionalDependencies") return;
      each(edges, (edge, value) => {
        const key = `${prefix}${version(name)}\0${field}\0${edge}`;
        edgeVersions.set(key, [...edgeVersions.get(key) ?? [], version(value)]);
      });
    }));
  }
  for (const [key, versions] of edgeVersions) resolutions.set(key, [...new Set(versions)].sort().join(" "));
  return resolutions;
}
