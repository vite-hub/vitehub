// Behavior record of the Console search palette and the session filter. It drives each behavior with the keyboard and
// the pointer, and writes what a person sees: the groups and items, the highlighted item, the field, focus, the page
// that opens, and the theme. Record on the base and on your branch, then compare. From the repository root, with the
// playground running (see playground/console/README.md):
//
//   node packages/vite-hub/test/console-search.browser.mjs record .cache/console-search/base.json --url http://127.0.0.1:4391
//   node packages/vite-hub/test/console-search.browser.mjs record .cache/console-search/head.json --url http://127.0.0.1:4391
//   node packages/vite-hub/test/console-search.browser.mjs compare .cache/console-search/base.json .cache/console-search/head.json
//
// The script reads the page through roles and states only (`role="dialog"`, `role="option"`, `data-highlighted`), so
// the same steps run against Nuxt UI and ui-sdk. `compare` prints each step that differs and exits with 1.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { parseArgs } from "node:util";
import { chromium } from "playwright-core";

const now = "2026-11-15T12:00:00.000Z";
const { positionals, values: options } = parseArgs({
  allowPositionals: true,
  options: { url: { type: "string", default: "http://127.0.0.1:4391" } },
});
const [command, ...files] = positionals;

if (command === "record" && files.length === 1) await record(resolve(files[0]));
else if (command === "compare" && files.length === 2) process.exitCode = await compare(resolve(files[0]), resolve(files[1]));
else {
  console.error("Usage: console-search.browser.mjs record <file> [--url <origin>]\n       console-search.browser.mjs compare <base> <head>");
  process.exitCode = 2;
}

async function compare(baseFile, headFile) {
  const base = JSON.parse(await readFile(baseFile, "utf8"));
  const head = JSON.parse(await readFile(headFile, "utf8"));
  let differences = 0;
  for (const name of new Set([...Object.keys(base), ...Object.keys(head)])) {
    const before = JSON.stringify(base[name], null, 1);
    const after = JSON.stringify(head[name], null, 1);
    if (before === after) continue;
    differences++;
    console.log(`\n${name} differs\n  base: ${before?.replace(/\n\s*/g, " ")}\n  head: ${after?.replace(/\n\s*/g, " ")}`);
  }
  console.log(`\n${Object.keys(base).length} steps, ${differences} differ`);
  return differences ? 1 : 0;
}

/** Runs in the page: what the open palette shows. */
function readPalette() {
  const dialog = [...document.querySelectorAll('[role="dialog"]')].find(element => element.querySelector('[role="option"], input'));
  if (!dialog) return { open: false };
  const text = element => element.textContent.replace(/\s+/g, " ").trim();
  const input = dialog.querySelector("input");
  const groups = [...dialog.querySelectorAll('[role="group"]')]
    .filter(group => group.querySelector('[role="option"]'))
    .map((group) => {
      const labelled = group.getAttribute("aria-labelledby");
      const label = labelled ? document.getElementById(labelled) : group.firstElementChild;
      return {
        label: label ? text(label) : "",
        items: [...group.querySelectorAll('[role="option"]')].map(option =>
          `${text(option)}${option.hasAttribute("data-disabled") || option.getAttribute("aria-disabled") === "true" ? " [disabled]" : ""}`),
      };
    });
  const highlighted = dialog.querySelector('[role="option"][data-highlighted]');
  const active = document.activeElement;
  const options = [...dialog.querySelectorAll('[role="option"]')].filter(option => !option.closest('[role="group"]'));
  return {
    open: true,
    title: dialog.getAttribute("aria-labelledby") ? text(document.getElementById(dialog.getAttribute("aria-labelledby"))) : null,
    description: dialog.getAttribute("aria-describedby") ? text(document.getElementById(dialog.getAttribute("aria-describedby")) ?? dialog) : null,
    placeholder: input?.placeholder ?? null,
    query: input?.value ?? null,
    inputFocused: active === input,
    loading: Boolean(dialog.querySelector(".animate-spin")),
    groups,
    ungrouped: options.map(text),
    highlighted: highlighted ? text(highlighted) : null,
    empty: groups.length || options.length ? null : text(dialog.querySelector('[data-slot="empty"], [data-slot="vh-empty"]') ?? dialog).slice(0, 200),
  };
}

