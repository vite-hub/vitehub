/**
 * The schema keys of `webhooksSchema` and their SQL names. Its own module, so the Vite plugin lists the table without
 * loading Drizzle during config resolution.
 */
export const webhooksTableNames: Readonly<Record<string, string>> = { webhookDeliveries: "vitehub_webhook_deliveries" }

/** The schema key of `webhookEndpointsSchema` and its SQL name. */
export const webhookEndpointsTableNames: Readonly<Record<string, string>> = { webhookEndpoints: "vitehub_webhook_endpoints" }
