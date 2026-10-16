import { defineComponent, h, inject, type InjectionKey, type PropType, provide, ref, type Ref, toRef } from "vue";

// The values follow Liveblocks' Yjs sync status (`loading`, `synchronizing`, `synchronized`), plus `error` for a save
// the server rejected. The parts split as Kibo UI's Status. Pair it with ConnectionStatus: a disconnected editor can
// still have changes waiting to go out.

/** Where local changes stand: not loaded yet, on their way, stored, or rejected. */
export type SyncStatusValue = "loading" | "synchronizing" | "synchronized" | "error";

const statusKey: InjectionKey<Ref<SyncStatusValue>> = Symbol("SyncStatus");

const labels: Record<SyncStatusValue, string> = {
  error: "Not saved",
  loading: "Loading",
  synchronized: "Saved",
  synchronizing: "Saving",
};

export const SyncStatus = defineComponent({
  name: "SyncStatus",
  props: {
    status: { required: true, type: String as PropType<SyncStatusValue> },
  },
  setup(props, { slots }) {
    const status = toRef(props, "status");
    provide(statusKey, status);
    return () =>
      h(
        "div",
        { "data-slot": "sync-status", "data-status": props.status, role: "status" },
        slots.default?.({ status: props.status }) ?? [h(SyncStatusIndicator), h(SyncStatusLabel)],
      );
  },
});

export const SyncStatusIndicator = defineComponent({
  name: "SyncStatusIndicator",
  setup() {
    const status = inject(statusKey, ref<SyncStatusValue>("loading"));
    return () => h("span", { "aria-hidden": "true", "data-slot": "sync-status-indicator", "data-status": status.value });
  },
});

export const SyncStatusLabel = defineComponent({
  name: "SyncStatusLabel",
  setup(_props, { slots }) {
    const status = inject(statusKey, ref<SyncStatusValue>("loading"));
    return () => h("span", { "data-slot": "sync-status-label" }, slots.default?.({ status: status.value }) ?? labels[status.value]);
  },
});
