// Two parts that CSS anchor positioning places, in a real browser: CommentLayer's thread cards beside their pins, and
// AgentSession's details card, which floats as a native popover on a narrow column. anchored.browser.mjs drives them.
import { createCommentsClient, type CommentUser } from "@vite-hub/comments/client";
import { createMemoryTransport } from "@vite-hub/comments/testing";
import { createApp, defineComponent, h } from "vue";

import "./styles.css";
import { createViteHubUI } from "../../../src/config.ts";
import { AgentSession, AgentSessionDetailsRow, AgentSessionDetailsSection } from "../../../src/agent-session.ts";
import { CommentLayer } from "../../../src/components/comment-layer.ts";
import { useComments, type CommentsState } from "../../../src/headless/comments.ts";
import { uiSdkComponents } from "../../../src/ui-sdk/components.ts";

declare global {
  interface Window {
    comments: CommentsState;
  }
}

const ana: CommentUser = { id: "ana", name: "Ana Ruiz" };
const pricing = { id: "/pricing", kind: "page" } as const;

const Comments = defineComponent({
  setup() {
    const client = createCommentsClient({ transport: createMemoryTransport({ threads: [], user: ana, users: [ana] }), user: ana });
    window.comments = useComments({ client, hotkey: false, subject: pricing });
    return () => [
      h("main", [h("h1", "Pricing"), h("p", "Three plans for teams of every size."), h("div", { class: "spot", id: "spot" })]),
      h(CommentLayer, { comments: window.comments }),
    ];
  },
});

const Session = defineComponent({
  setup() {
    // `?moved` puts the session in a translated container, as in a sliding panel.
    const moved = new URLSearchParams(location.search).has("moved");
    return () => h("div", { class: "session", style: moved ? { translate: "120px 60px" } : undefined }, h(AgentSession, { title: "Fix the pricing table", subtitle: "3 min ago" }, {
      default: () => h("p", "The agent read pricing.vue and changed the yearly price."),
      details: () => h(AgentSessionDetailsSection, { title: "Session" }, () => [
        h(AgentSessionDetailsRow, { label: "Status", value: "Completed" }),
        h(AgentSessionDetailsRow, { label: "Model", value: "claude-opus" }),
      ]),
    }));
  },
});

const view = new URLSearchParams(location.search).get("view");
createApp(view === "session" ? Session : Comments).use(createViteHubUI({ components: uiSdkComponents })).mount("#app");
