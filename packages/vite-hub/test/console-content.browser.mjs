// Run against the Console playground: CONSOLE_TEST_URL=http://127.0.0.1:3087 node --test test/console-content.browser.mjs
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { test } from "node:test";
import { chromium } from "playwright-core";

const origin = process.env.CONSOLE_TEST_URL ?? "http://127.0.0.1:3087";
const output = process.env.CONSOLE_TEST_ARTIFACTS;
const body =
  "July and August bring warm days and afternoon rain.\n\n## Plan your day\n\nKeep a light raincoat in your bag.\n\n- Drink water\n- Take a break\n";
const contribution = {
  id: "content",
  label: "Content",
  description: "Edit Content documents.",
  icon: "i-lucide-file-pen-line",
  view: { kind: "document-editor", notice: "Synthetic local documents." },
};
const collections = ["en", "es", "th"].map((name, index) => ({
  name,
  label: ["English", "Español", "ไทย"][index],
  path: `content/${name}/**/*.md`,
  titleField: "title",
  access: { read: true, write: true, publish: true },
  schema: {
    type: "object",
    properties: { title: { type: "string", minLength: 1 }, description: { type: "string" } },
    required: ["title"],
  },
}));

async function fixture(page) {
  const controls = { delay: {}, hold: {}, fail: {}, saves: [], publishes: [] };
  const documents = Array.from({ length: 9 }, (_, index) => ({
    id: index ? `document-${index}` : "weather",
    collection: "en",
    path: `content/en/${index ? `document-${index}` : "weather"}.md`,
    data: {
      title: index ? `Document ${index}` : "July in Thailand",
      description: "Synthetic content for a local browser check.",
    },
    body,
    digest: `digest-${index}`,
    revision: "revision-1",
    state: "published",
    updatedAt: "2026-10-28T10:00:00.000Z",
  }));
  const states = () => ({
    draft: documents.filter((doc) => doc.state === "draft").length,
    changed: documents.filter((doc) => doc.state === "changed").length,
    published: documents.filter((doc) => doc.state === "published").length,
    deleted: 0,
  });
  await page.route("**/_vitehub/rpc/__call", async (route) => {
    const { operation, input = {} } = route.request().postDataJSON();
    const action = operation === "documents.action" ? input.action : operation;
    if (controls.hold[action]) await controls.hold[action];
    if (controls.delay[action])
      await new Promise((resolve) => setTimeout(resolve, controls.delay[action]));
    if (controls.fail[action])
      return route.fulfill({
        status: 503,
        json: {
          ok: false,
          status: 503,
          code: "CONSOLE_REQUEST_FAILED",
          message: "The local fixture is temporarily unavailable.",
        },
      });
    const query = input.body ?? {};
    let value;
    if (operation === "sections.list")
      value = {
        sections: ["content"],
        contributions: [contribution],
        projectName: "Content playground",
        scoped: true,
        auth: false,
      };
    else if (operation === "definitions.list")
      value = { section: "content", kind: "document-editor", collections };
    else if (operation === "documents.action") {
      const document = documents.find((doc) => doc.id === query.id);
      if (action === "overview")
        value = {
          collections: collections.map((collection) => ({
            name: collection.name,
            label: collection.label,
            states: states(),
            changes: [],
            total: 9,
          })),
          activity: [],
          totals: states(),
        };
      else if (action === "list") {
        const items = documents.filter(
          (doc) =>
            (!query.search || doc.data.title.toLowerCase().includes(query.search.toLowerCase())) &&
            (!query.state || doc.state === query.state),
        );
        value = {
          items: items.map((doc) => ({ ...doc, title: doc.data.title })),
          changes: documents
            .filter((doc) => doc.state !== "published")
            .map((doc) => ({ id: doc.id, digest: doc.digest, state: doc.state })),
          states: states(),
          total: items.length,
          nextCursor: null,
          scheduled: 0,
        };
      } else if (action === "get") value = document ?? null;
      else if (action === "raw")
        value = document
          ? { ...document, text: `---\ntitle: ${document.data.title}\n---\n\n${document.body}` }
          : null;
      else if (action === "sessions")
        value = { available: false, sessions: [], user: { id: "local", name: "Local editor" } };
      else if (action === "session")
        value = {
          available: false,
          lease: false,
          digest: document?.digest ?? null,
          sessions: [],
          user: { id: "local", name: "Local editor" },
        };
      else if (action === "save") {
        assert.ok(document);
        controls.saves.push(query);
        Object.assign(document, {
          body: query.body,
          data: query.data,
          state: "changed",
          digest: `saved-${controls.saves.length}`,
        });
        value = document;
      } else if (action === "publish") {
        controls.publishes.push(query);
        for (const expectation of query.expect)
          documents.find((doc) => doc.id === expectation.id).state = "published";
        value = {
          documents: query.expect.map((doc) => ({
            collection: query.collection,
            id: doc.id,
            change: "update",
          })),
        };
      } else if (action === "revisions") value = { revisions: [] };
      else value = null;
    } else return route.continue();
    return route.fulfill({ json: { ok: true, value } });
  });
  return Object.assign(controls, { documents });
}

