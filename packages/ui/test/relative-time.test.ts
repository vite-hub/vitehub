// @vitest-environment happy-dom

import { TooltipProvider } from "reka-ui";
import { renderToString } from "@vue/server-renderer";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type App, compile, createSSRApp, defineComponent, h, nextTick, ref } from "vue";
import { createViteHubUI } from "../src/config.ts";
import { provideRelativeNow, RelativeTime } from "../src/components/relative-time.ts";
import { describeTime } from "../src/internal/describe-time.ts";
import { useTooltipComponent } from "../src/internal/nuxt-ui.ts";
import { startRelativeClock } from "../src/internal/relative-now.ts";

// 4 November 2026, noon UTC: the clock of comark-time's tests, so the cases below are theirs.
const now = Date.parse("2026-11-04T12:00:00Z");
const day = 86_400_000;
const timeZone = process.env.TZ;
const mounted: App[] = [];

afterEach(() => {
  for (const app of mounted.splice(0)) app.unmount();
  vi.useRealTimers();
  vi.restoreAllMocks();
  process.env.TZ = timeZone;
  document.body.innerHTML = "";
});

describe("describeTime, as comark-time has it", () => {
  const settings = { locale: "en", now, timeZone: "UTC" };

  it("reports invalid clock and threshold options with a diagnostic and fix", () => {
    expect(() => describeTime(now, { now: "invalid" })).toThrowError(expect.objectContaining({ code: "UI_RELATIVE_TIME_NOW_INVALID", fix: expect.stringContaining("now") }));
    expect(() => describeTime(now, { threshold: "invalid" })).toThrowError(expect.objectContaining({ code: "UI_RELATIVE_TIME_THRESHOLD_INVALID", fix: expect.stringContaining("threshold") }));
  });

  it.each([
    ["2026-10-15", "relative", "2 weeks ago", "Thu, Oct 15, 2026"],
    ["2026-10-14", "absolute", "Oct 14", "3 weeks ago"],
    ["2026-10-13", "absolute", "Oct 13", "3 weeks ago"],
    ["2025-10-13", "absolute", "Oct 13, 2025", "last year"],
  ])("switches to a date at 3 weeks: %s", (date, mode, label, tip) => {
    expect(describeTime(date, settings)).toEqual({ datetime: date, mode, label, tip });
  });

  it("reads an instant, with its time in the tip and the reader's zone", () => {
    expect(describeTime("2026-11-02T09:30:00Z", settings)).toEqual({
      datetime: "2026-11-02T09:30:00Z",
      label: "2 days ago",
      mode: "relative",
      tip: "Mon, Nov 2, 2026, 9:30 AM UTC",
    });
    expect(describeTime(now - 20 * day - 23 * 3_600_000, settings)?.label).toBe("2 weeks ago");
    expect(describeTime(now - 21 * day, settings)).toMatchObject({ label: "Oct 14", tip: "3 weeks ago · 12:00 PM UTC" });
    expect(describeTime("2026-11-02T09:30:00Z", { ...settings, timeZone: "Europe/Madrid" })?.tip).toBe("Mon, Nov 2, 2026, 10:30 AM GMT+1");
  });
});

// Renders on a server and hydrates the HTML in the browser, both with the clock at `server`, then moves the browser to
// `zone`. Returns the `<time>` and Vue's hydration warnings.
async function hydrate(at: number | string, options: { zone?: string, clock?: boolean, props?: Record<string, unknown> } = {}) {
  const clock = ref(now);
  const app = () => {
    const root = createSSRApp({ render: () => h(RelativeTime, { at, ...options.props }) });
    if (options.clock !== false) provideRelativeNow(clock, root);
    return root;
  };
  process.env.TZ = "UTC";
  const html = await renderToString(app());
  if (options.zone) process.env.TZ = options.zone;
  const warnings: string[] = [];
  vi.spyOn(console, "warn").mockImplementation((...args) => void warnings.push(args.map(String).join(" ")));
  vi.spyOn(console, "error").mockImplementation((...args) => void warnings.push(args.map(String).join(" ")));
  const container = document.createElement("div");
  container.innerHTML = html;
  document.body.append(container);
  const client = app();
  client.mount(container);
  mounted.push(client);
  const time = container.querySelector("time");
  if (!time) throw new Error("RelativeTime rendered no <time>.");
  return { clock, html, mismatches: () => warnings.filter((line) => /hydration/i.test(line)), time };
}

