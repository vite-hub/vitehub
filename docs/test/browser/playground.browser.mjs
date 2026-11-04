// Opens /playground in headless Chromium against a running docs server and boots the real WebContainer. It edits a
// file and reads the preview, copies a share link and restores it in a new page, downloads the zip, and switches
// templates. It needs network access to StackBlitz, and the snapshots that `nuxt build` (or `TUTORIAL_SNAPSHOTS=1
// nuxi dev`) writes, as tutorial.browser.mjs does.
//
//   TUTORIAL_SNAPSHOTS=1 pnpm --filter vitehub-docs dev --port 4871
//   DOCS_URL=http://127.0.0.1:4871 node test/browser/playground.browser.mjs
//
// Set PLAYGROUND_SCREENSHOTS=<dir> to save a screenshot of each state.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { chromium } from "playwright-core";

const base = process.env.DOCS_URL ?? "http://127.0.0.1:4871";
const shots = process.env.PLAYGROUND_SCREENSHOTS;
const playground = `${base}/playground`;
const bootTimeout = 10 * 60_000;

async function shot(page, name) {
  if (!shots) return;
  await mkdir(shots, { recursive: true });
  await page.screenshot({ path: join(shots, `${name}.png`) });
}

function containerFrames(page) {
  return page.frames().filter(frame => frame.url().includes("stackblitz") || frame.url().includes("webcontainer-api.io"));
}

/** Reads the preview frames until `pattern` matches. The preview origin wraps the app in frames of its own. */
async function readPreview(page, pattern) {
  let text = "";
  for (let attempt = 0; attempt < 120 && !pattern.test(text); attempt++) {
    await page.waitForTimeout(500);
    text = "";
    for (const frame of page.frames().filter(candidate => candidate.url().includes("webcontainer-api.io"))) {
      // A reloaded frame can fail a locator read while it loads, so read it directly.
      const read = frame.evaluate(() => document.body?.innerText ?? "").catch(() => "");
      text += await Promise.race([read, new Promise(done => setTimeout(done, 1000, ""))]);
    }
  }
  return text.trim();
}

/**
 * Reads the preview through "Open preview in a new tab". Playwright cannot read the preview frame after it navigates
 * a second time, so a reload in the frame is not readable.
 */
async function readPreviewTab(page, pattern) {
  let text = "";
  for (let attempt = 0; attempt < 10 && !pattern.test(text); attempt++) {
    const popup = page.context().waitForEvent("page");
    await page.getByRole("link", { name: "Open preview in a new tab" }).click();
    const tab = await popup;
    text = await tab.locator("body").innerText({ timeout: 30_000 }).catch(() => "");
    await tab.close();
    if (!pattern.test(text)) await page.waitForTimeout(2000);
  }
  return text.trim();
}

async function waitForApp(page) {
  await page.locator(".vh-ws-preview-frame").waitFor({ timeout: bootTimeout });
  await page.locator(".vh-ws-boot").waitFor({ state: "detached", timeout: bootTimeout });
}

/** Replaces the word `from` in the open file with `to`, the way a reader does: double-click, then type. */
async function replaceWord(page, from, to) {
  const point = await page.evaluate((word) => {
    const walker = document.createTreeWalker(document.querySelector(".cm-content"), NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const index = node.textContent.indexOf(word);
      if (index === -1) continue;
      const range = document.createRange();
      range.setStart(node, index);
      range.setEnd(node, index + word.length);
      const rect = range.getBoundingClientRect();
      return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
    }
  }, from);
  assert.ok(point, `the editor shows ${from}`);
  await page.mouse.dblclick(point.x, point.y);
  await page.keyboard.type(to);
}

