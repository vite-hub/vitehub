// Source of `deploy.mjs` in the Deno deployment output. It runs without ViteHub packages, so its errors stay plain.
export function denoDeployRunnerSource(deploymentName: string | undefined, entrypoint: string): string {
  return `import { spawn } from "node:child_process"
import { access, cp, mkdtemp, realpath, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, isAbsolute, join, relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const organization = process.env.DENO_DEPLOY_ORG
const app = process.env.DENO_DEPLOY_APP || ${JSON.stringify(deploymentName)}
const region = process.env.DENO_DEPLOY_REGION || "global"
const entrypoint = ${JSON.stringify(entrypoint)}

if (!organization || !app) {
  throw new Error("DENO_DEPLOY_ORG and DENO_DEPLOY_APP are required.")
}

let activeChild

function run(args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn("deno", args, { cwd, stdio: "inherit" })
    activeChild = child
    child.on("error", reject)
    child.on("exit", (code, signal) => {
      activeChild = undefined
      resolve({ code, signal })
    })
  })
}

async function enclosingGitRoot(path) {
  let current = resolve(path)
  while (true) {
    try {
      await access(join(current, ".git"))
      return current
    } catch (error) {
      if (error?.code !== "ENOENT") throw error
    }
    const parent = dirname(current)
    if (parent === current) return
    current = parent
  }
}

function contains(parent, child) {
  const path = relative(parent, child)
  return path === "" || (!path.startsWith("..") && !isAbsolute(path))
}

const sourceRoot = await realpath(fileURLToPath(new URL(".", import.meta.url)))
const uploadRoot = await realpath(await mkdtemp(join(tmpdir(), "vitehub-deno-deploy-")))
const signals = ["SIGINT", "SIGTERM"]
let interrupted = false
const handleSignal = (signal) => {
  interrupted = true
  activeChild?.kill(signal)
  void rm(uploadRoot, { force: true, recursive: true }).finally(() => {
    process.kill(process.pid, signal)
  })
}
for (const signal of signals) process.once(signal, handleSignal)

try {
  if (contains(sourceRoot, uploadRoot) || await enclosingGitRoot(uploadRoot)) {
    throw new Error("Deno deployment staging must be outside the generated output and any enclosing Git repository. Set TMPDIR to an external directory.")
  }
  await cp(sourceRoot, uploadRoot, { recursive: true })

  if (!interrupted) {
    const common = ["--allow-node-modules", "--org", organization, "--app", app]
    const creation = await run(["deploy", "create", ".", "--source", "local", "--do-not-use-detected-build-config", "--runtime-mode", "dynamic", "--entrypoint", entrypoint, "--working-directory", ".", "--region", region, ...common], uploadRoot)
    if (creation.signal != null && !interrupted) {
      throw new Error("deno deploy create exited with " + creation.signal)
    }
    if (!interrupted && creation.code !== 0) {
      const deployment = await run(["deploy", ".", "--prod", "--config", "deno.json", ...common], uploadRoot)
      if (deployment.code !== 0) {
        throw new Error("deno deploy exited with " + (deployment.signal || "code " + deployment.code))
      }
    }
  }
} finally {
  try {
    await rm(uploadRoot, { force: true, recursive: true })
  } finally {
    for (const signal of signals) process.off(signal, handleSignal)
  }
}
`
}
