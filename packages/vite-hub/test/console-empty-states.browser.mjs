// Run against the Console playground: CONSOLE_TEST_URL=http://127.0.0.1:3087 node --test test/console-empty-states.browser.mjs
import assert from "node:assert/strict";
import { test } from "node:test";
import { chromium } from "playwright-core";

const origin = process.env.CONSOLE_TEST_URL ?? "http://127.0.0.1:3087";

// Each case answers one RPC operation with an empty result, so the section shows its empty or error state.
const cases = [
  { path: "env", title: "No Server Env declared", operation: "env.get", value: () => ({ entries: [] }) },
  {
    path: "blob",
    title: "No media yet",
    operation: "blob.list",
    value: () => ({ blobs: [], hasMore: false, limit: 100, prefix: "", store: "default", stores: ["default"] }),
  },
  { path: "email", title: "No Email yet", operation: "definitions.list", value: (fixture) => ({ ...fixture, records: [] }) },
  { path: "workspaces", title: "No definition selected", operation: "definitions.list", value: (fixture) => ({ ...fixture, definitions: [] }) },
  // On narrow screens the key list stacks above the value pane, so the state centers in the value pane.
  { path: "kv", title: "This store is empty", operation: "kv.list", value: (fixture) => ({ ...fixture, keys: [] }), pane: "section[aria-label=Value]" },
  { path: "env", title: "Could not load Env declarations", operation: "env.get", fail: true },
];

/** The vertical distance between the state's title and the middle of its pane: `selector`, or the element that scrolls around it. */
function offsetFromPaneMiddle([title, selector]) {
  const heading = [...document.querySelectorAll("h2")].find((element) => element.textContent.trim() === title);
  if (!heading) return undefined;
  let pane = selector ? heading.closest(selector) : heading.parentElement;
  while (pane && !selector && !/(auto|scroll)/.test(getComputedStyle(pane).overflowY)) pane = pane.parentElement;
  const box = (pane ?? document.documentElement).getBoundingClientRect();
  const text = heading.getBoundingClientRect();
  return { offset: (text.top + text.bottom) / 2 - (box.top + box.bottom) / 2, height: box.height };
}

for (const viewport of [{ width: 1280, height: 800 }, { width: 420, height: 800 }]) {
  test(`empty states sit in the middle of their pane at ${viewport.width}px`, async () => {
    const browser = await chromium.launch();
    try {
      const page = await browser.newPage({ viewport });
      for (const entry of cases) {
        await page.unrouteAll();
        await page.route("**/_vitehub/rpc/__call", async (route) => {
          if (route.request().postDataJSON().operation !== entry.operation) return route.continue();
          if (entry.fail) return route.fulfill({ status: 500, json: { ok: false, status: 500, code: "CONSOLE_REQUEST_FAILED", message: "Synthetic failure." } });
          const fixture = await (await route.fetch()).json();
          return route.fulfill({ json: { ok: true, value: entry.value(fixture.value) } });
        });
        await page.goto(`${origin}/_vitehub/${entry.path}`);
        await page.getByRole("heading", { name: entry.title }).waitFor();
        // The headless pointer starts over the rail, which expands over the pane on hover.
        await page.mouse.move(viewport.width - 1, viewport.height - 1);
        const position = await page.evaluate(offsetFromPaneMiddle, [entry.title, entry.pane]);
        assert.ok(position, `${entry.path}: no "${entry.title}" heading`);
        assert.ok(
          Math.abs(position.offset) < position.height * 0.1,
          `${entry.path}: "${entry.title}" is ${Math.round(position.offset)}px from the middle of its ${Math.round(position.height)}px pane`,
        );
      }
    } finally {
      await browser.close();
    }
  });
}
