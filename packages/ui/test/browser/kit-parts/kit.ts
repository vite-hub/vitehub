// Each case as kit markup: the HTML that a Console page writes in place of the Nuxt UI tag, on the kit family. The
// classes are the Console's, except where `kitClass` says otherwise (see cases.ts).
import { Icon } from "@iconify/vue";
import { Avatar, AvatarFallback, AvatarImage } from "@ui-sdk/vue/avatar";
import { h } from "vue";
import type { VNode } from "vue";

import { picture } from "./cases.ts";
import type { Action, Case } from "./cases.ts";
import { status } from "./status.ts";

function icon(name: string): VNode {
  return h(Icon, { icon: name.replace(/^i-/, ""), "aria-hidden": "true" });
}

// A stand-in of the size of the Console's button. The check masks buttons; the Button move is its own unit.
function button(action: Action, size: "xs" | "sm"): VNode {
  return h("button", { type: "button", class: "fixture-button", "data-size": size }, [action.icon ? icon(action.icon) : null, action.label]);
}

function paragraphs(texts: string[]): VNode[] {
  return texts.map((text, index) => h("p", { class: index ? "mt-1 text-pretty" : "text-pretty" }, text));
}

const statValues = [["Drafts", "4"], ["Changed", "2"], ["Published", "18"], ["Deleted", "0"]];

export function render(item: Case): VNode {
  switch (item.part) {
    case "skeleton":
      return h("div", { "data-slot": "vh-skeleton", "aria-hidden": "true", class: item.class });
    case "badge":
      return h("span", { "data-slot": "vh-badge", "data-size": item.size, "data-tone": item.color, class: item.class, role: item.role }, item.status ? [status(item.status, item.label!)] : item.label);
    case "chip":
      return h("span", { "data-slot": "vh-chip" }, [icon("i-lucide-funnel"), item.show ? h("span", { "data-slot": "vh-chip-indicator" }) : null]);
    case "alert": {
      const actions = item.actions?.length ? h("div", { "data-slot": "vh-alert-actions" }, item.actions.map(action => button(action, "xs"))) : null;
      const content = h("div", { "data-slot": "vh-alert-content" }, [
        item.title ? h("div", { "data-slot": "vh-alert-title" }, item.title) : null,
        item.description || item.paragraphs ? h("div", { "data-slot": "vh-alert-description" }, item.paragraphs ? paragraphs(item.paragraphs) : item.description) : null,
        item.orientation === "horizontal" ? null : actions,
      ]);
      return h("div", { "data-slot": "vh-alert", "data-tone": item.color, "data-variant": item.variant, class: item.class, role: item.role ?? "status" }, [
        item.icon ? icon(item.icon) : null,
        content,
        item.orientation === "horizontal" ? actions : null,
        item.close ? h("button", { type: "button", "data-slot": "vh-alert-close", "aria-label": "Dismiss" }, [icon("i-lucide-x")]) : null,
      ]);
    }
    case "empty": {
      const size = item.size === "xs" ? "xs" : "sm";
      return h("div", { "data-slot": "vh-empty", "data-size": item.size, "data-variant": item.variant === "naked" ? undefined : "outline", class: item.kitClass ?? item.class, role: item.role }, [
        item.icon ? h("span", { "data-slot": "vh-empty-icon" }, [icon(item.icon)]) : null,
        item.title ? h("h2", { "data-slot": "vh-empty-title" }, item.title) : null,
        item.description || item.paragraphs ? h("div", { "data-slot": "vh-empty-description" }, item.paragraphs ? paragraphs(item.paragraphs) : item.description) : null,
        item.body ? h("div", { class: "flex flex-wrap items-center justify-center gap-1" }, [h("span", { class: "text-xs text-dimmed" }, "E_CONSOLE_LOAD · 500")]) : null,
        item.actions?.length ? h("div", { "data-slot": "vh-empty-actions" }, item.actions.map(action => button(action, size))) : null,
      ]);
    }
    case "card":
      return h("section", { "data-slot": "vh-card", "aria-label": "Documents by state" }, [
        h("dl", { class: "grid grid-cols-4 gap-4" }, statValues.map(([label, value]) =>
          h("div", { class: "grid gap-1" }, [h("dt", { class: "text-xs text-muted" }, label), h("dd", { class: "text-2xl font-semibold tabular-nums text-highlighted" }, value)]))),
      ]);
    case "avatar-group":
      // Each avatar sits in a span, as each sits in a tooltip trigger in the Console.
      return h("span", { "data-slot": "vh-avatar-group", "data-size": item.size, role: "img", "aria-label": "Ana · Editing" }, [
        ...item.people.map(person =>
          h("span", { class: person.viewing ? "opacity-60" : undefined }, [h(Avatar, () => [
            person.image ? h(AvatarImage, { src: picture, alt: "" }) : null,
            h(AvatarFallback, () => person.live ? icon("i-lucide-users") : (person.initials ?? "CN")),
          ])])),
        item.more ? h("span", { "data-slot": "vh-avatar-group-count" }, `+${item.more}`) : null,
      ]);
  }
}
