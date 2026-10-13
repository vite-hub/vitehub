import { stubLanding } from "./stub";
import type { PrimitiveLanding } from "./types";

export const WorkflowLanding = {
  ...stubLanding("workflows", "Workflow", "/docs/workflows"),
  eyebrow: "ViteHub Workflow",
  description: "Turn a sequence of server steps into durable work that can pause, resume, and be inspected.",
  tagline: "Steps that keep their place when the world interrupts them.",
  accent: "primary",
  supported: ["Vite", "Nitro", "Nuxt"],
} satisfies PrimitiveLanding;
