import { existsSync } from "node:fs"
import { readdir, readFile, writeFile } from "node:fs/promises"
import { join, posix } from "node:path"

import { formatDiagnostic } from "nostics"

import { viteHubErrorDiagnostics } from "./error-diagnostics.ts"
import { systemdStopTimeoutSeconds } from "./systemd.ts"

/** The build machine. Its OS, CPU, and C library family do not establish native ABI compatibility. */
export interface BuildPlatform {
  arch: string
  libc: "glibc" | "musl" | undefined
  nodeVersion: string
  os: string
}

/** The Dockerfile settings of a build, from `vitehub()`. */
export interface DockerfileBuild {
  /** An absolute `dataDir` from `vitehub()`. */
  dataDir?: string
  drainMs: number
  healthRoute?: string
  /** The deployment name. */
  name: string
}

export interface Dockerfile {
  /** `node:<major>-slim`, or `-alpine` when native packages need musl. */
  baseImage: string
  /** Persistence targets in the container. */
  dataDirs: string[]
  drainMs: number
  /** The health route, when `health` is on. */
  healthRoute?: string
  /** The image name in the usage comment. */
  imageName: string
  hasNativePackages: boolean
  /** `linux/<arch>` when the output has native packages, so the image runs them on the CPU they were built for. */
  platform?: string
}

const appDir = "/app"
const defaultDataDir = `${appDir}/.vitehub`
const dockerArch: Record<string, string> = { arm: "arm/v7", arm64: "arm64", ppc64: "ppc64le", s390x: "s390x", x64: "amd64" }

export function currentBuildPlatform(): BuildPlatform {
  const header = process.platform === "linux" ? (process.report?.getReport() as { header?: { glibcVersionRuntime?: string } } | undefined)?.header : undefined
  return {
    arch: process.arch,
    libc: process.platform === "linux" ? header?.glibcVersionRuntime ? "glibc" : "musl" : undefined,
    nodeVersion: process.versions.node,
    os: process.platform,
  }
}

/**
 * The packages in the server output that hold code for one OS or CPU: a package.json with `os` or `cpu`, as napi-rs
 * and esbuild binaries have, or a compiled `.node` addon.
 */
export async function findNativePackages(serverDir: string): Promise<string[]> {
  const root = join(serverDir, "node_modules")
  if (!existsSync(root)) return []
  const packages = new Set<string>()
  for (const file of await readdir(root, { recursive: true })) {
    const entry = packageEntry(file.replaceAll("\\", "/"))
    if (!entry) continue
    if (entry.file.endsWith(".node")) packages.add(entry.name)
    else if (entry.file === "package.json") {
      const manifest: unknown = JSON.parse(await readFile(join(root, file), "utf8"))
      if (manifest && typeof manifest === "object" && ("os" in manifest || "cpu" in manifest)) packages.add(entry.name)
    }
  }
  return [...packages].sort()
}

/** The innermost package that holds a path below `node_modules`, and the path inside that package. */
function packageEntry(path: string): { file: string, name: string } | undefined {
  const index = path.lastIndexOf("node_modules/")
  const parts = (index === -1 ? path : path.slice(index + "node_modules/".length)).split("/")
  const size = parts[0]!.startsWith("@") ? 2 : 1
  if (parts.length <= size) return
  return { file: parts.slice(size).join("/"), name: parts.slice(0, size).join("/") }
}

/** Docker image names allow lowercase letters, digits, and separators. */
function imageName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^[^a-z0-9]+/, "") || "app"
}

export function resolveDockerfile(options: DockerfileBuild & { nativePackages: readonly string[], platform: BuildPlatform }): Dockerfile {
  const { platform } = options
  const native = options.nativePackages.length > 0 && platform.os === "linux"
  const major = platform.nodeVersion.split(".")[0]
  const arch = native ? dockerArch[platform.arch] : undefined
  const dataDir = posix.normalize(options.dataDir ?? defaultDataDir).replace(/\/$/, "") || "/"
  const coversDefault = dataDir === defaultDataDir || defaultDataDir.startsWith(dataDir === "/" ? dataDir : `${dataDir}/`)
  return {
    baseImage: `node:${major}-${native && platform.libc === "musl" ? "alpine" : "slim"}`,
    dataDirs: coversDefault ? [dataDir] : [defaultDataDir, dataDir],
    drainMs: options.drainMs,
    ...(options.healthRoute ? { healthRoute: options.healthRoute } : {}),
    hasNativePackages: options.nativePackages.length > 0,
    imageName: imageName(options.name),
    ...(arch ? { platform: `linux/${arch}` } : {}),
  }
}

