import { n as normalizeQueueOptions, t as getVercelQueueTopicName } from "./vercel-ajzHk2Wk.js";
import { r as getCloudflareQueueName, t as getCloudflareQueueBindingName } from "./cloudflare-Bqp51yQ9.js";
import { existsSync, mkdirSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { basename, dirname, relative, resolve } from "node:path";
import { cp, mkdir, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
//#region src/internal/hosting.ts
function normalizeHosting(hosting) {
	return hosting?.trim().toLowerCase().replaceAll("_", "-") || "";
}
function detectHosting(target) {
	const preset = normalizeHosting(process.env.NITRO_PRESET || target?.preset);
	if (preset.includes("cloudflare") || process.env.CF_PAGES || process.env.CLOUDFLARE_WORKER) return "cloudflare";
	if (preset.includes("vercel") || process.env.VERCEL || process.env.VERCEL_ENV) return "vercel";
}
//#endregion
//#region src/discovery.ts
const queueSuffixPattern = /\.queue\.(?:c|m)?[jt]s$/i;
const ignoredDirs = new Set([
	"node_modules",
	"dist",
	".nitro",
	".output",
	".nuxt",
	".vercel",
	".git",
	".vitehub"
]);
function listQueueFiles(root) {
	if (!existsSync(root)) return [];
	const files = [];
	for (const entry of readdirSync(root, { withFileTypes: true })) {
		if (entry.name.startsWith(".")) continue;
		const absolute = resolve(root, entry.name);
		if (entry.isDirectory() && !entry.isSymbolicLink()) {
			if (ignoredDirs.has(entry.name)) continue;
			files.push(...listQueueFiles(absolute));
			continue;
		}
		if (entry.isFile() && queueSuffixPattern.test(entry.name)) files.push(absolute);
	}
	return files.sort();
}
function normalizeSuffixQueueName(rootDir, file) {
	return relative(rootDir, file).replace(/\\/g, "/").replace(queueSuffixPattern, "");
}
function scanSuffixQueueFiles(rootDir) {
	const files = listQueueFiles(rootDir);
	const definitions = /* @__PURE__ */ new Map();
	for (const file of files) {
		const name = normalizeSuffixQueueName(rootDir, file);
		if (!name) continue;
		const existing = definitions.get(name);
		if (existing) throw new Error(`Duplicate queue name "${name}" from suffix scan:\n  - ${existing.handler}\n  - ${file}`);
		definitions.set(name, {
			handler: file,
			name,
			source: "vite-suffix"
		});
	}
	return [...definitions.values()].sort((left, right) => left.name.localeCompare(right.name));
}
function discoverQueueDefinitions(options) {
	return mergeQueueDefinitions(...[...new Set([options.rootDir, ...options.scanDirs || []].filter(Boolean))].map((root) => scanSuffixQueueFiles(root)));
}
function mergeQueueDefinitions(...sources) {
	const definitions = /* @__PURE__ */ new Map();
	for (const source of sources) {
		if (!source) continue;
		for (const definition of source) {
			const existing = definitions.get(definition.name);
			if (existing && existing.handler !== definition.handler) throw new Error(`Duplicate queue name "${definition.name}" from multiple discovery sources:\n  - ${existing.handler} (${existing.source ?? "unknown"})\n  - ${definition.handler} (${definition.source ?? "unknown"})`);
			if (!existing) definitions.set(definition.name, definition);
		}
	}
	return [...definitions.values()].sort((left, right) => left.name.localeCompare(right.name));
}
function manifestPath(rootDir) {
	return resolve(rootDir, "node_modules", ".vitehub", "queue", "manifest.json");
}
function writeQueueManifest(rootDir, definitions) {
	const file = manifestPath(rootDir);
	mkdirSync(resolve(file, ".."), { recursive: true });
	const temp = `${file}.${process.pid}.tmp`;
	const manifest = {
		definitions,
		generatedAt: (/* @__PURE__ */ new Date()).toISOString(),
		rootDir,
		version: 1
	};
	writeFileSync(temp, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
	renameSync(temp, file);
	return file;
}
function createQueueRegistryContents(registryFile, definitions) {
	return [
		"const registry = {",
		...definitions.map((definition) => {
			const importPath = relative(resolve(registryFile, ".."), definition.handler).replace(/\\/g, "/");
			return `  ${JSON.stringify(definition.name)}: async () => import(${JSON.stringify(importPath.startsWith(".") ? importPath : `./${importPath}`)}),`;
		}),
		"}",
		"",
		"export default registry",
		""
	].join("\n");
}
//#endregion
//#region src/internal/vite-build.ts
const queuePackageName = "@vitehub/queue";
const defaultCompatibilityDate = "2026-04-20";
const generatedDirSegments = [".vitehub", "queue"];
const generatedRegistryFileName = "registry.mjs";
const cloudflareWorkerFileName = "cloudflare-worker.mjs";
const vercelServerFileName = "vercel-server.mjs";
const userWorkerEntryCandidates = [
	resolve("src", "worker.ts"),
	resolve("src", "worker.mts"),
	resolve("src", "worker.js"),
	resolve("src", "worker.mjs")
];
const currentFileDir = dirname(fileURLToPath(import.meta.url));
const packageDir = resolve(currentFileDir, basename(currentFileDir) === "internal" ? "../.." : "..");
function ensureGeneratedDir(rootDir) {
	return resolve(rootDir, ...generatedDirSegments);
}
function createImportPath(fromFile, targetFile) {
	const importPath = relative(dirname(fromFile), targetFile).replace(/\\/g, "/");
	return importPath.startsWith(".") ? importPath : `./${importPath}`;
}
function resolveUserWorkerEntry(rootDir) {
	for (const candidate of userWorkerEntryCandidates) {
		const absolute = resolve(rootDir, candidate);
		if (existsSync(absolute)) return absolute;
	}
}
function toGeneratedWorkerPath(rootDir, filename) {
	return relative(rootDir, resolve(rootDir, ...generatedDirSegments, filename)).replace(/\\/g, "/");
}
function toSafeAppName(rootDir) {
	return basename(rootDir).replace(/[^a-z0-9-]+/gi, "-").replace(/-+/g, "-").replace(/^-|-$/g, "").toLowerCase();
}
function resolveClientDir(rootDir, clientOutDir) {
	return resolve(rootDir, clientOutDir);
}
function resolveRuntimeModule(modulePath) {
	const distFile = resolve(packageDir, "dist", `${modulePath}.js`);
	if (existsSync(distFile)) return distFile;
	return resolve(packageDir, "src", `${modulePath}.ts`);
}
async function writeCloudflareWorkerEntry(rootDir, queue) {
	const generatedDir = ensureGeneratedDir(rootDir);
	await mkdir(generatedDir, { recursive: true });
	const registryFile = resolve(generatedDir, generatedRegistryFileName);
	const cloudflareWorkerFile = resolve(generatedDir, cloudflareWorkerFileName);
	const vercelServerFile = resolve(generatedDir, vercelServerFileName);
	const definitions = discoverQueueDefinitions({ rootDir });
	const userWorkerEntry = resolveUserWorkerEntry(rootDir);
	const queueConfigForCloudflare = normalizeQueueOptions(queue, { hosting: "cloudflare" }) || false;
	const queueConfigForVercel = normalizeQueueOptions(queue, { hosting: "vercel" }) || false;
	await writeFile(registryFile, createQueueRegistryContents(registryFile, definitions), "utf8");
	const workerImports = [`import { createQueueCloudflareWorker } from ${JSON.stringify(createImportPath(cloudflareWorkerFile, resolveRuntimeModule("runtime/cloudflare-vite")))}`, `import queueRegistry from ${JSON.stringify(`./${generatedRegistryFileName}`)}`];
	if (userWorkerEntry) workerImports.push(`import queueApp from ${JSON.stringify(createImportPath(cloudflareWorkerFile, userWorkerEntry))}`);
	await writeFile(cloudflareWorkerFile, [
		...workerImports,
		"",
		`const queueConfig = ${JSON.stringify(queueConfigForCloudflare, null, 2)}`,
		"",
		"export default createQueueCloudflareWorker({",
		userWorkerEntry ? "  app: queueApp," : "",
		"  queue: queueConfig,",
		"  registry: queueRegistry,",
		"})",
		""
	].filter(Boolean).join("\n"), "utf8");
	const vercelImports = [`import { createQueueVercelServer } from ${JSON.stringify(createImportPath(vercelServerFile, resolveRuntimeModule("runtime/vercel-vite")))}`, `import queueRegistry from ${JSON.stringify(`./${generatedRegistryFileName}`)}`];
	if (userWorkerEntry) vercelImports.push(`import queueApp from ${JSON.stringify(createImportPath(vercelServerFile, userWorkerEntry))}`);
	await writeFile(vercelServerFile, [
		...vercelImports,
		"",
		`const queueConfig = ${JSON.stringify(queueConfigForVercel, null, 2)}`,
		"",
		"export default createQueueVercelServer({",
		userWorkerEntry ? "  app: queueApp," : "",
		"  queue: queueConfig,",
		"  registry: queueRegistry,",
		"})",
		""
	].filter(Boolean).join("\n"), "utf8");
	writeQueueManifest(rootDir, definitions);
	return {
		cloudflareWorkerFile,
		definitions,
		generatedDir,
		registryFile,
		vercelServerFile
	};
}
async function bundleEsmEntry(entryFile, outfile, options = {}) {
	await build({
		bundle: true,
		conditions: options.conditions,
		entryPoints: [entryFile],
		external: options.external,
		format: options.format || "esm",
		logLevel: "silent",
		outfile,
		platform: options.platform || "neutral",
		sourcemap: false,
		target: "es2022",
		write: true
	});
}
async function copyClientOutput(clientDir, targetDir) {
	if (resolve(clientDir) === resolve(targetDir)) return;
	await rm(targetDir, {
		force: true,
		recursive: true
	});
	await mkdir(dirname(targetDir), { recursive: true });
	await cp(clientDir, targetDir, { recursive: true });
}
function createCloudflareQueueBindings(definitions) {
	if (!definitions.length) return;
	return {
		consumers: definitions.map((definition) => ({ queue: getCloudflareQueueName(definition.name) })),
		producers: definitions.map((definition) => ({
			binding: getCloudflareQueueBindingName(definition.name),
			queue: getCloudflareQueueName(definition.name)
		}))
	};
}
async function createCloudflareQueueConfig(options = {}) {
	const rootDir = resolve(process.cwd(), options.rootDir || ".");
	const queues = createCloudflareQueueBindings((await writeCloudflareWorkerEntry(rootDir, void 0)).definitions);
	return {
		assets: { run_worker_first: ["/api/*"] },
		compatibility_date: options.compatibilityDate || "2026-04-20",
		compatibility_flags: ["nodejs_compat"],
		main: toGeneratedWorkerPath(rootDir, cloudflareWorkerFileName),
		observability: { enabled: true },
		...queues ? { queues } : {}
	};
}
async function writeCloudflareOutput(rootDir, clientOutDir, artifacts) {
	const clientDir = resolveClientDir(rootDir, clientOutDir);
	const outputRoot = resolve(rootDir, "dist", toSafeAppName(rootDir));
	const workerOutfile = resolve(outputRoot, "index.js");
	await rm(outputRoot, {
		force: true,
		recursive: true
	});
	await mkdir(outputRoot, { recursive: true });
	await bundleEsmEntry(artifacts.cloudflareWorkerFile, workerOutfile, {
		conditions: [
			"workerd",
			"worker",
			"browser",
			"default"
		],
		external: ["@vercel/queue", "node:async_hooks"],
		format: "esm",
		platform: "neutral"
	});
	const wranglerConfig = {
		assets: {
			directory: "../client",
			run_worker_first: ["/api/*"]
		},
		compatibility_date: defaultCompatibilityDate,
		compatibility_flags: ["nodejs_compat"],
		main: "index.js",
		name: toSafeAppName(rootDir),
		observability: { enabled: true },
		...createCloudflareQueueBindings(artifacts.definitions) ? { queues: createCloudflareQueueBindings(artifacts.definitions) } : {}
	};
	await writeFile(resolve(outputRoot, "wrangler.json"), `${JSON.stringify(wranglerConfig, null, 2)}\n`, "utf8");
	await writeFile(resolve(outputRoot, "vitehub.wrangler.deploy.json"), `${JSON.stringify(wranglerConfig, null, 2)}\n`, "utf8");
	if (existsSync(resolve(clientDir, "index.html"))) await copyClientOutput(clientDir, resolve(rootDir, "dist", "client"));
}
function createVercelConfigJson() {
	return {
		version: 3,
		routes: [{ handle: "filesystem" }, {
			src: "/(.*)",
			dest: "/__server"
		}]
	};
}
function createNodeFunctionConfig(extra = {}) {
	return {
		handler: "index.mjs",
		launcherType: "Nodejs",
		runtime: "nodejs24.x",
		shouldAddHelpers: false,
		supportsResponseStreaming: true,
		...extra
	};
}
function createVercelQueueWrapperContents(file, registryFile, name) {
	return [
		"import { createApp, defineEventHandler } from 'h3'",
		"import { toNodeHandler } from 'h3/node'",
		`import { handleHostedVercelQueueCallback } from ${JSON.stringify(createImportPath(file, resolveRuntimeModule("runtime/hosted")))}`,
		`import { loadQueueDefinition, runWithQueueRuntimeEvent, setQueueRuntimeConfig, setQueueRuntimeRegistry } from ${JSON.stringify(createImportPath(file, resolveRuntimeModule("runtime/state")))}`,
		`import queueRegistry from ${JSON.stringify(createImportPath(file, registryFile))}`,
		"",
		"setQueueRuntimeConfig({ provider: { provider: 'vercel' } })",
		"setQueueRuntimeRegistry(queueRegistry)",
		"",
		"const app = createApp()",
		`app.use(defineEventHandler(async (event) => {`,
		`  const definition = await loadQueueDefinition(${JSON.stringify(name)})`,
		"  if (!definition) {",
		"    throw new Error('Missing queue definition.')",
		"  }",
		`  return await handleHostedVercelQueueCallback(event, ${JSON.stringify(name)}, definition)`,
		"}))",
		"",
		"const handler = toNodeHandler(app)",
		"export default function queueHandler(req, res) {",
		"  return runWithQueueRuntimeEvent({ req, res }, () => handler(req, res))",
		"}",
		""
	].join("\n");
}
async function writeVercelOutput(rootDir, clientOutDir, artifacts) {
	const clientDir = resolveClientDir(rootDir, clientOutDir);
	const outputRoot = resolve(rootDir, ".vercel", "output");
	const serverDir = resolve(outputRoot, "functions", "__server.func");
	const serverEntry = resolve(serverDir, "index.mjs");
	const queueRoot = resolve(outputRoot, "functions", "api", "vitehub", "queues", "vercel");
	await rm(outputRoot, {
		force: true,
		recursive: true
	});
	await mkdir(serverDir, { recursive: true });
	await bundleEsmEntry(artifacts.vercelServerFile, serverEntry, {
		external: ["@vercel/queue"],
		format: "esm",
		platform: "node"
	});
	await writeFile(resolve(serverDir, ".vc-config.json"), `${JSON.stringify(createNodeFunctionConfig(), null, 2)}\n`, "utf8");
	await writeFile(resolve(outputRoot, "config.json"), `${JSON.stringify(createVercelConfigJson(), null, 2)}\n`, "utf8");
	await copyClientOutput(clientDir, resolve(outputRoot, "static"));
	for (const definition of artifacts.definitions) {
		const safeName = definition.name.replace(/[^a-z0-9/_-]+/gi, "_");
		const functionDir = resolve(queueRoot, ...safeName.split("/"), `${safeName.split("/").at(-1)}.func`);
		const functionFile = resolve(functionDir, "index.mjs");
		await mkdir(functionDir, { recursive: true });
		await writeFile(functionFile, createVercelQueueWrapperContents(functionFile, artifacts.registryFile, definition.name), "utf8");
		await writeFile(resolve(functionDir, ".vc-config.json"), `${JSON.stringify(createNodeFunctionConfig({ experimentalTriggers: [{
			topic: getVercelQueueTopicName(definition.name),
			type: "queue/v2beta"
		}] }), null, 2)}\n`, "utf8");
	}
}
async function generateProviderOutputs(options) {
	const artifacts = await writeCloudflareWorkerEntry(options.rootDir, options.queue);
	await writeCloudflareOutput(options.rootDir, options.clientOutDir, artifacts);
	await writeVercelOutput(options.rootDir, options.clientOutDir, artifacts);
	return artifacts;
}
//#endregion
//#region src/vite.ts
function mergeNoExternal(current) {
	if (current === true) return true;
	if (!current) return [queuePackageName];
	const values = Array.isArray(current) ? current : [current];
	return values.some((value) => value === "@vitehub/queue") ? values : [...values, queuePackageName];
}
function isQueueServerEnvironment(name, config) {
	return name === "ssr" || config.consumer === "server";
}
function resolveRootDir(configRoot) {
	return resolve(process.cwd(), configRoot || ".");
}
function resolveClientOutDir(userConfig) {
	return typeof userConfig.build?.outDir === "string" ? userConfig.build.outDir : "dist/client";
}
function writeBuildInfo(rootDir, queue) {
	const generatedDir = resolve(rootDir, ".vitehub", "queue");
	mkdirSync(generatedDir, { recursive: true });
	writeFileSync(resolve(generatedDir, "build-state.json"), `${JSON.stringify({
		generatedAt: (/* @__PURE__ */ new Date()).toISOString(),
		hosting: detectHosting({ preset: process.env.NITRO_PRESET }),
		queue: queue || null
	}, null, 2)}\n`, "utf8");
}
function hubQueue() {
	let rawConfig = {};
	let rootDir = process.cwd();
	let command = "serve";
	return {
		name: "@vitehub/queue/vite",
		config(config, env) {
			rawConfig = config;
			rootDir = resolveRootDir(typeof config.root === "string" ? config.root : void 0);
			command = env.command;
			writeBuildInfo(rootDir, config.queue);
		},
		configEnvironment(name, config) {
			if (!isQueueServerEnvironment(name, config)) return;
			return { resolve: { noExternal: mergeNoExternal(config.resolve?.noExternal) } };
		},
		async closeBundle() {
			if (command === "serve") return;
			await generateProviderOutputs({
				clientOutDir: resolveClientOutDir(rawConfig),
				queue: rawConfig.queue,
				rootDir
			});
		}
	};
}
//#endregion
export { createCloudflareQueueConfig, hubQueue };
