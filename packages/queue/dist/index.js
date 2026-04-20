import { n as normalizeQueueOptions, t as getVercelQueueTopicName } from "./vercel-ajzHk2Wk.js";
import { i as createQueueMessageId, r as QueueError, t as createCloudflareQueueBatchHandler } from "./cloudflare-D4NjTi-M.js";
import { n as getCloudflareQueueDefinitionName, r as getCloudflareQueueName, t as getCloudflareQueueBindingName } from "./cloudflare-Bqp51yQ9.js";
import { a as runQueue, i as getQueue, n as createQueueClient, r as deferQueue, t as handleHostedVercelQueueCallback } from "./hosted-CixlUk6j.js";
import { createQueueCloudflareWorker } from "./runtime/cloudflare-vite.js";
//#region src/definition.ts
const allowedOptions = new Set([
	"cache",
	"callbackOptions",
	"concurrency",
	"onDispatchError",
	"onError"
]);
function validateOptions(options) {
	if (!options) return;
	for (const key of Object.keys(options)) if (!allowedOptions.has(key)) throw new TypeError(`Unknown queue definition option \`${key}\`.`);
	return options;
}
function defineQueue(handler, options) {
	if (typeof handler !== "function") throw new TypeError("`defineQueue()` requires a queue handler.");
	return {
		handler,
		options: validateOptions(options)
	};
}
function createQueue(input) {
	if (!input || typeof input !== "object" || Array.isArray(input)) throw new TypeError("`createQueue()` accepts a single options object with a `handler` property.");
	const { handler, ...options } = input;
	return defineQueue(handler, Object.keys(options).length > 0 ? options : void 0);
}
//#endregion
export { QueueError, createCloudflareQueueBatchHandler, createQueue, createQueueClient, createQueueCloudflareWorker, createQueueMessageId, deferQueue, defineQueue, getCloudflareQueueBindingName, getCloudflareQueueDefinitionName, getCloudflareQueueName, getQueue, getVercelQueueTopicName, handleHostedVercelQueueCallback, normalizeQueueOptions, runQueue };
