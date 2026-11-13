// Opens each primitive landing page in headless Chromium against a running docs server and checks its hero figure:
// the scene mounts with no page errors, the caption shows a step, nothing in the figure overlaps another token or
// leaves the figure, and readers who turn motion off get the still frame with its summary. It checks a desktop
// width, the narrow right column, and a phone.
//
//   pnpm --filter vitehub-docs dev --port 4873
//   DOCS_URL=http://127.0.0.1:4873 node test/browser/hero-figures.browser.mjs
//
// Set HERO_SCREENSHOTS=<dir> to save a screenshot of each figure.
import assert from "node:assert/strict";
import { mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { chromium } from "playwright-core";

const base = process.env.DOCS_URL ?? "http://127.0.0.1:4873";
const shots = process.env.HERO_SCREENSHOTS;
const scenes = (await readdir(new URL("../../app/utils/hero-figure/scenes/", import.meta.url))).filter(file => file.endsWith(".ts")).map(file => file.slice(0, -3)).sort();

/** The boxes of every visible token, pill, and figure part, to find overlaps and parts outside the figure. */
function measure() {
  const fig = document.querySelector(".vh-fig");
  if (!fig) return null;
  const box = fig.getBoundingClientRect();
  // A part counts when a reader can see it: its own opacity times the opacity of every parent in the figure.
  const visible = (el) => {
    if (getComputedStyle(el).visibility === "hidden" || el.getClientRects().length === 0) return false;
    let opacity = 1;
    for (let node = el; node && node !== fig.parentElement; node = node.parentElement) opacity *= Number(getComputedStyle(node).opacity);
    return opacity > 0.3;
  };
  const tokens = [...fig.querySelectorAll(".job")].filter(el => visible(el)).map((el) => {
    const r = el.querySelector(".body").getBoundingClientRect();
    return { id: el.id, left: r.left, right: r.right, top: r.top, bottom: r.bottom };
  });
  const overlaps = [];
  for (let i = 0; i < tokens.length; i++) {
    for (let j = i + 1; j < tokens.length; j++) {
      const [a, b] = [tokens[i], tokens[j]];
      if (a.left < b.right - 2 && b.left < a.right - 2 && a.top < b.bottom - 2 && b.top < a.bottom - 2) overlaps.push(`${a.id}/${b.id}`);
    }
  }
  const outside = [...fig.querySelectorAll(".lane *")].filter(el => visible(el) && !el.closest("svg")).filter((el) => {
    const r = el.getBoundingClientRect();
    return r.width > 0 && (r.left < box.left - 6 || r.right > box.right + 6);
  }).map((el) => {
    const r = el.getBoundingClientRect();
    return `${el.className.baseVal ?? el.className} (${Math.round(r.left - box.left)}..${Math.round(r.right - box.right)})`;
  }).slice(0, 3);
  return { overlaps, outside, caption: document.querySelector(".vh-hero-figure-text")?.textContent?.trim() ?? "" };
}

async function check(browser, scene, { width, reducedMotion = "no-preference" }) {
  const page = await browser.newPage({ viewport: { width, height: 1000 }, reducedMotion });
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.goto(`${base}/docs/${scene}`, { waitUntil: "load" });
  await page.locator(".vh-fig").waitFor({ timeout: 30_000 });
  const problems = [];
  // Sample the loop at many moments. A token overlap or a part outside the figure at any moment fails the check.
  const samples = reducedMotion === "reduce" ? 1 : 24;
  for (let i = 0; i < samples; i++) {
    if (i) await page.waitForTimeout(500);
    const m = await page.evaluate(measure);
    assert.ok(m, `${scene}: no figure`);
    for (const pair of m.overlaps) problems.push(`overlap ${pair}`);
    for (const part of m.outside) problems.push(`outside ${part}`);
    assert.ok(m.caption.length > 0, `${scene}: empty caption`);
  }
  if (reducedMotion === "reduce") assert.equal(await page.locator(".vh-hero-figure-progress").count(), 0, `${scene}: the still frame shows no progress`);
  if (shots) {
    await mkdir(shots, { recursive: true });
    await page.locator(".vh-hero-figure").screenshot({ path: join(shots, `${scene}-${width}${reducedMotion === "reduce" ? "-still" : ""}.png`) });
  }
  await page.close();
  assert.deepEqual(errors, [], `${scene} at ${width}px: page errors`);
  assert.deepEqual([...new Set(problems)], [], `${scene} at ${width}px`);
}

const browser = await chromium.launch();
test.after(() => browser.close());

for (const scene of scenes) {
  test(`${scene} hero figure`, async () => {
    await check(browser, scene, { width: 1440 });
    await check(browser, scene, { width: 1024 });
    await check(browser, scene, { width: 390 });
    await check(browser, scene, { width: 1440, reducedMotion: "reduce" });
  });
}
