// Run against the Console playground: CONSOLE_TEST_URL=http://127.0.0.1:3087 node --test test/console-usage-roll.browser.mjs
// The playground's usage fixture has 19 sessions in 30 days and 10 in 7 days.
import assert from "node:assert/strict";
import { test } from "node:test";
import { chromium } from "playwright-core";

const origin = process.env.CONSOLE_TEST_URL ?? "http://127.0.0.1:3087";

/** Starts to sample the Sessions headline on each frame: whether it is the same element, and how its digits move. */
function sample() {
  const value = [...document.querySelectorAll(".usage-headline__item")]
    .find(item => item.querySelector(".usage-headline__label")?.textContent === "Sessions")
    ?.querySelector(".usage-headline__value");
  const frames = [];
  let running = true;
  const tick = () => {
    const current = [...document.querySelectorAll(".usage-headline__item")]
      .find(item => item.querySelector(".usage-headline__label")?.textContent === "Sessions")
      ?.querySelector(".usage-headline__value");
    // The digits that move: each has a `translate` from the roll, in em.
    const moving = [...(value?.querySelectorAll("[data-motion-glyph]") ?? [])]
      .filter(glyph => glyph.style.translate)
      .map(glyph => ({ digit: glyph.dataset.motionGlyph, y: Number.parseFloat(glyph.style.translate.split(" ")[1] ?? "0") }));
    frames.push({ same: current === value, moving });
    if (running) requestAnimationFrame(tick);
  };
  tick();
  window.stopSample = () => {
    running = false;
    return { frames, text: value?.textContent, connected: value?.isConnected };
  };
}

/** Clicks a period and returns what the Sessions headline did until its roll ended. */
async function changePeriod(page, label, total) {
  await page.evaluate(sample);
  await page.getByRole("button", { name: label, exact: true }).click();
  await page.waitForFunction((text) => {
    const value = document.querySelector(".usage-headline__item[aria-pressed=true] .usage-headline__value");
    return value?.textContent === text && !value.querySelector("[data-motion-glyphs]");
  }, total, { timeout: 10_000 });
  return page.evaluate(() => window.stopSample());
}

test("the usage headline rolls its digits when the period changes", async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    await page.goto(`${origin}/_vitehub/usage?metric=sessions`);
    await page.locator(".usage-headline__value").first().waitFor();
    // The headless pointer starts over the rail, which expands over the page on hover.
    await page.mouse.move(1279, 799);
    assert.equal(await page.locator(".usage-headline__item[aria-pressed=true] .usage-headline__value").textContent(), "19");

    const down = await changePeriod(page, "7 days", "10");
    assert.ok(down.connected, "the headline value stays on the page");
    assert.ok(down.frames.every(frame => frame.same), "the headline value is the same element in every frame");
    const fewer = down.frames.flatMap(frame => frame.moving);
    assert.ok(fewer.length > 0, "digits roll from 19 to 10");
    // Fewer sessions: the new digits come from above (negative y) and the old ones leave downward.
    assert.ok(fewer.some(glyph => ["1", "0"].includes(glyph.digit) && glyph.y < -0.1), `a new digit comes from above: ${JSON.stringify(fewer.slice(0, 4))}`);
    assert.ok(fewer.some(glyph => glyph.digit === "9" && glyph.y > 0.1), "the old 9 leaves downward");
    assert.ok(!fewer.some(glyph => glyph.digit === "1" && glyph.y > 0.1), "the tens digit 1 stays");

    const up = await changePeriod(page, "30 days", "19");
    assert.ok(up.frames.every(frame => frame.same), "the headline value is the same element in every frame");
    const more = up.frames.flatMap(frame => frame.moving);
    // More sessions: the new 9 comes from below.
    assert.ok(more.some(glyph => glyph.digit === "9" && glyph.y > 0.1), "the new 9 comes from below");
  }
  finally {
    await browser.close();
  }
});
