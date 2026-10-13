import { stubLanding } from "./stub";
import type { PrimitiveLanding } from "./types";

export const RateLimitsLanding = {
  ...stubLanding("rate-limit", "Rate Limit", "/docs/rate-limit"),
  eyebrow: "ViteHub Rate Limit",
  description: "Protect routes with request budgets that remain explicit across local and hosted runtimes.",
  tagline: "Request budgets your API can explain.",
  accent: "warning",
  supported: ["Vite", "Nitro", "Nuxt"],
} satisfies PrimitiveLanding;
