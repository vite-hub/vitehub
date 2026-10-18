import { createHash, randomUUID } from "node:crypto";
import { maxSatisfying, minVersion, rcompare, valid, validRange } from "semver";

import type {
  BoxResolvedToolchain,
  BoxToolchain,
  BoxToolchainInput,
  BoxToolchainPackageManagerPin,
  BoxToolchainPin,
  BoxToolchainPins,
} from "../index.ts";
import { boxErrorDiagnostics } from "../error-diagnostics.ts";
import { abortable } from "./abortable.ts";
import { isRuntimeString, runtimeRecord } from "./runtime-type.ts";

/** Project files that can pin the toolchain, relative to the project root. */
export const toolchainProjectFiles = ["package.json", ".node-version", ".nvmrc"] as const;

export interface ToolchainPlatform {
  readonly arch: string;
  readonly libc: "glibc" | "musl";
  readonly os: "darwin" | "linux";
}

export interface ToolchainCommandResult {
  readonly exitCode: number;
  readonly stderr: string;
  readonly stdout: string;
}

/**
 * The filesystem and shell where the toolchain is installed. Paths are absolute
 * paths in that filesystem. `run` executes a POSIX `sh` script as the Box user.
 */
export interface ToolchainTarget {
  readonly abortSignal?: AbortSignal;
  /** Content-addressed cache root. Published entries are read-only. */
  readonly cacheRoot: string;
  /** Use a node already on the target PATH when it reports the exact resolved version. */
  readonly reuseExactNode?: boolean;
  /** Directory where verified archives are staged before extraction. */
  readonly scratch: string;
  /** Serialize installs of one cache entry across processes. */
  lock?(key: string): Promise<() => Promise<void>>;
  readProjectFiles(paths: readonly string[]): Promise<Readonly<Record<string, string | undefined>>>;
  run(script: string): Promise<ToolchainCommandResult>;
  write(path: string, contents: Uint8Array): Promise<void>;
}

const defaultNodeDistribution = "https://nodejs.org/dist";
const defaultMuslNodeDistribution = "https://unofficial-builds.nodejs.org/download/release";
const defaultNpmRegistry = "https://registry.npmjs.org";
const indexCacheMilliseconds = 5 * 60_000;
const readyMarker = ".vitehub-toolchain";
const packageManagerNames: ReadonlySet<string> = new Set<BoxToolchainPackageManagerPin["name"]>(["npm", "pnpm", "yarn"]);
const architectures: ReadonlyMap<string, string> = new Map([
  ["aarch64", "arm64"],
  ["amd64", "x64"],
  ["arm64", "arm64"],
  ["armv7l", "armv7l"],
  ["ppc64le", "ppc64le"],
  ["s390x", "s390x"],
  ["x86_64", "x64"],
]);
const toolchainKeys = new Set(["fallbackNode", "node", "packageManager"]);
const indexCache = new Map<string, { expires: number; value: Promise<readonly NodeRelease[]> }>();
const downloads = new Map<string, Promise<Uint8Array>>();
const downloadTimeoutMilliseconds = 10 * 60_000;

interface NodeRelease {
  readonly files?: readonly string[];
  readonly lts: string | false;
  readonly version: string;
}

interface PackageVersionMetadata {
  readonly bin: Readonly<Record<string, string>>;
  readonly integrity: string;
  readonly tarball: string;
}

/** Validate a Box or Driver toolchain declaration. */
export function normalizeToolchain(value: BoxToolchain | undefined, label = "box.toolchain"): BoxToolchainInput | undefined {
  if (value === undefined) return;
  if (value === "project") return Object.freeze({ node: "project", packageManager: "project" });
  const options = runtimeRecord(value);
  if (!options) {
    throw boxErrorDiagnostics.BOX_R0146({ message: `[vitehub] ${label} must be "project" or an object with node, packageManager, or fallbackNode.` });
  }
  const unknown = Object.keys(options).find(key => !toolchainKeys.has(key));
  if (unknown) throw boxErrorDiagnostics.BOX_R0146({ message: `[vitehub] ${label}.${unknown} is not supported. Use node, packageManager, or fallbackNode.` });
  const node = options.node ?? "project";
  const packageManager = options.packageManager ?? "project";
  if (!isVersionText(node)) throw boxErrorDiagnostics.BOX_R0146({ message: `[vitehub] ${label}.node must be "project" or a Node.js version, range, or alias.` });
  if (packageManager !== false && !isVersionText(packageManager)) {
    throw boxErrorDiagnostics.BOX_R0146({ message: `[vitehub] ${label}.packageManager must be "project", false, or a name@version value such as "pnpm@10.2.0".` });
  }
  if (packageManager !== false && packageManager !== "project") parsePackageManager(packageManager, `${label}.packageManager`);
  const fallbackNode = options.fallbackNode;
  if (fallbackNode !== undefined && !isVersionText(fallbackNode)) {
    throw boxErrorDiagnostics.BOX_R0146({ message: `[vitehub] ${label}.fallbackNode must be a Node.js version, range, or alias.` });
  }
  return Object.freeze({
    ...(fallbackNode === undefined ? {} : { fallbackNode: fallbackNode.trim() }),
    node: node.trim(),
    packageManager: packageManager === false ? false : packageManager.trim(),
  });
}

