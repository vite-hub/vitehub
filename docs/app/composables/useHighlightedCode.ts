import { computed, toValue, type MaybeRefOrGetter } from "vue";
import { codeToHtml } from "shiki";
import { getCodeLanguage } from "~~/modules/vitehub-docs/runtime/utils/showcase";

function hashCode(value: string) {
  let hash = 0;

  for (let index = 0; index < value.length; index += 1) {
    hash = ((hash << 5) - hash + value.charCodeAt(index)) | 0;
  }

  return Math.abs(hash).toString(36);
}

export function useHighlightedCode(key: MaybeRefOrGetter<string>, code: MaybeRefOrGetter<string>, language?: MaybeRefOrGetter<string | undefined>) {
  const keyRef = computed(() => toValue(key));
  const codeRef = computed(() => toValue(code));
  const languageRef = computed(() => toValue(language) || getCodeLanguage(keyRef.value));
  const cacheKey = computed(() => `hl-${keyRef.value}-${languageRef.value}-${hashCode(codeRef.value)}`);

  return useAsyncData(
    cacheKey,
    () => codeToHtml(codeRef.value, {
      lang: languageRef.value,
      themes: {
        light: "material-theme-lighter",
        default: "material-theme",
        dimmed: "material-theme-palenight",
      },
    }),
    {
      watch: [keyRef, codeRef, languageRef],
    },
  );
}
