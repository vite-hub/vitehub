import { createApp, defineEventHandler, toWebHandler } from "h3";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const getItem = vi.fn<() => Promise<unknown>>();
const fetchIndex = vi.fn<() => Promise<string>>();
const storage = vi.fn(() => ({ getItem }));
vi.stubGlobal("defineEventHandler", defineEventHandler);
vi.stubGlobal("useStorage", storage);
vi.stubGlobal("$fetch", fetchIndex);
const { default: handler } = await import("../server/routes/raw/[...].get");
const request = toWebHandler(createApp().use(handler));

beforeEach(() => vi.resetAllMocks());
afterAll(() => vi.unstubAllGlobals());

describe("raw Markdown responses", () => {
  it.each(["# Introduction\n\nHello", ""])("returns stored Markdown unchanged: %j", async (markdown) => {
    getItem.mockResolvedValue(markdown);
    const response = await request(new Request("https://vitehub.dev/raw/docs/introduction.md"));

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/markdown; charset=utf-8");
    expect(await response.text()).toBe(markdown);
    expect(storage).toHaveBeenCalledWith("assets:vitehub-raw");
    expect(getItem).toHaveBeenCalledWith("docs/introduction.md");
  });

  it.each([null, { body: "not a Markdown asset" }, 42])("returns 404 for invalid storage values: %j", async (value) => {
    getItem.mockResolvedValue(value);
    const response = await request(new Request("https://vitehub.dev/raw/missing.md"));
    expect(response.status).toBe(404);
  });

  it("rejects non-Markdown paths without reading storage", async () => {
    const response = await request(new Request("https://vitehub.dev/raw/docs/introduction.html"));
    expect(response.status).toBe(404);
    expect(getItem).not.toHaveBeenCalled();
  });

  it("serves the home page from the llms index", async () => {
    fetchIndex.mockResolvedValue("# ViteHub\n\nDocumentation index");
    const response = await request(new Request("https://vitehub.dev/raw/index.md"));

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("# ViteHub\n\nDocumentation index");
    expect(fetchIndex).toHaveBeenCalledWith("/llms.txt", { responseType: "text" });
    expect(getItem).not.toHaveBeenCalled();
  });
});
