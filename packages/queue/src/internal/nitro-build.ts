import { mkdir, rm, writeFile } from "node:fs/promises"
import { relative, resolve } from "node:path"

import { build as bundle } from "esbuild"

import { computePackageDir, createImportPath, generatedDirSegments as sharedGeneratedDirSegments, resolveRuntimeModule as resolveRuntimeFromPkg } from "@vitehub/internal/build/paths"
import { createNodeFunctionConfig } from "@vitehub/internal/build/vercel-config"

import { normalizeQueueOptions } from "../config.ts"
import { discoverQueueDefinitions } from "../discovery.ts"
import { getVercelQueueTopicName } from "../integrations/vercel.ts"

import type { QueueModuleOptions } from "../types.ts"

export const generatedDirSegments = sharedGeneratedDirSegments("queue")

const packageDir = computePackageDir(import.meta.url)
const resolveRuntimeModule = (modulePath: string) => resolveRuntimeFromPkg(packageDir, modulePath)

async function bundleQueueWrapperEntry(entryFile: string, outfile: string, inject: string[]) {
  await bundle({
    banner: {
      js: 'import { createRequire as __createRequire } from "node:module";\nvar require = __createRequire(import.meta.url);\n',
    },
    bundle: true,
    entryPoints: [entryFile],
    format: "esm",
    inject,
    logLevel: "silent",
    outfile,
    platform: "node",
    sourcemap: false,
    target: "es2022",
    write: true,
  })
}

function sanitizeVercelConsumerName(functionPath: string) {
  let result = ""
  for (const char of functionPath) {
    if (char === "_") {
      result += "__"
    } else if (char === "/") {
      result += "_S"
    } else if (char === ".") {
      result += "_D"
    } else if (/[A-Za-z0-9-]/.test(char)) {
      result += char
    } else {
      result += `_${char.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0")}`
    }
  }
  return result
}

function createVercelQueueWrapperContents(file: string, registryFile: string, name: string, queueConfig: false | ReturnType<typeof normalizeQueueOptions>) {
  return [
    "import { H3 } from 'h3'",
    "import { toNodeHandler } from 'h3/node'",
    `import { handleHostedVercelQueueCallback, hostedVercelWaitUntil } from ${JSON.stringify(createImportPath(file, resolveRuntimeModule("runtime/hosted")))}`,
    `import { loadQueueDefinition, runWithQueueRuntimeEvent, setQueueRuntimeConfig, setQueueRuntimeRegistry } from ${JSON.stringify(createImportPath(file, resolveRuntimeModule("runtime/state")))}`,
    `import queueRegistry from ${JSON.stringify(createImportPath(file, registryFile))}`,
    "",
    `setQueueRuntimeConfig(${JSON.stringify(queueConfig, null, 2)})`,
    "setQueueRuntimeRegistry(queueRegistry)",
    "",
    "const app = new H3()",
    "app.use(async (event) => {",
    `  const definition = await loadQueueDefinition(${JSON.stringify(name)})`,
    "  if (!definition) {",
    "    throw new Error('Missing queue definition.')",
    "  }",
    `  return await handleHostedVercelQueueCallback(event, ${JSON.stringify(name)}, definition)`,
    "})",
    "",
    "const handler = toNodeHandler(app)",
    "export default function queueHandler(req, res) {",
    "  return runWithQueueRuntimeEvent({ req, res, waitUntil: hostedVercelWaitUntil }, () => handler(req, res))",
    "}",
    "",
  ].join("\n")
}

function createQueueAutoImportContents(file: string) {
  return [
    `export { defineQueue, deferQueue, getQueue, runQueue } from ${JSON.stringify(createImportPath(file, resolveRuntimeModule("index")))}`,
    "",
  ].join("\n")
}

export async function writeNitroVercelQueueOutputs(options: {
  outputDir: string
  queue: QueueModuleOptions | undefined
  registryFile: string
  scanDirs: string[]
}) {
  const outputRoot = resolve(options.outputDir)
  const functionsRoot = resolve(outputRoot, "functions")
  const queueRoot = resolve(functionsRoot, "api", "vitehub", "queues", "vercel")
  const queueConfig = normalizeQueueOptions(options.queue, { hosting: "vercel" }) || false
  const definitions = discoverQueueDefinitions({
    mode: "nitro-server-queues",
    scanDirs: options.scanDirs,
  })

  await rm(queueRoot, { force: true, recursive: true })

  if (!definitions.length) {
    return
  }

  const functionDirs = new Map<string, typeof definitions[number]>()
  for (const definition of definitions) {
    const safeName = definition.name.replace(/[^a-z0-9/_-]+/gi, "_")
    const segments = safeName.split("/")
    const functionDirKey = [...segments, `${segments.at(-1)}.func`].join("/")
    const existing = functionDirs.get(functionDirKey)
    if (existing) {
      throw new Error(`Queue names "${existing.name}" and "${definition.name}" collide after Vercel output sanitization:\n  - ${existing.handler}\n  - ${definition.handler}\nResolved output path: ${functionDirKey}`)
    }
    functionDirs.set(functionDirKey, definition)
    const functionDir = resolve(queueRoot, ...segments, `${segments.at(-1)}.func`)
    const functionFile = resolve(functionDir, "index.mjs")
    const wrapperFile = resolve(functionDir, "index.source.mjs")
    const autoImportFile = resolve(functionDir, "queue-auto-imports.mjs")
    const functionPath = relative(functionsRoot, functionDir).replace(/\\/g, "/")
    const consumer = sanitizeVercelConsumerName(functionPath)

    await mkdir(functionDir, { recursive: true })
    await writeFile(wrapperFile, createVercelQueueWrapperContents(wrapperFile, options.registryFile, definition.name, queueConfig), "utf8")
    await writeFile(autoImportFile, createQueueAutoImportContents(autoImportFile), "utf8")
    await bundleQueueWrapperEntry(wrapperFile, functionFile, [autoImportFile])
    await rm(wrapperFile, { force: true })
    await rm(autoImportFile, { force: true })
    await writeFile(resolve(functionDir, ".vc-config.json"), `${JSON.stringify(createNodeFunctionConfig({
      experimentalTriggers: [{
        consumer,
        topic: getVercelQueueTopicName(definition.name),
        type: "queue/v2beta",
      }],
    }), null, 2)}\n`, "utf8")
  }
}
