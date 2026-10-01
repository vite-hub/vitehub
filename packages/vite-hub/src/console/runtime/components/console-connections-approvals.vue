<script setup lang="ts">
import { computed, onMounted, ref, shallowRef } from "vue";
import {
  connectionApprovalResultSchema,
  loadConnectionApprovals,
  requestConnectionsManagement,
} from "../client/connections-management";
const props = defineProps<{ endpoint: string; name: string }>();
const emit = defineEmits<{ changed: [] }>();
const approvals = ref<Awaited<ReturnType<typeof loadConnectionApprovals>>["history"]>([]);
const pendingCursors = ref<(string | undefined)[]>([undefined]);
const pendingPage = shallowRef(0);
const nextCursor = shallowRef<string>();
const loaded = ref(false);
const busy = ref(false);
const error = ref("");
const notice = ref("");
const pending = ref<Awaited<ReturnType<typeof loadConnectionApprovals>>["history"]>([]);
const decided = computed(() => approvals.value.filter((approval) => approval.status !== "pending"));
async function run(action: () => Promise<void>) {
  busy.value = true;
  error.value = "";
  notice.value = "";
  try {
    await action();
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : "Could not complete the request.";
  } finally {
    busy.value = false;
  }
}
async function fetchApprovals(before?: string) {
  const result = await loadConnectionApprovals(props.endpoint, props.name, before);
  approvals.value = result.history;
  pending.value = result.pending;
  nextCursor.value = result.nextCursor;
  loaded.value = true;
}
function load() {
  return run(async () => {
    await fetchApprovals();
    pendingCursors.value = [undefined];
    pendingPage.value = 0;
  });
}
function changePage(direction: "next" | "previous") {
  return run(async () => {
    const page = pendingPage.value + (direction === "next" ? 1 : -1);
    const before = direction === "next" ? nextCursor.value : pendingCursors.value[page];
    if (page < 0 || (direction === "next" && !before)) return;
    await fetchApprovals(before);
    pendingCursors.value = [...pendingCursors.value.slice(0, page), before];
    pendingPage.value = page;
  });
}
function decide(id: string, decision: "approve" | "deny") {
  return run(async () => {
    let failure: unknown;
    try {
      const result = await requestConnectionsManagement(
        props.endpoint,
        decision,
        connectionApprovalResultSchema,
        { id },
      );
      notice.value =
        result.approval.status === "executed"
          ? "Approved. The call ran. Status: executed."
          : result.approval.status === "denied"
            ? "Denied. The call does not run."
            : `Status: ${result.approval.status}.`;
    } catch (cause) {
      failure = cause;
    }
    await fetchApprovals(pendingCursors.value[pendingPage.value]);
    emit("changed");
    if (!failure) return;
    const message = failure instanceof Error ? failure.message : "Could not complete the request.";
    // An approved call that fails keeps the status "failed". Other errors leave the approval pending.
    error.value =
      approvals.value.find((approval) => approval.id === id)?.status === "failed"
        ? `Approved, but the call failed. Status: failed. ${message}`
        : message;
  });
}
onMounted(load);
</script>
<template>
  <div class="space-y-4">
    <div class="flex items-start justify-between gap-3">
      <p class="text-xs text-muted">
        Calls that wait for a person. Approve runs the call once with the stored input.
      </p>
      <UButton label="Refresh" color="neutral" variant="ghost" :loading="busy" @click="load" />
    </div>
    <p v-if="error" role="alert" class="text-sm text-error">{{ error }}</p>
    <p v-if="notice" role="status" class="text-sm text-muted">{{ notice }}</p>
    <p v-if="loaded && !pending.length" class="text-sm text-muted">No pending approvals.</p>
    <ol v-if="pending.length" role="list" aria-label="Pending approvals" class="divide-y divide-default">
      <li v-for="approval in pending" :key="approval.id" class="space-y-2 py-3 text-xs">
        <p class="break-all font-mono text-highlighted">{{ approval.action }}</p>
        <p class="break-all text-muted">{{ approval.actor }}</p>
        <time :datetime="approval.createdAt" class="block text-muted tabular-nums">{{
          new Date(approval.createdAt).toLocaleString()
        }}</time>
        <div class="flex gap-2">
          <UButton
            label="Approve"
            color="neutral"
            variant="outline"
            size="xs"
            :disabled="busy"
            @click="decide(approval.id, 'approve')"
          />
          <UButton
            label="Deny"
            color="error"
            variant="ghost"
            size="xs"
            :disabled="busy"
            @click="decide(approval.id, 'deny')"
          />
        </div>
      </li>
    </ol>
    <nav v-if="pendingPage > 0 || nextCursor" aria-label="Pending approval pages" class="flex items-center gap-2">
      <UButton label="Previous" color="neutral" variant="outline" size="xs" :disabled="busy || pendingPage === 0" @click="changePage('previous')" />
      <span class="text-xs text-muted">Page {{ pendingPage + 1 }}</span>
      <UButton label="Next" color="neutral" variant="outline" size="xs" :disabled="busy || !nextCursor" @click="changePage('next')" />
    </nav>
    <section v-if="decided.length" class="space-y-2">
      <h3 class="text-sm text-muted">Decided</h3>
      <ol role="list" aria-label="Decided approvals" class="divide-y divide-default">
        <li v-for="approval in decided" :key="approval.id" class="space-y-1 py-3 text-xs">
          <div class="flex flex-wrap justify-between gap-2">
            <span class="break-all font-mono text-highlighted">{{ approval.action }}</span
            ><span
              :class="
                approval.status === 'failed' || approval.status === 'denied'
                  ? 'text-error'
                  : 'text-muted'
              "
              >{{ approval.status }}</span
            >
          </div>
          <p class="break-all text-muted">
            Requested by {{ approval.actor
            }}<template v-if="approval.decidedBy"> · decided by {{ approval.decidedBy }}</template>
          </p>
          <time
            :datetime="approval.decidedAt ?? approval.createdAt"
            class="block text-muted tabular-nums"
            >{{ new Date(approval.decidedAt ?? approval.createdAt).toLocaleString() }}</time
          >
          <p v-if="approval.error" class="break-all font-mono text-error">{{ approval.error }}</p>
        </li>
      </ol>
    </section>
  </div>
</template>
