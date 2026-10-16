import { computed, defineComponent, h, inject, onBeforeUnmount, type InjectionKey, type PropType, provide, ref, type Ref, watch } from "vue";

// The parts split as Kibo UI's Status (`Status`, `StatusIndicator`, `StatusLabel`). `status` takes the values that
// y-websocket, Hocuspocus, and y-partyserver emit, so a provider's status passes straight through.

/** A realtime provider's connection status. */
export type ConnectionStatusValue = "connecting" | "connected" | "disconnected";
/** What the parts show: the first connection, a live connection, or a lost one that is coming back. */
export type ConnectionStatusState = "connecting" | "connected" | "reconnecting";

const stateKey: InjectionKey<Ref<ConnectionStatusState>> = Symbol("ConnectionStatus");

const labels: Record<ConnectionStatusState, string> = {
  connected: "Connected",
  connecting: "Connecting",
  reconnecting: "Reconnecting",
};

export const ConnectionStatus = defineComponent({
  name: "ConnectionStatus",
  props: {
    status: { required: true, type: String as PropType<ConnectionStatusValue> },
    /** How long, in ms, a lost connection stays "connected" before it shows "reconnecting". Most drops are back sooner. */
    delay: { default: 1_500, type: Number },
  },
  setup(props, { slots }) {
    const joined = ref(props.status === "connected");
    const lost = ref(false);
    let timer: ReturnType<typeof setTimeout> | undefined;
    // A provider that retries alternates between "disconnected" and "connecting": time the drop from leaving "connected".
    watch(() => props.status, (status, previous) => {
      if (status === "connected") {
        clearTimeout(timer);
        joined.value = true;
        lost.value = false;
      }
      else if (previous === "connected") {
        timer = setTimeout(() => (lost.value = true), props.delay);
      }
    });
    onBeforeUnmount(() => clearTimeout(timer));
    const state = computed<ConnectionStatusState>(() => (!joined.value ? "connecting" : lost.value ? "reconnecting" : "connected"));
    provide(stateKey, state);
    return () =>
      h(
        "div",
        { "data-slot": "connection-status", "data-status": state.value, role: "status" },
        slots.default?.({ state: state.value }) ?? [h(ConnectionStatusIndicator), h(ConnectionStatusLabel)],
      );
  },
});

export const ConnectionStatusIndicator = defineComponent({
  name: "ConnectionStatusIndicator",
  setup() {
    const state = inject(stateKey, ref<ConnectionStatusState>("connecting"));
    return () => h("span", { "aria-hidden": "true", "data-slot": "connection-status-indicator", "data-status": state.value });
  },
});

export const ConnectionStatusLabel = defineComponent({
  name: "ConnectionStatusLabel",
  setup(_props, { slots }) {
    const state = inject(stateKey, ref<ConnectionStatusState>("connecting"));
    return () => h("span", { "data-slot": "connection-status-label" }, slots.default?.({ state: state.value }) ?? labels[state.value]);
  },
});
