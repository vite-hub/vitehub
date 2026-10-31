import { stubLanding } from "./stub";
import type { PrimitiveLanding } from "./types";

export const CmsLanding = {
  ...stubLanding("cms", "CMS", "/docs/cms"),
  eyebrow: "ViteHub CMS",
  description: "Store editable documents from one file, edit them in the Console, and publish them to your site or to a pull request.",
  tagline: "Edit and publish content where your app runs.",
  accent: "secondary",
  supported: ["Vite", "Nitro", "Nuxt"],
} satisfies PrimitiveLanding;