/** Runs in the page: the element that has focus, by its role and name. */
function readFocus() {
  const active = document.activeElement;
  if (!active || active === document.body) return "body";
  return `${active.tagName.toLowerCase()} ${active.getAttribute("aria-label") ?? active.textContent.replace(/\s+/g, " ").trim().slice(0, 40)}`;
}

async function record(file) {
  const browser = await chromium.launch();
  const result = {};
  try {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, colorScheme: "light", timezoneId: "UTC" });
    await context.clock.setFixedTime(now);
    const page = await context.newPage();
    const settle = async () => {
      await page.waitForLoadState("networkidle").catch(() => {});
      await page.waitForTimeout(500);
    };
    const palette = () => page.evaluate(readPalette);
    const location = () => page.evaluate(() => `${location.pathname.replace(/^.*\/_vitehub/, "")}${location.search}`);
    const open = async (path = "/") => {
      await page.goto(`${options.url}/_vitehub${path}`);
      await page.locator('[aria-label="Search"], button:has-text("Search")').first().waitFor({ timeout: 60_000 });
      await settle();
      await page.evaluate(() => document.activeElement instanceof HTMLElement && document.activeElement.blur());
      await page.keyboard.press("/");
      await page.locator('[role="dialog"] [role="option"]').first().waitFor();
      await settle();
    };
    // Replaces the query. Backspace in an empty field goes back a page, so an empty field gets no Backspace.
    const type = async (text) => {
      const current = await page.evaluate(() => document.activeElement instanceof HTMLInputElement ? document.activeElement.value : "");
      if (current) {
        await page.keyboard.press("Control+A");
        await page.keyboard.press("Backspace");
      }
      if (text) await page.keyboard.type(text, { delay: 20 });
      await settle();
    };

    await open();
    result.opensWithSlash = await palette();
    await page.keyboard.press("ArrowUp");
    result.arrowUpFromFirst = (await palette()).highlighted;
    for (let index = 0; index < 3; index++) await page.keyboard.press("ArrowDown");
    result.arrowDownThree = (await palette()).highlighted;
    for (let index = 0; index < 80; index++) await page.keyboard.press("ArrowDown");
    result.arrowDownToEnd = (await palette()).highlighted;
    await page.keyboard.press("ArrowDown");
    result.arrowDownPastEnd = (await palette()).highlighted;
    await page.keyboard.press("Home");
    result.home = { highlighted: (await palette()).highlighted, focus: await page.evaluate(readFocus) };
    await page.locator('[role="dialog"] [role="option"]').nth(4).hover();
    result.hover = (await palette()).highlighted;

    for (const query of ["kv", "data", "theme", "release", "agent", "auth", "go to", "blob", "settings", "zzzz"]) {
      await type(query);
      result[`query ${query}`] = await palette();
      for (let index = 0; index < 2; index++) await page.keyboard.press("ArrowDown");
      result[`query ${query} arrow down twice`] = (await palette()).highlighted;
    }
    await type("");
    result.queryCleared = await palette();

    await type("kv");
    await page.keyboard.press("Escape");
    await page.waitForTimeout(400);
    result.escapeWithQuery = { palette: await palette(), focus: await page.evaluate(readFocus) };

    await open();
    await page.keyboard.press("Backspace");
    await page.waitForTimeout(300);
    result.backspaceOnFirstPage = (await palette()).open;

    await type("kv");
    await page.keyboard.press("Enter");
    await page.waitForTimeout(800);
    result.enterRunsHighlighted = { palette: (await palette()).open, location: await location(), focus: await page.evaluate(readFocus) };

    await open();
    await type("change theme");
    await page.keyboard.press("Enter");
    await settle();
    result.nestedPage = await palette();
    await page.keyboard.press("ArrowDown");
    result.nestedPageArrowDown = (await palette()).highlighted;
    await type("da");
    result.nestedPageQuery = await palette();
    await type("");
    await page.keyboard.press("Backspace");
    await settle();
    result.nestedPageBack = await palette();
    await type("change theme");
    await page.keyboard.press("Enter");
    await settle();
    await page.keyboard.press("Escape");
    await page.waitForTimeout(400);
    result.nestedPageEscape = (await palette()).open;

    await open();
    await type("change theme");
    await page.keyboard.press("Enter");
    await settle();
    await type("dark");
    await page.keyboard.press("Enter");
    await page.waitForTimeout(500);
    result.nestedPageRuns = { palette: (await palette()).open, dark: await page.evaluate(() => document.documentElement.classList.contains("dark")) };
    await open();
    await type("toggle theme");
    await page.keyboard.press("Enter");
    await page.waitForTimeout(500);
    result.toggleTheme = { palette: (await palette()).open, dark: await page.evaluate(() => document.documentElement.classList.contains("dark")) };
    await open();
    await type("change theme");
    await page.keyboard.press("Enter");
    await settle();
    await type("system");
    await page.keyboard.press("Enter");
    await page.waitForTimeout(500);

    await open();
    await page.getByRole("option", { name: /^Blob/ }).first().click();
    await page.waitForTimeout(800);
    result.clickRuns = { palette: (await palette()).open, location: await location() };

    await open();
    await type("kv");
    const popup = context.waitForEvent("page", { timeout: 5000 }).catch(() => undefined);
    await page.keyboard.press("Control+Enter");
    const opened = await popup;
    await page.waitForTimeout(500);
    result.controlEnterOpensTab = { palette: (await palette()).open, location: await location(), tab: opened ? new URL(opened.url()).pathname.replace(/^.*\/_vitehub/, "") : null };
    await opened?.close();

    await page.goto(`${options.url}/_vitehub/`);
    await settle();
    await page.evaluate(() => document.activeElement instanceof HTMLElement && document.activeElement.blur());
    await page.keyboard.press("Control+k");
    await page.locator('[role="dialog"] [role="option"]').first().waitFor();
    await settle();
    result.controlKOpens = (await palette()).open;
    await page.keyboard.press("Control+k");
    await page.waitForTimeout(400);
    result.controlKCloses = (await palette()).open;
    await page.keyboard.press("/");
    await page.waitForTimeout(400);
    await page.keyboard.press("Escape");
    await page.waitForTimeout(400);

    // The Search row of the sidebar opens the palette, and focus goes back to it.
    const searchRow = page.locator('[aria-label="Search"], button:has-text("Search")').first();
    await searchRow.focus();
    await page.keyboard.press("Enter");
    await page.locator('[role="dialog"] [role="option"]').first().waitFor();
    await settle();
    result.searchRowOpens = { open: (await palette()).open, inputFocused: (await palette()).inputFocused };
    await page.keyboard.press("Escape");
    await page.waitForTimeout(400);
    result.focusReturnsToSearchRow = await page.evaluate(readFocus);
    await page.keyboard.press("Enter");
    await page.locator('[role="dialog"] [role="option"]').first().waitFor();
    await page.locator('[role="dialog"] button[aria-label="Close"]').first().click();
    await page.waitForTimeout(400);
    result.closeButton = { open: (await palette()).open, focus: await page.evaluate(readFocus) };

    // `/` does not open search while a field has focus. On a Spanish or German keyboard, `/` is Shift+7.
    await page.evaluate(() => document.activeElement instanceof HTMLElement && document.activeElement.blur());
    await page.evaluate(() => document.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, code: "Digit7", key: "/", shiftKey: true })));
    await page.waitForTimeout(800);
    result.shiftedSlashOpens = (await palette()).open;
    await page.keyboard.press("Escape");
    await page.waitForTimeout(400);

    // Slow session search shows the loading state.
    await page.route("**/_vitehub/rpc", async (route) => {
      if (route.request().postData()?.includes('"m":"search.query"')) await new Promise(done => setTimeout(done, 2500));
      await route.continue();
    });
    await page.goto(`${options.url}/_vitehub/`);
    await settle();
    await page.evaluate(() => document.activeElement instanceof HTMLElement && document.activeElement.blur());
    await page.keyboard.press("/");
    await page.waitForTimeout(1200);
    const loading = await palette();
    result.loading = { loading: loading.loading, groups: loading.groups.map(group => group.label) };
    await page.waitForTimeout(3000);
    result.loaded = (await palette()).loading;
    await page.unroute("**/_vitehub/rpc");

    // A failed load shows a disabled status item.
    await context.addCookies([{ name: "playground-fail", value: "sections=503", url: options.url }]);
    await page.goto(`${options.url}/_vitehub/`);
    await page.locator('[aria-label="Search"], button:has-text("Search")').first().waitFor({ timeout: 60_000 });
    await settle();
    await page.evaluate(() => document.activeElement instanceof HTMLElement && document.activeElement.blur());
    await page.keyboard.press("/");
    await page.waitForTimeout(3000);
    result.failedLoad = await palette();
    await context.clearCookies();

    // The session filter of the Agents page: a searchable list with one checked value per group.
    await page.goto(`${options.url}/_vitehub/agents`);
    await settle();
    const filter = page.getByRole("button", { name: /^Filter sessions/ });
    await filter.click();
    await page.locator('[role="option"]').first().waitFor();
    await settle();
    const readFilter = () => page.evaluate(() => {
      const text = element => element.textContent.replace(/\s+/g, " ").trim();
      const listbox = document.querySelector('[role="listbox"], [data-slot="command-list"]');
      const root = listbox?.closest('[role="dialog"], [data-slot="popover-content"], [data-reka-popper-content-wrapper]') ?? listbox?.parentElement;
      return {
        input: root?.querySelector("input")?.placeholder ?? null,
        inputFocused: document.activeElement === root?.querySelector("input"),
        groups: [...(root?.querySelectorAll('[role="group"]') ?? [])].map(group => ({
          label: text(group.getAttribute("aria-labelledby") ? document.getElementById(group.getAttribute("aria-labelledby")) : group.firstElementChild),
          items: [...group.querySelectorAll('[role="option"]')].map(option => `${text(option)}${option.getAttribute("aria-selected") === "true" ? " [checked]" : ""}`),
        })),
        highlighted: root?.querySelector('[role="option"][data-highlighted]') ? text(root.querySelector('[role="option"][data-highlighted]')) : null,
      };
    });
    result.filterOpens = await readFilter();
    await page.keyboard.type("pa", { delay: 20 });
    await settle();
    result.filterQuery = await readFilter();
    await page.keyboard.press("Enter");
    await settle();
    result.filterSelect = { filter: await readFilter(), location: await location(), button: await filter.getAttribute("aria-label") };
    await page.keyboard.press("Enter");
    await settle();
    result.filterUnselect = { filter: await readFilter(), location: await location(), button: await filter.getAttribute("aria-label") };
    await page.keyboard.press("Escape");
    await page.waitForTimeout(400);
    result.filterEscape = { focus: await page.evaluate(readFocus), open: await page.locator('[role="option"]').count() };
  }
  catch (error) {
    // Keep the steps that ran, so a failure shows where the two sides part.
    result.failed = { after: Object.keys(result).at(-1) ?? null, error: String(error).split("\n")[0] };
    process.exitCode = 1;
  }
  finally {
    await browser.close();
  }
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(result, null, 2)}\n`);
  console.log(`${Object.keys(result).length} steps -> ${file}`);
}