/** Whether pins come from project files. */
export function toolchainReadsProject(toolchain: BoxToolchainInput): boolean {
  return toolchain.node === "project" || toolchain.packageManager === "project";
}

/**
 * Read Node.js and package manager pins. Node.js resolution order:
 * devEngines.runtime, .node-version, .nvmrc, volta.node, engines.node, fallbackNode.
 */
export function readToolchainPins(
  toolchain: BoxToolchainInput,
  files: Readonly<Record<string, string | undefined>>,
): BoxToolchainPins {
  const manifest = parseManifest(files["package.json"]);
  const node = toolchain.node === "project"
    ? projectNodePin(manifest, files) ?? (toolchain.fallbackNode ? { source: "toolchain.fallbackNode", version: toolchain.fallbackNode } : undefined)
    : { source: "toolchain.node", version: toolchain.node };
  if (!node) {
    throw boxErrorDiagnostics.BOX_R0147({ message: "[vitehub] Box toolchain could not find a Node.js version. Add package.json devEngines.runtime, .node-version, .nvmrc, volta.node, or engines.node to the project, or set toolchain.fallbackNode." });
  }
  const packageManager = toolchain.packageManager === false
    ? undefined
    : toolchain.packageManager === "project"
      ? projectPackageManagerPin(manifest)
      : parsePackageManager(toolchain.packageManager, "toolchain.packageManager");
  return Object.freeze({ node: Object.freeze(node), ...(packageManager ? { packageManager: Object.freeze(packageManager) } : {}) });
}

function projectNodePin(
  manifest: Record<string, unknown> | undefined,
  files: Readonly<Record<string, string | undefined>>,
): BoxToolchainPin | undefined {
  const runtime = runtimeRecord(manifest?.devEngines)?.runtime;
  for (const entry of Array.isArray(runtime) ? runtime : runtime ? [runtime] : []) {
    const value = runtimeRecord(entry);
    if (value?.name === "node" && isVersionText(value.version)) {
      return { source: "package.json#devEngines.runtime", version: value.version.trim() };
    }
  }
  for (const file of [".node-version", ".nvmrc"] as const) {
    const version = versionFile(files[file]);
    if (version) return { source: file, version };
  }
  const volta = runtimeRecord(manifest?.volta)?.node;
  if (isVersionText(volta)) return { source: "package.json#volta.node", version: volta.trim() };
  const engines = runtimeRecord(manifest?.engines)?.node;
  if (isVersionText(engines)) return { source: "package.json#engines.node", version: engines.trim() };
}

function projectPackageManagerPin(manifest: Record<string, unknown> | undefined): BoxToolchainPackageManagerPin | undefined {
  if (manifest?.packageManager !== undefined) {
    if (!isRuntimeString(manifest.packageManager)) {
      throw boxErrorDiagnostics.BOX_R0148({ message: "[vitehub] package.json packageManager must be a name@version string." });
    }
    return parsePackageManager(manifest.packageManager, "package.json#packageManager");
  }
  const declared = runtimeRecord(manifest?.devEngines)?.packageManager;
  const entries = Array.isArray(declared) ? declared : declared ? [declared] : [];
  const entry = entries.map(runtimeRecord).find(value => isRuntimeString(value?.name));
  if (!entry) return;
  const source = "package.json#devEngines.packageManager";
  if (!isVersionText(entry.version)) {
    throw boxErrorDiagnostics.BOX_R0148({ message: `[vitehub] ${source} must declare a version for ${String(entry.name)}.` });
  }
  return parsePackageManager(`${String(entry.name)}@${entry.version.trim()}`, source);
}