describe("RelativeTime", () => {
  it("uses the native title with app-wide locale but no tooltip provider", async () => {
    const app = createSSRApp({ render: () => h(RelativeTime, { at: now - day }) });
    app.provide(Symbol.for("nuxt-ui.locale-context"), ref({ code: "en" }));
    provideRelativeNow(ref(now), app);
    const html = await renderToString(app);
    expect(html).toContain(">yesterday</time>");
    const container = document.createElement("div");
    container.innerHTML = html;
    document.body.append(container);
    app.mount(container);
    mounted.push(app);
    await nextTick();
    expect(container.querySelector("time")?.title).toContain("2026");
  });

  it("uses the native title inside a tooltip provider when the app gives no tooltip", async () => {
    const child = defineComponent({
      setup() {
        expect(useTooltipComponent()).toBeUndefined();
        return () => h(RelativeTime, { at: now });
      },
    });
    const app = createSSRApp({ render: () => h(TooltipProvider, null, { default: () => h(child) }) });
    provideRelativeNow(ref(now), app);
    expect(await renderToString(app)).toMatch(/^(?:<!--\[-->)?<time/);
  });

  it("renders the tooltip that the app gives", async () => {
    const UTooltip = defineComponent({ setup: (_props, { slots }) => () => h("span", { "data-given-tooltip": "" }, slots.default?.()) });
    const app = createSSRApp({ render: () => h(RelativeTime, { at: now }) });
    app.use(createViteHubUI({ components: { UTooltip } }));
    provideRelativeNow(ref(now), app);
    expect(await renderToString(app)).toContain("<span data-given-tooltip><time");
  });
  it("renders the words of the provided clock on the server", async () => {
    const html = await renderToString(createSSRApp({
      setup: () => provideRelativeNow(ref(now)),
      render: () => h(RelativeTime, { at: now - 5 * 60_000 }),
    }));
    expect(html).toBe('<time data-mode="relative" data-slot="relative-time" datetime="2026-11-04T11:55:00Z">5 minutes ago</time>');
  });

  it("writes a date from 3 weeks back, with its year in another year", async () => {
    expect((await hydrate(now - 21 * day)).time.textContent).toBe("Oct 14");
    expect((await hydrate("2025-10-13")).time.textContent).toBe("Oct 13, 2025");
    expect((await hydrate(now - 20 * day)).time.textContent).toBe("2 weeks ago");
  });

  it("takes the short and narrow words, another locale, and another threshold", async () => {
    expect((await hydrate("2026-10-24", { props: { format: "short" } })).time.textContent).toBe("last wk.");
    expect((await hydrate("2026-11-01", { props: { locale: "es" } })).time.textContent).toBe("hace 3 días");
    expect((await hydrate("2026-11-02", { props: { threshold: "1d" } })).time.textContent).toBe("Nov 2");
  });

  it("takes a static format from a template", async () => {
    // The template compiler turns a static `style` into the native attribute, so the prop must have another name.
    const app = createSSRApp({ components: { RelativeTime }, render: compile('<RelativeTime at="2026-10-24" format="short" />') });
    provideRelativeNow(ref(now), app);
    expect(await renderToString(app)).toContain(">last wk.</time>");
  });

  it("reads under a minute as now, before or after the clock", async () => {
    expect((await hydrate(now - 25_000)).time.textContent).toBe("now");
    expect((await hydrate(now + 4_000)).time.textContent).toBe("now");
    expect((await hydrate(now - 61_000)).time.textContent).toBe("1 minute ago");
  });

  it("hydrates a date in UTC, then shows it in the reader's zone", async () => {
    // 23:30 UTC on 13 October is 14 October in Tokyo.
    const { html, mismatches, time } = await hydrate("2026-10-13T23:30:00Z", { zone: "Asia/Tokyo" });
    expect(html).toContain(">Oct 13</time>");
    expect(mismatches()).toEqual([]);
    await nextTick();
    expect(time.textContent).toBe("Oct 14");
  });

  it("follows the clock", async () => {
    const { clock, time } = await hydrate(now - 5 * 60_000);
    clock.value += 60_000;
    await nextTick();
    expect(time.textContent).toBe("6 minutes ago");
  });

  it("gives the full date as a title outside Nuxt UI's UApp, once the reader's zone is known", async () => {
    const { html, time } = await hydrate(now - 2 * day, { zone: "Europe/Madrid" });
    expect(html).not.toContain("title");
    await nextTick();
    expect(time.getAttribute("title")).toBe("Mon, Nov 2, 2026, 1:00 PM GMT+1");
  });

  it("renders the tip in the tooltip only when it opens", async () => {
    const opened = ref(false);
    const UTooltip = defineComponent({
      setup: (_props, { slots }) => () => [slots.default?.(), opened.value ? h("span", { role: "tooltip" }, slots.content?.()) : null],
    });
    const app = createSSRApp({ setup: () => provideRelativeNow(ref(now)), render: () => h(RelativeTime, { at: now - 21 * day }) });
    app.use(createViteHubUI({ components: { UTooltip } }));
    const container = document.createElement("div");
    document.body.append(container);
    app.mount(container);
    mounted.push(app);
    await nextTick();
    expect(container.querySelector("time")?.hasAttribute("title")).toBe(false);
    expect(container.querySelector("[role=tooltip]")).toBeNull();
    opened.value = true;
    await nextTick();
    expect(container.querySelector("[role=tooltip]")?.textContent).toBe(describeTime(now - 21 * day, { locale: "en", now })?.tip);
  });

  it("leaves the tooltip out with tooltip false", async () => {
    const { time } = await hydrate(now - 2 * day, { props: { tooltip: false } });
    await nextTick();
    expect(time.hasAttribute("title")).toBe(false);
  });

  it("renders the UTC date without a clock, then counts from the browser clock", async () => {
    vi.useFakeTimers({ now: now + 10 * 60_000, toFake: ["Date", "setInterval", "clearInterval"] });
    const { html, mismatches, time } = await hydrate(now, { clock: false });
    expect(html).toContain(">Nov 4, 2026</time>");
    expect(mismatches()).toEqual([]);
    await nextTick();
    expect(time.textContent).toBe("10 minutes ago");
    vi.advanceTimersByTime(60_000);
    await nextTick();
    expect(time.textContent).toBe("11 minutes ago");
  });
});

describe("the clock", () => {
  it("moves every 30 s while the page is visible, and catches up when it shows again", () => {
    vi.useFakeTimers({ now, toFake: ["Date", "setInterval", "clearInterval"] });
    let state: DocumentVisibilityState = "visible";
    vi.spyOn(document, "visibilityState", "get").mockImplementation(() => state);
    const clock = ref(0);
    const stop = startRelativeClock(clock);
    expect(clock.value).toBe(now);

    vi.advanceTimersByTime(30_000);
    expect(clock.value).toBe(now + 30_000);

    state = "hidden";
    document.dispatchEvent(new Event("visibilitychange"));
    vi.advanceTimersByTime(5 * 60_000);
    expect(clock.value).toBe(now + 30_000);

    state = "visible";
    document.dispatchEvent(new Event("visibilitychange"));
    expect(clock.value).toBe(now + 5.5 * 60_000);

    stop();
    vi.advanceTimersByTime(60_000);
    expect(clock.value).toBe(now + 5.5 * 60_000);
  });
});