function shellArgument(value: string): string {
  return /^[\w./:-]+$/.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`
}

export function renderDockerfile(dockerfile: Dockerfile): string {
  const stopTimeout = systemdStopTimeoutSeconds(dockerfile.drainMs)
  const volumes = dockerfile.dataDirs.map((dir, index) => `-v ${shellArgument(`${dockerfile.imageName}${index === 0 ? "" : "-custom"}-data:${dir}`)}`).join(" ")
  const health = dockerfile.healthRoute
    ? [
        "const { NITRO_HOST, NITRO_PORT, HOST, PORT } = process.env",
        "const host = NITRO_HOST || HOST || '0.0.0.0'",
        "const address = host === '0.0.0.0' ? '127.0.0.1' : host === '::' ? '[::1]' : host.includes(':') ? '[' + host + ']' : host",
        "const port = Number.parseInt(NITRO_PORT ?? PORT ?? '')",
        `fetch('http://' + address + ':' + (Number.isNaN(port) ? 3000 : port) + ${JSON.stringify(dockerfile.healthRoute)}).then(r => process.exit(r.ok ? 0 : 1), () => process.exit(1))`,
      ].join("; ")
    : undefined
  const lines = [
    // A constant platform is the point here: the native packages in the output run only on this CPU.
    ...(dockerfile.platform ? ["# check=skip=FromPlatformFlagConstDisallowed"] : []),
    "# Generated by ViteHub. The next build replaces this file. Build the image from the build output and run it:",
    `#   docker build -t ${dockerfile.imageName} .output`,
    ...(volumes.includes("\n") || volumes.includes("\r")
      ? ["# Mount a named volume at each path listed in VOLUME."]
      : [`#   docker run --init --stop-timeout ${stopTimeout} -p 3000:3000 --env-file .env ${volumes} ${dockerfile.imageName}`]),
    `# --init reaps child processes. The build-time default stop timeout is ${stopTimeout} seconds.`,
    "# If VITEHUB_SHUTDOWN_DRAIN_MS is set at runtime, use --stop-timeout = ceil(budget in seconds) + 30.",
    ...(dockerfile.platform ? ["# The output has native packages for this CPU, so the image uses the same platform."] : []),
    ...(dockerfile.hasNativePackages ? [
      `# Native ABI compatibility is not inferred. Build the app in ${dockerfile.baseImage} for the target CPU, or use a compatible Linux Node base for both steps.`,
      "# To use the same exact base as the app build, pass --build-arg VITEHUB_NODE_IMAGE=<image-or-digest> to docker build.",
      `ARG VITEHUB_NODE_IMAGE=${dockerfile.baseImage}`,
    ] : []),
    `FROM ${dockerfile.platform ? `--platform=${dockerfile.platform} ` : ""}${dockerfile.hasNativePackages ? "${VITEHUB_NODE_IMAGE}" : dockerfile.baseImage}`,
    `WORKDIR ${appDir}`,
    "COPY . .output/",
    // Relative data paths resolve in the working directory, as in the systemd unit.
    `RUN ${JSON.stringify(["install", "-d", "-o", "node", "-g", "node", ...new Set([appDir, ...dockerfile.dataDirs])])}`,
    "USER node",
    "ENV NODE_ENV=production HOST=0.0.0.0 PORT=3000",
    "EXPOSE 3000",
    `VOLUME ${JSON.stringify(dockerfile.dataDirs)}`,
    // ViteHub drains on SIGTERM and exits once.
    "STOPSIGNAL SIGTERM",
    ...(health ? [
      "# This probe uses HTTP over TCP. For TLS or a Unix socket, use --no-healthcheck or replace the probe.",
      `HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 CMD ${JSON.stringify(["node", "-e", health])}`,
    ] : []),
    `CMD ${JSON.stringify(["node", ".output/server/index.mjs"])}`,
    "",
  ]
  return lines.join("\n")
}

/** Writes `Dockerfile` into the build output. It warns when the output has native packages that a Linux image cannot load. */
export async function writeDockerfile(build: DockerfileBuild, output: { logger: { warn(message: string): void }, outputDir: string, serverDir: string }): Promise<string> {
  const platform = currentBuildPlatform()
  const nativePackages = await findNativePackages(output.serverDir)
  if (nativePackages.length && platform.os !== "linux") {
    output.logger.warn(formatDiagnostic(viteHubErrorDiagnostics.VITE_HUB_DOCKERFILE_NATIVE_PACKAGES_NOT_LINUX({ os: platform.os, packages: nativePackages.join(", ") })))
  }
  const file = join(output.outputDir, "Dockerfile")
  await writeFile(file, renderDockerfile(resolveDockerfile({ ...build, nativePackages, platform })), "utf8")
  return file
}
