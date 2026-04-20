//#region src/integrations/cloudflare.ts
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();
const cloudflareQueueNamePrefix = "queue--";
const defaultCloudflareQueueBindingPrefix = "QUEUE";
const encodedCloudflareQueueNamePattern = /^queue--([0-9a-f]{2})+$/i;
function encodeQueueNameHex(name) {
	return [...textEncoder.encode(name)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
function decodeQueueNameHex(hex) {
	const bytes = hex.match(/.{2}/g)?.map((byte) => Number.parseInt(byte, 16)) ?? [];
	if (!bytes.length || bytes.some((byte) => !Number.isFinite(byte))) return;
	return textDecoder.decode(new Uint8Array(bytes));
}
function getCloudflareQueueName(name) {
	return `${cloudflareQueueNamePrefix}${encodeQueueNameHex(name)}`;
}
function getCloudflareQueueBindingName(name) {
	const encoded = encodeQueueNameHex(name).toUpperCase();
	return encoded ? `${defaultCloudflareQueueBindingPrefix}_${encoded}` : defaultCloudflareQueueBindingPrefix;
}
function getCloudflareQueueDefinitionName(name) {
	if (!encodedCloudflareQueueNamePattern.test(name)) return name;
	return decodeQueueNameHex(name.slice(7)) || name;
}
//#endregion
export { getCloudflareQueueDefinitionName as n, getCloudflareQueueName as r, getCloudflareQueueBindingName as t };
