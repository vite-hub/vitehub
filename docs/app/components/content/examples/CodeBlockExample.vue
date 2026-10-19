<script setup lang="ts">
import { defineComponent, h, type VNode } from "vue";
import { useHighlightedCode } from "@vite-hub/ui";

const RenderVNode = defineComponent({
  props: { node: { required: true, type: Object as () => VNode } },
  setup(props) { return () => props.node; },
});

const code = `export default defineEventHandler(async (event) => {
  const { city } = getQuery(event);
  return await getWeather(String(city));
});`;

const lines = useHighlightedCode(code, "ts");
</script>

<template>
  <CodeBlock class="max-w-lg">
    <CodeBlockHeader>
      <CodeBlockTitle><UIcon name="i-ph-file-ts-light" />server/api/weather.ts</CodeBlockTitle>
      <CodeBlockActions>
        <CodeBlockCopyButton :value="code" />
      </CodeBlockActions>
    </CodeBlockHeader>
    <CodeBlockContent line-numbers>
      <CodeBlockLine v-for="(line, index) in lines" :key="index">
        <RenderVNode :node="line" />
      </CodeBlockLine>
    </CodeBlockContent>
  </CodeBlock>
</template>
