import { describe, expect, it } from "vitest";
import { parseMarkdown, stringifyMarkdown } from "chat";
import type { CardElement } from "chat";
import {
  formatChannelCitationMessage,
  formatChannelCitationStream,
  formatChannelCitationText,
} from "../src/internal/channel-citations.ts";

async function collect(chunks: AsyncIterable<string>): Promise<string> {
  let text = "";
  for await (const chunk of chunks) text += chunk;
  return text;
}

describe("Chat SDK citation delivery", () => {
  const input =
    "Yes. citeturn228505view0turn395856view0 See [the PR](https://github.com/acme/portal/pull/1188).";
  const expected =
    "Yes. [source link unavailable] See [the PR](https://github.com/acme/portal/pull/1188).";

  it("keeps the answer and verified link without inventing a URL for opaque IDs", () => {
    expect(formatChannelCitationText(input)).toBe(expected);
    expect(formatChannelCitationText("citeturn0search0citeturn1view0L8-L13")).toBe(
      "[source link unavailable][source link unavailable]",
    );
  });

  it("produces the same delivered answer for every two-chunk split", async () => {
    for (let split = 0; split <= input.length; split++) {
      const chunks = (async function* () {
        yield input.slice(0, split);
        yield input.slice(split);
      })();
      expect(await collect(formatChannelCitationStream(chunks))).toBe(expected);
    }
  });

  it("closes a source whose next chunk is stalled without waiting for it", async () => {
    let completePending: ((result: IteratorResult<string>) => void) | undefined;
    let returns = 0;
    const stream = {
      [Symbol.asyncIterator]: () => ({
        next: () =>
          new Promise<IteratorResult<string>>((resolve) => {
            completePending = resolve;
          }),
        return: async () => {
          returns++;
          return { done: true as const, value: undefined };
        },
      }),
    };
    const iterator = formatChannelCitationStream(stream)[Symbol.asyncIterator]();
    const pending = iterator.next();
    await expect(iterator.return?.()).resolves.toMatchObject({ done: true });
    expect(returns).toBe(1);
    completePending?.({ done: false, value: "late text" });
    await expect(pending).resolves.toMatchObject({ done: true });
    await iterator.return?.();
    expect(returns).toBe(1);
  });

  it("cancels a pending read from a real async generator and requests its cleanup", async () => {
    let release: ((text: string) => void) | undefined;
    const chunk = new Promise<string>((resolve) => {
      release = resolve;
    });
    let reportCleanup: (() => void) | undefined;
    const cleanedUp = new Promise<void>((resolve) => {
      reportCleanup = resolve;
    });
    const source = (async function* () {
      try {
        yield await chunk;
      } finally {
        reportCleanup?.();
      }
    })();
    const iterator = formatChannelCitationStream(source)[Symbol.asyncIterator]();
    const pending = iterator.next();
    try {
      await expect(iterator.return?.()).resolves.toMatchObject({ done: true });
      await expect(pending).resolves.toMatchObject({ done: true });
    } finally {
      release?.("late text");
    }
    await cleanedUp;
  });

  it("labels a citation truncated at the end of a completed stream", async () => {
    const chunks = (async function* () {
      yield "Answer. cite";
      yield "turn0view0";
    })();
    expect(await collect(formatChannelCitationStream(chunks))).toBe(
      "Answer. [source link unavailable]",
    );
  });

  it("does not leak a native marker prefix when generation ends halfway through it", async () => {
    const marker = "citeturn0view0";
    for (let end = 1; end < marker.length; end++) {
      const truncated = `Answer. ${marker.slice(0, end)}`;
      const expected = "Answer. [source link unavailable]";
      expect(formatChannelCitationText(truncated)).toBe(expected);
      const chunks = (async function* () {
        for (const character of truncated) yield character;
      })();
      expect(await collect(formatChannelCitationStream(chunks))).toBe(expected);
    }
  });

  it("preserves ordinary Markdown, code, Unicode, and message attachments", () => {
    const markdown =
      "**Résumé**\n\n```css\n.rgh-filter { display: none; }\n```\n\n[Source](https://example.com)";
    expect(formatChannelCitationText(markdown)).toBe(markdown);
    const files = [{ filename: "report.txt", data: Buffer.from("report") }];
    expect(formatChannelCitationMessage({ markdown: input, files })).toEqual({
      markdown: expected,
      files,
    });
    expect(formatChannelCitationMessage({ raw: input })).toEqual({ raw: expected });
    expect(formatChannelCitationMessage({ text: input })).toEqual({ text: expected });
  });

  it("formats AST text without mutating the AST, URLs, or attachments", () => {
    const ast = parseMarkdown(input);
    const files = [{ filename: "report.txt", data: Buffer.from("report") }];
    const formatted = formatChannelCitationMessage({ ast, files });
    expect(formatted).toMatchObject({
      ast: {
        children: [
          {
            children: [
              { value: "Yes. [source link unavailable] See " },
              { url: "https://github.com/acme/portal/pull/1188" },
              { value: "." },
            ],
          },
        ],
      },
      files,
    });
    expect(stringifyMarkdown(ast)).toContain("cite");
  });

  it("formats visible card text and fallback text while preserving action values and URLs", () => {
    const url = "https://example.com/source";
    const card: CardElement = {
      type: "card",
      title: input,
      subtitle: input,
      imageUrl: url,
      children: [
        { type: "section", children: [{ type: "text", content: input }] },
        { type: "fields", children: [{ type: "field", label: input, value: input }] },
        { type: "link", label: input, url },
        { type: "image", alt: input, url },
        {
          type: "actions",
          children: [
            { type: "button", id: "apply", label: input, tooltip: input, value: input },
            { type: "link-button", label: input, tooltip: input, url },
            {
              type: "select",
              id: "choose",
              label: input,
              placeholder: input,
              options: [{ label: input, description: input, value: input }],
            },
          ],
        },
        { type: "table", caption: input, headers: [input], rows: [[input]] },
        {
          type: "chart",
          title: input,
          chart: { type: "pie", segments: [{ label: input, value: 1 }] },
        },
      ],
    };
    const formatted = formatChannelCitationMessage({ card, fallbackText: input });
    expect(formatted).toMatchObject({
      card: {
        title: expected,
        subtitle: expected,
        imageUrl: url,
        children: [
          { children: [{ content: expected }] },
          { children: [{ label: expected, value: expected }] },
          { label: expected, url },
          { alt: expected, url },
          {
            children: [
              { id: "apply", label: expected, tooltip: expected, value: input },
              { label: expected, tooltip: expected, url },
              {
                id: "choose",
                label: expected,
                placeholder: expected,
                options: [{ label: expected, description: expected, value: input }],
              },
            ],
          },
          { caption: expected, headers: [expected], rows: [[expected]] },
          { title: expected, chart: { segments: [{ label: expected, value: 1 }] } },
        ],
      },
      fallbackText: expected,
    });
    expect(formatChannelCitationMessage(card)).toMatchObject({ type: "card", title: expected });
    expect(card.title).toBe(input);
  });
});
