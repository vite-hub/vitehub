import type { Connect, ConnectProvider, ConnectProviderKind, ConnectProviderName } from "@vite-hub/web-container/connect";
import { computed, defineComponent, h, nextTick, type PropType, ref, useId, type VNode } from "vue";
import { icon, providerLogo } from "./icons.ts";

/**
 * - `idle`: no token yet.
 * - `connecting`: the app checks the token.
 * - `connected`: the token works. Set `account`.
 * - `error`: the provider rejected the token. Set `message` to override the default copy.
 * - `blocked`: the provider blocked a browser request. Offer a relay or a command to run locally.
 * - `needs-relay`: the provider does not accept browser requests at all.
 * - `unavailable`: this step cannot run in a browser. Set `command`.
 */
export type ConnectProviderStatus = "idle" | "connecting" | "connected" | "error" | "blocked" | "needs-relay" | "unavailable";

export interface ConnectProviderState {
  status: ConnectProviderStatus
  /** The connected account, such as a user or team name. */
  account?: string
  message?: string
  /** A command the reader runs on their machine, for `blocked` and `unavailable`. */
  command?: string
}

const providerInfo: Record<ConnectProviderName, { label: string, tokenUrl: string }> = {
  anthropic: { label: "Anthropic", tokenUrl: "https://console.anthropic.com/settings/keys" },
  cloudflare: { label: "Cloudflare", tokenUrl: "https://dash.cloudflare.com/profile/api-tokens" },
  github: { label: "GitHub", tokenUrl: "https://github.com/settings/personal-access-tokens/new" },
  netlify: { label: "Netlify", tokenUrl: "https://app.netlify.com/user/applications#personal-access-tokens" },
  openai: { label: "OpenAI", tokenUrl: "https://platform.openai.com/api-keys" },
  vercel: { label: "Vercel", tokenUrl: "https://vercel.com/account/settings/tokens" },
};

const groups: readonly { kind: ConnectProviderKind, label: string }[] = [
  { kind: "deploy", label: "Deploy" },
  { kind: "source", label: "Source" },
  { kind: "model", label: "Model keys" },
];

export function connectProviderLabel(name: ConnectProviderName): string {
  return providerInfo[name].label;
}

function defaultState(provider: ConnectProvider): ConnectProviderState {
  return { status: provider.reach === "relay" ? "needs-relay" : "idle" };
}

function copyButton(text: string, onCopy: (text: string) => void): VNode {
  return h("button", { class: "vh-ws-button", type: "button", onClick: () => onCopy(text) }, [icon("copy"), "Copy command"]);
}

