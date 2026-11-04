// Opens a runnable tutorial in headless Chromium against a running docs server, boots the real WebContainer, follows
// the steps, edits a file, and reads the app. It needs network access to StackBlitz and the npm registry, and takes
// about five minutes because the first start installs the app.
//
//   pnpm --filter vitehub-docs dev --port 4870
//   DOCS_URL=http://127.0.0.1:4870 node test/browser/tutorial.browser.mjs
//
// Set TUTORIAL_SCREENSHOTS=<dir> to save a screenshot of each state.
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { chromium } from "playwright-core";

const base = process.env.DOCS_URL ?? "http://127.0.0.1:4870";
const shots = process.env.TUTORIAL_SCREENSHOTS;
const tutorial = `${base}/tutorials/first-agent`;
const installTimeout = 10 * 60_000;

async function shot(page, name) {
  if (!shots) return;
  await mkdir(shots, { recursive: true });
  await page.screenshot({ path: join(shots, `${name}.png`) });
}

function containerFrames(page) {
  return page.frames().filter(frame => frame.url().includes("stackblitz") || frame.url().includes("webcontainer-api.io"));
}

async function runRequest(page) {
  const button = page.getByRole("button", { name: "Run in workspace" });
  await button.waitFor();
  await page.waitForFunction(() => {
    const element = [...document.querySelectorAll("button")].find(candidate => candidate.textContent?.includes("Run in workspace"));
    return element && !element.disabled;
  }, undefined, { timeout: installTimeout });
  await button.click();
  const output = page.locator(".vh-tutorial-run-output");
  await output.waitFor({ timeout: 60_000 });
  return output.innerText();
}

