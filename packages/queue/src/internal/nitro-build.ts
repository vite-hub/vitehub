import { existsSync } from "node:fs"
import { mkdir, rm, writeFile } from "node:fs/promises"
import { basename, dirname, relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"

import { build as bundle } from "esbuild"

import { normalizeQueueOptions } from "../config.ts"
import { discoverQueueDefinitions } from "../discovery.ts"
import { getVercelQueueTopicName } from "../integrations/vercel.ts"

import type { QueueModuleOptions } from "../types.ts"

export const generatedDirSegments = [".vitehub", "queue"] as const

const currentFileDir = dirname(fileURLToPath(import.meta.url))
const packageDir = resolve(currentFileDir, basename(currentFileDir) === "internal" ? "../.." : "..")

function createImportPath(fromFile: string, targetFile: string) {
  const importPath = relative(dirname(fromFile), targetFile).replace(/\\/g, "/")
  return importPath.startsWith(".") ? importPath : `./${importPath}`
}

function resolveRuntimeModule(modulePath: string) {
  const distFile = resolve(packageDir, "dist", `${modulePath}.js`)
  return existsSync(distFile) ? distFile : resolve(packageDir, "src", `${modulePath}.ts`)
}

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

function createNodeFunctionConfig(extra: Record<string, unknown> = {}) {
  return {
    handler: "index.mjs",
    launcherType: "Nodejs",
    runtime: "nodejs24.x",
    shouldAddHelpers: false,
    supportsResponseStreaming: true,
    ...extra,
  }
}

function createVercelQueueWrapperContents(file: string, registryFile: string, name: string, queueConfig: false | ReturnType<typeof normalizeQueueOptions>) {
  return [
    "import { H3 } from 'h3'",
    "import { toNodeHandler } from 'h3/node'",
    `import { handleHostedVercelQueueCallback } from ${JSON.stringify(createImportPath(file, resolveRuntimeModule("runtime/hosted")))}`,
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
    "  return runWithQueueRuntimeEvent({ req, res }, () => handler(req, res))",
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

  for (const definition of definitions) {
    const safeName = definition.name.replace(/[^a-z0-9/_-]+/gi, "_")
    const segments = safeName.split("/")
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
