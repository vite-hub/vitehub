// @vitest-environment happy-dom

import { flushPromises, mount } from "@vue/test-utils";
import { h, nextTick } from "vue";
import { describe, expect, it, vi } from "vitest";
import { AgentInvocation, AgentInvocationInspector, workspaceArtifactPath } from "../../src/console/runtime/components/invocation/agent-invocation.ts";
import type { AgentInvocationView } from "../../src/console/runtime/components/invocation/types.ts";
import {
  clipboard, delivery, delta, event, input, invocation, message, messageAuthors, messageBodies, openWork,
  runSummary, threadRows, timestamp, tool, workText, workTitle,
} from "./fixtures.ts";

const show = (value: AgentInvocationView, props: Record<string, unknown> = {}) => mount(AgentInvocation, { props: { invocation: value, ...props } });
const messageCount = (value: AgentInvocationView) => runSummary(mount(AgentInvocationInspector, { props: { invocation: value } })).Messages;
const steer = (content: string) => delta("user", content, { "input.mode": "steer", "message.id": "steer" });

describe("Agent Invocation session thread", () => {
  describe("session", () => {
    it("places one semantic run timestamp before the session activities and falls back to creation time", () => {
      const value = invocation([], { createdAt: "2026-09-05T10:00:00Z", startedAt: "2026-09-05T10:01:00Z", updatedAt: "2026-09-05T10:02:00Z" });
      const wrapper = show(value);
      const time = wrapper.get("time");
      expect(time.attributes("datetime")).toBe("2026-09-05T10:01:00.000Z");
      expect(time.element.nextElementSibling?.getAttribute("role")).toBe("log");
      expect(wrapper.findAll("time")).toHaveLength(1);
      expect(show({ ...value, startedAt: "invalid" }).get("time").attributes("datetime")).toBe("2026-09-05T10:00:00.000Z");
    });

    it("mounts the session log before the first activity", async () => {
      const waiting = invocation([], { status: "running" });
      const wrapper = show(waiting);
      const log = wrapper.get('[role="log"]').element;
      expect(wrapper.get('[role="status"]').text()).toContain("Waiting for the first update");
      await wrapper.setProps({ invocation: invocation([message("assistant", "Started", { "message.id": "assistant" })], { status: "running" }) });
      expect(wrapper.get('[role="log"]').element).toBe(log);
      expect(wrapper.find('[role="status"]').exists()).toBe(false);
      expect(wrapper.get('[role="log"] li').text()).toContain("Started");
    });

    it("uses one flexible grid row when the host owns the header", () => {
      expect(show(invocation([], { status: "running" }), { header: false }).get("article").classes()).toContain("vh-invocation-session--headerless");
    });

    it("keeps active work visible and collapses it when the run completes", async () => {
      const active = invocation([
        message("user", "Run it.", { "message.id": "user" }),
        tool("start", "shell", "shell", { "tool.input": { command: "pnpm test" } }),
      ], { startedAt: timestamp, status: "running", updatedAt: "2026-08-22T00:00:09.000Z" });
      const wrapper = show(active);
      expect(workTitle(wrapper)).toBe("Working…");
      expect(wrapper.get(".vh-invocation-work__details").attributes("open")).toBe("");
      expect(workText(wrapper)).toContain("Shell");

      await wrapper.setProps({ invocation: { ...active, completedAt: "2026-08-22T00:00:09.000Z", status: "completed" } });
      expect(workTitle(wrapper)).toBe("Worked for 9s");
      expect(wrapper.get(".vh-invocation-work__details").attributes("open")).toBeUndefined();
      expect(wrapper.find(".vh-invocation-work__activities").exists()).toBe(false);
    });
  });

  describe("messages", () => {
    it("preserves input message roles in the thread and the work", async () => {
      const wrapper = show(invocation([input([["system", "Follow the repository rules."], ["user", "Review this change."], ["assistant", "I found one issue."], ["tool", "The check passed."]])]));
      expect(messageAuthors(wrapper)).toEqual(["System", "You", "Assistant"]);
      await openWork(wrapper);
      expect(wrapper.get('[data-role="tool"] .vh-invocation-message__role').text()).toBe("Tool");
    });

    it("keeps completed multi-turn conversations outside work summaries", () => {
      const wrapper = show(invocation([input([["user", "First question"], ["assistant", "First answer"], ["user", "Follow-up question"], ["assistant", "Final answer"]])], { completedAt: timestamp }));
      expect(threadRows(wrapper)).not.toContain("work");
      expect(messageBodies(wrapper)).toEqual(["First question", "First answer", "Follow-up question", "Final answer"]);
    });

    it("keeps late commentary after the final answer", () => {
      const wrapper = show(invocation([
        message("user", "Question", { "message.id": "0", "message.phase": "message" }),
        message("assistant", "Final answer", { "message.id": "1", "message.phase": "final" }),
        message("assistant", "Late commentary", { "message.id": "2", "message.phase": "commentary" }),
        event("agent.step.completed"),
      ]));
      expect(messageBodies(wrapper)).toEqual(["Question", "Final answer", "Late commentary"]);
    });

    it("collapses long user messages until requested", async () => {
      const wrapper = show(invocation([message("user", "x".repeat(721), { "message.id": "user" })], { status: "running" }));
      expect(wrapper.get(".vh-invocation-message__content").attributes("data-collapsed")).toBe("true");
      expect(wrapper.get(".vh-invocation-message__more").text()).toBe("Read more");
      await wrapper.get(".vh-invocation-message__more").trigger("click");
      expect(wrapper.get(".vh-invocation-message__content").attributes("data-collapsed")).toBeUndefined();
      expect(wrapper.get(".vh-invocation-message__more").text()).toBe("Show less");
    });

    it("attributes only the first prompt and copies each visible message", async () => {
      const at = "2026-08-22T14:35:00.000Z";
      const writeText = vi.fn().mockResolvedValue(undefined);
      clipboard(writeText);
      const wrapper = show(invocation([
        input([["user", "Earlier question"], ["assistant", "Earlier answer"]], {}, "agent.invocation.started"),
        message("user", "Check item 18807.", { "channel.sentAt": at, "message.id": "prompt" }),
      ], {
        agentName: "support-agent",
        annotations: { triggeredBy: "Maxi", "channel.sentAt": "2026-08-22T14:34:00.000Z", "github.url": "https://github.com/vite-hub/vite-hub/issues/18807" },
        createdAt: at,
        id: "message-meta",
        status: "running",
        updatedAt: at,
      }));
      expect(wrapper.findAll(".vh-invocation-message__meta")).toHaveLength(3);
      expect(messageAuthors(wrapper)).toEqual(["You", "Assistant", "Maxi"]);
      const prompt = wrapper.findAll(".vh-invocation-message").at(-1)!;
      expect(prompt.get(".vh-invocation-message__meta time").attributes("datetime")).toBe("2026-08-22T14:34:00.000Z");
      await prompt.get('button[aria-label="Copy message"]').trigger("click");
      await flushPromises();
      expect(writeText).toHaveBeenCalledWith("Check item 18807.\n\nInvocation ID: message-meta\nTrace ID: trace\nAgent: support-agent\nURL: https://github.com/vite-hub/vite-hub/issues/18807");
      expect(prompt.get('button[aria-label="Copied"]').text()).toBe("Copied");
    });

    it("does not announce message copy success when the clipboard rejects", async () => {
      clipboard(vi.fn().mockRejectedValue(new Error("Clipboard denied")));
      const wrapper = show(invocation([message("user", "Copy me", { "message.id": "prompt" })], { status: "running" }));
      await wrapper.get('button[aria-label="Copy message"]').trigger("click");
      await flushPromises();
      expect(wrapper.find('button[aria-label="Copied"]').exists()).toBe(false);
      expect(wrapper.get('button[aria-label="Copy failed"]').text()).toContain("Copy failed");
      expect(wrapper.get('[role="status"]').text()).toBe("Message could not be copied");
    });

    it("collapses Teams history and renders one trigger, work summary, and final answer", async () => {
      const at = "2026-08-22T14:35:00.000Z";
      const history = Array.from({ length: 49 }, (_, index) => ({
        id: `history-${index}`,
        parts: [{ text: index === 48 ? "Old delivered answer" : `Earlier message ${index + 1}`, type: "text" }],
        role: index % 2 ? "assistant" : "user",
      }));
      const wrapper = show(invocation([
        event("agent.invocation.started", { "input.messages": history }, { sequence: 1 }),
        message("assistant", "Order multiple source", { "vitehub.auxiliary.kind": "title" }, { sequence: 1.5 }),
        message("user", "Where does the order multiple come from?", { "message.id": "trigger" }, { sequence: 2 }),
        tool("finish", "search", "search", {}, { sequence: 3 }),
        message("assistant", "", { "message.id": "empty" }, { sequence: 4 }),
        message("assistant", "The order multiple comes from BC.", { "message.id": "final" }, { sequence: 5 }),
        delivery({ "channel.effect.intent": "failed", "channel.effect.kind": "reaction" }, { sequence: 5.5 }),
        delivery({ "channel.delivery.provider": "msteams", "channel.effect.content": "The order multiple comes from BC.", "channel.effect.kind": "reply" }, { sequence: 6 }),
      ], { createdAt: at, startedAt: at, updatedAt: "2026-08-22T14:35:08.000Z" }));
      const rows = wrapper.findAll(".vh-invocation-activities > li");
      expect(threadRows(wrapper)).toEqual(["history", "message", "work", "message"]);
      expect(rows[0]!.get("summary").text()).toContain("49 previous messages");
      expect((rows[0]!.get("details").element as HTMLDetailsElement).open).toBe(false);
      expect(rows[1]!.text()).toContain("Where does the order multiple come from?");
      expect(workTitle(wrapper)).toBe("Worked for 8s");
      expect(rows[3]!.text()).toContain("The order multiple comes from BC.");
      expect(wrapper.text().split("The order multiple comes from BC.")).toHaveLength(2);
      expect(wrapper.text()).not.toContain("Order multiple source");
      await openWork(wrapper);
      const receipts = rows[2]!.findAll('[data-kind="delivery"]');
      expect(wrapper.findAll('[data-kind="delivery"]')).toHaveLength(2);
      expect(receipts).toHaveLength(2);
      expect(receipts[1]!.text()).toContain("Reply sent");
      expect(receipts[1]!.get(".vh-channel-icon").attributes("aria-label")).toBe("Microsoft Teams");
    });

    it("preserves assistant history matching the session title while omitting title observations", () => {
      const wrapper = show(invocation([
        message("assistant", "Done", { "message.id": "earlier-answer" }),
        event("agent.title.recorded", { "message.content": "Done", "message.role": "assistant" }),
        message("user", "Check again", { "message.id": "prompt" }),
        message("assistant", "Checked again", { "message.id": "answer" }),
      ], { title: "Done" }));
      expect(messageBodies(wrapper.get(".vh-invocation-history__messages"))).toEqual(["Done"]);
      expect(wrapper.findAll('[role="log"] .vh-invocation-message')).toHaveLength(3);
    });

    it.each(["completed", "failed", "cancelled"] as const)("labels messages in collapsed work for %s runs", (status) => {
      const value = invocation([message("user", "Run the tests.", { "message.id": "0" }), message("tool", "Tests passed.", { "message.id": "1" }), message("assistant", "The tests pass.", { "message.id": "2" })], { status });
      const wrapper = show(value);
      expect(messageBodies(wrapper)).toHaveLength(2);
      expect(wrapper.get(".vh-invocation-work__details").attributes("open")).toBeUndefined();
      expect(messageCount(value)).toBe("3");
    });
  });

  describe("repeated prompts", () => {
    const answers = (commentary: boolean) => commentary ? [message("assistant", "Continuing.", { "message.id": "commentary", "message.phase": "commentary" })] : [];

    it.each([false, true])("preserves a distinct repeated user turn with commentary=%s", async (commentary) => {
      const wrapper = show(invocation([
        message("user", "Run it.", { "message.id": "prompt" }),
        message("assistant", "First answer.", { "message.id": "answer-1" }),
        message("user", "Run it.", { "message.id": "later-user" }),
        message("assistant", "Second answer.", { "message.id": "answer-2" }),
        ...answers(commentary),
      ]));
      await openWork(wrapper);
      expect(messageBodies(wrapper, "user")).toEqual(["Run it.", "Run it."]);
      expect(workText(wrapper)).toContain("First answer.");
      expect(wrapper.text()).toContain("Second answer.");
    });

    it.each([false, true])("hides the initial driver echo with independent IDs and commentary=%s", async (commentary) => {
      const driverInput = (content: string, id: string) => event("agent.input.message", { "message.content": content, "message.id": id, "message.role": "user" });
      const wrapper = show(invocation([
        event("agent.invocation.started", { "input.messages": [{ id: "persisted-prompt", role: "user", parts: [{ type: "text", text: "Run it." }] }] }),
        driverInput("Run it.", "driver-event"),
        message("assistant", "First answer.", { "message.id": "answer-1" }),
        driverInput("Run it.", "later-event"),
        message("assistant", "Second answer.", { "message.id": "answer-2" }),
        ...answers(commentary),
      ]));
      await openWork(wrapper);
      expect(messageBodies(wrapper, "user")).toEqual(["Run it.", "Run it."]);
      expect(messageBodies(wrapper, "user", "work")).toHaveLength(1);
      expect(wrapper.text()).toContain("First answer.");
      expect(wrapper.text()).toContain("Second answer.");
    });

    it.each([true, false])("hides a repeated prompt record only with a shared identity=%s", async (sharedIdentity) => {
      const wrapper = show(invocation([
        message("user", "Run it.", sharedIdentity ? { "message.id": "prompt" } : {}),
        event("agent.invocation.started", { "input.messages": [{ id: "prompt", role: "user", parts: [{ type: "text", text: "Run it." }] }] }),
        message("assistant", "Done.", { "message.id": "answer" }),
      ]));
      if (wrapper.find(".vh-invocation-work__details").exists()) await openWork(wrapper);
      expect(messageBodies(wrapper, "user")).toHaveLength(sharedIdentity ? 1 : 2);
    });

    it("counts the rendered messages after the initial driver echo is removed", () => {
      const value = invocation([
        event("agent.invocation.started", { "input.messages": [{ id: "prompt", role: "user", parts: [{ type: "text", text: "Run the tests." }] }] }),
        event("agent.input.message", { "message.role": "user", "message.content": "Run the tests.", "message.id": "driver-prompt" }),
        event("agent.message.recorded", { "message.role": "assistant", "message.content": "The tests pass.", "message.id": "answer" }),
      ]);
      expect(messageBodies(show(value))).toHaveLength(2);
      expect(messageCount(value)).toBe("2");
    });
  });

  describe("steers and commentary", () => {
    const checkThis = input([["user", "Check this"]], {}, "agent.input");

    it("preserves distinct assistant turns with identical text after a steer", async () => {
      const wrapper = show(invocation([
        checkThis,
        delta("assistant", "Done", { "message.id": "first-answer" }),
        steer("Check again"),
        delta("assistant", "Done", { "message.id": "second-answer" }),
        event("agent.invocation.finish", { "result.text": "Done" }),
      ]));
      expect(messageBodies(wrapper, undefined, "thread")).toEqual(["Check this", "Done"]);
      await openWork(wrapper);
      expect(messageBodies(wrapper, undefined, "work")).toEqual(["Done", "Check again"]);
    });

    it.each(["running", "failed"] as const)("keeps an unanswered steer after the earlier reply in a %s session", async (status) => {
      const wrapper = show(invocation([
        checkThis,
        delta("assistant", "Earlier answer", { "message.id": "first-answer" }),
        steer("Check again"),
        tool("start", "check", "shell", { "tool.input": { command: "pnpm test" } }),
      ], { status }));
      expect(messageBodies(wrapper, undefined, "thread")).toHaveLength(1);
      await openWork(wrapper);
      expect(messageBodies(wrapper, undefined, "work")).toEqual(["Earlier answer", "Check again"]);
      expect(workText(wrapper).indexOf("Check again")).toBeLessThan(workText(wrapper).indexOf("Shell"));
    });

    it.each(["running", "failed"] as const)("keeps commentary before later tools in a prompted %s session", async (status) => {
      const wrapper = show(invocation([
        checkThis,
        delta("assistant", "Checking the fix.", { "message.phase": "commentary" }),
        tool("start", "check", "shell", { "tool.input": { command: "pnpm test" } }),
      ], { status }));
      expect(messageBodies(wrapper, undefined, "thread")).toHaveLength(1);
      await openWork(wrapper);
      expect(workText(wrapper)).toContain("Checking the fix.");
      expect(workText(wrapper).indexOf("Checking the fix.")).toBeLessThan(workText(wrapper).indexOf("Shell"));
      // Commentary is part of the work, so it has no author line or copy button.
      expect(wrapper.get('.vh-invocation-work__activities .vh-invocation-message[data-phase="commentary"]').find(".vh-invocation-message__meta").exists()).toBe(false);
    });

    it("keeps provider summary and commentary items as separate markdown blocks", async () => {
      const wrapper = show(invocation([
        checkThis,
        delta("assistant", "**Reading related facts**", { "message.id": "reasoning_summary_text:turn", "message.phase": "commentary" }),
        delta("assistant", "I’m also applying the evidence skill.", { "message.id": "assistant_text:comment", "message.phase": "commentary" }),
        tool("start", "check", "search"),
      ], { status: "running" }));
      await openWork(wrapper);
      const rows = wrapper.get(".vh-invocation-work__activities").findAll(":scope > li");
      expect(rows.slice(0, 2).map(row => row.attributes("data-phase"))).toEqual(["commentary", "commentary"]);
      expect(rows[0]!.text()).toContain("Reading related facts");
      expect(rows[0]!.text()).not.toContain("I’m also applying");
      expect(rows[1]!.text()).toContain("I’m also applying the evidence skill.");
      expect(rows[1]!.find(".vh-invocation-message__meta").exists()).toBe(false);
    });
  });

  describe("workspace links", () => {
    it("recognizes safe absolute provider Workspace artifact links", () => {
      expect(workspaceArtifactPath("/workspace/vitehub-provider-DjQaJy/artifacts/source-map.html")).toBe("artifacts/source-map.html");
      expect(workspaceArtifactPath("/workspace/run/../.env")).toBeUndefined();
      expect(workspaceArtifactPath("/workspace/run/report.html#summary")).toBe("report.html");
      expect(workspaceArtifactPath("/workspace/run/image.png?download=1#preview")).toBe("image.png");
      expect(workspaceArtifactPath("/workspace/run/report%23summary%3Fdraft.html?download=1")).toBe("report#summary?draft.html");
      expect(workspaceArtifactPath("/workspace/run/%2e%2e/.env?download=1")).toBeUndefined();
    });

    it("opens provider Workspace artifact links through the inspector", () => {
      const wrapper = show(invocation([message("assistant", "[Source map](/workspace/provider-session/artifacts/source-map.html)", { "message.id": "answer" })]));
      const link = document.createElement("a");
      link.href = "/workspace/provider-session/artifacts/source-map.html";
      wrapper.element.append(link);
      link.dispatchEvent(new MouseEvent("click", { bubbles: true, button: 0, cancelable: true }));
      expect(wrapper.emitted("inspect")?.at(-1)).toEqual(["workspace", "artifacts/source-map.html"]);
    });

    it("forwards workspace artifact paths without navigating", async () => {
      const wrapper = mount(AgentInvocation, {
        props: { invocation: invocation([], { status: "running" }) },
        slots: { footer: () => h("a", { href: "/workspace/id/reports/a%23b.md" }, "Artifact") },
      });
      await wrapper.get("a").trigger("click");
      expect(wrapper.emitted("inspect")).toEqual([["workspace", "reports/a#b.md"]]);
      await wrapper.setProps({ workspaceInspectable: false });
      await wrapper.get("a").trigger("click");
      expect(wrapper.emitted("inspect")).toHaveLength(1);
    });
  });
});
