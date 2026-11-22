import UButton from "@nuxt/ui/components/Button.vue";
import { h, ref } from "vue";
import type { VNode } from "vue";

import { CopyButton } from "../../../src/components/copy-button.ts";
import { MorphText, RollNumber } from "../../../src/components/motion.ts";
import { morphText, ring, rollNumber, swapIcon } from "../../../src/motion.ts";
import { getMotionSlowFactor } from "../../../src/motion/spring.ts";

Object.assign(window, { motionText: { morphText, ring, rollNumber, swapIcon } });

type Phase = "idle" | "busy" | "done";
const phase = ref<Phase>("idle");
const count = ref(12);
const label = ref("Copy link");
const loading = ref(false);

const publishLabels = { idle: "Publish", busy: "Publishing", done: "Published" } as const;

async function publish(event: MouseEvent): Promise<void> {
  if (phase.value !== "idle") return;
  const button = event.currentTarget;
  const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms * getMotionSlowFactor()));
  phase.value = "busy";
  await wait(1500);
  phase.value = "done";
  await wait(280);
  if (button instanceof HTMLElement) ring(button);
  await wait(1600);
  phase.value = "idle";
}

export function textRows(row: (title: string, children: VNode[]) => VNode): VNode[] {
  return [
    row("Labels and icons", [
      h(UButton, {
        "data-test": "publish",
        "size": "lg",
        "label": publishLabels[phase.value],
        "loading": phase.value === "busy",
        "icon": phase.value === "done" ? "i-lucide-check" : "i-lucide-arrow-right",
        "onClick": publish,
      }),
      h(CopyButton, { "data-test": "copy", "value": "pnpm add vite-hub", "aria-label": "Copy the install command" }),
      h(CopyButton, { "data-test": "copy-page", "value": "# Page", "label": "Copy page", "variant": "outline" }),
      h(UButton, { "data-test": "label-toggle", "variant": "outline", "label": label.value, "onClick": () => (label.value = label.value === "Copy link" ? "Copied" : "Copy link") }),
      h(UButton, { "data-test": "loading-only", "label": "Save", "loading": loading.value }),
      h(UButton, { "data-test": "loading-toggle", "label": "Toggle loading", "onClick": () => (loading.value = !loading.value) }),
    ]),
    row("Plain text, counts, rings", [
      h("span", { "class": "plain", "data-test": "morph-host" }, [h("span", { "data-test": "morph" }, "Publish")]),
      h("span", { "class": "plain", "data-test": "morph-vue" }, [h(MorphText, { text: label.value })]),
      h("span", { "class": "plain tabular-nums", "data-test": "count-host" }, [h(RollNumber, { "data-test": "count", "value": count.value })]),
      h(UButton, { "data-test": "count-up", "variant": "outline", "label": "+1", "onClick": () => count.value++ }),
      h(UButton, { "data-test": "count-down", "variant": "outline", "label": "−1", "onClick": () => count.value-- }),
      h("span", { "class": "plain tabular-nums", "data-test": "roll" }, "99"),
      h("span", { "class": "plain", "data-test": "icon-box" }, [h("span", { "data-test": "icon-old" }, "◆")]),
      h("button", { "class": "plain", "data-test": "ring" }, "Ring"),
      h("div", { "data-motion": "none" }, [h("span", { "class": "plain", "data-test": "morph-off" }, "Publish")]),
    ]),
  ];
}
