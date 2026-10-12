import { stubLanding } from "./stub";
import type { PrimitiveLanding } from "./types";

const landing = stubLanding("connections", "Connections", "/docs/connections");

export const ConnectionsLanding = {
  ...landing,
  eyebrow: "ViteHub Connections",
  description: "Keep account credentials and provider APIs behind one typed server contract.",
  tagline: "Connect provider accounts without spreading secrets through your app.",
  accent: "secondary",
  supported: ["Vite", "Nitro"],
  variants: landing.variants.filter((variant) => variant.framework !== "nuxt"),
} satisfies PrimitiveLanding;
