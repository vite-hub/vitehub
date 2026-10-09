import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { glob, lstat, readdir, readFile, realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { parse } from "yaml";
import { parseSyml } from "@yarnpkg/parsers";
import { hasRuntimeType, isRuntimeRecord } from "../internal/runtime-type.ts";

const inputNames = new Set([".npmrc", ".yarnrc.yml", "package.json", "package-lock.json", "npm-shrinkwrap.json", "pnpm-lock.yaml", "pnpm-workspace.yaml", "yarn.lock"]);
const dependencyFields = new Set(["dependencies", "devDependencies", "optionalDependencies", "peerDependencies", "resolutions", "overrides", "catalog", "catalogs", "patchedDependencies"]);
const sourceFields = new Set(["resolved", "tarball", "resolution", "version", "specifier", "repo"]);
const downloadHosts = new Set(["registry.npmjs.org", "registry.yarnpkg.com", "pkg.pr.new", "github.com", "codeload.github.com"]);

function unwrapYarnVirtualSource(value: string): string {
  return value.replace(/(^|@)(?:virtual:[^#]*#)+/g, "$1");
}

function checkDownloadSource(value: string): void {
  // Yarn's nested protocols can percent-encode their underlying source URL.
  const decoded = unwrapYarnVirtualSource(decodeURIComponent(value));
  if (decoded.includes("\\") && /(?:^|[@:(])https:/i.test(decoded)
    || /(?:^|[@:(])https:(?!\/\/)/i.test(decoded)) throw new Error("Dependency downloads require a trusted HTTPS URL with forward slashes.");
  for (const match of decoded.matchAll(/(?:^|[@:(])([a-z][a-z\d+.-]*):/gi)) {
    if (!["npm", "workspace", "catalog", "file", "link", "portal", "https"].includes(match[1]!.toLowerCase())) throw new Error("Unsupported dependency source protocol; downloads require a trusted HTTPS registry or code host.");
  }
  // Git fetchers prepare remote projects before packing them, which can run
  // unvalidated install scripts even when the final install skips builds.
  const source = decoded.match(/(?:^|[@:(])([a-z][a-z\d+.-]*:\/\/.+)/i)?.[1];
  if (!source && !/(?:^|@)npm:/.test(decoded) && /(?:^|@)(?!\.{1,2}\/)[\w.-]+\/(?!\.{1,2}(?:#|$))[\w.-]+(?:#.*)?$/.test(decoded)) throw new Error("Git dependencies require preparation inside the provider sandbox.");
  if (source && !/^file:/i.test(source)) {
    const url = new URL(source.replace(/^git\+/i, ""));
    if (url.protocol !== "https:" || !downloadHosts.has(url.hostname) || url.port || url.username || url.password) throw new Error("Dependency downloads require a trusted HTTPS registry or code host.");
    const githubArchive = /^\/[^/]+\/[^/]+\/archive\/.+\.(?:tar\.gz|zip)$/i.test(url.pathname)
      || /^\/[^/]+\/[^/]+\/releases\/download\/[^/]+\/.+\.(?:tgz|tar\.gz)$/i.test(url.pathname);
    if (/\.git\/?$/i.test(url.pathname) || url.hostname === "github.com" && !githubArchive) throw new Error("Git dependencies require preparation inside the provider sandbox.");
  } else if (/(?:^|@)git@/i.test(decoded)) throw new Error("Dependency downloads require a trusted HTTPS registry or code host.");
}
const booleanSettings = new Set(["auto-install-peers", "strict-peer-dependencies", "hoist", "shamefully-hoist", "link-workspace-packages", "prefer-workspace-packages", "shared-workspace-lockfile", "package-manager-strict", "legacy-peer-deps", "install-links"]);
const patternSettings = new Set(["hoist-pattern", "public-hoist-pattern"]);
const workspaceFields = new Set(["packages", "catalog", "catalogs", "catalogMode", "overrides", "packageExtensions", "patchedDependencies", "onlyBuiltDependencies", "ignoredBuiltDependencies", "neverBuiltDependencies", "allowBuilds"]);

function supportedSetting(key: string, value: unknown): boolean {
  const normalized = key.replace(/\[\]$/, "").replace(/[A-Z]/g, letter => `-${letter.toLowerCase()}`);
  if (normalized === "link-workspace-packages" && value === "deep") return true;
  if (booleanSettings.has(normalized)) return value === true || value === false || value === "true" || value === "false";
  if (normalized === "node-linker") return value === "isolated" || value === "hoisted" || value === "pnp";
  if (patternSettings.has(normalized)) return Array.isArray(value)
    ? value.every(item => hasRuntimeType(item, "string")) : hasRuntimeType(value, "string");
  return false;
}

function validateNpmConfig(source: string): void {
  for (const line of source.split(/\r?\n/)) {
    const setting = line.trim();
    if (!setting || /^[;#]/.test(setting)) continue;
    const separator = setting.indexOf("=");
    const key = setting.slice(0, separator).trim();
    const value = setting.slice(separator + 1).trim();
    if (separator < 1 || !supportedSetting(key, value)) throw new Error(`Unsupported project npm configuration: ${key || setting}. Host-local configuration paths and package-manager extensions are not allowed.`);
  }
}

export class GitHubDependencyConflictError extends Error {}

/** Validate decoded manifests and lockfiles before a package manager can read host paths. */
export async function validateGitHubInstallInputs(target: string, prepareLinkedBins?: (paths: readonly string[]) => Promise<void>): Promise<string> {
  const hash = createHash("sha256");
  const root = await realpath(target);
  const inside = (path: string) => { const part = relative(root, path); return part !== ".." && !part.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) && !isAbsolute(part); };
  const packageRoots = new Set([root]);
  const pnpm = await stat(join(root, "pnpm-lock.yaml")).then(info => info.isFile(), () => false);
  const npm = !pnpm && (await stat(join(root, "package-lock.json")).then(info => info.isFile(), () => false)
    || await stat(join(root, "npm-shrinkwrap.json")).then(info => info.isFile(), () => false));
  const dependencyFiles = new Set<string>();
  const dependencyDirectories = new Set<string>();
  const linkedDirectories = new Set<string>();
  const linkedBinFiles = new Set<string>();
  async function checkPath(value: string, base: string, workspace = false) {
    // Workspace exclusions still contribute crawler roots. File dependencies
    // use literal paths and must keep their leading exclamation marks.
    let decoded = decodeURIComponent(workspace ? value.replace(/^!+/, "") : value);
    if (decoded.startsWith("//") || /^[a-z]:/i.test(decoded) || decoded.includes("\\") || decoded.startsWith("~")) throw new Error("Host-local dependency paths are not allowed.");
    if (!inside(resolve(base, decoded))) throw new Error("Host-local dependency paths must stay inside the checkout.");
    // Check wildcard prefixes before deeper matching can pass through a symlink.
    const parts = decoded.split("/");
    for (let length = 1; length <= parts.length; length++) {
      const pattern = parts.slice(0, length).join("/");
      if (!/[*?{[]/.test(pattern)) continue;
      for await (const match of glob(pattern, { cwd: base })) {
        if (!inside(await realpath(resolve(base, match)))) throw new Error("Host-local dependency symlinks must stay inside the checkout.");
      }
    }
    // Workspace globs have no realpath; validate the existing prefix as well.
    decoded = decoded.split(/[*?{[]/, 1)[0]!;
    const path = resolve(base, decoded || ".");
    if (!inside(path)) throw new Error("Host-local dependency paths must stay inside the checkout.");
    let current = path;
    for (;;) {
      try {
        const canonical = await realpath(current);
        if (!inside(canonical)) throw new Error("Host-local dependency symlinks must stay inside the checkout.");
        return canonical;
      } catch (error) {
        if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
        const parent = dirname(current);
        if (parent === current) throw error;
        current = parent;
      }
    }
  }
  async function selectLocalPackage(value: string, base: string, copyContents = true) {
    await checkPath(value, base);
    const path = resolve(base, decodeURIComponent(value));
    const info = await stat(path).catch(() => undefined);
    if (info?.isDirectory()) {
      const canonical = await realpath(path);
      packageRoots.add(canonical);
      // Link and portal dependencies read live source files. Installation
      // fingerprints their manifests and command targets, not unrelated output.
      if (copyContents) dependencyDirectories.add(canonical);
      else linkedDirectories.add(canonical);
    }
    else if (info?.isFile()) dependencyFiles.add(path);
  }
  async function selectPatch(value: string, base: string) {
    await checkPath(value, base);
    const path = resolve(base, decodeURIComponent(value));
    if (!(await stat(path)).isFile()) throw new Error("Dependency patches must be regular files.");
    dependencyFiles.add(path);
  }
  async function inspectYarnPatch(value: string, base: string): Promise<boolean> {
    const patch = value.match(/(?:^|@)patch:([^#]+)#(.+?)(?:::.*)?$/i);
    if (!patch) return false;
    await inspect(decodeURIComponent(patch[1]!), base, true);
    for (const source of patch[2]!.split("&")) {
      const path = decodeURIComponent(source).replace(/^optional!/, "");
      if (/^~?builtin<compat\/[a-z\d._/-]+>$/i.test(path)) continue;
      if (!path.startsWith("~/")) {
        await checkPath(encodeURIComponent(path), base);
        throw new Error("Yarn dependency patches must use project-relative ~/ selectors; parent package filesystems cannot be fingerprinted by the host.");
      }
      await selectPatch(encodeURIComponent(path.slice(2)), root);
    }
    return true;
  }
  async function inspectPnpmPatches(value: unknown, base: string) {
    if (!isRuntimeRecord(value)) throw new Error("Dependency patches must be a path mapping.");
    for (const entry of Object.values(value)) {
      const path = hasRuntimeType(entry, "string") ? entry : isRuntimeRecord(entry) ? entry.path : undefined;
      if (!hasRuntimeType(path, "string")) throw new Error("Dependency patches must reference checkout files.");
      await selectPatch(path, base);
    }
  }
  async function inspect(value: unknown, base: string, dependency = false, field = "", npmPackageEntry = false): Promise<void> {
    if (hasRuntimeType(value, "string")) {
      const source = unwrapYarnVirtualSource(value);
      if (source !== value) return await inspect(source, base, dependency, field);
      if (field === "workspaces") { await checkPath(value, base, true); return; }
      if ((dependency || sourceFields.has(field)) && await inspectYarnPatch(value, base)) return;
      if (dependency || sourceFields.has(field)) checkDownloadSource(value);
      if (/^git(?:\+file)?:/i.test(value) && !/^git:\/\//i.test(value)) throw new Error("Host-local Git dependencies are not allowed.");
      const local = value.match(/(?:^|@)(file|link|portal):(.+)/i);
      if (local) await selectLocalPackage(local[2]!, base, local[1]!.toLowerCase() === "file");
      else if ((dependency || ["resolved", "tarball", "directory", "workspaces"].includes(field)) && /^(?:\.{1,2}[/\\]|[/\\]|~(?:[^/\\]*[/\\]|$)|[a-z]:[/\\])/i.test(value)) await selectLocalPackage(value, base);

      else if (field === "directory") await selectLocalPackage(value, base);
      return;
    }
    if (Array.isArray(value)) { for (const entry of value) await inspect(entry, base, dependency, field); return; }
    if (!isRuntimeRecord(value)) return;
    const npmLink = npmPackageEntry && value.link === true;
    if (npmLink) {
      if (!hasRuntimeType(value.resolved, "string") || /^[a-z][a-z\d+.-]*:/i.test(decodeURIComponent(value.resolved))) {
        throw new Error("npm workspace links must reference checkout-relative paths.");
      }
      await selectLocalPackage(value.resolved, root, false);
    }
    for (const [key, entry] of Object.entries(value)) {
      if (npmLink && key === "resolved") continue;
      if (key === "workspaces" && pnpm) continue;
      if (key === "patchedDependencies") {
        await inspectPnpmPatches(entry, base);
      } else if (npm && ["package-lock.json", "npm-shrinkwrap.json"].includes(field) && key === "packages" && isRuntimeRecord(entry)) {
        // npm package locations can be nested below any workspace. Their
        // link semantics come from the lockfile map, not a path prefix.
        for (const [location, contents] of Object.entries(entry)) await inspect(contents, base, false, location, true);
      } else if (key === "importers" && isRuntimeRecord(entry)) {
        for (const [importer, contents] of Object.entries(entry)) {
          await checkPath(importer, base);
          await inspect(contents, resolve(base, importer));
        }
      } else {
        // Yarn lock keys can group descriptors. Each source is validated separately.
        if (dependency || ["yarn.lock", "packages", "snapshots"].includes(field)) {
          for (const descriptor of key.split(/,\s+/)) {
            if (/(?:^|@)(?:file|link|portal):/i.test(descriptor)) await inspect(descriptor, base, true);
            if (/(?:^|@)[a-z][a-z\d+.-]*:/i.test(decodeURIComponent(descriptor)) && !(await inspectYarnPatch(descriptor, base))) checkDownloadSource(descriptor);
          }
        }
        await inspect(entry, base, dependency || dependencyFields.has(key), key === "packages" && field === "workspaces" ? "workspaces" : key);
      }
    }
  }
  async function selectWorkspaces(patterns: unknown, directory: string): Promise<void> {
    if (!Array.isArray(patterns)) return;
    const values = patterns.filter(value => hasRuntimeType(value, "string"));
    for (const value of values) await checkPath(value, directory, true);
    const exclude = ["**/node_modules/**", "**/.git/**", ...values.filter(value => value.startsWith("!")).map(value => value.replace(/^!+/, ""))];
    for (const pattern of values.filter(value => !value.startsWith("!"))) {
      for await (const match of glob(pattern, { cwd: directory, exclude })) {
        const path = resolve(directory, match);
        const canonical = await realpath(path);
        if (!inside(canonical)) throw new Error("Host-local dependency symlinks must stay inside the checkout.");
        if (await stat(path).then(info => info.isDirectory(), () => false)) packageRoots.add(canonical);
      }
    }
  }
  async function visit(directory: string): Promise<void> {
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      if ([".git", "node_modules"].includes(entry.name)) continue;
      // Root npm installs do not read workspace-local project configuration.
      if (npm && entry.name === ".npmrc" && directory !== root) continue;
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        // A package-manager input must be a regular file, so it cannot change targets.
        if (inputNames.has(entry.name)) throw new Error("Dependency inputs must not be symbolic links.");
      } else if (entry.isDirectory()) continue;
      else if (inputNames.has(entry.name)) {
        const source = await readFile(path, "utf8");
        if (/^<{7} /m.test(source)) throw new GitHubDependencyConflictError(`Resolve dependency conflicts in ${relative(root, path)} and call refreshDependencies before validation.`);
        hash.update(relative(root, path)).update("\0").update(source).update("\0");
        if (entry.name === ".npmrc") { validateNpmConfig(source); continue; }
        // Yarn reads only the validated linker from this file. Other settings
        // are omitted from the host configuration and cannot select executables.
        if (entry.name === ".yarnrc.yml") continue;
        let data: unknown;
        if (entry.name === "yarn.lock") {
          // Classic fields have no YAML separators. The native legacy grammar
          // also handles headerless Classic files; modern locks declare metadata.
          data = parseSyml(/^__metadata:/m.test(source) ? source : `# yarn lockfile v1\n${source}`);
          if (!isRuntimeRecord(data) || Object.values(data).some(value => !isRuntimeRecord(value))) throw new Error("Invalid Yarn lockfile stanza; dependency fields must be structured.");
        } else data = entry.name.endsWith(".json") ? JSON.parse(source) : parse(source);
        await inspect(data, directory, false, entry.name);
        if (entry.name === "package.json" && !pnpm && isRuntimeRecord(data)) {
          await selectWorkspaces(Array.isArray(data.workspaces) ? data.workspaces : isRuntimeRecord(data.workspaces) ? data.workspaces.packages : undefined, directory);
        }
        if (entry.name === "pnpm-workspace.yaml" && isRuntimeRecord(data)) {
          for (const [key, value] of Object.entries(data)) {
            if (!workspaceFields.has(key) && !supportedSetting(key, value)) throw new Error(`Unsupported project pnpm configuration: ${key}. Host-local configuration paths and package-manager extensions are not allowed.`);
          }
          if (pnpm) await selectWorkspaces(data.packages ?? ["**"], directory);
        }
      }
    }
  }
  for (const directory of packageRoots) await visit(directory);
  for (const directory of linkedDirectories) {
    const source = await readFile(join(directory, "package.json"), "utf8").catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
      return undefined;
    });
    if (source === undefined) continue;
    const manifest: unknown = JSON.parse(source);
    if (!isRuntimeRecord(manifest) || manifest.bin === undefined) continue;
    const targets = hasRuntimeType(manifest.bin, "string") ? [manifest.bin]
      : isRuntimeRecord(manifest.bin) ? Object.values(manifest.bin) : undefined;
    if (!targets) throw new Error("Linked dependency bin targets must be file paths.");
    for (const target of targets) {
      if (!hasRuntimeType(target, "string") || !target) throw new Error("Linked dependency bin targets must be file paths.");
      const canonical = await checkPath(encodeURIComponent(target), directory);
      const path = resolve(directory, target);
      if ([path, canonical].some(candidate => relative(root, candidate).split(/[\\/]/).includes(".git"))) throw new Error("Linked dependency bin targets must not read Git metadata.");
      linkedBinFiles.add(path);
    }
  }
  await prepareLinkedBins?.([...linkedBinFiles].map(path => relative(root, path)));
  const fingerprintedDirectories = new Set<string>();
  async function collectDependencyFiles(directory: string): Promise<void> {
    if (fingerprintedDirectories.has(directory)) return;
    fingerprintedDirectories.add(directory);
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      // Installed modules and Git metadata are not local package source inputs.
      if (entry.name === "node_modules" || entry.name === ".git") continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await collectDependencyFiles(path);
      else if (entry.isFile()) dependencyFiles.add(path);
      else throw new Error("Local dependency contents must be regular files and directories.");
    }
  }
  for (const directory of dependencyDirectories) await collectDependencyFiles(directory);
  for (const path of [...new Set([...dependencyFiles, ...linkedBinFiles])].sort()) {
    hash.update(relative(root, path)).update("\0");
    const info = linkedBinFiles.has(path) ? await lstat(path).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
      return undefined;
    }) : await stat(path);
    // Package managers skip missing commands; their later appearance changes shims.
    if (!info) { hash.update("missing-bin\0"); continue; }
    if (linkedBinFiles.has(path) && !info.isFile()) throw new Error("Linked dependency bin targets must be regular files.");
    hash.update(info.mode & 0o111 ? "executable\0" : "regular\0");
    for await (const chunk of createReadStream(path)) hash.update(chunk);
    hash.update("\0");
  }
  return hash.digest("hex");
}
