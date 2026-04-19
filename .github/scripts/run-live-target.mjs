import { existsSync, readFileSync } from "node:fs"
import { basename, resolve } from "node:path"
import { spawnSync } from "node:child_process"
import { pathToFileURL } from "node:url"

function required(name) {
  const value = process.env[name]
  if (!value)
    throw new Error(`Missing required environment variable: ${name}`)
  return value
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env ? { ...process.env, ...options.env } : process.env,
    encoding: "utf8",
    stdio: "pipe",
  })

  if (result.stdout)
    process.stdout.write(result.stdout)
  if (result.stderr)
    process.stderr.write(result.stderr)

  if (result.status !== 0) {
    throw new Error([
      `Command failed: ${command} ${args.join(" ")}`,
      result.error ? String(result.error) : "",
    ].filter(Boolean).join("\n"))
  }

  return result
}

function runOptional(command, args, options = {}) {
  try {
    return run(command, args, options)
  }
  catch (error) {
    process.stderr.write(`${String(error)}\n`)
    return null
  }
}

function ensureEnvNames(names) {
  for (const name of names || [])
    required(name)
}

async function loadLiveTargetModule(packageDir) {
  const workspace = required("GITHUB_WORKSPACE")
  const modulePath = resolve(workspace, packageDir, "src", "internal", "live-target.mjs")
  if (!existsSync(modulePath))
    throw new Error(`Missing live target module for ${packageDir}: ${modulePath}`)
  return await import(pathToFileURL(modulePath).href)
}

async function loadTargetDefinition(context) {
  const liveTargetModule = await loadLiveTargetModule(context.packageDir)
  const definitions = liveTargetModule.getLiveTargetDefinitions({
    packageDir: context.packageDir,
    packageName: context.packageName,
    workspaceDir: context.workspace,
  })
  const definition = definitions.find(candidate =>
    candidate.framework === context.framework && candidate.provider === context.provider,
  )
  if (!definition) {
    throw new Error(`No live target definition found for ${context.packageName}/${context.framework}/${context.provider}.`)
  }
  return { definition, liveTargetModule }
}

function buildLiveTarget(context, definition) {
  run("pnpm", ["--dir", context.packageDir, "build"], { cwd: context.workspace })

  run("pnpm", ["--dir", `${context.packageDir}/playground/${context.framework}`, "run", "build"], {
    cwd: context.workspace,
    env: {
      ...definition.buildEnvPlaceholders,
      NITRO_PRESET: context.provider === "cloudflare" ? "cloudflare-module" : "vercel",
      SANDBOX_PROVIDER: context.packageName === "sandbox" ? context.provider : "",
    },
  })
}

function deployCloudflare(context, manifest) {
  const workspace = context.workspace
  const deployDir = resolve(workspace, manifest.deployDir)
  const deployConfigPath = resolve(workspace, manifest.deployConfigPath)
  ensureEnvNames(manifest.requiredDeployEnvNames)
  ensureEnvNames(manifest.requiredRuntimeEnvNames)

  for (const queueName of manifest.queueNames || []) {
    runOptional("npx", ["wrangler", "queues", "create", queueName], { cwd: deployDir })
  }

  run("npx", ["wrangler", "--cwd", deployDir, "deploy", "--config", basename(deployConfigPath)], {
    cwd: deployDir,
  })

  const liveUrl = manifest.liveUrlTemplate?.replace("${CLOUDFLARE_WORKERS_SUBDOMAIN}", required("CLOUDFLARE_WORKERS_SUBDOMAIN"))
  if (!liveUrl)
    throw new Error(`Missing liveUrlTemplate for ${manifest.packageName}/${manifest.framework}/cloudflare.`)
  return liveUrl
}

function deployVercel(context, manifest) {
  const playgroundDir = resolve(context.workspace, manifest.deployDir)
  ensureEnvNames(manifest.requiredDeployEnvNames)
  run("npx", ["vercel", "link", "--yes", "--project", manifest.appName, "--token", required("VERCEL_TOKEN")], {
    cwd: playgroundDir,
  })

  const linkedProjectPath = resolve(context.workspace, manifest.linkedProjectPath)
  if (!existsSync(linkedProjectPath))
    throw new Error(`Missing Vercel project metadata at ${linkedProjectPath}.`)

  const project = JSON.parse(readFileSync(linkedProjectPath, "utf8"))
  if (!project.orgId || !project.projectId)
    throw new Error(`Incomplete Vercel project metadata: ${JSON.stringify(project)}`)

  const deployArgs = ["vercel", "deploy", "--prod", "--prebuilt", "--yes", "--token", required("VERCEL_TOKEN")]
  const blobToken = process.env.BLOB_READ_WRITE_TOKEN || process.env.VERCEL_BLOB_READ_WRITE_TOKEN || ""
  if (blobToken && (manifest.requiredDeployEnvNames || []).includes("BLOB_READ_WRITE_TOKEN"))
    deployArgs.push("--env", `BLOB_READ_WRITE_TOKEN=${blobToken}`)

  const result = run("npx", deployArgs, {
    cwd: playgroundDir,
    env: {
      VERCEL_ORG_ID: project.orgId,
      VERCEL_PROJECT_ID: project.projectId,
      VERCEL_TEAM_ID: project.orgId,
    },
  })

  const output = `${result.stdout || ""}\n${result.stderr || ""}`
  const production = [...output.matchAll(/Production:\s+(https:\/\/[^\s]+)/g)].at(-1)?.[1]
  const fallback = [...output.matchAll(/https:\/\/[^\s]+\.vercel\.app/g)].at(-1)?.[0]
  const liveUrl = production ?? fallback
  if (!liveUrl)
    throw new Error(`Could not determine Vercel deployment URL for ${manifest.packageName}/${manifest.framework}.`)
  return liveUrl
}

function runLiveE2E(context, liveUrl) {
  run("pnpm", [
    "--dir",
    context.packageDir,
    "test:e2e",
    "--mode",
    "live",
    "--provider",
    context.provider,
    "--framework",
    context.framework,
    "--url",
    liveUrl,
  ], { cwd: context.workspace })
}

const context = {
  framework: required("MATRIX_FRAMEWORK"),
  packageDir: required("MATRIX_PACKAGE_DIR"),
  packageName: required("MATRIX_PACKAGE_NAME"),
  provider: required("MATRIX_PROVIDER"),
  workspace: required("GITHUB_WORKSPACE"),
}

const { definition, liveTargetModule } = await loadTargetDefinition(context)
buildLiveTarget(context, definition)

const manifest = liveTargetModule.prepareLiveDeployTarget({
  framework: context.framework,
  packageDir: context.packageDir,
  packageName: context.packageName,
  provider: context.provider,
  workspaceDir: context.workspace,
})

const liveUrl = manifest.deployMode === "cloudflare-wrangler"
  ? deployCloudflare(context, manifest)
  : deployVercel(context, manifest)

runLiveE2E(context, liveUrl)
