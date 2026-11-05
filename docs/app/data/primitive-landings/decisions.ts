import { stubLanding } from "./stub";
import type { PrimitiveLanding } from "./types";

export const DecisionsLanding = {
  ...stubLanding("decisions", "Decisions", "/docs/decisions"),
  eyebrow: "ViteHub Decisions",
  description: "Turn text into choices over options that you declare, for filters, search facets, and command palettes.",
  tagline: "Type a sentence. Get typed choices.",
  accent: "info",
  supported: ["Vite", "Nitro", "Nuxt"],
} satisfies PrimitiveLanding;
