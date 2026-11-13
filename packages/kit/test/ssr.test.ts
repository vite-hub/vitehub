import { createColorScheme } from "@ui-sdk/core";
import { type Component, createSSRApp, h, type VNode } from "vue";
import { renderToString } from "vue/server-renderer";
import { describe, expect, it } from "vitest";

import { createOverlays } from "@vite-hub/kit/overlays";
import { createToaster } from "@vite-hub/kit/toast";

import { kitEntries } from "./entries.ts";

type Entry = Record<string, unknown>;

function isComponent(value: unknown): value is Component {
  return typeof value === "object" && value !== null && ("setup" in value || "render" in value);
}

function part(entry: Entry, name: string): Component {
  const value = entry[name];
  if (!isComponent(value)) throw new TypeError(`${name} is not a component.`);
  return value;
}

function pascalCase(name: string): string {
  return name.split("-").map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join("");
}

/** The root part of an entry, such as `Tabs` for `tabs` and `OTPInput` for `otp-input`. */
function rootPart(entry: Entry, name: string): Component {
  const root = Object.keys(entry).find((key) => key.toLowerCase() === pascalCase(name).toLowerCase());
  if (!root) throw new TypeError(`${name} has no root part.`);
  return part(entry, root);
}

// These roots render no element of their own. Each one gets the part that renders on the server.
const firstParts: Record<string, string> = {
  "alert-dialog": "AlertDialogTrigger",
  autocomplete: "AutocompleteInput",
  dialog: "DialogTrigger",
  drawer: "DrawerTrigger",
  "hover-card": "HoverCardTrigger",
  menu: "MenuTrigger",
  popover: "PopoverTrigger",
  "token-input": "TokenInputEditor",
  tooltip: "TooltipTrigger",
  "trigger-menu": "TriggerMenuInput",
};

// The overlay host renders only what is open, so the test opens a toaster.
const overlays = createOverlays();
overlays.mount("toaster", { toaster: createToaster() });

/** The parts that need props or another root. Every other entry renders its root part. */
const trees: Record<string, (entry: Entry) => VNode> = {
  overlays: (entry) => h(part(entry, "OverlayHost"), { overlays }),
  preferences: (entry) => h(part(entry, "Preferences"), { preferences: [createColorScheme()] }),
  radio: (entry) => h(part(entry, "RadioGroup"), null, () => h(part(entry, "Radio"), { value: "a" })),
  toast: (entry) => h(part(entry, "ToastRegion")),
};

function tree(name: string, entry: Entry): VNode {
  const custom = trees[name];
  if (custom) return custom(entry);
  const root = rootPart(entry, name);
  const first = firstParts[name];
  return first ? h(root, null, () => h(part(entry, first), null, () => "Open")) : h(root);
}

const entries = await Promise.all(kitEntries.map(async (name) => {
  const specifier = `@vite-hub/kit/${name}`;
  const entry: Entry = await import(/* @vite-ignore */ specifier);
  return { entry, name };
}));
const partEntries = entries.filter(({ entry }) => Object.values(entry).some(isComponent));

describe("server rendering", () => {
  it("covers every entry that has parts", () => {
    expect(partEntries.length).toBe(61);
  });

  it.each(partEntries)("renders $name with data-slot", async ({ entry, name }) => {
    const html = await renderToString(createSSRApp({ render: () => tree(name, entry) }));
    expect(html).toMatch(/data-slot="[a-z-]+"/);
  });
});
