//#region src/enqueue.ts
const envelopeKeys = new Set([
	"contentType",
	"delaySeconds",
	"id",
	"idempotencyKey",
	"region",
	"retentionSeconds"
]);
let fallbackCounter = 0;
function createQueueMessageId(prefix = "queue") {
	const uuid = globalThis.crypto?.randomUUID?.();
	if (uuid) return `${prefix}_${uuid}`;
	fallbackCounter = fallbackCounter + 1 >>> 0;
	return `${prefix}_${Date.now().toString(36)}_${fallbackCounter.toString(36)}`;
}
function isQueueEnvelope(input) {
	if (typeof input !== "object" || input === null || Array.isArray(input) || !("payload" in input)) return false;
	for (const key of Object.keys(input)) if (envelopeKeys.has(key)) return true;
	return false;
}
function normalizeQueueEnqueueInput(input) {
	if (!isQueueEnvelope(input)) return {
		id: createQueueMessageId(),
		options: {},
		payload: input
	};
	const { contentType, delaySeconds, id, idempotencyKey, payload, region, retentionSeconds } = input;
	const options = {
		...contentType !== void 0 ? { contentType } : {},
		...delaySeconds !== void 0 ? { delaySeconds } : {},
		...idempotencyKey !== void 0 ? { idempotencyKey } : {},
		...region !== void 0 ? { region } : {},
		...retentionSeconds !== void 0 ? { retentionSeconds } : {}
	};
	return {
		id: typeof id === "string" && id.length > 0 ? id : createQueueMessageId(),
		options,
		payload
	};
}
//#endregion
//#region src/errors.ts
var QueueError = class extends Error {
	code;
	details;
	httpStatus;
	method;
	provider;
	cause;
	constructor(message, metadata = {}) {
		super(message);
		this.name = "QueueError";
		Object.assign(this, metadata);
	}
};
//#endregion
//#region src/providers/cloudflare.ts
function isCloudflareQueueBinding(binding) {
	return Boolean(binding) && typeof binding === "object" && typeof binding.send === "function" && typeof binding.sendBatch === "function";
}
function toSendOptions(options = {}) {
	const unsupported = [options.idempotencyKey !== void 0 ? "idempotencyKey" : void 0, options.retentionSeconds !== void 0 ? "retentionSeconds" : void 0].filter(Boolean);
	if (unsupported.length) throw new QueueError(`Cloudflare queue does not support enqueue options: ${unsupported.join(", ")}.`, {
		code: "CLOUDFLARE_UNSUPPORTED_ENQUEUE_OPTIONS",
		details: { unsupported },
		httpStatus: 400,
		method: "send",
		provider: "cloudflare"
	});
	return {
		contentType: options.contentType,
		delaySeconds: options.delaySeconds
	};
}
function resolveAction(action, message) {
	if (action === "ack") {
		message.ack();
		return;
	}
	if (action && typeof action === "object" && "retry" in action) {
		message.retry(action.retry);
		return;
	}
	message.retry();
}
function createCloudflareQueueBatchHandler(options) {
	const requested = Number(options.concurrency ?? 1);
	const concurrency = Number.isFinite(requested) ? Math.max(1, Math.floor(requested)) : 1;
	return async (batch) => {
		const messages = Array.isArray(batch?.messages) ? batch.messages : [];
		if (!messages.length) return;
		let index = 0;
		const worker = async () => {
			while (index < messages.length) {
				const message = messages[index++];
				try {
					await options.onMessage(message, batch);
					message.ack();
				} catch (error) {
					resolveAction(options.onError ? await options.onError(error, message, batch) : void 0, message);
				}
			}
		};
		await Promise.all(Array.from({ length: Math.min(concurrency, messages.length) }, () => worker()));
	};
}
function createCloudflareQueueClient(provider) {
	if (typeof provider.binding === "undefined" || typeof provider.binding === "string") throw new QueueError(typeof provider.binding === "string" ? "Cloudflare queue binding names require request-scoped runtime resolution." : "Cloudflare queue direct clients require a binding.", {
		code: "CLOUDFLARE_BINDING_RESOLUTION_REQUIRED",
		httpStatus: 400,
		provider: "cloudflare"
	});
	if (!isCloudflareQueueBinding(provider.binding)) throw new QueueError("Invalid Cloudflare queue binding. Expected an object with send() and sendBatch().", {
		code: "CLOUDFLARE_BINDING_INVALID",
		httpStatus: 400,
		provider: "cloudflare"
	});
	const binding = provider.binding;
	return {
		provider: "cloudflare",
		native: binding,
		binding,
		async send(input) {
			const normalized = normalizeQueueEnqueueInput(input);
			await binding.send(normalized.payload, toSendOptions(normalized.options));
			return {
				status: "queued",
				messageId: normalized.id
			};
		},
		async sendBatch(items, options) {
			await binding.sendBatch(items.map((item) => ({
				...item,
				...toSendOptions({
					...options,
					contentType: item.contentType || options?.contentType,
					delaySeconds: item.delaySeconds ?? options?.delaySeconds
				})
			})));
			return items.map(() => ({ status: "queued" }));
		},
		createBatchHandler: createCloudflareQueueBatchHandler
	};
}
//#endregion
export { normalizeQueueEnqueueInput as a, createQueueMessageId as i, createCloudflareQueueClient as n, QueueError as r, createCloudflareQueueBatchHandler as t };
