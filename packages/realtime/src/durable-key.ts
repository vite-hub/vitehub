/**
 * The `Symbol.for` key of the global slot that holds the isolate's Durable Object for Realtime. The server reads it, and
 * the generated Nitro plugin writes it without importing the server.
 */
export const realtimeDurableObjectKey = "vitehub.realtime.durable-object"
