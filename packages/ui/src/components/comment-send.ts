import type { CommentSendAgent, CommentSendClient, CommentSendState } from "@vite-hub/comments/client";
import { defineComponent, h, nextTick, onBeforeUnmount, onBeforeUpdate, onMounted, onUpdated, type PropType, ref, shallowRef, type VNode, watch } from "vue";
import { announce, prepareAnnouncer } from "../internal/announce.ts";
import { agentLogos } from "../internal/agent-logos.ts";
import { useUIComponent } from "../internal/nuxt-ui.ts";
import { useCopy } from "./copy-button.ts";

const time = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
const comments = (count: number) => `${count} ${count === 1 ? "comment" : "comments"}`;

/** What a screen reader hears when the segment changes to `state`. */
function message(state: CommentSendState): string | undefined {
  switch (state.status) {
    case "pairing":
      if (state.reason === "expired") return "Setup code expired.";
      if (state.reason === "refused") return `That URL isn't ${state.agent.host}.`;
      return `Setup prompt copied. Paste it in the ${agentLogos[state.agent.logo].thread} that should get your comments.`;
    case "confirm":
      return `${state.agent.name} at ${state.agent.host} wants your comments from this site.`;
    case "sent":
      return state.inbox ? "In inbox." : "Sent.";
    case "working":
      return "Working.";
    case "failed":
      return "Not delivered.";
    case "limited":
      return `Limit reached, try at ${time.format(state.retryAt)}.`;
    default:
      return undefined;
  }
}

/**
 * The Send segment of a comment pill: **Send N** hands the member's waiting comments to their agent, and its state
 * takes the place of the button: Sending, Sent, Working with **Open thread**, or Not delivered with **Retry**. Without
 * an agent, Send copies a setup prompt and pairs one in place, and asks once: **Allow and send N**. It renders
 * `createCommentSend()` of `vite-hub/comments/client`, starts it on mount, and stops it on unmount. It draws one row,
 * so it fits in the ViteHub pill and in Drop's.
 */
