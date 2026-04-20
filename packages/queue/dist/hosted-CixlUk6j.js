import { n as normalizeQueueOptions, t as getVercelQueueTopicName } from "./vercel-ajzHk2Wk.js";
import { a as normalizeQueueEnqueueInput, n as createCloudflareQueueClient, r as QueueError } from "./cloudflare-D4NjTi-M.js";
import { t as getCloudflareQueueBindingName } from "./cloudflare-Bqp51yQ9.js";
import { getQueueClientCache, getQueueRuntimeConfig, getQueueRuntimeEvent, loadQueueDefinition, runWithQueueRuntimeEvent } from "./runtime/state.js";
import { getRequestHeaders, getRequestURL, readRawBody } from "h3";
//#region src/providers/vercel.ts
async function loadVercelQueueClient(region) {
	let module;
	try {
		module = await import("@vercel/queue");
	} catch (error) {
		throw new QueueError(`@vercel/queue load failed. Install it to use the Vercel provider. Original error: ${error instanceof Error ? error.message : error}`, {
			cause: error,
			code: "VERCEL_QUEUE_SDK_LOAD_FAILED",
			provider: "vercel"
		});
	}
	if ("QueueClient" in module && typeof module.QueueClient === "function") return new module.QueueClient(region ? { region } : void 0);
	if (typeof module.send === "function" && typeof module.handleCallback === "function") return {
		handleCallback: module.handleCallback,
		handleNodeCallback: typeof module.handleNodeCallback === "function" ? module.handleNodeCallback : void 0,
		send: module.send
	};
	throw new QueueError("@vercel/queue does not expose the expected queue client API.", {
		code: "VERCEL_QUEUE_SDK_INVALID",
		provider: "vercel"
	});
}
async function createVercelQueueClient(provider) {
	const topic = provider.topic;
	if (!topic) throw new QueueError("Vercel queue topics are derived from discovered queue names. Direct clients require a topic.", {
		code: "VERCEL_TOPIC_RESOLUTION_REQUIRED",
		httpStatus: 400,
		provider: "vercel"
	});
	const client = provider.client || await loadVercelQueueClient(provider.region);
	return {
		provider: "vercel",
		native: client,
		topic,
		async send(input) {
			const normalized = normalizeQueueEnqueueInput(input);
			if (normalized.options.contentType !== void 0) throw new QueueError("Vercel queue does not support enqueue options: contentType.", {
				code: "VERCEL_UNSUPPORTED_ENQUEUE_OPTIONS",
				details: { unsupported: ["contentType"] },
				httpStatus: 400,
				method: "send",
				provider: "vercel"
			});
			return {
				status: "queued",
				messageId: (await client.send(topic, normalized.payload, {
					delaySeconds: normalized.options.delaySeconds,
					idempotencyKey: normalized.options.idempotencyKey || normalized.id,
					region: normalized.options.region,
					retentionSeconds: normalized.options.retentionSeconds
				})).messageId ?? void 0
			};
		},
		callback: client.handleCallback,
		nodeCallback: client.handleNodeCallback || (() => {
			throw new QueueError("@vercel/queue handleNodeCallback is not available on this client.", {
				code: "VERCEL_NODE_CALLBACK_UNAVAILABLE",
				httpStatus: 400,
				provider: "vercel"
			});
		})
	};
}
//#endregion
//#region src/runtime/client.ts
function getCloudflareEnv(event) {
	const target = event;
	return target?.env || target?.context?.cloudflare?.env || target?.context?._platform?.cloudflare?.env || target?.req?.runtime?.cloudflare?.env || globalThis.__env__;
}
function resolveCloudflareBinding(binding, name) {
	if (binding && typeof binding !== "string") return binding;
	const bindingName = binding || getCloudflareQueueBindingName(name);
	const resolved = getCloudflareEnv(getQueueRuntimeEvent())?.[bindingName];
	if (!resolved) return bindingName;
	return resolved;
}
function applyNamedProviderDefaults(name, provider) {
	if (provider.provider === "cloudflare") return {
		...provider,
		binding: resolveCloudflareBinding(provider.binding, name)
	};
	return {
		...provider,
		topic: provider.topic || getVercelQueueTopicName(name)
	};
}
async function createQueueClient(options) {
	if (options.provider === "cloudflare") return createCloudflareQueueClient(options);
	return await createVercelQueueClient(options);
}
function getActiveQueueConfig() {
	const config = getQueueRuntimeConfig();
	if (config === false) return false;
	return config || normalizeQueueOptions(void 0, { hosting: "vercel" });
}
async function createNamedQueueClient(name) {
	const config = getActiveQueueConfig();
	if (config === false) throw new QueueError("Queue is disabled.", {
		code: "QUEUE_DISABLED",
		httpStatus: 400
	});
	const provider = applyNamedProviderDefaults(name, config.provider);
	try {
		return await createQueueClient(provider);
	} catch (error) {
		if (error instanceof QueueError) throw error;
		throw new QueueError(error instanceof Error ? error.message : String(error), {
			cause: error,
			provider: provider.provider
		});
	}
}
async function getQueue(name) {
	const definition = await loadQueueDefinition(name);
	if (!definition) throw new QueueError(`Unknown queue definition: ${name}`, {
		code: "QUEUE_DEFINITION_NOT_FOUND",
		details: { name },
		httpStatus: 404
	});
	const cache = getQueueClientCache();
	const config = getActiveQueueConfig();
	if (definition.options?.cache === false || config === false || config.provider.cache === false || config.provider.provider === "cloudflare") return await createNamedQueueClient(name);
	const existing = cache.get(name);
	if (existing) return await existing;
	const pending = createNamedQueueClient(name).catch((error) => {
		cache.delete(name);
		throw error;
	});
	cache.set(name, pending);
	return await pending;
}
async function runQueue(name, input) {
	if (!await loadQueueDefinition(name)) throw new QueueError(`Unknown queue definition: ${name}`, {
		code: "QUEUE_DEFINITION_NOT_FOUND",
		details: { name },
		httpStatus: 404
	});
	const normalized = normalizeQueueEnqueueInput(input);
	return await (await getQueue(name)).send({
		...normalized.options,
		id: normalized.id,
		payload: normalized.payload
	});
}
function deferQueue(name, input) {
	const request = getQueueRuntimeEvent();
	const task = () => runWithQueueRuntimeEvent(request, () => runQueue(name, input));
	const handleError = async (error) => {
		console.error(`[vitehub] Deferred queue dispatch failed for "${name}"`, error);
		try {
			await (await loadQueueDefinition(name))?.options?.onDispatchError?.(error, { name });
		} catch (hookError) {
			console.error(`[vitehub] onDispatchError hook failed for "${name}"`, hookError);
		}
	};
	const promise = task().catch(handleError);
	if (typeof request?.waitUntil === "function") request.waitUntil(promise);
}
//#endregion
//#region src/runtime/hosted.ts
async function toRequest(event) {
	if (event.request instanceof Request) return event.request;
	const h3Event = event;
	const body = await readRawBody(h3Event);
	return new Request(getRequestURL(h3Event), {
		body: body || void 0,
		headers: getRequestHeaders(h3Event),
		method: event.method || "POST"
	});
}
function createVercelJobHandler(definition) {
	return async (payload, metadata) => {
		const meta = metadata;
		await definition.handler({
			attempts: typeof meta?.deliveryCount === "number" ? meta.deliveryCount : 1,
			id: typeof meta?.messageId === "string" ? meta.messageId : "vercel-message",
			metadata,
			payload
		});
	};
}
async function handleHostedVercelQueueCallback(event, name, definition) {
	const queue = await getQueue(name);
	if (queue.provider !== "vercel") throw new QueueError(`Queue "${name}" resolved to provider "${queue.provider}", expected "vercel".`, {
		code: "VERCEL_PROVIDER_EXPECTED",
		httpStatus: 400,
		provider: queue.provider
	});
	return await queue.callback(createVercelJobHandler(definition), definition.options?.callbackOptions)(await toRequest(event));
}
//#endregion
export { runQueue as a, getQueue as i, createQueueClient as n, deferQueue as r, handleHostedVercelQueueCallback as t };
