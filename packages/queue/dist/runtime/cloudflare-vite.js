import { t as createCloudflareQueueBatchHandler } from "../cloudflare-D4NjTi-M.js";
import { n as getCloudflareQueueDefinitionName } from "../cloudflare-Bqp51yQ9.js";
import { loadQueueDefinition, runWithQueueRuntimeEvent, setQueueRuntimeConfig, setQueueRuntimeRegistry } from "./state.js";
import { createApp, toWebHandler } from "h3";
//#region src/runtime/cloudflare-vite.ts
function setActiveEnv(env) {
	globalThis.__env__ = env;
}
function createRuntimeEvent(env, context) {
	return {
		context: {
			cloudflare: { env },
			waitUntil: typeof context?.waitUntil === "function" ? context.waitUntil.bind(context) : void 0
		},
		env,
		waitUntil: typeof context?.waitUntil === "function" ? context.waitUntil.bind(context) : void 0
	};
}
function resolveQueueAppFetch(queueApp) {
	if (!queueApp) return;
	if (typeof queueApp === "function") return queueApp;
	if (typeof queueApp.request === "function") return (request, context) => queueApp.request(request, void 0, context);
	if (typeof queueApp.fetch === "function") return queueApp.fetch.bind(queueApp);
	throw new TypeError("Invalid Vite queue worker app. Expected an h3 app or a fetch-compatible handler.");
}
function createQueueJob(message, batch) {
	return {
		attempts: typeof message.attempts === "number" ? message.attempts : 1,
		id: message.id,
		metadata: {
			batch,
			message
		},
		payload: message.body
	};
}
function createQueueCloudflareWorker(options = {}) {
	const queueConfig = options.queue;
	const registry = options.registry;
	const defaultHandler = toWebHandler(createApp());
	const appHandler = resolveQueueAppFetch(options.app);
	const applyRuntimeState = () => {
		setQueueRuntimeConfig(queueConfig);
		setQueueRuntimeRegistry(registry);
	};
	return {
		async fetch(request, env, context) {
			applyRuntimeState();
			setActiveEnv(env);
			const runtimeEvent = createRuntimeEvent(env, context);
			return await runWithQueueRuntimeEvent(runtimeEvent, () => Promise.resolve(appHandler ? appHandler(request, runtimeEvent.context) : defaultHandler(request, runtimeEvent.context)));
		},
		async queue(batch, env, context) {
			applyRuntimeState();
			setActiveEnv(env);
			if (queueConfig === false || queueConfig?.provider.provider !== "cloudflare") return;
			const definition = await loadQueueDefinition(getCloudflareQueueDefinitionName(batch.queue));
			if (!definition) return;
			const runtimeEvent = createRuntimeEvent(env, context);
			await createCloudflareQueueBatchHandler({
				concurrency: definition.options?.concurrency,
				onError: definition.options?.onError,
				onMessage: async (message, currentBatch) => {
					await runWithQueueRuntimeEvent(runtimeEvent, async () => {
						await definition.handler(createQueueJob(message, currentBatch));
					});
				}
			})(batch);
		}
	};
}
//#endregion
export { createQueueCloudflareWorker };
