import { stubLanding } from "./stub";
import type { PrimitiveLanding } from "./types";

export const RealtimeLanding = {
  ...stubLanding("realtime", "Realtime", "/docs/realtime"),
  eyebrow: "ViteHub Realtime",
  description: "Share live document state through a host independent primitive for collaborative interfaces.",
  tagline: "Live state for interfaces that move together.",
  accent: "secondary",
  supported: ["Vite", "Nitro", "Nuxt"],
} satisfies PrimitiveLanding;