/** Parse `name@version[+algorithm.hex]`, the package.json packageManager format. */
export function parsePackageManager(value: string, source: string): BoxToolchainPackageManagerPin {
  const match = /^([a-z]+)@([^+\s]+)(?:\+(sha1|sha224|sha256|sha384|sha512)\.([0-9a-fA-F]+))?$/.exec(value.trim());
  if (!match) {
    throw boxErrorDiagnostics.BOX_R0148({ message: `[vitehub] ${source} must be name@version, such as pnpm@10.2.0. Received ${JSON.stringify(value)}.` });
  }
  const [, name, version, algorithm, digest] = match;
  if (name === "bun") {
    throw boxErrorDiagnostics.BOX_R0149({ message: `[vitehub] ${source} selects bun, which the Box toolchain does not provision yet. Install bun in the Box image or set toolchain.packageManager to false.` });
  }
  if (!isPackageManagerName(name)) {
    throw boxErrorDiagnostics.BOX_R0149({ message: `[vitehub] ${source} selects unsupported package manager ${name}. Expected npm, pnpm, or yarn.` });
  }
  if (!valid(version) && !validRange(version)) {
    throw boxErrorDiagnostics.BOX_R0148({ message: `[vitehub] ${source} has an invalid ${name} version: ${version}.` });
  }
  return {
    ...(algorithm ? { integrity: `${algorithm}.${digest!.toLowerCase()}` } : {}),
    name,
    source,
    version: version!,
  };
}

/** Detect the target OS, architecture, and C library with POSIX tools. */
export async function detectToolchainPlatform(target: Pick<ToolchainTarget, "run">): Promise<ToolchainPlatform> {
  const result = await target.run([
    "uname -s",
    "uname -m",
    "if ls /lib/ld-musl-* >/dev/null 2>&1 || (ldd --version 2>&1 | grep -qi musl); then echo musl; else echo glibc; fi",
  ].join("\n"));
  const [system = "", machine = "", libc = ""] = result.stdout.trim().split(/\r?\n/).map(line => line.trim());
  if (result.exitCode !== 0) throw toolchainCommandError("detect the Box platform", result);
  const os = system === "Linux" ? "linux" : system === "Darwin" ? "darwin" : undefined;
  const arch = architectures.get(machine);
  if (!os || !arch) {
    throw boxErrorDiagnostics.BOX_R0150({ message: `[vitehub] Box toolchain does not support ${system || "an unknown OS"} ${machine || "on an unknown architecture"}. Supported systems are Linux and macOS.` });
  }
  return { arch, libc: os === "linux" && libc === "musl" ? "musl" : "glibc", os };
}

/** Official Node.js distribution for the platform. musl builds come from unofficial-builds. */
export function nodeDistribution(
  platform: ToolchainPlatform,
  environment: Readonly<Record<string, string | undefined>> = processEnvironment(),
): {
  archive(version: string): string;
  base: string;
  file: string;
  key(version: string): string;
  url(version: string, file: string): string;
} {
  const musl = platform.libc === "musl";
  const base = trimSlash(musl
    ? environment.VITEHUB_NODE_MUSL_DIST_URL || defaultMuslNodeDistribution
    : environment.VITEHUB_NODE_DIST_URL || defaultNodeDistribution);
  const suffix = `${platform.os}-${platform.arch}${musl ? "-musl" : ""}`;
  return {
    archive: (version: string) => `node-v${version}-${suffix}.tar.gz`,
    base,
    file: musl ? `linux-${platform.arch}-musl` : platform.os === "darwin" ? `osx-${platform.arch}-tar` : `linux-${platform.arch}`,
    key: (version: string) => `node-v${version}-${suffix}`,
    url: (version: string, file: string) => `${base}/v${version}/${file}`,
  };
}

