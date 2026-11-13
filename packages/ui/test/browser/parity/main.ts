import { createApp } from "vue";
import { engines } from "./engines.ts";

declare global {
  interface Window {
    parity: { engines: Record<string, string[]>; ready: boolean };
  }
}

const component = (path: string) => path.slice(path.lastIndexOf("/") + 1, -".vue".length);

window.parity = {
  engines: Object.fromEntries(Object.entries(engines).map(([name, fixtures]) => [name, Object.keys(fixtures).map(component).sort()])),
  ready: false,
};

const query = new URLSearchParams(location.search);
const engine = query.get("engine");
const name = query.get("component");
if (engine && name) {
  const load = engines[engine]?.[`./${engine}/${name}.vue`];
  if (!load) throw new Error(`The ${engine} engine has no ${name} fixture.`);
  createApp((await load()).default).mount("#app");
  window.parity.ready = true;
}
