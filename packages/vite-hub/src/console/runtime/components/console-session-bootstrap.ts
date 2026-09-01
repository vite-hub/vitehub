import { watch } from "vue";

import type { Ref } from "vue";

export function usePreservedAgentSelectionRefresh(options: {
  isLoading: Readonly<Ref<boolean>>;
  scheduleRefresh: () => void;
  selectedAgentName: Readonly<Ref<string | undefined>>;
}) {
  let preservedAgentSelection: string | undefined;
  let refreshAfterPreservedAgentSelection = false;

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

  return {
    preserveInvocationListFor(agentName: string) {
      preservedAgentSelection = agentName;
    },
  };
}