/** Resolve a version, range, or alias to one exact Node.js release. */
export async function resolveNodeVersion(spec: string, platform: ToolchainPlatform, signal?: AbortSignal): Promise<string> {
  const value = spec.trim().replace(/^v(?=\d)/, "");
  const exact = valid(value);
  if (exact) return exact;
  const distribution = nodeDistribution(platform);
  const releases = (await nodeReleases(distribution.base, signal))
    .filter(release => !release.files || release.files.includes(distribution.file));
  const alias = value.toLowerCase();
  const lts = /^lts(?:\/(.+))?$/.exec(alias);
  let match: NodeRelease | undefined;
  if (alias === "node" || alias === "latest" || alias === "current") match = releases[0];
  else if (lts) {
    const name = lts[1] === undefined || lts[1] === "*" ? undefined : lts[1];
    match = releases.find(release => release.lts && (!name || release.lts.toLowerCase() === name));
  }
  else if (validRange(value)) {
    const version = maxSatisfying(releases.map(release => release.version), value);
    match = version ? releases.find(release => release.version === version) : undefined;
  }
  else {
    throw boxErrorDiagnostics.BOX_R0151({ message: `[vitehub] Box toolchain cannot parse Node.js version ${JSON.stringify(spec)}.` });
  }
  if (!match) {
    throw boxErrorDiagnostics.BOX_R0151({ message: `[vitehub] No Node.js release for ${distribution.file} matches ${JSON.stringify(spec)} in ${distribution.base}/index.json.` });
  }
  return match.version;
}

async function nodeReleases(base: string, signal: AbortSignal | undefined) {
  const url = `${base}/index.json`;
  const cached = indexCache.get(url);
  if (cached && cached.expires > Date.now()) return await cached.value;
  const value = fetchBytes(url, "Node.js release index", signal).then((bytes) => {
    const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
    if (!Array.isArray(parsed)) throw new TypeError("index.json is not a list");
    return parsed.flatMap((entry): NodeRelease[] => {
      const record = runtimeRecord(entry);
      const version = isRuntimeString(record?.version) ? valid(record.version) : null;
      if (!version) return [];
      return [{
        ...(Array.isArray(record?.files) ? { files: record.files.filter(isRuntimeString) } : {}),
        lts: isRuntimeString(record?.lts) ? record.lts : false,
        version,
      }];
    }).sort((left, right) => rcompare(left.version, right.version));
  });
  indexCache.set(url, { expires: Date.now() + indexCacheMilliseconds, value });
  value.catch(() => indexCache.delete(url));
  return await value;
}

function registryPackage(name: BoxToolchainPackageManagerPin["name"], version: string) {
  if (name !== "yarn") return name;
  const lowest = valid(version) ?? minVersion(version)?.version;
  return lowest && Number(lowest.split(".")[0]) >= 2 ? "@yarnpkg/cli-dist" : "yarn";
}

function registryUrl(environment = processEnvironment()) {
  return trimSlash(environment.VITEHUB_NPM_REGISTRY_URL || defaultNpmRegistry);
}

async function resolvePackageManagerVersion(pin: BoxToolchainPackageManagerPin, signal: AbortSignal | undefined) {
  const exact = valid(pin.version);
  const name = registryPackage(pin.name, pin.version);
  if (exact) return { name, version: exact };
  const document = runtimeRecord(JSON.parse(new TextDecoder().decode(await fetchBytes(
    `${registryUrl()}/${encodePackageName(name)}`,
    `${name} registry metadata`,
    signal,
    { accept: "application/vnd.npm.install-v1+json" },
  ))));
  const versions = Object.keys(runtimeRecord(document?.versions) ?? {});
  const version = maxSatisfying(versions, pin.version);
  if (!version) {
    throw boxErrorDiagnostics.BOX_R0151({ message: `[vitehub] No ${name} release matches ${JSON.stringify(pin.version)} from ${pin.source}.` });
  }
  return { name, version };
}

async function packageVersionMetadata(name: string, version: string, signal: AbortSignal | undefined): Promise<PackageVersionMetadata> {
  const document = runtimeRecord(JSON.parse(new TextDecoder().decode(await fetchBytes(
    `${registryUrl()}/${encodePackageName(name)}/${encodeURIComponent(version)}`,
    `${name}@${version} registry metadata`,
    signal,
  ))));
  const dist = runtimeRecord(document?.dist);
  const declared = isRuntimeString(document?.bin)
    ? { [name.split("/").at(-1)!]: document.bin }
    : Object.fromEntries(Object.entries(runtimeRecord(document?.bin) ?? {}).flatMap(([command, path]) => isRuntimeString(path) ? [[command, path] as const] : []));
  const bin = Object.fromEntries(Object.entries(declared).map(([command, path]) => [command, path.replace(/^(?:\.\/)+/, "")]));
  if (!isRuntimeString(dist?.tarball) || !isRuntimeString(dist.integrity) || !dist.integrity.startsWith("sha512-")) {
    throw boxErrorDiagnostics.BOX_R0152({ message: `[vitehub] ${name}@${version} registry metadata has no sha512 integrity.` });
  }
  if (!Object.keys(bin).length || Object.entries(bin).some(([command, path]) => !/^[A-Za-z0-9._-]+$/.test(command) || !safeRelativePath(path))) {
    throw boxErrorDiagnostics.BOX_R0152({ message: `[vitehub] ${name}@${version} registry metadata has no usable bin entries.` });
  }
  return { bin, integrity: dist.integrity, tarball: dist.tarball };
}