export const CommentSend = defineComponent({
  name: "CommentSend",
  props: {
    /** The client from `createCommentSend(transport)`. */
    // SAFETY: Vue's runtime constructor cannot express an interface.
    client: { required: true, type: Object as PropType<CommentSendClient> },
  },
  setup(props) {
    const UIcon = useUIComponent("UIcon");
    const { copy } = useCopy();
    const copyPrompt = (prompt: Promise<string>) => copy(() => prompt);
    const state = shallowRef(props.client.state);
    const root = ref<HTMLElement>();
    let stop: (() => void) | undefined;
    let unsubscribe: (() => void) | undefined;

    const follow = (client: CommentSendClient) => {
      unsubscribe?.();
      stop?.();
      state.value = client.state;
      unsubscribe = client.onChange(() => (state.value = client.state));
      stop = client.start();
    };
    onMounted(() => {
      prepareAnnouncer(root.value);
      follow(props.client);
    });
    watch(() => props.client, follow);
    onBeforeUnmount(() => {
      unsubscribe?.();
      stop?.();
    });

    watch(() => state.value.status === "pairing" ? `${state.value.status}:${state.value.reason ?? ""}` : state.value.status, () => {
      const text = message(state.value);
      if (text) announce(root.value, text);
    });

    // × and Escape stop pairing. The button that was pressed is gone by then, so Escape listens on the document.
    const onKeydown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      if (state.value.status !== "pairing" && state.value.status !== "confirm") return;
      event.preventDefault();
      props.client.cancel();
    };
    watch(() => state.value.status === "pairing" || state.value.status === "confirm", (listening) => {
      if (listening) document.addEventListener("keydown", onKeydown);
      else document.removeEventListener("keydown", onKeydown);
    });
    onBeforeUnmount(() => document.removeEventListener("keydown", onKeydown));

    // The segment grows and shrinks with a short ease-out. When the pressed button goes, the focus would fall to the
    // page, so it moves to the next button of the segment, unless the person moved it somewhere else meanwhile.
    let before = 0;
    let focused = false;
    const activeElement = () => (root.value?.getRootNode() as Document | ShadowRoot | undefined)?.activeElement ?? null;
    onBeforeUpdate(() => {
      before = root.value?.offsetWidth ?? 0;
      const active = activeElement();
      focused ||= Boolean(active && root.value?.contains(active));
    });
    onUpdated(() => {
      const element = root.value;
      if (!element) return;
      const after = element.offsetWidth;
      if (before && after && before !== after && !matchMedia("(prefers-reduced-motion: reduce)").matches) {
        element.animate([{ width: `${before}px`, overflow: "hidden" }, { width: `${after}px`, overflow: "hidden" }], { duration: 200, easing: "cubic-bezier(0.23, 1, 0.32, 1)" });
      }
      const active = activeElement();
      if (!focused || (active && active !== element.ownerDocument.body && !element.contains(active))) return void (focused = false);
      if (active && element.contains(active)) return;
      const next = element.querySelector<HTMLElement>("button, a");
      if (!next) return;
      focused = false;
      void nextTick(() => next.focus({ preventScroll: true }));
    });

    const icon = (name: string, spin = false) => h(UIcon, { "aria-hidden": "true", class: spin ? "vh-comment-send-icon vh-comment-send-spin" : "vh-comment-send-icon", name });
    const logo = (agent: CommentSendAgent) => {
      const drawn = agentLogos[agent.logo];
      return h("span", { "aria-hidden": "true", "data-logo": agent.logo, "data-slot": "comment-send-logo" },
        h("svg", { fill: "currentColor", viewBox: drawn.viewBox, xmlns: "http://www.w3.org/2000/svg" }, h("path", { d: drawn.path })));
    };
    const status = (tone: "error" | "warning" | undefined, children: Array<VNode | string>, attrs: Record<string, unknown> = {}) =>
      h("span", { ...attrs, "data-slot": "comment-send-status", "data-tone": tone }, children);
    const action = (name: string, children: Array<VNode | string>, attrs: Record<string, unknown> = {}) =>
      h("button", { ...attrs, "data-action": name, "data-slot": "comment-send-action", type: "button" }, children);
    const close = (label: string) => action("cancel", [icon("i-lucide-x")], { "aria-label": label, "data-icon": "", onClick: () => props.client.cancel(), title: `${label} (Esc)` });
    const copyAgain = () => action("copy-again", [icon("i-lucide-copy"), "Copy again"], { onClick: () => void props.client.copyAgain(copyPrompt) });
    const sendContent = (count: number, inbox: boolean) => [icon(inbox ? "i-lucide-inbox" : "i-lucide-send"), inbox ? "To inbox" : "Send", h("span", { "data-slot": "comment-send-count" }, String(count))];
    // Sending has no agent of its own, so it takes the words of the Send N it replaces.
    let lastInbox = false;
    const sendButton = (count: number, toInbox: boolean) => {
      lastInbox = toInbox;
      return action("send", sendContent(count, toInbox), {
        "aria-label": `${toInbox ? "Send to inbox" : "Send"}: ${comments(count)}`,
        onClick: () => void props.client.send(copyPrompt),
        title: `Send ${comments(count)} that wait for an answer to your agent`,
      });
    };

    const parts = (current: CommentSendState): Array<VNode | string> => {
      switch (current.status) {
        case "idle":
          return current.count > 0 ? [sendButton(current.count, current.inbox)] : [];
        case "pairing":
          if (current.reason === "expired") return [status("warning", [icon("i-lucide-circle-alert"), "Setup code expired"]), copyAgain(), close("Cancel connect")];
          if (current.reason === "refused") return [status("error", [icon("i-lucide-circle-alert"), `That URL isn't ${current.agent.host}`]), copyAgain(), close("Cancel connect")];
          return [
            status(undefined, [logo(current.agent), h("span", { "data-slot": "comment-send-message" }, ["Setup prompt copied. ", h("b", `Paste it in the ${agentLogos[current.agent.logo].thread}`), " that should get your comments"])]),
            status(undefined, [icon("i-lucide-loader-circle", true)], { "aria-label": "Waiting for the agent", "data-icon": "", role: "img" }),
            close("Cancel connect"),
          ];
        case "confirm":
          return [
            status(undefined, [logo(current.agent), h("span", { "data-slot": "comment-send-message" }, [h("b", current.agent.name), ` · ${current.agent.host} wants your comments from this site`])]),
            action("allow", [icon("i-lucide-check"), `Allow and send ${current.count}`], { "data-variant": "on", onClick: () => void props.client.allow() }),
            close("Don't allow"),
          ];
        case "sending":
          // A hidden copy of Send N shares the cell, so Sending is as wide as the button it replaces and the pill holds still.
          return [h("span", { "data-slot": "comment-send-hold" }, [
            status(undefined, [icon("i-lucide-loader-circle", true), "Sending"]),
            h("span", { "aria-hidden": "true", "data-slot": "comment-send-hold-copy" }, sendContent(current.count, lastInbox)),
          ])];
        case "sent":
          return [status(undefined, [icon("i-lucide-check"), current.inbox ? "In inbox" : "Sent"])];
        case "working":
          return [
            status(undefined, [h("span", { "aria-hidden": "true", "data-slot": "comment-send-dot" }), "Working"]),
            current.thread
              ? h("a", { "aria-label": `Open the ${current.agent?.name ?? "agent"} thread`, "data-action": "open", "data-slot": "comment-send-action", href: current.thread, rel: "noopener", target: "_blank" }, ["Open thread", icon("i-lucide-arrow-up-right")])
              : null,
            current.count > 0 ? sendButton(current.count, Boolean(current.agent && !current.agent.host)) : null,
          ].filter(part => part !== null);
        case "failed":
          return [
            status("error", [icon("i-lucide-circle-alert"), "Not delivered"], { title: current.reason }),
            action("retry", [icon("i-lucide-rotate-ccw"), "Retry"], { "aria-label": `Retry: send ${comments(current.count)} again`, onClick: () => void props.client.send(copyPrompt) }),
          ];
        case "limited":
          return [status("warning", [icon("i-lucide-circle-alert"), `Limit reached, try at ${time.format(current.retryAt)}`])];
      }
    };

    return () => {
      const current = state.value;
      const children = parts(current);
      return h("div", {
        "aria-label": "Send comments to your agent",
        "data-slot": "comment-send",
        "data-state": current.status,
        "data-reason": current.status === "pairing" ? current.reason : undefined,
        hidden: children.length === 0 || undefined,
        ref: root,
        role: "group",
      }, h("span", { key: current.status === "pairing" ? `pairing-${current.reason ?? ""}` : current.status, "data-slot": "comment-send-content" }, children));
    };
  },
});