test("runs the first Agent tutorial in the browser", { timeout: 20 * 60_000 }, async (t) => {
  const browser = await chromium.launch({ args: ["--headless=new"] });
  t.after(() => browser.close());

  await t.test("desktop: boots, follows the steps, edits a file, and reads the app", async (step) => {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    // A failed run must not leave its WebContainer running beside the next check.
    step.after(() => page.close().catch(() => {}));
    page.on("pageerror", error => console.log("[page error]", error.message));
    const response = await page.goto(tutorial);
    assert.equal(response?.headers()["cross-origin-embedder-policy"], "credentialless");
    assert.equal(response?.headers()["cross-origin-opener-policy"], "same-origin");
    assert.equal(await page.evaluate(() => crossOriginIsolated), true);
    await page.getByText("Step 1 of 4").waitFor();
    await page.locator(".vh-ws-boot").waitFor();
    await shot(page, "desktop-booting");

    // Step 1 changes vite.config.ts. Solve writes it, without a question because nothing was edited.
    await page.getByRole("button", { name: "Solve" }).click();
    await page.locator(".cm-content").filter({ hasText: "agent: true" }).waitFor();
    await page.getByRole("button", { name: "Next", exact: true }).click();

    // Step 2 creates the Agent. "Show in editor" opens the new file empty; Solve then asks before it replaces the edit.
    await page.getByText("Step 2 of 4").waitFor();
    await page.getByRole("button", { name: "Show in editor" }).first().click();
    await page.locator(".cm-content").click();
    await page.keyboard.type("// my attempt");
    await page.getByRole("button", { name: "Solve" }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Replace files" }).click();
    await page.locator(".cm-content").filter({ hasText: "defineAgent" }).waitFor();
    await page.getByRole("button", { name: "Next", exact: true }).click();

    await page.getByText("Step 3 of 4").waitFor();
    await page.getByRole("button", { name: "Solve" }).click();
    await page.locator(".cm-content").filter({ hasText: "runAgent(greeting" }).waitFor();
    await page.getByRole("button", { name: "Next", exact: true }).click();
    await page.getByText("Step 4 of 4").waitFor();

    // The preview shows the health route once the dev server is ready.
    await page.locator(".vh-ws-preview-frame").waitFor({ timeout: installTimeout });
    await page.locator(".vh-ws-boot").waitFor({ state: "detached", timeout: installTimeout });
    // The preview origin wraps the app in frames of its own, so read every frame that it serves.
    let health = "";
    for (let attempt = 0; attempt < 120 && !health.includes("\"ok\""); attempt++) {
      await page.waitForTimeout(500);
      for (const frame of page.frames().filter(candidate => candidate.url().includes("webcontainer-api.io"))) {
        health += await frame.locator("body").innerText({ timeout: 1000 }).catch(() => "");
      }
    }
    console.log("preview /api/health:", health.trim());
    assert.match(health, /"ok":\s*true/);
    await shot(page, "desktop-ready");

    assert.match(await runRequest(page), /Hello, Ada\. This result came from an Agent Invocation\./);

    // Edit the Agent in the editor. The running app picks the change up.
    await page.getByRole("treeitem", { name: "greeting.ts" }).click();
    const point = await page.evaluate(() => {
      const walker = document.createTreeWalker(document.querySelector(".cm-content"), NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const index = node.textContent.indexOf("Hello");
        if (index === -1) continue;
        const range = document.createRange();
        range.setStart(node, index);
        range.setEnd(node, index + 5);
        const rect = range.getBoundingClientRect();
        return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
      }
    });
    assert.ok(point, "the editor shows the greeting");
    await page.mouse.dblclick(point.x, point.y);
    await page.keyboard.type("Hi");
    await page.waitForTimeout(3000);
    await page.getByRole("button", { name: "Run in workspace" }).click();
    await page.locator(".vh-tutorial-run-output").filter({ hasText: "Hi, Ada" }).waitFor({ timeout: 60_000 });
    await shot(page, "desktop-edited");

    // Going back with an edit asks before it replaces the files.
    await page.getByRole("button", { name: "Prev" }).first().click();
    await page.getByText("You changed 1 file").waitFor();
    await shot(page, "desktop-step-bar");
    await page.getByRole("button", { name: "Keep mine" }).click();
    await page.getByRole("button", { name: "Reset" }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Replace files" }).click();
    await page.getByText("You changed").waitFor({ state: "detached" });
    await page.close();
  });

  await t.test("tablet: boots only after a tap", async () => {
    const page = await browser.newPage({ viewport: { width: 900, height: 1180 } });
    await page.goto(tutorial);
    await page.getByRole("button", { name: "Open workspace" }).waitFor();
    await page.waitForTimeout(3000);
    assert.equal(containerFrames(page).length, 0, "no WebContainer before the tap");
    await shot(page, "tablet");
    // The server renders the button, so a tap before hydration does nothing. Tap until the workspace mounts.
    for (let attempt = 0; attempt < 15 && await page.locator(".vh-ws-shell").count() === 0; attempt++) {
      await page.getByRole("button", { name: "Open workspace" }).click().catch(() => {});
      await page.waitForTimeout(2000);
    }
    await page.locator(".vh-ws-shell").waitFor();
    await page.waitForFunction(() => document.querySelector("iframe[src*='stackblitz']") !== null, undefined, { timeout: 60_000 });
    await shot(page, "tablet-open");
    await page.close();
  });

  await t.test("phone: prose and a card, never a WebContainer", async () => {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    await page.goto(tutorial);
    const card = page.getByText("This tutorial has a live workspace. Open it on a desktop to edit and run the code.");
    await card.waitFor();
    assert.equal(await page.getByRole("link", { name: "Download starter" }).getAttribute("href"), "/_tutorials/first-agent-starter.zip");
    await page.waitForTimeout(3000);
    assert.equal(containerFrames(page).length, 0);
    assert.equal(await page.locator(".vh-ws-shell").count(), 0);
    await shot(page, "mobile");
    const zip = await page.request.get(`${base}/_tutorials/first-agent-starter.zip`);
    assert.equal(zip.status(), 200);
    assert.equal((await zip.body()).subarray(0, 2).toString(), "PK");
    await page.close();
  });

  await t.test("unsupported browser: an inline notice and the prose at full width", async () => {
    // Safari sends no credentialless isolation. Strip the headers and use its user agent to get the same page.
    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 15_6) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/19.0 Safari/605.1.15",
    });
    const page = await context.newPage();
    await page.route(`${tutorial}*`, async (route) => {
      const response = await route.fetch();
      const headers = { ...response.headers() };
      delete headers["cross-origin-embedder-policy"];
      delete headers["cross-origin-opener-policy"];
      await route.fulfill({ response, headers });
    });
    await page.goto(tutorial);
    await page.getByText("The live workspace does not run in Safari").waitFor();
    assert.equal(await page.locator(".vh-ws-shell").count(), 0);
    await shot(page, "safari");
    await context.close();
  });

  await t.test("the rest of the site gets no isolation headers, and links across the boundary load a new document", async () => {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    const docs = await page.goto(`${base}/docs/getting-started/first-agent`);
    assert.equal(docs?.headers()["cross-origin-embedder-policy"], undefined);
    assert.equal(docs?.headers()["cross-origin-opener-policy"], undefined);
    const navigation = page.waitForEvent("framenavigated", { predicate: frame => frame === page.mainFrame() });
    await page.getByRole("link", { name: "Run this tutorial in your browser" }).click();
    await navigation;
    await page.getByText("Step 1 of 4").waitFor();
    assert.equal(await page.evaluate(() => crossOriginIsolated), true, "the tutorial loaded as a new isolated document");
    await page.getByRole("link", { name: "Read in the docs" }).click();
    await page.waitForURL(/\/docs\/getting-started\/first-agent/);
    assert.equal(await page.evaluate(() => crossOriginIsolated), false, "the docs page loaded as a new document");
    await page.close();
  });
});
