// Mounts one workspace part from `fixtures/` by its file name: `?part=shell&layout=side`. A new part needs only a new
// fixture file and a new file in `checks/`. When the part is on screen, `<html>` gets `data-ready`.
import "./styles.css";

import { type Component, createApp, h } from "vue";

import { createViteHubUI } from "../../../src/config.ts";
import { uiSdkComponents } from "../../../src/ui-sdk/components.ts";

/** A fixture renders one part with the query of the page, and names the element that shows when it is ready. */
export interface WorkspacePartFixture {
  component: Component<{ params: URLSearchParams }>;
  ready: string;
}

const fixtures = import.meta.glob<WorkspacePartFixture>("./fixtures/*.ts", { eager: true, import: "default" });
const byName = new Map(Object.entries(fixtures).map(([path, fixture]) => [path.slice("./fixtures/".length, -".ts".length), fixture]));

const params = new URLSearchParams(location.search);
const name = params.get("part") ?? "";
const fixture = byName.get(name);
if (!fixture) throw new Error(`No workspace part "${name}". The parts are: ${[...byName.keys()].join(", ")}.`);

createApp({ render: () => h(fixture.component, { params }) }).use(createViteHubUI({ components: uiSdkComponents })).mount("#app");

async function ready(selector: string) {
  while (!document.querySelector(selector)) await new Promise(resolve => requestAnimationFrame(resolve));
  await document.fonts.ready;
  document.documentElement.dataset.ready = "";
}
void ready(fixture.ready);
