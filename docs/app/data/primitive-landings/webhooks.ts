import { stubLanding } from "./stub";
import type { PrimitiveLanding } from "./types";

export const WebhooksLanding = {
  ...stubLanding("webhooks", "Webhooks", "/docs/webhooks"),
  eyebrow: "ViteHub Webhooks",
  description: "Send your app's events to a URL outside the app, signed, retried, and debounced, on every host.",
  tagline: "Call sendWebhook(). ViteHub signs, waits, and retries.",
  accent: "secondary",
  supported: ["Vite", "Nitro", "Nuxt"],
} satisfies PrimitiveLanding;
