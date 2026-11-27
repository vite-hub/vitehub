/**
 * The schema keys of `webhooksSchema` and their SQL names. Its own module, so the Vite plugin lists the table without
 * loading Drizzle during config resolution.
 */
export const webhooksTableNames: Readonly<Record<string, string>> = { webhookDeliveries: "vitehub_webhook_deliveries" }

/** The schema keys of `webhookEndpointsSchema` and their SQL names. */
export const webhookEndpointsTableNames: Readonly<Record<string, string>> = { webhookEndpoints: "vitehub_webhook_endpoints", webhookPairings: "vitehub_webhook_pairings" }