async function capture(page, name, selectors = []) {
  if (!output) return;
  await mkdir(output, { recursive: true });
  const boxes = {};
  for (const selector of selectors) {
    const target = page.locator(selector).first();
    boxes[selector] = (await target.count()) ? await target.boundingBox() : null;
  }
  await page.screenshot({ path: `${output}/${name}.png` });
  await writeFile(
    `${output}/${name}.json`,
    JSON.stringify({ viewport: page.viewportSize(), boxes }, null, 2),
  );
}

test("Content hydrates Rich without changing stored Markdown", { timeout: 120_000 }, async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const controls = await fixture(page);
    await page.goto(`${origin}/_vitehub/content/en/weather`);
    await page.getByRole("textbox", { name: "Title", exact: true }).waitFor();
    await page.waitForTimeout(3500);
    await capture(page, "rich", [".vitehub-markdown-editor"]);
    const rich = await page.locator(".tiptap").innerText();
    await page.getByRole("radio", { name: "Source", exact: true }).click();
    assert.equal(
      await page.getByRole("textbox", { name: "Markdown body", exact: true }).inputValue(),
      body,
    );
    assert.ok(
      rich.includes("July and August"),
      `Rich body is blank while Source has ${body.length} characters. Browser errors: ${errors.join("; ")}`,
    );
    await page.getByRole("radio", { name: "Rich", exact: true }).click();
    assert.equal(await page.locator(".tiptap").getAttribute("contenteditable"), "true");
    assert.equal(
      controls.saves.length,
      0,
      "Hydration must not autosave or normalize the stored body",
    );
    await page.getByRole("radio", { name: "Rich", exact: true }).click();
    await page
      .getByRole("textbox", { name: "Title", exact: true })
      .fill("July in Thailand, updated");
    await page.waitForFunction(() => document.body.innerText.includes("Changed"));
    assert.equal(controls.saves.at(-1).body, body, "A title edit must keep the stored Markdown");
    const tableBody =
      "## Trains\n\n| Route | Time |\n| --- | --- |\n| Bangkok | 09:00 |\n\n| Ticket | Price |\n| --- | --- |\n| Local | 20 |\n";
    controls.documents[1].body = tableBody;
    await page.goto(`${origin}/_vitehub/content/en/document-1`);
    await page.locator(".tiptap table").first().waitFor();
    assert.equal(await page.locator(".tiptap table").count(), 2);
    assert.equal(await page.locator(".tiptap").getAttribute("contenteditable"), "true");
    await page.getByRole("radio", { name: "Source", exact: true }).click();
    assert.equal(
      await page.getByRole("textbox", { name: "Markdown body", exact: true }).inputValue(),
      tableBody,
    );
    assert.equal(controls.saves.length, 1, "Loading tables must not save a replacement body");
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
});

test(
  "Sidebar counts follow local publishing and a document restored by another tab",
  { timeout: 120_000 },
  async () => {
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
      const controls = await fixture(page);
      await page.goto(`${origin}/_vitehub/content/en/weather`);
      const title = page.getByRole("textbox", { name: "Title", exact: true });
      await title.fill("A local draft title");
      const english = page.locator(".vitehub-console__section-link").filter({ hasText: "English" });
      await page.waitForFunction(() =>
        document.querySelector(".vitehub-console__pills")?.textContent.includes("changed"),
      );
      assert.match(await english.innerText(), /1\s+changed/);
      await page.getByRole("button", { name: "Publish", exact: true }).click();
      await page.waitForFunction(
        () => !document.querySelector(".vitehub-console__pills")?.textContent.includes("changed"),
      );
      await title.fill("Another local draft");
      await page.waitForFunction(() =>
        document.querySelector(".vitehub-console__pills")?.textContent.includes("changed"),
      );
      // Another tab restores the published version. Presence tells this tab to read that version.
      Object.assign(controls.documents[0], {
        data: { ...controls.documents[0].data, title: "A local draft title" },
        state: "published",
        digest: "restored-by-another-tab",
      });
      await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
      await page.waitForFunction(
        () => document.querySelector("textarea#field-title")?.value === "A local draft title",
      );
      assert.equal(await page.getByRole("button", { name: "Publish", exact: true }).count(), 0);
      await page.waitForFunction(
        () => !document.querySelector(".vitehub-console__pills")?.textContent.includes("changed"),
        null,
        { timeout: 3000 },
      );
      assert.doesNotMatch(await english.innerText(), /changed/);
    } finally {
      await browser.close();
    }
  },
);

