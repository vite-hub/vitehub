import { stubLanding } from "./stub";
import type { PrimitiveLanding } from "./types";

export const CommentsLanding = {
  ...stubLanding("comments", "Comments", "/docs/comments"),
  eyebrow: "ViteHub Comments",
  description: "Pin comments on the pages of your live site, see who else is on the page, and edit Content text in place.",
  tagline: "Review the site where people read it.",
  accent: "secondary",
  supported: ["Vite", "Nitro", "Nuxt"],
} satisfies PrimitiveLanding;
