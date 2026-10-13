import { stubLanding } from "./stub";
import type { PrimitiveLanding } from "./types";

const startingLayout = stubLanding("channels", "Channels", "/docs/channels");

export const ChannelsLanding = {
  ...startingLayout,
  eyebrow: "ViteHub Channels",
  description: "Deliver named messages through provider connectors while keeping delivery code behind one server contract.",
  tagline: "Choose a delivery channel without coupling your routes to a provider.",
  accent: "secondary",
  supported: ["Vite", "Nitro", "Nuxt"],
} satisfies PrimitiveLanding;
