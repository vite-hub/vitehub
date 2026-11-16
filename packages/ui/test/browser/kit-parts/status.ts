import { h } from "vue";
import type { VNode } from "vue";

import type { Color } from "./cases.ts";

const dots: Record<Color, string> = { neutral: "bg-inverted", success: "bg-success", warning: "bg-warning", info: "bg-info", error: "bg-error" };

// The Status part of @vite-hub/ui that the MCP connection badge holds: a 6px dot and a label.
export function status(tone: Color, label: string): VNode {
  return h("span", { class: "inline-flex items-center gap-1.5" }, [h("span", { class: ["size-1.5 rounded-full", dots[tone]] }), label]);
}