test("runs the playground in the browser", { timeout: 30 * 60_000 }, async (t) => {
  const browser = await chromium.launch({ args: ["--headless=new"] });
  t.after(() => browser.close());
  const desktop = await browser.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true });
  await desktop.grantPermissions(["clipboard-read", "clipboard-write"], { origin: base });
  let shareLink = "";

  await t.test("desktop: boots a template, edits it, shares it, and downloads it", async (step) => {
    const page = await desktop.newPage();
    step.after(() => page.close().catch(() => {}));
    page.on("pageerror", error => console.log("[page error]", error.message));
    const started = performance.now();
    const response = await page.goto(playground);
    assert.equal(response?.headers()["cross-origin-embedder-policy"], "credentialless");
    assert.equal(response?.headers()["cross-origin-opener-policy"], "same-origin");
    assert.equal(await page.evaluate(() => crossOriginIsolated), true);
    await page.locator(".vh-ws-shell").waitFor();
    await page.getByRole("treeitem", { name: "settings.post.ts" }).waitFor();
    await shot(page, "desktop-booting");

    await waitForApp(page);
    assert.match(await readPreview(page, /"ok"/), /"ok":\s*true/);
    console.log(`first boot: preview ready ${((performance.now() - started) / 1000).toFixed(1)} s after page load`);
    await shot(page, "desktop-ready");

    // Edit the health route. The dev server picks up the change, and Reload shows it.
    await page.getByRole("treeitem", { name: "health.get.ts" }).click();
    await replaceWord(page, "true", "\"edited\"");
    await page.waitForTimeout(3000);
    assert.match(await readPreviewTab(page, /edited/), /"ok":\s*"edited"/);
    await page.getByRole("button", { name: "Reload preview" }).click();
    await shot(page, "desktop-edited");

    // Copy link puts the files in the URL hash.
    await page.getByRole("button", { name: "Copy link" }).click();
    await page.getByText("Link copied", { exact: true }).waitFor();
    shareLink = await page.evaluate(() => navigator.clipboard.readText());
    assert.match(shareLink, /\/playground#code=[\w-]+$/);
    console.log(`share link: ${shareLink.length} characters`);

    // Download saves the current files, with the edit.
    const download = page.waitForEvent("download");
    await page.getByRole("button", { name: "Download" }).click();
    const file = await download;
    assert.equal(file.suggestedFilename(), "vitehub-kv.zip");
    const dir = await mkdtemp(join(tmpdir(), "vitehub-playground-"));
    try {
      await file.saveAs(join(dir, "app.zip"));
      execFileSync("unzip", ["-q", "app.zip"], { cwd: dir });
      assert.match(execFileSync("cat", ["vitehub-kv/server/api/health.get.ts"], { cwd: dir, encoding: "utf8" }), /ok: "edited"/);
      assert.match(execFileSync("cat", ["vitehub-kv/vite.config.ts"], { cwd: dir, encoding: "utf8" }), /kv:/);
    }
    finally {
      await rm(dir, { recursive: true, force: true });
    }

    // The Agent template has other dependencies, so it boots a new workspace with its own snapshot.
    await page.getByRole("button", { name: "Templates" }).click();
    await page.getByRole("menuitem", { name: /First Agent/ }).waitFor();
    // Let the menu finish its open animation.
    await page.waitForTimeout(500);
    await shot(page, "desktop-templates");
    await page.getByRole("menuitem", { name: /First Agent/ }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Replace files" }).click();
    await page.getByRole("treeitem", { name: "greeting.ts" }).waitFor();
    await page.waitForURL(/\/playground\?template=agent$/);
    await waitForApp(page);
    assert.match(await readPreview(page, /"ok"/), /"ok":\s*true/);
    await shot(page, "desktop-agent");

    // Back to KV without edits: no question.
    await page.getByRole("button", { name: "Templates" }).click();
    await page.getByRole("menuitem", { name: /KV storage/ }).click();
    await page.getByRole("treeitem", { name: "settings.post.ts" }).waitFor();
    assert.equal(await page.getByRole("dialog").count(), 0);
    await page.close();
  });

  await t.test("desktop: a share link restores the files in a new page", async (step) => {
    const page = await desktop.newPage();
    step.after(() => page.close().catch(() => {}));
    await page.goto(shareLink);
    await page.getByText("You opened shared files on the KV storage template.").waitFor();
    await page.getByRole("treeitem", { name: "health.get.ts" }).click();
    await page.locator(".cm-content").filter({ hasText: "ok: \"edited\"" }).waitFor();
    await waitForApp(page);
    assert.match(await readPreview(page, /edited/), /"ok":\s*"edited"/);
    await shot(page, "desktop-share-restored");

    // An unreadable link says so and opens the default template.
    await page.goto(`${playground}#code=broken`);
    await page.getByText("This link has no files that the playground can read.").waitFor();
    await page.close();
  });

  await t.test("tablet: boots only after a tap", async () => {
    const page = await browser.newPage({ viewport: { width: 900, height: 1180 } });
    await page.goto(playground);
    await page.getByRole("button", { name: "Open playground" }).waitFor();
    await page.waitForTimeout(3000);
    assert.equal(containerFrames(page).length, 0, "no WebContainer before the tap");
    await page.getByRole("button", { name: "Open playground" }).click();
    await page.locator(".vh-ws-shell").waitFor();
    await page.close();
  });

  await t.test("phone: a card, never a WebContainer", async () => {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, acceptDownloads: true });
    await page.goto(playground);
    await page.getByText("The playground runs a ViteHub app in a desktop browser.").waitFor();
    await page.waitForTimeout(3000);
    assert.equal(containerFrames(page).length, 0);
    assert.equal(await page.locator(".vh-ws-shell").count(), 0);
    await shot(page, "mobile");
    const download = page.waitForEvent("download");
    await page.getByRole("button", { name: "Download files" }).click();
    assert.equal((await download).suggestedFilename(), "vitehub-kv.zip");
    await page.close();
  });

  await t.test("unsupported browser: an inline notice and no workspace", async () => {
    // Safari sends no credentialless isolation. Strip the headers and use its user agent to get the same page.
    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 15_6) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/19.0 Safari/605.1.15",
    });
    const page = await context.newPage();
    await page.route(`${playground}*`, async (route) => {
      const response = await route.fetch();
      const headers = { ...response.headers() };
      delete headers["cross-origin-embedder-policy"];
      delete headers["cross-origin-opener-policy"];
      await route.fulfill({ response, headers });
    });
    await page.goto(playground);
    await page.getByText("The live workspace does not run in Safari").waitFor();
    await page.getByRole("button", { name: "Download files" }).waitFor();
    assert.equal(await page.locator(".vh-ws-shell").count(), 0);
    await shot(page, "safari");
    await context.close();
  });

  await t.test("the docs get no isolation headers, and links across the boundary load a new document", async () => {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    const docs = await page.goto(`${base}/docs`);
    assert.equal(docs?.headers()["cross-origin-embedder-policy"], undefined);
    assert.equal(docs?.headers()["cross-origin-opener-policy"], undefined);
    // A page outside the boundary to the playground, through the header.
    const home = await page.goto(base);
    assert.equal(home?.headers()["cross-origin-opener-policy"], undefined);
    await page.getByRole("navigation", { name: "Primary" }).getByRole("link", { name: "Playground" }).click();
    await page.waitForURL(/\/playground$/);
    await page.locator(".vh-ws-shell").waitFor();
    assert.equal(await page.evaluate(() => crossOriginIsolated), true, "the playground loaded as a new isolated document");
    // Playground to docs, through the header.
    await page.getByRole("navigation", { name: "Primary" }).getByRole("link", { name: "Docs" }).click();
    await page.waitForURL(/\/docs/);
    assert.equal(await page.evaluate(() => crossOriginIsolated), false, "the docs page loaded as a new document");
    await page.close();
  });
});
