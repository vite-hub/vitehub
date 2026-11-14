import { stubLanding } from "./stub";
import type { PrimitiveLanding } from "./types";

export const FormsLanding = {
  ...stubLanding("forms", "Forms", "/docs/forms"),
  eyebrow: "ViteHub Forms",
  description: "Let visitors write to you through a form, with a spam guard, validation, an inbox in the Console, and email.",
  tagline: "Write the schema. Read the messages.",
  accent: "secondary",
  supported: ["Vite", "Nitro", "Nuxt"],
} satisfies PrimitiveLanding;