/** One provider: logo, label, one status line, and one action. */
export const ConnectProviderRow = defineComponent({
  name: "ConnectProviderRow",
  props: {
    provider: { required: true, type: Object as PropType<ConnectProvider> },
    state: { default: undefined, type: Object as PropType<ConnectProviderState> },
    /** Where the reader learns to deploy a relay. */
    relayUrl: { default: undefined, type: String },
  },
  emits: {
    connect: (token: string) => typeof token === "string",
    oauth: (provider: ConnectProvider) => provider.auth === "oauth",
    disconnect: () => true,
    "copy-command": (command: string) => typeof command === "string",
  },
  setup(props, { emit }) {
    const open = ref(false);
    const token = ref("");
    const inputId = useId();
    const input = ref<HTMLInputElement | null>(null);
    const state = computed(() => props.state ?? defaultState(props.provider));
    const label = computed(() => connectProviderLabel(props.provider.name));

    async function startEdit() {
      open.value = true;
      await nextTick();
      input.value?.focus();
    }
    function submit(event: Event) {
      event.preventDefault();
      const value = token.value.trim();
      if (!value) return;
      emit("connect", value);
      token.value = "";
      open.value = false;
    }
    const copy = (command: string) => emit("copy-command", command);

    function statusLine(): VNode {
      const { status, account, message } = state.value;
      const env = h("code", { class: "vh-ws-env" }, props.provider.env);
      switch (status) {
        case "connecting":
          return h("span", "Checking the token...");
        case "connected":
          return h("span", { class: "vh-ws-connected" }, [icon("check"), h("span", { class: "vh-ws-sr-only" }, "Connected: "), account ? `${account} · ` : "", env]);
        case "error":
          return h("span", { class: "vh-ws-error" }, message ?? (props.provider.auth === "oauth" ? `${label.value} connection failed. Sign in again.` : `${label.value} rejected the token. Paste a new one.`));
        case "blocked":
          return h("span", { class: "vh-ws-error" }, message ?? `${label.value} blocked the request.`);
        case "needs-relay":
          return h("span", message ?? `Needs a relay. ${label.value} does not accept browser requests.`);
        case "unavailable":
          return h("span", message ?? "Run this step on your machine.");
        case "idle":
          return h("span", message ?? (props.provider.auth === "oauth" ? "Sign in to connect" : "Paste a token"));
      }
    }

    function action(): VNode | VNode[] | undefined {
      const { status, command } = state.value;
      const relay = props.relayUrl
        ? h("a", { class: "vh-ws-button", href: props.relayUrl, rel: "noopener", target: "_blank" }, "Set up relay")
        : undefined;
      switch (status) {
        case "connected":
          return h("button", { "aria-label": `Disconnect ${label.value}`, class: "vh-ws-button", type: "button", onClick: () => emit("disconnect") }, "Disconnect");
        case "connecting":
          return h("button", { class: "vh-ws-button", disabled: true, type: "button" }, "Connecting");
        case "blocked":
          return [relay, command ? copyButton(command, copy) : undefined].filter((node): node is VNode => node !== undefined);
        case "needs-relay":
          return relay;
        case "unavailable":
          return command ? copyButton(command, copy) : undefined;
        case "error":
        case "idle":
          if (props.provider.auth === "oauth") {
            return h("button", { "aria-label": `Connect ${label.value}`, class: "vh-ws-button", type: "button", onClick: () => emit("oauth", props.provider) }, "Connect");
          }
          return open.value
            ? undefined
            : h("button", { "aria-label": `Connect ${label.value}`, class: "vh-ws-button", type: "button", onClick: startEdit }, status === "error" ? "Paste a new token" : "Connect");
      }
    }

    return () => h("li", { class: "vh-ws-provider", "data-provider": props.provider.name, "data-status": state.value.status }, [
      h("div", { class: "vh-ws-provider-row" }, [
        providerLogo(props.provider.name),
        h("div", { class: "vh-ws-provider-text" }, [
          h("span", { class: "vh-ws-provider-label" }, label.value),
          h("span", { class: "vh-ws-provider-status" }, [statusLine()]),
        ]),
        h("div", { class: "vh-ws-provider-action" }, action()),
      ]),
      open.value && props.provider.auth === "token"
        ? h("form", { class: "vh-ws-token-form", onSubmit: submit }, [
            h("label", { class: "vh-ws-token-label", for: inputId }, `${label.value} token`),
            h("div", { class: "vh-ws-token-row" }, [
              h("input", {
                autocapitalize: "off",
                autocomplete: "off",
                class: "vh-ws-input",
                "data-1p-ignore": "",
                id: inputId,
                ref: input,
                spellcheck: false,
                type: "password",
                value: token.value,
                onInput: (event: Event) => { token.value = (event.target as HTMLInputElement).value; },
                onKeydown: (event: KeyboardEvent) => { if (event.key === "Escape") open.value = false; },
              }),
              h("button", { class: "vh-ws-button vh-ws-button--primary", disabled: !token.value.trim(), type: "submit" }, "Save"),
              h("button", { class: "vh-ws-button", type: "button", onClick: () => { open.value = false; token.value = ""; } }, "Cancel"),
            ]),
            h("a", { class: "vh-ws-link", href: providerInfo[props.provider.name].tokenUrl, rel: "noopener", target: "_blank" }, "Create a token"),
          ])
        : undefined,
    ]);
  },
});

/**
 * The accounts a reader can connect, from `defineConnect()`. It renders state and emits events.
 * The application stores tokens, for example with `useConnectStore()`.
 */
export const ConnectPanel = defineComponent({
  name: "ConnectPanel",
  props: {
    connect: { required: true, type: Object as PropType<Connect> },
    /** The state of each provider. A provider without state is `idle`, or `needs-relay` when it needs one. */
    states: { default: () => ({}), type: Object as PropType<Partial<Record<ConnectProviderName, ConnectProviderState>>> },
    relayUrl: { default: undefined, type: String },
  },
  emits: {
    connect: (provider: ConnectProviderName, token: string) => typeof provider === "string" && typeof token === "string",
    oauth: (provider: ConnectProvider) => provider.auth === "oauth",
    disconnect: (provider: ConnectProviderName) => typeof provider === "string",
    "remove-all": () => true,
    "copy-command": (command: string) => typeof command === "string",
  },
  setup(props, { emit }) {
    const panelId = useId();
    const anyConnected = computed(() => Object.values(props.states).some(state => state?.status === "connected"));
    return () => h("div", { class: "vh-ws-connect" }, [
      ...groups.map(({ kind, label }) => {
        const providers = props.connect.providers.filter(provider => provider.kind === kind);
        if (providers.length === 0) return undefined;
        const headingId = `${panelId}-${kind}`;
        return h("section", { "aria-labelledby": headingId, class: "vh-ws-connect-group", key: kind }, [
          h("h3", { class: "vh-ws-connect-heading", id: headingId }, label),
          h("ul", { class: "vh-ws-providers" }, providers.map(provider => h(ConnectProviderRow, {
            key: provider.name,
            provider,
            relayUrl: props.relayUrl,
            state: props.states[provider.name],
            onConnect: (token: string) => emit("connect", provider.name, token),
            onOauth: (provider: ConnectProvider) => emit("oauth", provider),
            onDisconnect: () => emit("disconnect", provider.name),
            "onCopy-command": (command: string) => emit("copy-command", command),
          }))),
        ]);
      }),
      h("footer", { class: "vh-ws-connect-footer" }, [
        icon("lock"),
        h("p", "Tokens stay in this browser. They are passed to the workspace as environment variables. ViteHub servers never receive them."),
        h("button", { class: "vh-ws-button", disabled: !anyConnected.value, type: "button", onClick: () => emit("remove-all") }, "Remove all"),
      ]),
    ]);
  },
});
