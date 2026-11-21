// CommentSend in a real browser, in the two pills that render it: the ViteHub page pill (a shadow root in the pill of
// `@vite-hub/internal`, with the comments overlay's toolbar styles) and a Vue app's own dark pill (light DOM, with
// `@vite-hub/ui/styles.css`, as Drop's). `?surface=vitehub|app` picks the pill, `?state=<name>` the state, and `?live`
// drives the real `createCommentSend()` over an in-page transport. comment-send.browser.mjs takes the screenshots.
import { createApp, defineComponent, h, type Component } from "vue";

import "./page.css";
import sendCss from "../../../comment-send.css?inline";
import { createCommentSend, type CommentSendAgent, type CommentSendClient, type CommentSendState, type CommentSendTransport } from "../../../../comments/src/client-send.ts";
import { pillBarStyles } from "../../../../comments/src/overlay/styles.ts";
import { mountViteHubPagePill, viteHubPageSvgIcon } from "../../../../internal/src/runtime/page-pill.ts";
import { viteHubPillButtonStyles } from "../../../../internal/src/runtime/page-tools-shared.ts";
import { CommentSend } from "../../../src/components/comment-send.ts";
import { createViteHubUI } from "../../../src/config.ts";

const t3: CommentSendAgent = { name: "T3 Code", logo: "t3", host: "relay.t3.codes" };
const prompt = "Connect this site's comments to this T3 thread. The code K7Q-4MX works once, for 10 minutes.";
const thread = "https://app.t3.codes/threads/42";
const retryAt = new Date(2026, 10, 19, 15, 10).getTime();

const states: Record<string, CommentSendState> = {
  idle: { status: "idle", count: 2, inbox: false },
  pairing: { status: "pairing", count: 2, prompt, expiresAt: Date.now() + 600_000, agent: t3 },
  confirm: { status: "confirm", count: 2, agent: t3 },
  sending: { status: "sending", count: 2 },
  sent: { status: "sent", count: 0, inbox: false },
  working: { status: "working", count: 0, agent: t3, thread },
  more: { status: "working", count: 1, agent: t3, thread },
  failed: { status: "failed", count: 2, reason: "The relay answered 502." },
  limited: { status: "limited", count: 2, retryAt },
  expired: { status: "pairing", count: 2, prompt, expiresAt: 0, agent: t3, reason: "expired" },
  refused: { status: "pairing", count: 2, prompt, expiresAt: 0, agent: t3, reason: "refused" },
  inbox: { status: "idle", count: 3, inbox: true },
  claude: { status: "confirm", count: 3, agent: { name: "Claude Code", logo: "claude", host: "example.com" } },
  codex: { status: "confirm", count: 3, agent: { name: "Codex", logo: "codex", host: "example.com" } },
};

/** A client that stays in one state, for a screenshot. */
function still(state: CommentSendState): CommentSendClient {
  const noop = async () => {};
  return { state, onChange: () => () => {}, start: () => () => {}, refresh: noop, send: noop, pairAnother: noop, allow: noop, copyAgain: noop, cancel: () => {} };
}

declare global {
  interface Window {
    /** The live flow: `paste()` plays the agent using the setup code, `done()` the agent finishing. */
    flow: { paste: () => void, done: () => void, calls: string[] };
  }
}

/** A server in the page: no agent yet, two waiting threads. */
function liveTransport(): CommentSendTransport {
  let pasted = false;
  let working = false;
  let done = false;
  const calls: string[] = [];
  window.flow = { paste: () => (pasted = true), done: () => (done = true), calls };
  const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
  return {
    status: async () => (working && !done ? { count: 0, agent: t3, working: { id: "send-1", thread } } : { count: working ? 0 : 2, ...(working ? { agent: t3 } : {}) }),
    startPairing: async () => {
      calls.push("startPairing");
      return { code: "K7Q-4MX", prompt, expiresAt: Date.now() + 600_000, agent: t3, count: 2, selection: "two" };
    },
    pollPairing: async () => (pasted ? { status: "paired", agent: t3 } : { status: "waiting" }),
    allow: async (code) => {
      calls.push(`allow ${code}`);
      await wait(600);
      working = true;
      return { status: "sent", id: "send-1", thread };
    },
    cancel: async (code) => void calls.push(`cancel ${code}`),
    send: async () => {
      calls.push("send");
      return { status: "sent", id: "send-2", thread };
    },
  };
}

const params = new URLSearchParams(location.search);
const surface = params.get("surface") ?? "vitehub";
const client = params.has("live")
  ? createCommentSend(liveTransport(), { pairingInterval: 200, statusInterval: 300, sentFor: 2000 })
  : still(states[params.get("state") ?? "idle"]!);

