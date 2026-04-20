//#region src/config.ts
const knownProviders = new Set(["cloudflare", "vercel"]);
function isPlainObject(value) {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
function cloneSharedOptions(input) {
	const shared = {};
	if (typeof input?.cache === "boolean") shared.cache = input.cache;
	return shared;
}
function normalizeHosting(hosting) {
	return hosting?.trim().toLowerCase().replaceAll("_", "-") || "";
}
function resolveProvider(options, hosting) {
	const provider = options.provider;
	if (typeof provider === "string") {
		if (!knownProviders.has(provider)) throw new TypeError(`Unknown \`queue.provider\`: ${JSON.stringify(provider)}. Expected "cloudflare" or "vercel".`);
		if (provider === "cloudflare") return {
			...cloneSharedOptions(options),
			...typeof options.binding === "string" ? { binding: options.binding } : {},
			provider: "cloudflare"
		};
		return {
			...cloneSharedOptions(options),
			...typeof options.region === "string" ? { region: options.region } : {},
			provider: "vercel"
		};
	}
	if (hosting.includes("cloudflare")) return {
		...cloneSharedOptions(options),
		provider: "cloudflare"
	};
	return {
		...cloneSharedOptions(options),
		...typeof options.region === "string" ? { region: options.region } : {},
		provider: "vercel"
	};
}
function normalizeQueueOptions(options, input = {}) {
	if (options === false) return;
	if (typeof options !== "undefined" && !isPlainObject(options)) throw new TypeError("`queue` must be a plain object.");
	return { provider: resolveProvider(options || {}, normalizeHosting(input.hosting)) };
}
//#endregion
//#region src/integrations/vercel.ts
const textEncoder = new TextEncoder();
const vercelQueueTopicPrefix = "topic--";
function encodeQueueNameHex(name) {
	return [...textEncoder.encode(name)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
function getVercelQueueTopicName(name) {
	return `${vercelQueueTopicPrefix}${encodeQueueNameHex(name)}`;
}
//#endregion
export { normalizeQueueOptions as n, getVercelQueueTopicName as t };
