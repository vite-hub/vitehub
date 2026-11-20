import { consoleBytes } from "../../../client/format.ts";

// Reads the `agent.input.attachments` observation: the attachments the model received and the ones left out.

export const inputAttachmentsObservation = "agent.input.attachments";

interface AttachmentRow {
  bytes?: number;
  mediaType?: string;
  messageId?: string;
  name?: string;
  origin?: string;
  reason?: string;
}

function rows(value: unknown): AttachmentRow[] {
  return Array.isArray(value) ? value.filter((item): item is AttachmentRow => typeof item === "object" && item !== null) : [];
}

function count(attributes: Record<string, unknown>, key: string, fallback: number): number {
  const value = attributes[key];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function noun(items: readonly AttachmentRow[], total: number): string {
  const images = items.every(item => typeof item.mediaType === "string" && item.mediaType.startsWith("image/"));
  return `${images ? "image" : "attachment"}${total === 1 ? "" : "s"}`;
}

/** `Sent 3 images (2.1 MB), skipped 1: byte-budget` */
export function inputAttachmentsTitle(attributes: Record<string, unknown>): string {
  const sent = rows(attributes["input.attachments.sent"]);
  const skipped = rows(attributes["input.attachments.skipped"]);
  const sentCount = count(attributes, "input.attachments.sentCount", sent.length);
  const skippedCount = count(attributes, "input.attachments.skippedCount", skipped.length);
  const bytes = count(attributes, "input.attachments.sentBytes", sent.reduce((total, item) => total + (item.bytes ?? 0), 0));
  const title = sentCount
    ? `Sent ${sentCount} ${noun(sent, sentCount)} (${consoleBytes(bytes)})`
    : `Sent no ${noun(skipped, 2)}`;
  if (!skippedCount) return title;
  const shortened = attributes["vitehub.observation.truncatedAttributes"];
  const shortenedSkips = attributes["vitehub.observation.truncated"] === true
    && (!Array.isArray(shortened) || shortened.includes("input.attachments.skipped"));
  if (skipped.length < skippedCount || shortenedSkips) return `${title}, skipped ${skippedCount}`;
  const reasons = new Map<string, number>();
  for (const item of skipped) reasons.set(item.reason ?? "unknown", (reasons.get(item.reason ?? "unknown") ?? 0) + 1);
  const list = [...reasons].map(([reason, total]) => total > 1 ? `${reason} (${total})` : reason).join(", ");
  return `${title}, skipped ${skippedCount}${list ? `: ${list}` : ""}`;
}

function line(item: AttachmentRow, outcome: string): string {
  const fields = [
    item.name ? `\`${item.name}\`` : undefined,
    item.mediaType,
    item.bytes === undefined ? undefined : consoleBytes(item.bytes),
    item.origin === "history" ? "from history" : item.origin === "current" ? "from current input" : undefined,
    item.messageId ? `message \`${item.messageId}\`` : undefined,
  ].filter(Boolean);
  return `- ${outcome}: ${fields.join(" · ")}`;
}

/** One line per attachment, sent ones first. */
export function inputAttachmentsBody(attributes: Record<string, unknown>): string | undefined {
  const lines = [
    ...rows(attributes["input.attachments.sent"]).map(item => line(item, "Sent")),
    ...rows(attributes["input.attachments.skipped"]).map(item => line(item, `Skipped (${item.reason ?? "unknown"})`)),
  ];
  return lines.length ? lines.join("\n") : undefined;
}