const icon = (d: string) => h("svg", { "aria-hidden": "true", fill: "none", stroke: "currentColor", "stroke-linecap": "round", "stroke-linejoin": "round", "stroke-width": 2, viewBox: "0 0 24 24" }, h("path", { d }));
const commentIcon = () => icon("M7.9 20A9 9 0 1 0 4 16.1L2 22Z");
const highlightIcon = () => icon("m9 11-6 6v3h9l3-3M22 12l-4.6 4.6a2 2 0 0 1-2.8 0l-5.2-5.2a2 2 0 0 1 0-2.8L14 4");
const eyeIcon = () => h("svg", { "aria-hidden": "true", fill: "none", stroke: "currentColor", "stroke-linecap": "round", "stroke-linejoin": "round", "stroke-width": 2, viewBox: "0 0 24 24" }, [
  h("path", { d: "M2.06 12.35a1 1 0 0 1 0-.7 10.75 10.75 0 0 1 19.88 0 1 1 0 0 1 0 .7 10.75 10.75 0 0 1-19.88 0" }),
  h("circle", { cx: 12, cy: 12, r: 3 }),
]);

/** The comments overlay's toolbar, as `toolbar()` of packages/comments/src/overlay/app.ts draws it, with Send after the eye. */
const ViteHubToolbar = defineComponent({
  setup: () => () => h("div", { class: "toolbar", role: "group", "aria-label": "Comments" }, [
    h("button", { "aria-label": "Comments, 2 open", "aria-pressed": "false", type: "button" }, [commentIcon(), "Comments", h("span", { class: "count" }, "2")]),
    h("button", { "aria-label": "Hide comments", "aria-pressed": "false", class: "eye", type: "button" }, eyeIcon()),
    h(CommentSend, { client }),
    h("button", { "aria-pressed": "false", type: "button" }, [highlightIcon(), "Highlight"]),
  ]),
});

/** A Vue app's own pill, dark on a light page, as Drop's: the Comments track holds the Send segment. */
const AppPill = defineComponent({
  setup: () => () => h("div", { class: "app-pill", role: "toolbar", "aria-label": "Document tools" }, [
    h("button", { class: "app-pill-button", type: "button" }, "Drop"),
    h("div", { class: "app-pill-track", role: "group", "aria-label": "Comments" }, [
      h("button", { class: "app-pill-button", type: "button" }, [commentIcon(), "Comments", h("span", { class: "app-pill-count" }, "5")]),
      h("button", { "aria-label": "Hide comments", class: "app-pill-button app-pill-square", type: "button" }, eyeIcon()),
      h(CommentSend, { client }),
    ]),
    h("button", { class: "app-pill-button", type: "button" }, "Share"),
  ]),
});

function mount(component: Component, into: Element) {
  createApp(component).use(createViteHubUI()).mount(into);
}

document.querySelector("#rows")!.innerHTML = `
  <article class="post">
    <nav><b>Notes from the road</b><span>Trips</span><span>Food</span><span>About</span></nav>
    <p class="kicker">São Miguel · 12 min read</p>
    <h1>Ten days in the Azores, slowly</h1>
    <p>We landed in Ponta Delgada with no car booked, which on an island with four buses a day was a mistake. The first rental desk had one car left, a manual with a cracked mirror, and we took it.</p>
    <p>Furnas is where to slow down. The cozido is cooked for six hours in the ground by the lake, and you have to order it the day before.</p>
  </article>`;

if (surface === "vitehub") {
  const controller = new AbortController();
  const pill = mountViteHubPagePill({
    name: "vitehub-pill",
    label: "ViteHub tools",
    mark: viteHubPageSvgIcon("0 0 20 18", "M19.734 8.156 15.576.844A1.66 1.66 0 0 0 14.135 0H5.819C5.226 0 4.677.32 4.38.844L.222 8.156a1.71 1.71 0 0 0 0 1.688l4.158 7.312c.297.523.846.844 1.439.844h8.316c.593 0 1.142-.32 1.438-.844l4.158-7.312c.3-.523.3-1.165.003-1.688Z", { fill: "currentColor" }),
    slots: ["comments"],
    storage: { collapsed: "comment-send-test-collapsed", dock: "comment-send-test-dock" },
    exit: { label: "Turn off ViteHub tools", press: () => {} },
    signal: controller.signal,
  });
  const segment = document.createElement("vitehub-tool");
  segment.slot = "comments";
  pill.append(segment);
  const shadow = segment.attachShadow({ mode: "open" });
  const style = document.createElement("style");
  style.textContent = viteHubPillButtonStyles + pillBarStyles + sendCss;
  const root = document.createElement("div");
  shadow.append(style, root);
  mount(ViteHubToolbar, root);
}
else {
  await import("./app.css");
  const host = document.createElement("div");
  host.className = "app-host";
  document.body.append(host);
  mount(AppPill, host);
}
