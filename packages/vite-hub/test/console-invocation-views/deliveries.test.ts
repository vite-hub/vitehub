// @vitest-environment happy-dom

import { mount } from "@vue/test-utils";
import { describe, expect, it } from "vitest";
import { AgentInvocation, AgentInvocationInspector } from "../../src/console/runtime/components/invocation/agent-invocation.ts";
import { invocationActivities, invocationActivityTitle } from "../../src/console/runtime/components/invocation/internal/invocation-activity.ts";
import type { AgentInvocationView } from "../../src/console/runtime/components/invocation/types.ts";
import { delivery, delta, event, input, invocation, message, messageAuthors, messageBodies, openWork, receipts, runSummary, threadRows, timestamp, tool, workText } from "./fixtures.ts";

const show = (value: AgentInvocationView) => mount(AgentInvocation, { props: { invocation: value } });
const messageCount = (value: AgentInvocationView) => runSummary(mount(AgentInvocationInspector, { props: { invocation: value } })).Messages;
const count = (text: string, needle: string) => text.split(needle).length - 1;
const prompt = message("user", "Run it.");
const commentary = (content: string) => message("assistant", content, { "message.phase": "commentary" });

describe("Agent Invocation channel deliveries", () => {
  describe("receipts", () => {
    it("puts the channel icon in the same icon slot as other run steps", () => {
      const wrapper = show(invocation([
        event("agent.invocation.start", { "input.prompt": "Fix it." }),
        delivery({ "channel.delivery.provider": "github", "channel.effect.kind": "reply" }),
      ], { startedAt: timestamp, status: "running" }));
      const summary = wrapper.get('[data-kind="delivery"] .vh-invocation-event__summary');
      expect(summary.element.tagName).toBe("DIV");
      expect(summary.find('.vh-invocation-event__icon[data-icon="channel"] .vh-channel-icon').exists()).toBe(true);
    });

    it.each([
      ["reply", "Reply failed", "Telegram disconnected", "Partially delivered reply."],
      ["reaction", "Reaction failed", "Reaction delivery failed", undefined],
    ])("keeps a failed %s error inspectable without presenting it as sent content", async (kind, title, error, content) => {
      const value = invocation([delivery({ "channel.effect.kind": kind, "error.message": error, ...(content ? { "channel.effect.content": content } : {}) }, { type: "error" })], { status: "failed" });
      expect(invocationActivityTitle(invocationActivities(value)[0]!)).toBe(title);
      expect(invocationActivities(value)[0]?.status).toBe("failed");
      const row = show(value).get('[data-kind="delivery"]');
      // The captured reply stays visible as the row body, outside the collapsed details.
      const body = row.find(".vh-invocation-delivery__body");
      expect(body.exists() ? body.text() : undefined).toBe(content);
      if (content) expect(body.element.parentElement).toBe(row.element);
      await row.get("summary").trigger("click");
      expect(row.get(".vh-invocation-event__failure").text()).toBe(error);
      expect(row.findAll(".vh-invocation-event__markdown")).toHaveLength(content ? 1 : 0);
      expect(row.find(".vh-invocation-event__body").exists()).toBe(false);
    });

    it("preserves Markdown-significant whitespace in captured delivery bodies", () => {
      const wrapper = mount(AgentInvocation, {
        global: { stubs: { Markdown: true } },
        props: { invocation: invocation([delivery({ "channel.effect.content": "    delivered as code\n", "channel.effect.kind": "reply" })]) },
      });
      expect(wrapper.getComponent({ name: "Markdown" }).props("value")).toBe("    delivered as code\n");
    });

    it("groups terminal work and delivery receipts while keeping the final answer visible", async () => {
      const wrapper = show(invocation([
        message("user", "Run it.", { "message.id": "user" }),
        delivery({ "channel.effect.intent": "started", "channel.effect.kind": "reaction" }),
        tool("start", "shell", "shell", { "tool.input": { command: "pnpm test" } }),
        tool("finish", "shell", "shell", { "tool.output": "passed" }),
        delivery({ "channel.delivery.provider": "telegram", "channel.effect.content": "Done.", "channel.effect.kind": "reply" }),
        message("assistant", "Done.", { "message.id": "assistant" }),
        tool("finish", "verify", "verify", { "tool.output": "clean" }),
        delivery({ "channel.effect.kind": "reply", "channel.effect.content": "Unsent reply", "error.message": "Telegram disconnected" }, { type: "error" }),
        delivery({ "channel.effect.kind": "status", "channel.effect.content": "Working" }),
        event("product.issue.completed", { "vitehub.activity.kind": "action", "vitehub.activity.title": "Updated issue" }),
      ], { cancelledAt: "2026-08-22T00:00:05.000Z", startedAt: timestamp, status: "cancelled", updatedAt: "2026-08-22T00:00:09.000Z" }));
      expect(wrapper.get('[role="log"]').attributes("aria-relevant")).toBe("additions text");
      expect(wrapper.get('[role="log"] > ol').attributes("role")).toBeUndefined();
      expect(wrapper.get('[role="log"] > ol').attributes("aria-label")).toBeUndefined();
      expect(threadRows(wrapper)).toEqual(["message", "work", "message"]);
      expect(wrapper.find(".vh-invocation-work__activities").exists()).toBe(false);

      await openWork(wrapper);
      for (const text of ["Shell", "Verify", "Unsent reply", "Updated issue", "Reply sent"]) expect(workText(wrapper)).toContain(text);
      expect(receipts(wrapper)).toHaveLength(4);
      const failedReply = wrapper.get('[data-kind="delivery"][data-status="failed"]');
      await failedReply.get("summary").trigger("click");
      expect(failedReply.text()).toContain("Telegram disconnected");
      expect(messageBodies(wrapper, "assistant", "thread")).toEqual(["Done."]);
    });

    it("shows a delivered reply as the assistant answer after the collapsed work", async () => {
      const at = (seconds: number) => new Date(Date.parse(timestamp) + seconds * 1_000).toISOString();
      const wrapper = show(invocation([
        event("vitehub.agent.configured", { "vitehub.agent.configuration": { agent: { name: "meal-logger" }, capabilities: [{ id: "db" }, { id: "transcribe" }], tools: [{ name: "db_query" }] } }),
        message("user", "Two eggs and toast.", { "message.id": "prompt" }),
        tool("finish", "lookup", "db_query", {}, { timestamp: at(4) }),
        delivery({ "channel.effect.content": "Working on it.", "channel.effect.kind": "status" }, { timestamp: at(9) }),
        delivery({ "channel.effect.content": "Logged breakfast: **412 kcal**.", "channel.effect.kind": "reply" }, { timestamp: at(18) }),
      ], { annotations: { triggeredBy: "Ada" }, completedAt: at(19), startedAt: timestamp, updatedAt: at(19) }));
      expect(threadRows(wrapper)).toEqual(["message", "work", "message"]);
      expect(messageAuthors(wrapper)).toEqual(["Ada", "Assistant"]);
      expect(messageBodies(wrapper, "assistant")).toEqual([expect.stringContaining("412 kcal")]);
      expect(wrapper.find(".vh-invocation-delivery__body").exists()).toBe(false);

      await openWork(wrapper);
      const deliveries = receipts(wrapper);
      expect(deliveries.map(item => item.get(".vh-invocation-event__title").text())).toEqual(["Status updated", "Reply sent"]);
      // A status update stays in the work log; the reply receipt keeps no second copy of the answer.
      expect(deliveries[0]!.get(".vh-invocation-delivery__body").text()).toBe("Working on it.");
      expect(deliveries[1]!.text()).not.toContain("412 kcal");
      expect(wrapper.get('[data-kind="system"] .vh-invocation-event__title').text()).toBe("Configured meal-logger with 2 capabilities");
    });
  });

  describe("answers and duplicates", () => {
    it.each(["Done.", "Delivered a different reply."])("preserves primary reply evidence for %s", async (deliveredContent) => {
      const wrapper = show(invocation([
        prompt,
        delivery({ "channel.effect.kind": "reply", "channel.effect.primary": true, "channel.effect.content": deliveredContent }),
        message("assistant", "Done."),
      ]));
      expect(wrapper.text()).toContain("Done.");
      // A delivered reply that differs from the answer is what the user saw, so it stays outside the collapsed work.
      const answers = deliveredContent === "Done." ? ["Done."] : [deliveredContent, "Done."];
      expect(messageBodies(wrapper, "assistant")).toEqual(answers);
      expect(messageAuthors(wrapper).slice(1)).toEqual(answers.map(() => "Assistant"));
      expect(wrapper.find('.vh-invocation-activities > [data-kind="delivery"]').exists()).toBe(false);
      await openWork(wrapper);
      const [receipt] = receipts(wrapper);
      expect(receipt!.text()).toContain("Reply sent");
      expect(receipt!.text()).not.toContain(deliveredContent);
      expect(count(wrapper.text(), "Done.")).toBe(1);
    });

    it.each([
      { content: "Done.", deliverySequence: 2, hasFollowup: false },
      { content: "  Done.\n", deliverySequence: 2, hasFollowup: false },
      { content: "Done.", deliverySequence: 2, hasFollowup: true },
      { content: "Done.", deliverySequence: 5, hasFollowup: true },
    ])("keeps a matching update receipt in work at sequence $deliverySequence with followup $hasFollowup", async ({ content, deliverySequence, hasFollowup }) => {
      const wrapper = show(invocation([
        prompt,
        delivery({ "channel.effect.kind": "update", "channel.effect.content": content }, { sequence: deliverySequence }),
        message("assistant", "Done.", {}, { sequence: 3 }),
        ...(hasFollowup ? [commentary("More context.")] : []),
      ].map((item, index) => ({ sequence: index + 1, ...item }))));
      expect(messageBodies(wrapper, "assistant")).toHaveLength(hasFollowup ? 2 : 1);
      expect(wrapper.find('[data-kind="delivery"]').exists()).toBe(false);
      await openWork(wrapper);
      expect(wrapper.find('.vh-invocation-activities > [data-kind="delivery"]').exists()).toBe(false);
      const [receipt] = receipts(wrapper);
      expect(receipt!.text()).toContain("Message updated");
      expect(receipt!.text()).not.toContain("Done.");
      expect(count(wrapper.text(), "Done.")).toBe(1);
    });

    it.each([
      { hasFinalAnswer: false, hasFollowup: false },
      { hasFinalAnswer: true, hasFollowup: false },
      { hasFinalAnswer: true, hasFollowup: true },
    ])("deduplicates repeated deliveries with $hasFinalAnswer final answer and $hasFollowup followup", async ({ hasFinalAnswer, hasFollowup }) => {
      const value = invocation([
        prompt,
        ...["reply", "update", "reply"].map((kind, index) => delivery({ "channel.effect.kind": kind, "channel.effect.content": index === 1 ? "  Done.\n" : "Done." })),
        ...(hasFinalAnswer ? [message("assistant", "Done.")] : []),
        ...(hasFollowup ? [commentary("More context.")] : []),
      ]);
      const wrapper = show(value);
      expect(messageBodies(wrapper, "assistant")).toHaveLength(hasFollowup ? 2 : 1);
      await openWork(wrapper);
      expect(wrapper.findAll('[data-kind="delivery"]')).toHaveLength(3);
      expect(count(wrapper.text(), "Done.")).toBe(1);
      expect(messageCount(value)).toBe(hasFollowup ? "3" : "2");
    });

    it.each([undefined, "Finished.", "Done."])("counts a delivered answer matching history with final response %s", (finalResponse) => {
      const value = invocation([
        input([["user", "Earlier question"], ["assistant", "Done."]]),
        message("user", "Run it again."),
        delivery({ "channel.effect.kind": "reply", "channel.effect.content": "Done." }),
        ...(finalResponse ? [message("assistant", finalResponse)] : []),
      ]);
      const wrapper = show(value);
      const answers = finalResponse === "Finished." ? ["Done.", "Done.", "Finished."] : ["Done.", "Done."];
      expect(messageBodies(wrapper)).toHaveLength(answers.length + 2);
      expect(messageBodies(wrapper, "assistant")).toEqual(answers);
      expect(messageCount(value)).toBe(String(answers.length + 2));
    });

    it.each(["reply", "update"].flatMap(kind =>
      [undefined, "Done.", "Finished."].flatMap(finalResponse =>
        (finalResponse ? [false, true] : [false]).map(hasFollowup => ({ kind, finalResponse, hasFollowup })))),
    )("renders a promptless $kind answer with final response $finalResponse and followup $hasFollowup", async ({ kind, finalResponse, hasFollowup }) => {
      const value = invocation([
        delivery({ "channel.effect.kind": kind, "channel.effect.content": "Done." }),
        ...(finalResponse ? [message("assistant", finalResponse)] : []),
        ...(hasFollowup ? [commentary("Followup.")] : []),
      ]);
      const wrapper = show(value);
      const answers = ["Done.", ...(finalResponse === "Finished." ? [finalResponse] : []), ...(hasFollowup ? ["Followup."] : [])];
      expect(messageBodies(wrapper, "assistant")).toEqual(answers);
      expect(wrapper.get(".vh-invocation-work__details").attributes("open")).toBeUndefined();
      expect(wrapper.find('[data-kind="delivery"]').exists()).toBe(false);
      await openWork(wrapper);
      expect(receipts(wrapper)[0]!.find(".vh-invocation-delivery__body").exists()).toBe(false);
      expect(messageCount(value)).toBe(String(answers.length));
    });
  });

  describe("order with commentary", () => {
    const prompted = (events: ReturnType<typeof delta>[], status: AgentInvocationView["status"]) => invocation([input([["user", "Check this"]], {}, "agent.input"), ...events], { status });

    it.each([
      { status: "completed", note: "One more check." },
      { status: "failed", note: "One more check." },
      { status: "completed", note: "Found it." },
      { status: "failed", note: "Found it." },
    ] as const)("preserves final then commentary order in a prompted $status session with $note", ({ status, note }) => {
      const wrapper = show(prompted([
        delta("assistant", "Found it.", { "message.phase": "final" }),
        delta("assistant", note, { "message.phase": "commentary" }),
        delivery({ "channel.effect.kind": "reply", "channel.effect.content": "Found it." }, { sequence: 5 }),
      ], status));
      expect(messageBodies(wrapper, undefined, "thread")).toEqual(["Check this", "Found it.", note]);
      expect(count(wrapper.text(), "Found it.")).toBe(note === "Found it." ? 2 : 1);
    });

    it.each(["completed", "failed"] as const)("keeps delivery-first receipts in work before the final answer and later commentary in a %s session", async (status) => {
      const wrapper = show(prompted([
        tool("start", "check", "shell"),
        delivery({ "channel.effect.kind": "reply", "channel.effect.content": "Found it." }),
        delta("assistant", "Found it.", { "message.phase": "final" }),
        delta("assistant", "One more check.", { "message.phase": "commentary" }),
      ], status));
      expect(wrapper.find('.vh-invocation-activities > [data-kind="delivery"]').exists()).toBe(false);
      await openWork(wrapper);
      expect(receipts(wrapper)[0]!.text()).toContain("Reply sent");
      expect(workText(wrapper)).not.toContain("Found it.");
      expect(count(wrapper.text(), "Found it.")).toBe(1);
      expect(messageBodies(wrapper, undefined, "thread").slice(1)).toEqual(["Found it.", "One more check."]);
    });
  });
});
