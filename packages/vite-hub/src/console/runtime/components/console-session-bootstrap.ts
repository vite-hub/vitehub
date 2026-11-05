import { watch } from "vue";

import type { Ref } from "vue";

interface BootstrapInvocation {
  agentName?: string;
}

export async function refreshCapabilityFilteredInvocations(options: {
  navigate: () => Promise<unknown>;
  refresh: () => Promise<unknown>;
}): Promise<void> {
  const refresh = options.refresh();
  await options.navigate();
  await refresh;
}

export function useConsoleSessionBootstrap(options: {
  agentNames: Readonly<Ref<readonly string[]>>;
  firstInvocation: Readonly<Ref<BootstrapInvocation | undefined>>;
  initialBootstrapPending: Ref<boolean>;
  isUsageRoute: Readonly<Ref<boolean>>;
  isLoading: Readonly<Ref<boolean>>;
  scheduleRefresh: () => void;
  selectedAgentName: Ref<string | undefined>;
}) {
  let preservedAgentSelection: string | undefined;
  let refreshAfterPreservedAgentSelection = false;

  function selectAgentName(agentName: string, preserveInvocationList = false): void {
    if (agentName === options.selectedAgentName.value) return;
    if (preserveInvocationList) preservedAgentSelection = agentName;
    options.selectedAgentName.value = agentName;
  }

  watch(options.selectedAgentName, (agentName) => {
    if (agentName && preservedAgentSelection === agentName) {
      preservedAgentSelection = undefined;
      refreshAfterPreservedAgentSelection = true;
      if (!options.isLoading.value) {
        refreshAfterPreservedAgentSelection = false;
        options.scheduleRefresh();
      }
      return;
    }
    options.scheduleRefresh();
  });

  watch(options.isLoading, (loading) => {
    if (loading || !refreshAfterPreservedAgentSelection) return;
    refreshAfterPreservedAgentSelection = false;
    options.scheduleRefresh();
  });

  watch(options.firstInvocation, (invocation) => {
    if (
      options.isUsageRoute.value ||
      !options.initialBootstrapPending.value ||
      options.selectedAgentName.value ||
      !invocation
    )
      return;
    options.initialBootstrapPending.value = false;
    if (invocation.agentName) selectAgentName(invocation.agentName, true);
  });

  watch(
    [options.agentNames, options.initialBootstrapPending, options.isUsageRoute],
    ([agentNames, bootstrapPending, isUsageRoute]) => {
      if (
        isUsageRoute ||
        bootstrapPending ||
        options.selectedAgentName.value ||
        !agentNames.length
      )
        return;
      selectAgentName(agentNames[0]!);
    },
  );

  return {
    selectAgentName,
  };
}
