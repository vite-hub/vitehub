import { stubLanding } from "./stub";
import type { PrimitiveLanding } from "./types";

export const KvLanding = {
  ...stubLanding("kv", "KV", "/docs/kv"),
  eyebrow: "ViteHub KV",
  description: "Store small pieces of state and cache behind one API that follows the host you deploy to.",
  tagline: "State that stays close to the code that uses it.",
  accent: "info",
  supported: ["Vite", "Nitro", "Nuxt"],
} satisfies PrimitiveLanding;
