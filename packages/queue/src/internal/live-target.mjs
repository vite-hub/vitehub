import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join, relative } from "node:path"

import { pushUnique, queueBindingName } from "@vitehub/internal-ci/cloudflare-binding"
import {
  buildDefinitionForTarget,
  finalizeManifest,
  getLiveTargetDefinitions as sharedGetLiveTargetDefinitions,
  prepareVercelManifest,
  writeManifest,
} from "@vitehub/internal-ci/live-target"

const appPrefix = "vitehub-queue-playground"
const buildEnvPlaceholders = {}

function ensureGeneratedConfig({ framework, outputDir, packageName }) {
  const nitroConfigPath = join(outputDir, "nitro.json")
  if (!existsSync(nitroConfigPath)) {
    throw new Error(`Unable to locate generated Wrangler config for ${packageName}/${framework}.`)
  }
  const nitro = JSON.parse(readFileSync(nitroConfigPath, "utf8"))
  const cloudflare = nitro.config?.cloudflare || {}
  const wrangler = cloudflare.wrangler || {}
  return {
    compatibility_flags: cloudflare.nodeCompat ? ["nodejs_compat"] : [],
    ...wrangler,
  }
}

function collectQueueNames(config) {
  const queues = new Set()
  for (const consumer of config.queues?.consumers || []) {
    if (consumer.queue) queues.add(String(consumer.queue))
  }
  for (const producer of config.queues?.producers || []) {
    if (producer.queue) queues.add(String(producer.queue))
  }
  return [...queues]
}

function normalizeCloudflareConfig({ appName, framework, outputDir, packageName }) {
  const candidates = [
    join(outputDir, "server", "wrangler.deploy.json"),
    join(outputDir, "server", "wrangler.json"),
    join(outputDir, "wrangler.deploy.json"),
    join(outputDir, "wrangler.json"),
  ]

  const sourcePath = candidates.find(candidate => existsSync(candidate))
  const sourceConfig = sourcePath
    ? JSON.parse(readFileSync(sourcePath, "utf8"))
    : ensureGeneratedConfig({ framework, outputDir, packageName })

  const config = {
    ...sourceConfig,
    compatibility_flags: [...new Set([...(sourceConfig.compatibility_flags || []), "nodejs_compat"])],
    main: "index.mjs",
    name: appName,
  }

  if (!config.assets && existsSync(join(outputDir, "public"))) {
    config.assets = { binding: "ASSETS", directory: "../public" }
  }

  const logicalQueues = collectQueueNames(config)
  const queueRenames = new Map(logicalQueues.map(queue => [queue, `${appName}-${queue}`]))

  if (queueRenames.size > 0) {
    config.queues ||= {}
    config.queues.consumers = (config.queues.consumers || []).map(entry => ({
      ...entry,
      queue: queueRenames.get(String(entry.queue)) ?? entry.queue,
    }))
    config.queues.producers = (config.queues.producers || []).map(entry => ({
      ...entry,
      queue: queueRenames.get(String(entry.queue)) ?? entry.queue,
    }))
    for (const [logical, live] of queueRenames) {
      pushUnique(config.queues.consumers, { queue: live }, entry => String(entry.queue))
      pushUnique(
        config.queues.producers,
        { binding: queueBindingName(logical), queue: live },
        entry => `${String(entry.binding)}:${String(entry.queue)}`,
      )
    }
  }

  return { config, queueNames: [...queueRenames.values()] }
}

export function getLiveTargetDefinitions({ packageDir, packageName, workspaceDir }) {
  return sharedGetLiveTargetDefinitions({ appPrefix, buildEnvPlaceholders, packageDir, packageName, workspaceDir })
}

export function prepareLiveDeployTarget({ framework, packageDir, packageName, provider, workspaceDir }) {
  const definition = buildDefinitionForTarget({ appPrefix, buildEnvPlaceholders, framework, packageDir, packageName, provider })
  const playgroundDir = join(workspaceDir, packageDir, "playground", framework)

  if (provider === "cloudflare") {
    const outputDir = join(playgroundDir, ".output")
    const serverDir = join(outputDir, "server")
    mkdirSync(serverDir, { recursive: true })
    const deployConfigPath = join(serverDir, "vitehub.wrangler.deploy.json")
    const { config, queueNames } = normalizeCloudflareConfig({
      appName: definition.appName,
      framework,
      outputDir,
      packageName,
    })
    writeFileSync(deployConfigPath, `${JSON.stringify(config, null, 2)}\n`)

    const manifest = {
      ...definition,
      deployConfigPath: relative(workspaceDir, deployConfigPath),
      deployDir: relative(workspaceDir, serverDir),
      deployMode: "cloudflare-wrangler",
      liveUrlTemplate: `https://${definition.appName}.\${CLOUDFLARE_WORKERS_SUBDOMAIN}.workers.dev`,
      queueNames,
      requiredBuildEnvNames: [],
      requiredDeployEnvNames: [
        "CLOUDFLARE_ACCOUNT_ID",
        "CLOUDFLARE_API_TOKEN",
      ],
      requiredRuntimeEnvNames: ["CLOUDFLARE_WORKERS_SUBDOMAIN"],
    }
    const manifestPath = writeManifest(playgroundDir, provider, manifest)
    return finalizeManifest({ manifest, manifestPath, workspaceDir })
  }

  const { manifest, manifestPath } = prepareVercelManifest({ definition, playgroundDir, workspaceDir })
  return finalizeManifest({ manifest, manifestPath, workspaceDir })
}
