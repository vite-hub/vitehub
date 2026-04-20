import { AsyncLocalStorage } from "node:async_hooks";
//#region src/runtime/state.ts
let runtimeConfig;
let registryOverride;
const queueEventStorage = new AsyncLocalStorage();
const queueClientCache = /* @__PURE__ */ new Map();
function setQueueRuntimeConfig(config) {
	runtimeConfig = config;
	queueClientCache.clear();
}
function getQueueRuntimeConfig() {
	return runtimeConfig;
}
function runWithQueueRuntimeEvent(event, callback) {
	return queueEventStorage.run(event, callback);
}
function enterQueueRuntimeEvent(event) {
	queueEventStorage.enterWith(event);
}
function getQueueRuntimeEvent() {
	return queueEventStorage.getStore();
}
function setQueueRuntimeRegistry(registry) {
	registryOverride = registry;
	queueClientCache.clear();
}
function getQueueClientCache() {
	return queueClientCache;
}
async function loadRuntimeRegistry() {
	if (registryOverride) return registryOverride;
	return {};
}
function isQueueDefinition(value) {
	return Boolean(value) && typeof value === "object" && typeof value.handler === "function";
}
async function loadQueueDefinition(name) {
	const entry = (await loadRuntimeRegistry())[name];
	if (!entry) return;
	const loaded = await entry();
	if (isQueueDefinition(loaded)) return loaded;
	if (loaded && typeof loaded === "object" && "default" in loaded && isQueueDefinition(loaded.default)) return loaded.default;
}
//#endregion
export { enterQueueRuntimeEvent, getQueueClientCache, getQueueRuntimeConfig, getQueueRuntimeEvent, loadQueueDefinition, runWithQueueRuntimeEvent, setQueueRuntimeConfig, setQueueRuntimeRegistry };