/**
 * Install the toolchain into the target. Returns PATH entries to prepend, in
 * order. Call verifyToolchain with the final Box environment afterwards.
 */
export async function provisionToolchain(
  toolchain: BoxToolchainInput,
  target: ToolchainTarget,
): Promise<BoxResolvedToolchain> {
  const signal = target.abortSignal;
  const pins = toolchain.pins ?? readToolchainPins(toolchain, await target.readProjectFiles(toolchainProjectFiles));
  const platform = await detectToolchainPlatform(target);
  const distribution = nodeDistribution(platform);
  const nodeVersion = await resolveNodeVersion(pins.node.version, platform, signal);
  const packageManager = pins.packageManager
    ? { pin: pins.packageManager, ...(await resolvePackageManagerVersion(pins.packageManager, signal)) }
    : undefined;
  const nodeKey = distribution.key(nodeVersion);
  // Integrity pins are part of the cache identity. A cached archive created for
  // one pin must never satisfy a different (or invalid) project pin.
  const packageKey = packageManager
    ? `${packageManager.name.replace(/^@/, "").replace("/", "-")}-${packageManager.version}${packageManager.pin.integrity ? `-${packageManager.pin.integrity.replace(/[^A-Za-z0-9_-]/g, "_")}` : ""}`
    : undefined;
  const nodeRoot = joinPath(target.cacheRoot, nodeKey);
  const packageRoot = packageKey ? joinPath(target.cacheRoot, packageKey) : undefined;

  const state = await target.run([
    `test -f ${shellQuote(joinPath(nodeRoot, readyMarker))} && echo node-ready || echo node-missing`,
    packageRoot ? `test -f ${shellQuote(joinPath(packageRoot, readyMarker))} && echo package-ready || echo package-missing` : "echo package-none",
    target.reuseExactNode ? "command -v node >/dev/null 2>&1 && node -v 2>/dev/null || echo none" : "echo none",
  ].join("\n"));
  if (state.exitCode !== 0) throw toolchainCommandError("inspect the toolchain cache", state);
  const [nodeState, packageState, existingNode] = state.stdout.trim().split(/\r?\n/).map(line => line.trim());
  const reuseNode = target.reuseExactNode === true && existingNode === `v${nodeVersion}`;

  if (!reuseNode && nodeState !== "node-ready") {
    await installEntry(target, nodeKey, async () => {
      const file = distribution.archive(nodeVersion);
      const sums = new TextDecoder().decode(await fetchBytes(distribution.url(nodeVersion, "SHASUMS256.txt"), `Node.js ${nodeVersion} SHASUMS256.txt`, signal));
      const expected = sums.split(/\r?\n/).map(line => /^([0-9a-f]{64})\s+\*?(\S+)$/.exec(line.trim())).find(match => match?.[2] === file)?.[1];
      if (!expected) {
        throw boxErrorDiagnostics.BOX_R0151({ message: `[vitehub] Node.js ${nodeVersion} has no ${file} in ${distribution.url(nodeVersion, "SHASUMS256.txt")}.` });
      }
      const url = distribution.url(nodeVersion, file);
      const archive = await download(url, `Node.js ${nodeVersion}`, signal, bytes => {
        const actual = createHash("sha256").update(bytes).digest("hex");
        if (actual !== expected) {
          throw boxErrorDiagnostics.BOX_R0153({ message: `[vitehub] Node.js archive checksum mismatch for ${url}: expected sha256 ${expected}, received ${actual}.` });
        }
      });
      return { archive, metadata: { name: "node", sha256: expected, url, version: nodeVersion } };
    });
  }
  if (packageManager && packageRoot && packageKey && packageState !== "package-ready") {
    const { name, pin, version } = packageManager;
    await installEntry(target, packageKey, async () => {
      const metadata = await packageVersionMetadata(name, version, signal);
      const archive = await download(metadata.tarball, `${name}@${version}`, signal, async bytes => {
        const actual = `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
        if (actual !== metadata.integrity) {
          throw boxErrorDiagnostics.BOX_R0153({ message: `[vitehub] ${name}@${version} integrity mismatch: expected ${metadata.integrity}, received ${actual}.` });
        }
        if (pin.integrity) await verifyPackageManagerHash(pin, name, bytes);
      });
      return {
        archive,
        metadata: { integrity: metadata.integrity, name, url: metadata.tarball, version },
        shims: metadata.bin,
      };
    });
  }

  const bin = [
    ...(packageRoot ? [joinPath(packageRoot, "bin")] : []),
    ...(reuseNode ? [] : [joinPath(nodeRoot, "bin")]),
  ];
  return Object.freeze({
    bin: Object.freeze(bin),
    node: Object.freeze({ source: pins.node.source, version: nodeVersion }),
    ...(packageManager
      ? { packageManager: Object.freeze({ name: pins.packageManager!.name, source: pins.packageManager!.source, version: packageManager.version }) }
      : {}),
  });
}

/**
 * Check the versions that Box commands see. `run` must use the final Box
 * environment, so login profiles that reset PATH fail here.
 */
export async function verifyToolchain(
  toolchain: BoxResolvedToolchain,
  cacheRoot: string,
  run: (script: string) => Promise<ToolchainCommandResult>,
): Promise<void> {
  const packageManager = toolchain.packageManager;
  const result = await run([
    `cd -- ${shellQuote(cacheRoot)}`,
    "node -v",
    ...(packageManager ? [`${packageManager.name} --version`] : []),
  ].join(" && "));
  const [node, reported] = result.stdout.trim().split(/\r?\n/).map(line => line.trim());
  if (result.exitCode === 0 && node === `v${toolchain.node.version}` && (!packageManager || reported === packageManager.version)) return;
  const details = result.exitCode === 0
    ? `node -v reported ${node || "<empty>"}${packageManager ? ` and ${packageManager.name} --version reported ${reported || "<empty>"}` : ""}`
    : (result.stderr || result.stdout).trim().slice(0, 1_000) || `exit ${result.exitCode}`;
  throw boxErrorDiagnostics.BOX_R0154({ message: `[vitehub] Box toolchain verification failed for Node.js ${toolchain.node.version}${packageManager ? ` and ${packageManager.name} ${packageManager.version}` : ""}: ${details}` });
}

async function installEntry(
  target: ToolchainTarget,
  key: string,
  prepare: () => Promise<{ archive: Uint8Array; metadata: Record<string, string>; shims?: Readonly<Record<string, string>> }>,
) {
  const release = await target.lock?.(key);
  try {
    target.abortSignal?.throwIfAborted();
    const final = joinPath(target.cacheRoot, key);
    if (release) {
      const ready = await target.run(`test -f ${shellQuote(joinPath(final, readyMarker))}`);
      if (ready.exitCode === 0) return;
    }
    const { archive, metadata, shims } = await prepare();
    const archivePath = joinPath(target.scratch, `.vitehub-toolchain-${randomUUID()}.tgz`);
    await target.write(archivePath, archive);
    target.abortSignal?.throwIfAborted();
    const result = await target.run(installScript({ archive: archivePath, cacheRoot: target.cacheRoot, key, metadata, shims }));
    if (result.exitCode !== 0) throw toolchainCommandError(`install ${key}`, result);
  }
  finally {
    await release?.();
  }
}

/**
 * Extract into a private staging directory, then publish with an atomic
 * symbolic link. A concurrent installer that loses the race keeps the winner.
 */
export function installScript(options: {
  archive: string;
  cacheRoot: string;
  key: string;
  metadata: Record<string, string>;
  /** Package bin entries: command name to package-relative path. */
  shims?: Readonly<Record<string, string>>;
}): string {
  const final = joinPath(options.cacheRoot, options.key);
  const lines = [
    "set -eu",
    "umask 022",
    `archive=${shellQuote(options.archive)}`,
    `cache=${shellQuote(options.cacheRoot)}`,
    `final=${shellQuote(final)}`,
    `if [ -f "$final/${readyMarker}" ]; then rm -f -- "$archive"; exit 0; fi`,
    `mkdir -p -- "$cache/.store"`,
    `staging=$(mktemp -d "$cache/.store/${options.key}.XXXXXX")`,
    `cleanup() { chmod -R u+w -- "$staging" 2>/dev/null || true; rm -rf -- "$staging" "$archive"; }`,
    "trap cleanup EXIT HUP INT TERM",
  ];
  if (options.shims) {
    lines.push(
      `mkdir -- "$staging/package" "$staging/bin"`,
      `tar -xzf "$archive" -C "$staging/package" --strip-components=1`,
    );
    for (const [command, path] of Object.entries(options.shims)) {
      const shim = `"$staging/bin/"${shellQuote(command)}`;
      // Shims resolve node from PATH, where the toolchain node comes first.
      lines.push(
        `test -f "$staging/package/"${shellQuote(path)}`,
        `printf '%s\\n' '#!/bin/sh' ${shellQuote(`exec node ${shellQuote(joinPath(final, "package", path))} "$@"`)} > ${shim}`,
        `chmod 755 ${shim}`,
      );
    }
  }
  else {
    lines.push(`tar -xzf "$archive" -C "$staging" --strip-components=1`, `test -x "$staging/bin/node"`);
  }
  lines.push(
    `printf '%s\\n' ${shellQuote(JSON.stringify(options.metadata))} > "$staging/${readyMarker}"`,
    `chmod -R a-w -- "$staging"`,
    `if ln -sn ".store/$(basename -- "$staging")" "$final" 2>/dev/null; then trap - EXIT HUP INT TERM; rm -f -- "$archive"; exit 0; fi`,
    `test -f "$final/${readyMarker}"`,
  );
  return `${lines.join("\n")}\n`;
}

async function verifyPackageManagerHash(pin: BoxToolchainPackageManagerPin, name: string, tarball: Uint8Array) {
  const [algorithm = "", expected = ""] = pin.integrity?.split(".") ?? [];
  // Corepack hashes the yarn.js bundle for Yarn 2+, and the registry tarball otherwise.
  const contents = name === "@yarnpkg/cli-dist" ? await tarEntry(tarball, "bin/yarn.js") : tarball;
  const actual = contents ? createHash(algorithm).update(contents).digest("hex") : undefined;
  if (actual !== expected) {
    throw boxErrorDiagnostics.BOX_R0153({ message: `[vitehub] ${pin.name}@${pin.version} does not match the ${algorithm} hash from ${pin.source}: expected ${expected}, received ${actual ?? "<missing>"}.` });
  }
}

/** Read one regular file from a gzipped npm package tarball. */
async function tarEntry(gzipped: Uint8Array, path: string): Promise<Uint8Array | undefined> {
  const stream = new Blob([Uint8Array.from(gzipped)]).stream().pipeThrough(new DecompressionStream("gzip"));
  const bytes = new Uint8Array(await new Response(stream).arrayBuffer());
  const decoder = new TextDecoder();
  const field = (offset: number, length: number) => decoder.decode(bytes.subarray(offset, offset + length)).replace(/\0.*$/s, "");
  let longName: string | undefined;
  for (let offset = 0; offset + 512 <= bytes.length;) {
    const name = field(offset, 100);
    if (!name) break;
    const size = Number.parseInt(field(offset + 124, 12).trim() || "0", 8);
    const type = field(offset + 156, 1);
    const prefix = field(offset + 345, 155);
    const data = offset + 512;
    const entryName = longName ?? (prefix ? `${prefix}/${name}` : name);
    longName = undefined;
    if (type === "x" || type === "L") {
      const text = decoder.decode(bytes.subarray(data, data + size));
      longName = type === "L" ? text.replace(/\0.*$/s, "") : /(?:^|\n)\d+ path=([^\n]*)\n/.exec(text)?.[1];
    }
    else if ((type === "0" || type === "") && entryName.split("/").slice(1).join("/") === path) {
      return bytes.subarray(data, data + size);
    }
    offset = data + Math.ceil(size / 512) * 512;
  }
}

async function download(url: string, label: string, signal: AbortSignal | undefined, verify: (bytes: Uint8Array) => void | Promise<void>) {
  // Concurrent sessions in one process share a download. The cache lock covers other processes.
  let pending = downloads.get(url);
  if (!pending) {
    // The shared request outlives one caller's cancellation, so it uses its own deadline.
    pending = fetchBytes(url, label, AbortSignal.timeout(downloadTimeoutMilliseconds));
    downloads.set(url, pending);
    void pending.then(() => downloads.delete(url), () => downloads.delete(url));
  }
  const bytes = await abortable(pending, signal);
  await verify(bytes);
  return bytes;
}

async function fetchBytes(url: string, label: string, signal: AbortSignal | undefined, headers?: Record<string, string>) {
  let response: Response;
  try {
    response = await fetch(url, { headers, signal });
  }
  catch (error) {
    signal?.throwIfAborted();
    throw boxErrorDiagnostics.BOX_R0155({ message: `[vitehub] Box toolchain could not download ${label} from ${url}: ${error instanceof Error ? error.message : String(error)}`, cause: error });
  }
  if (!response.ok) {
    throw boxErrorDiagnostics.BOX_R0155({ message: `[vitehub] Box toolchain could not download ${label} from ${url}: HTTP ${response.status}.` });
  }
  return new Uint8Array(await response.arrayBuffer());
}

function toolchainCommandError(operation: string, result: ToolchainCommandResult) {
  const detail = (result.stderr || result.stdout).trim().slice(0, 1_000);
  return boxErrorDiagnostics.BOX_R0154({ message: `[vitehub] Box toolchain failed to ${operation} (exit ${result.exitCode})${detail ? `: ${detail}` : "."}` });
}

/** Read project files through a POSIX shell. Missing files resolve to undefined. */
export async function readProjectFilesWithShell(
  run: (script: string) => Promise<ToolchainCommandResult>,
  directory: string,
  paths: readonly string[],
): Promise<Record<string, string | undefined>> {
  const marker = `vitehub-${randomUUID()}`;
  const result = await run(paths.map(path => {
    const file = shellQuote(joinPath(directory, path));
    return `if [ -f ${file} ]; then printf '%s\\n' ${shellQuote(`${marker}:file`)}; base64 < ${file} | tr -d '\\n'; printf '\\n'; else printf '%s\\n\\n' ${shellQuote(`${marker}:missing`)}; fi`;
  }).join("\n"));
  if (result.exitCode !== 0) throw toolchainCommandError("read project files", result);
  const lines = result.stdout.split("\n");
  const files: Record<string, string | undefined> = {};
  paths.forEach((path, index) => {
    const state = lines[index * 2];
    if (state !== `${marker}:file` && state !== `${marker}:missing`) throw toolchainCommandError("read project files", result);
    files[path] = state === `${marker}:file` ? Buffer.from(lines[index * 2 + 1] ?? "", "base64").toString("utf8") : undefined;
  });
  return files;
}

function parseManifest(text: string | undefined) {
  if (text === undefined) return;
  try {
    const value = runtimeRecord(JSON.parse(text));
    if (value) return value;
  }
  catch {}
  throw boxErrorDiagnostics.BOX_R0148({ message: "[vitehub] Box toolchain cannot parse package.json as a JSON object." });
}

function versionFile(text: string | undefined) {
  const line = text?.split(/\r?\n/).map(value => value.replace(/#.*$/, "").trim()).find(Boolean);
  return line || undefined;
}

function isVersionText(value: unknown): value is string {
  return isRuntimeString(value) && Boolean(value.trim()) && !/[\0\n\r]/.test(value);
}

function isPackageManagerName(value: string | undefined): value is BoxToolchainPackageManagerPin["name"] {
  return value !== undefined && packageManagerNames.has(value);
}

function safeRelativePath(path: string) {
  const normalized = path.replace(/^\.\//, "");
  return Boolean(normalized) && !normalized.startsWith("/") && !normalized.split("/").includes("..") && !/[\0\n\r]/.test(normalized);
}

function encodePackageName(name: string) {
  return name.startsWith("@") ? `@${encodeURIComponent(name.slice(1))}` : encodeURIComponent(name);
}

function joinPath(...parts: string[]) {
  return parts.join("/").replace(/\/{2,}/g, "/");
}

function trimSlash(value: string) {
  return value.replace(/\/+$/, "");
}

function processEnvironment(): Readonly<Record<string, string | undefined>> {
  return globalThis.process?.env ?? {};
}

export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}
