import { computed, toValue, type MaybeRefOrGetter } from "vue";
import {
  getShowcaseFiles,
  getShowcaseExamples,
  getShowcasePhasePaths,
} from "../utils/showcase";
import { useFrameworkPreference } from "./useFrameworkPreference";
import { useUsageModePreference } from "./useUsageModePreference";

export function useShowcaseExamples(docsPath?: MaybeRefOrGetter<string | undefined>) {
  const pathRef = computed(() => toValue(docsPath));
  const { current: framework } = useFrameworkPreference();
  const { current: mode } = useUsageModePreference();

  const examples = computed(() => getShowcaseExamples());
  const example = computed(() => examples.value.find(entry => entry.docsPath === pathRef.value));
  const phases = computed(() => {
    if (!example.value) {
      return {};
    }

    return getShowcasePhasePaths(example.value, framework.value, mode.value);
  });
  const files = computed(() => {
    if (!example.value) {
      return [];
    }

    return getShowcaseFiles(example.value, framework.value, mode.value);
  });

  return {
    examples,
    example,
    framework,
    mode,
    phases,
    files,
  };
}
