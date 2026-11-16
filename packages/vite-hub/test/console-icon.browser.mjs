// Run against the Console playground: CONSOLE_TEST_URL=http://127.0.0.1:3087 node --test test/console-icon.browser.mjs
// The playground page `icons.html` draws every icon name of the Console sources with Nuxt UI's `UIcon` and with the
// Console `Icon`, in running text and in flex rows. Both must give the same SVG and the same box.
import assert from "node:assert/strict";
import { test } from "node:test";
import { chromium } from "playwright-core";

const origin = process.env.CONSOLE_TEST_URL ?? "http://127.0.0.1:3087";

/** Each row of the page: its icon name, its context, and the SVG markup and box (relative to the row) of each side. */
function readRows() {
  return [...document.querySelectorAll("[data-name]")].map((row) => {
    const rowBox = row.getBoundingClientRect();
    const side = (name) => {
      const wrapper = row.querySelector(`[data-side="${name}"]`);
      const svg = wrapper.querySelector("svg");
      const wrapperBox = wrapper.getBoundingClientRect();
      const box = svg?.getBoundingClientRect();
      return {
        markup: svg?.outerHTML,
        paths: svg?.childElementCount ?? 0,
        box: box && [box.x - wrapperBox.x, box.y - rowBox.y, box.width, box.height].map(value => Math.round(value * 100) / 100),
        wrapper: [wrapperBox.width, wrapperBox.height],
      };
    };
    return { name: row.dataset.name, context: row.dataset.context, nuxtUI: side("nuxt-ui"), console: side("console") };
  });
}

test("the Console Icon draws the same SVG as UIcon for every Console icon name", async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    await page.goto(`${origin}/_vitehub/icons.html`);
    await page.locator("main[data-names]").waitFor();
    const count = Number(await page.locator("main").getAttribute("data-names"));
    assert.ok(count > 100, `the page found only ${count} icon names`);
    // Lucide icons outside the client bundle load after the first render. Wait until every SVG has its shapes.
    await page.waitForFunction(() => [...document.querySelectorAll("[data-side] svg")].every(svg => svg.childElementCount > 0) && document.querySelectorAll("[data-side] svg").length === document.querySelectorAll("[data-side]").length, undefined, { timeout: 30_000 });
    const rows = await page.evaluate(readRows);
    assert.equal(new Set(rows.map(row => row.name)).size, count);
    for (const row of rows) {
      const where = `${row.name} (context ${row.context})`;
      assert.ok(row.nuxtUI.paths > 0, `${where}: UIcon drew no shapes`);
      assert.equal(row.console.markup, row.nuxtUI.markup, `${where}: the SVG differs`);
      assert.deepEqual(row.console.box, row.nuxtUI.box, `${where}: the icon box differs`);
      assert.deepEqual(row.console.wrapper, row.nuxtUI.wrapper, `${where}: the text around the icon moved`);
    }
    console.log(`${count} icon names, ${rows.length} rows: SVG markup and boxes are equal`);
  }
  finally {
    await browser.close();
  }
});
