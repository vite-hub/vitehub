<script setup lang="ts">
import { Status } from "@vite-hub/ui";
import { computed, onMounted, ref, shallowRef } from "vue";
import {
  connectionApprovalResultSchema,
  loadConnectionApprovals,
  requestConnectionsManagement,
} from "../client/connections-management";
import type { ConsoleConnectionApproval } from "../client/connections-management";
import { consoleDateTime } from "../client/format";
import ConsoleActivityFeed from "./console-activity-feed.vue";
import ConsoleSection from "./console-section.vue";
const props = defineProps<{ endpoint: string; name: string }>();
const emit = defineEmits<{ changed: [] }>();
const approvals = ref<Awaited<ReturnType<typeof loadConnectionApprovals>>["history"]>([]);
const pendingCursors = ref<(string | undefined)[]>([undefined]);
const pendingPage = shallowRef(0);
const nextCursor = shallowRef<string>();
const busy = ref(false);
const error = ref<unknown>();
const errorTitle = ref("Could not complete the request");
const notice = ref("");
const pending = ref<Awaited<ReturnType<typeof loadConnectionApprovals>>["history"]>([]);
const decided = computed(() => approvals.value.filter((approval) => approval.status !== "pending"));
/** A decided approval as a Console status. A denied call and a failed call are both calls that did not run as asked. */
const outcomes: Partial<Record<ConsoleConnectionApproval["status"], { label: string; tone: "error" | "neutral" | "success" }>> = {
  approved: { label: "Approved", tone: "neutral" },
  denied: { label: "Denied", tone: "error" },
  executed: { label: "Executed", tone: "success" },
  failed: { label: "Failed", tone: "error" },
};
async function run(action: () => Promise<void>) {
  busy.value = true;
  error.value = undefined;
  errorTitle.value = "Could not complete the request";
  notice.value = "";
  try {
    await action();
  } catch (cause) {
    error.value = cause;
  } finally {
    busy.value = false;
  }
}
async function fetchApprovals(before?: string) {
  const result = await loadConnectionApprovals(props.endpoint, props.name, before);
  approvals.value = result.history;
  pending.value = result.pending;
  nextCursor.value = result.nextCursor;
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
          ? "Approved. The call ran."
          : result.approval.status === "denied"
            ? "Denied. The call does not run."
            : `${outcomes[result.approval.status]?.label ?? result.approval.status}.`;
    } catch (cause) {
      failure = cause;
    }
    await fetchApprovals(pendingCursors.value[pendingPage.value]);
    emit("changed");
    if (!failure) return;
    // An approved call that fails keeps the status "failed". Other errors leave the approval pending.
    error.value = failure;
    errorTitle.value =
      approvals.value.find((approval) => approval.id === id)?.status === "failed"
        ? "Approved, but the call failed"
        : "Could not complete the request";
  });
}
onMounted(load);
</script>
<template>
  <ConsoleActivityFeed
    description="Calls that wait for a person. Approve runs the call once with the stored input."
    :items="pending"
    :item-key="(approval) => approval.id"
    label="Pending approvals"
    :loading="busy"
    :error="error"
    :error-title="errorTitle"
    empty-title="No pending approvals"
    empty-description="A call that needs a person waits here until someone approves or denies it."
    empty-icon="i-lucide-shield-check"
    :refresh="load"
  >
    <template #notices>
      <p v-if="notice" role="status" class="text-sm text-muted">{{ notice }}</p>
    </template>
    <template #item="{ item: approval }">
      <div class="space-y-2">
        <p class="break-all font-mono text-highlighted">{{ approval.action }}</p>
        <p class="break-all text-muted">{{ approval.actor }}</p>
        <time :datetime="approval.createdAt" class="block text-muted tabular-nums">{{
          consoleDateTime(approval.createdAt)
        }}</time>
        <div class="flex gap-2">
          <UButton
            label="Approve"
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
      </div>
    </template>
    <nav v-if="pendingPage > 0 || nextCursor" aria-label="Pending approval pages" class="flex items-center gap-2">
      <UButton label="Previous" variant="outline" size="xs" :disabled="busy || pendingPage === 0" @click="changePage('previous')" />
      <span class="text-xs text-muted">Page {{ pendingPage + 1 }}</span>
      <UButton label="Next" variant="outline" size="xs" :disabled="busy || !nextCursor" @click="changePage('next')" />
    </nav>
    <ConsoleSection v-if="decided.length" :level="3" title="Decided" :count="decided.length">
      <ol role="list" aria-label="Decided approvals" class="divide-y divide-default">
        <li v-for="approval in decided" :key="approval.id" class="space-y-1 py-3 text-xs">
          <div class="flex flex-wrap justify-between gap-2">
            <span class="break-all font-mono text-highlighted">{{ approval.action }}</span
            ><Status
              :label="outcomes[approval.status]?.label ?? approval.status"
              :tone="outcomes[approval.status]?.tone"
            />
          </div>
          <p class="break-all text-muted">
            Requested by {{ approval.actor
            }}<template v-if="approval.decidedBy"> · decided by {{ approval.decidedBy }}</template>
          </p>
          <time
            :datetime="approval.decidedAt ?? approval.createdAt"
            class="block text-muted tabular-nums"
            >{{ consoleDateTime(approval.decidedAt ?? approval.createdAt) }}</time
          >
          <p v-if="approval.error" class="break-all font-mono text-error">{{ approval.error }}</p>
        </li>
      </ol>
    </ConsoleSection>
  </ConsoleActivityFeed>
</template>
