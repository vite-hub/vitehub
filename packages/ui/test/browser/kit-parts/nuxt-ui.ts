// Each case as the Console renders it today: the Nuxt UI component with the ViteHub app config and theme.css.
import UAlert from "@nuxt/ui/components/Alert.vue";
import UAvatar from "@nuxt/ui/components/Avatar.vue";
import UBadge from "@nuxt/ui/components/Badge.vue";
import UCard from "@nuxt/ui/components/Card.vue";
import UChip from "@nuxt/ui/components/Chip.vue";
import UEmpty from "@nuxt/ui/components/Empty.vue";
import UIcon from "@nuxt/ui/components/Icon.vue";
import USkeleton from "@nuxt/ui/components/Skeleton.vue";
import { h } from "vue";
import type { VNode } from "vue";

import { picture } from "./cases.ts";
import type { Case } from "./cases.ts";
import { status } from "./status.ts";

function paragraphs(texts: string[]): VNode[] {
  return texts.map((text, index) => h("p", { class: index ? "mt-1 text-pretty" : "text-pretty" }, text));
}

const statValues = [["Drafts", "4"], ["Changed", "2"], ["Published", "18"], ["Deleted", "0"]];

export function render(item: Case): VNode {
  switch (item.part) {
    case "skeleton":
      return h(USkeleton, { class: item.class });
    case "badge":
      return h(UBadge, { size: item.size, color: item.color, label: item.status ? undefined : item.label, class: item.class, role: item.role }, item.status ? { default: () => status(item.status!, item.label!) } : undefined);
    case "chip":
      return h(UChip, { as: "span", show: item.show, color: "neutral", size: "sm" }, { default: () => h(UIcon, { name: "i-lucide-funnel", class: "size-4" }) });
    case "alert": {
      const slots: Record<string, () => VNode[]> = {};
      if (item.paragraphs) slots.description = () => paragraphs(item.paragraphs!);
      return h(UAlert, {
        color: item.color,
        variant: item.variant,
        icon: item.icon,
        title: item.title,
        description: item.description,
        actions: item.actions,
        orientation: item.orientation,
        close: item.close,
        class: item.class,
        role: item.role,
      }, slots);
    }
    case "empty": {
      const slots: Record<string, () => VNode[]> = {};
      if (item.paragraphs) slots.description = () => paragraphs(item.paragraphs!);
      if (item.body) slots.body = () => [h("div", { class: "flex flex-wrap items-center justify-center gap-1" }, [h("span", { class: "text-xs text-dimmed" }, "E_CONSOLE_LOAD · 500")])];
      return h(UEmpty, {
        variant: item.variant,
        size: item.size,
        icon: item.icon,
        title: item.title,
        description: item.description,
        actions: item.actions,
        class: item.class,
        role: item.role,
      }, slots);
    }
    case "card":
      return h(UCard, { as: "section", "aria-label": "Documents by state" }, {
        default: () => h("dl", { class: "grid grid-cols-4 gap-4" }, statValues.map(([label, value]) =>
          h("div", { class: "grid gap-1" }, [h("dt", { class: "text-xs text-muted" }, label), h("dd", { class: "text-2xl font-semibold tabular-nums text-highlighted" }, value)]))),
      });
    case "avatar-group": {
      // console-presence-avatars.vue, without the tooltips. A tooltip trigger adds no element.
      const size = item.size === "sm" ? "2xs" : "xs";
      const shown = item.people.map((person, index) =>
        h("span", {
          class: ["relative inline-flex rounded-full ring-2 ring-(--ui-bg)", index ? "-ms-1.5" : "", person.viewing ? "opacity-60" : ""],
          style: { zIndex: item.people.length - index },
        }, [
          person.live
            ? h(UAvatar, { icon: "i-lucide-users", alt: "Live session", size })
            : h(UAvatar, { src: person.image ? picture : undefined, text: person.initials ?? "CN", alt: person.initials ?? "Ana", size }),
        ]));
      const more = item.more
        ? [h("span", {
            class: ["relative -ms-1.5 inline-flex items-center justify-center rounded-full bg-elevated px-1.5 text-xs/none font-medium text-muted tabular-nums ring-2 ring-(--ui-bg)", item.size === "sm" ? "h-5 min-w-5" : "h-6 min-w-6"],
          }, `+${item.more}`)]
        : [];
      return h("span", { class: "flex shrink-0 items-center", role: "img", "aria-label": "Ana · Editing" }, [...shown, ...more]);
    }
  }
}