test(
  "Content collection distinguishes loading, failure, retry, and empty filters",
  { timeout: 120_000 },
  async () => {
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage({
        viewport: { width: 1280, height: 800 },
        reducedMotion: "reduce",
      });
      const controls = await fixture(page);
      const listGate = Promise.withResolvers();
      controls.hold.list = listGate.promise;
      await page.goto(`${origin}/_vitehub/content/en`);
      await page.getByRole("textbox", { name: "Search documents" }).waitFor();
      await capture(page, "collection-loading", ["[role=tablist]", "table", "table ~ p"]);
      assert.ok(await page.getByText("Loading documents…", { exact: true }).count());
      assert.equal(
        await page
          .locator("table tbody")
          .evaluate((el) => getComputedStyle(el.querySelector("td > div")).animationName),
        "none",
      );
      await page.emulateMedia({ reducedMotion: "no-preference" });
      await capture(page, "collection-loading-normal", ["[role=tablist]", "table", "table ~ p"]);
      delete controls.hold.list;
      listGate.resolve();
      controls.delay.list = 1500;
      assert.ok(await page.getByText("Loading documents…", { exact: true }).count());
      await page.getByRole("link", { name: "July in Thailand weather" }).waitFor();
      const tabs = await page.getByRole("tablist").boundingBox();
      await capture(page, "collection-loaded", ["[role=tablist]", "table"]);
      await page.evaluate(() => document.documentElement.classList.add("dark"));
      await capture(page, "collection-dark", ["[role=tablist]", "table"]);
      await page.evaluate(() => document.documentElement.classList.remove("dark"));
      controls.fail.list = true;
      await page.getByRole("tab", { name: /^Drafts/ }).click();
      await page.getByRole("button", { name: "Try again" }).waitFor();
      await capture(page, "collection-error", ["[role=alert]"]);
      controls.fail.list = false;
      await page.getByRole("button", { name: "Try again" }).focus();
      await page.keyboard.press("Enter");
      assert.ok(await page.getByText("Loading documents…", { exact: true }).count());
      await page.getByText("No drafts", { exact: true }).waitFor();
      await page.getByRole("tab", { name: /^All/ }).click();
      await page.getByRole("link", { name: "July in Thailand weather" }).waitFor();
      await page.getByRole("textbox", { name: "Search documents" }).fill("No such document");
      await page.getByText("No matching documents", { exact: true }).waitFor();
      await page.getByRole("button", { name: "Clear filters" }).click();
      await page.getByRole("link", { name: "July in Thailand weather" }).waitFor();
      assert.equal((await page.getByRole("tablist").boundingBox()).x, tabs.x);
      await page.setViewportSize({ width: 390, height: 844 });
      await page.getByRole("tab", { name: /^All/ }).focus();
      await page.keyboard.press("End");
      await page.waitForFunction(() => document.activeElement?.textContent.includes("Published"));
      const publishedTab = await page.getByRole("tab", { name: /^Published/ }).boundingBox();
      assert.ok(
        publishedTab.x + publishedTab.width <= 390,
        "Keyboard focus must reveal the full tab",
      );
      await capture(page, "collection-mobile", ["[role=tablist]", "table"]);
      assert.ok(
        await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
        "The mobile page must not overflow",
      );
    } finally {
      await browser.close();
    }
  },
);

