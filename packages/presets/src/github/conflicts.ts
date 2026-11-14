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
    else {
      const path = join(target, "pnpm-lock.yaml");
      const conflictedText = await readFile(path);
      try {
        await writeFile(path, sides[2]);
        const regenerated = await (options.regenerateLockfile ?? (directory => regenerateGitHubPnpmLockfile(directory, options.signal, { slots: options.slots })))(target);
        const lost = lostResolutions(sides[0], sides[1], regenerated);
        if (lost.length) throw new Error(`regeneration dropped resolutions the PR changed: ${lost.slice(0, 5).join(", ")}${lost.length > 5 ? ` and ${lost.length - 5} more` : ""}`);
        await stage("pnpm-lock.yaml", regenerated, "pnpm-lockfile");
      } catch (error) {
        if (options.signal?.aborted) throw error;
        // The index still holds the unmerged stages; restore the markers the model resolves.
        await writeFile(path, conflictedText);
        lockfile = (error instanceof Error ? error.message : String(error)).replace(/\s+/g, " ").slice(0, 300);
      }
    }
  }
  const done = new Set(resolved.map(item => item.path));
  return { conflicted, resolved, remaining: conflicted.filter(path => !done.has(path)), ...(lockfile ? { lockfile } : {}) };
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
  for (const line of lines) {
    if (state === "base") {
      // A hunk that rewrote base text needs judgment.
      if (line !== markers.split) return undefined;
      state = "theirs";
    } else if (state === "none" && line === markers.ours) {
      [state, ours, theirs] = ["ours", [], []];
    } else if (state === "ours" && line === markers.base) state = "base";
    else if (state === "theirs" && line === markers.theirs) {
      if (competing(ours, theirs)) return undefined;
      result.push(...theirs, ...ours);
      state = "none";
      hunks++;
    } else if (markerLines.has(line)) return undefined;
    else (state === "none" ? result : state === "ours" ? ours : theirs).push(line);
  }
  return state === "none" && hunks ? result.join("\n") : undefined;
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
 * Lockfile entries the PR added or changed against the merge base that the regenerated lockfile lacks.
 * Importer and catalog versions drop their peer suffix, which changes whenever a peer moves.
 */
function lostResolutions(base: string, ours: string, regenerated: string): string[] {
  const [before, pr, after] = [base, ours, regenerated].map(lockfileResolutions);
  return [...pr!].filter(([key, value]) => before!.get(key) !== value && after!.get(key) !== value).map(([key]) => key.replaceAll("\0", " "));
}

function lockfileResolutions(text: string): Map<string, string> {
  const resolutions = new Map<string, string>();
  const documents = parseAllDocuments(text);
  for (const [index, document] of documents.entries()) {
    if (document.errors.length) throw new Error("The lockfile is not valid YAML.");
    const data: unknown = document.toJS();
    if (!isRuntimeRecord(data)) continue;
    // pnpm writes its environment lockfile as a document before the project lockfile.
    const prefix = index === documents.length - 1 ? "" : `env${index}\0`;
    const dependency = (value: unknown) => isRuntimeRecord(value) && typeof value.version === "string"
      ? `${String(value.specifier ?? "")} ${value.version.split("(")[0]}` : JSON.stringify(value);
    if (isRuntimeRecord(data.importers)) {
      for (const [importer, fields] of Object.entries(data.importers)) {
        if (!isRuntimeRecord(fields)) continue;
        for (const [field, dependencies] of Object.entries(fields)) {
          if (!isRuntimeRecord(dependencies)) continue;
          for (const [name, value] of Object.entries(dependencies)) resolutions.set(`${prefix}${importer}\0${field}\0${name}`, dependency(value));
        }
      }
    }
    if (isRuntimeRecord(data.catalogs)) {
      for (const [catalog, dependencies] of Object.entries(data.catalogs)) {
        if (!isRuntimeRecord(dependencies)) continue;
        for (const [name, value] of Object.entries(dependencies)) resolutions.set(`${prefix}catalog:${catalog}\0${name}`, dependency(value));
      }
    }
    if (isRuntimeRecord(data.packages)) {
      for (const [name, value] of Object.entries(data.packages)) {
        resolutions.set(`${prefix}package\0${name}`, JSON.stringify(isRuntimeRecord(value) ? value.resolution : value));
      }
    }
  }
  return resolutions;
}
