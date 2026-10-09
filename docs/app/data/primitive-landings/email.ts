import type { PrimitiveLanding } from "./types";

export const EmailLanding = {
  slug: "email",
  name: "Email",
  docsTo: "/docs/email",
  eyebrow: "ViteHub Email",
  description: "Send transactional email through a typed server primitive that keeps provider details at the edge.",
  tagline: "Email delivery that stays inside your server contract.",
  accent: "primary",
  variants: [],
  supported: ["Vite", "Nitro", "Nuxt"],
} satisfies PrimitiveLanding;
