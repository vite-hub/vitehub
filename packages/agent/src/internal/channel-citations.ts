import { isAsyncIterable } from "./stream-result.ts";
import { isRuntimeString } from "./runtime-value.ts";
import type { AgentChatMessage } from "../types.ts";
import type { CardChild, CardElement } from "chat";
import type { Nodes } from "mdast";

const citationStart = "\uE200cite\uE202";
const citationEnd = "\uE201";
const unavailableCitation = "[source link unavailable]";

// Codex app-server supplies text and search actions, not a citation-ID-to-URL map.
// Keep ordinary links; label native references without guessing their sources.
function createCitationFormatter() {
  let pending = "";
  let insideCitation = false;
  return (chunk: string, final = false): string => {
    pending += chunk;
    let output = "";
    while (pending) {
      if (insideCitation) {
        const end = pending.indexOf(citationEnd);
        if (end === -1) {
          pending = "";
          break;
        }
        output += unavailableCitation;
        pending = pending.slice(end + citationEnd.length);
        insideCitation = false;
        continue;
      }
      const start = pending.indexOf(citationStart);
      if (start !== -1) {
        output += pending.slice(0, start);
        pending = pending.slice(start + citationStart.length);
        insideCitation = true;
        continue;
      }
      let held = 0;
      for (let length = 1; length < citationStart.length; length++) {
        if (pending.endsWith(citationStart.slice(0, length))) held = length;
      }
      output += pending.slice(0, pending.length - held);
      if (final) {
        if (held) output += unavailableCitation;
        pending = "";
      } else pending = pending.slice(pending.length - held);
      break;
    }
    if (final && insideCitation) {
      output += unavailableCitation;
      insideCitation = false;
    }
    return output;
  };
}

export function formatChannelCitationText(text: string): string {
  return createCitationFormatter()(text, true);
}

export function formatChannelCitationStream(stream: AsyncIterable<string>): AsyncIterable<string> {
  return {
    [Symbol.asyncIterator]() {
      const iterator = stream[Symbol.asyncIterator]();
      const format = createCitationFormatter();
      let closed = false;
      let pendingRead: Promise<IteratorResult<string>> | undefined;
      let cancelRead: (() => void) | undefined;
      const cancelled = new Promise<undefined>((resolve) => {
        cancelRead = () => resolve(undefined);
      });
      const close = async (error?: unknown, throwing = false) => {
        if (closed) return;
        closed = true;
        cancelRead?.();
        const closing = throwing && iterator.throw ? iterator.throw(error) : iterator.return?.();
        // Async generators queue return() behind next(). Request cleanup, but let
        // the delivery timeout finish while the invocation abort closes the source.
        if (pendingRead) void closing?.catch(() => undefined);
        else await closing;
      };
      return {
        async next(): Promise<IteratorResult<string>> {
          while (!closed) {
            pendingRead = iterator.next();
            const result = await Promise.race([pendingRead, cancelled]);
            pendingRead = undefined;
            if (closed || result === undefined) break;
            const text = format(result.done ? "" : result.value, Boolean(result.done));
            if (result.done) closed = true;
            if (text) return { done: false, value: text };
          }
          return { done: true, value: undefined };
        },
        // Forward cancellation immediately, even while the source's next() is stalled.
        async return(): Promise<IteratorResult<string>> {
          await close();
          return { done: true, value: undefined };
        },
        async throw(error: unknown): Promise<IteratorResult<string>> {
          await close(error, true);
          throw error;
        },
      };
    },
  };
}

function formatCitationAst<T extends Nodes>(node: T): T {
  let formatted = { ...node };
  if ("value" in node && isRuntimeString(node.value))
    formatted = { ...formatted, value: formatChannelCitationText(node.value) };
  if ("alt" in node && node.alt)
    formatted = { ...formatted, alt: formatChannelCitationText(node.alt) };
  if ("title" in node && node.title)
    formatted = { ...formatted, title: formatChannelCitationText(node.title) };
  if ("children" in node)
    formatted = { ...formatted, children: node.children.map((child) => formatCitationAst(child)) };
  return formatted;
}

type CardNode =
  | CardElement
  | CardChild
  | Extract<CardChild, { type: "actions" }>["children"][number]
  | Extract<CardChild, { type: "fields" }>["children"][number];

function formatOptionalCitationText(text: string | undefined): string | undefined {
  return text === undefined ? undefined : formatChannelCitationText(text);
}

function formatCitationCard<T extends CardNode>(node: T): T {
  switch (node.type) {
    case "card":
      return {
        ...node,
        title: formatOptionalCitationText(node.title),
        subtitle: formatOptionalCitationText(node.subtitle),
        children: node.children.map((child) => formatCitationCard(child)),
      };
    case "section":
    case "actions":
    case "fields":
      return { ...node, children: node.children.map((child) => formatCitationCard(child)) };
    case "text":
      return { ...node, content: formatChannelCitationText(node.content) };
    case "field":
      return {
        ...node,
        label: formatChannelCitationText(node.label),
        value: formatChannelCitationText(node.value),
      };
    case "button":
    case "link-button":
      return {
        ...node,
        label: formatChannelCitationText(node.label),
        tooltip: formatOptionalCitationText(node.tooltip),
      };
    case "link":
      return { ...node, label: formatChannelCitationText(node.label) };
    case "image":
      return { ...node, alt: formatOptionalCitationText(node.alt) };
    case "select":
    case "radio_select":
      return {
        ...node,
        label: formatChannelCitationText(node.label),
        ...(node.type === "select"
          ? { placeholder: formatOptionalCitationText(node.placeholder) }
          : {}),
        options: node.options.map((option) => ({
          ...option,
          label: formatChannelCitationText(option.label),
          description: formatOptionalCitationText(option.description),
        })),
      };
    case "table":
      return {
        ...node,
        caption: formatOptionalCitationText(node.caption),
        headers: node.headers.map(formatChannelCitationText),
        rows: node.rows.map((row) => row.map(formatChannelCitationText)),
      };
    case "chart":
      return {
        ...node,
        title: formatChannelCitationText(node.title),
        chart:
          node.chart.type === "pie"
            ? {
                ...node.chart,
                segments: node.chart.segments.map((segment) => ({
                  ...segment,
                  label: formatChannelCitationText(segment.label),
                })),
              }
            : {
                ...node.chart,
                categories: node.chart.categories.map(formatChannelCitationText),
                series: node.chart.series.map((series) => ({
                  ...series,
                  name: formatChannelCitationText(series.name),
                  data: series.data.map((point) => ({
                    ...point,
                    label: formatChannelCitationText(point.label),
                  })),
                })),
              },
      };
    case "divider":
      return node;
  }
}

export function formatChannelCitationMessage(message: AgentChatMessage): AgentChatMessage {
  if (isRuntimeString(message)) return formatChannelCitationText(message);
  if (isAsyncIterable(message)) {
    // SAFETY: AgentChatMessage streams yield string chunks at this delivery boundary.
    return formatChannelCitationStream(message as AsyncIterable<string>);
  }
  if ("markdown" in message)
    return { ...message, markdown: formatChannelCitationText(message.markdown) };
  if ("raw" in message) return { ...message, raw: formatChannelCitationText(message.raw) };
  if ("text" in message) return { ...message, text: formatChannelCitationText(message.text) };
  if ("ast" in message) return { ...message, ast: formatCitationAst(message.ast) };
  if ("card" in message)
    return {
      ...message,
      card: formatCitationCard(message.card),
      fallbackText: formatOptionalCitationText(message.fallbackText),
    };
  return formatCitationCard(message);
}