test(
  "Console and document loading recover without losing the requested route",
  { timeout: 120_000 },
  async () => {
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
      const controls = await fixture(page);
      const bootGate = Promise.withResolvers();
      controls.hold["sections.list"] = bootGate.promise;
      controls.delay["definitions.list"] = 2500;
      controls.fail["definitions.list"] = true;
      controls.delay.get = 2000;
      controls.fail.get = true;
      await page.goto(`${origin}/_vitehub/content/en/weather`, { waitUntil: "domcontentloaded" });
      await page.getByText("Opening Console…", { exact: true }).waitFor();
      await page.locator(".motion-safe\\:animate-spin").first().waitFor();
      assert.notEqual(
        await page
          .locator(".motion-safe\\:animate-spin")
          .first()
          .evaluate((el) => getComputedStyle(el).animationName),
        "none",
      );
      await capture(page, "console-loading");
      await page.emulateMedia({ reducedMotion: "reduce" });
      await capture(page, "console-loading-reduced");
      assert.ok(
        await page
          .locator(".motion-safe\\:animate-spin")
          .evaluateAll((elements) =>
            elements.every((el) => getComputedStyle(el).animationName === "none"),
          ),
      );
      delete controls.hold["sections.list"];
      bootGate.resolve();
      await page.getByText("Loading collections…", { exact: true }).waitFor();
      await capture(page, "collections-loading");
      await page.getByRole("heading", { name: "Couldn't load collections" }).waitFor();
      controls.fail["definitions.list"] = false;
      controls.delay["definitions.list"] = 0;
      await page.getByRole("button", { name: "Try again" }).last().click();
      await page.getByText("Loading document…", { exact: true }).first().waitFor();
      await capture(page, "document-loading");
      await page.getByRole("heading", { name: "Couldn't open this document" }).waitFor();
      controls.fail.get = false;
      await page.getByRole("button", { name: "Try again" }).focus();
      await page.keyboard.press("Enter");
      await page.getByRole("textbox", { name: "Title", exact: true }).waitFor();
      await page.waitForFunction(() =>
        document.querySelector(".tiptap")?.textContent.includes("July and August"),
      );
      assert.ok(page.url().endsWith("/content/en/weather"));
      assert.equal(controls.saves.length, 0);
    } finally {
      await browser.close();
    }
  },
);

test(
  "Rich and Source keep pending edits; save and publish failures stay recoverable on mobile",
  { timeout: 120_000 },
  async () => {
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
      const controls = await fixture(page);
      await page.goto(`${origin}/_vitehub/content/en/weather`);
      await page.getByRole("textbox", { name: "Title", exact: true }).waitFor();
      await page.getByRole("radio", { name: "Rich", exact: true }).focus();
      await page.keyboard.press("ArrowRight");
      assert.equal(
        await page.getByRole("radio", { name: "Source", exact: true }).getAttribute("aria-checked"),
        "true",
      );
      await page
        .getByRole("textbox", { name: "Markdown body", exact: true })
        .fill(`${body}\nA source edit.\n`);
      await page.getByRole("radio", { name: "Source", exact: true }).focus();
      await page.keyboard.press("ArrowLeft");
      await page.waitForFunction(() =>
        document.querySelector(".tiptap")?.textContent.includes("A source edit."),
      );
      await page.locator(".tiptap").press("ControlOrMeta+End");
      await page.keyboard.type(" Pending rich edit.");
      await page.getByRole("radio", { name: "Source", exact: true }).click();
      assert.ok(
        (
          await page.getByRole("textbox", { name: "Markdown body", exact: true }).inputValue()
        ).includes("Pending rich edit."),
      );
      controls.fail.save = true;
      await page
        .getByRole("textbox", { name: "Markdown body", exact: true })
        .fill(`${body}\nKeep this after a failure.\n`);
      await page.getByRole("button", { name: "Not saved · retry" }).waitFor();
      await page.setViewportSize({ width: 390, height: 844 });
      await capture(page, "save-error-mobile");
      assert.ok(await page.getByRole("button", { name: "Not saved · retry" }).isVisible());
      controls.fail.save = false;
      controls.delay.save = 1500;
      await page.getByRole("button", { name: "Not saved · retry" }).click();
      await page.getByText("Saving…", { exact: true }).waitFor();
      await capture(page, "saving-mobile");
      await page.getByRole("button", { name: "Publish", exact: true }).waitFor();
      await page.waitForFunction(() => document.body.innerText.includes("Changed"));
      assert.equal(controls.saves.at(-1).body, `${body}\nKeep this after a failure.\n`);
      controls.delay.publish = 1500;
      controls.fail.publish = true;
      await page.getByRole("button", { name: "Publish", exact: true }).click();
      await page.getByText("Publishing…", { exact: true }).waitFor();
      await capture(page, "publishing-mobile");
      await page.getByText("Publishing…", { exact: true }).waitFor({ state: "hidden" });
      assert.equal(controls.publishes.length, 0);
      assert.ok(
        (
          await page.getByRole("textbox", { name: "Markdown body", exact: true }).inputValue()
        ).includes("Keep this after a failure."),
      );
      controls.fail.publish = false;
      await page.getByRole("button", { name: "Publish", exact: true }).click();
      await page.getByText("Publishing…", { exact: true }).waitFor({ state: "hidden" });
      assert.equal(controls.publishes.length, 1);
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      await page.keyboard.press("ControlOrMeta+/");
      await page.locator(".tiptap").waitFor({ state: "visible" });
      await capture(page, "rich-mobile");
    } finally {
      await browser.close();
    }
  },
);
