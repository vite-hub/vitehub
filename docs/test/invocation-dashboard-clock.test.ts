import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";
import { ModuleKind, transpileModule } from "typescript";
import { afterEach, expect, it, vi } from "vitest";

afterEach(() => { vi.useRealTimers(); });

const vue = createRequire(import.meta.resolve("nuxt"))("vue") as {
  ref<T>(value: T): { value: T };
};

it("refreshes prerendered invocation timestamps after hydration and preserves selection", () => {
  const buildTime = Date.parse("2026-01-01T00:00:00Z");
  const clientTime = Date.parse("2026-01-08T00:00:00Z");
  vi.useFakeTimers();
  vi.setSystemTime(clientTime);
  const mounted: Array<() => void> = [];
  const source = readFileSync(new URL("../app/components/content/examples/InvocationDashboardBlock.vue", import.meta.url), "utf8");
  const script = source.split('<script setup lang="ts">')[1]!.split("</script>")[0]!;
  const code = transpileModule(`${script}\nexport { invocations, items, selected, select };`, {
    compilerOptions: { module: ModuleKind.CommonJS },
  }).outputText;
  const exports = {};
  runInNewContext(code, {
    Date,
    exports,
    require(id: string) {
      if (id === "vue") return { ...vue, onMounted: (callback: () => void) => mounted.push(callback) };
      if (id === "@vite-hub/ui") return {
        agentInvocationContext: () => [],
        agentInvocationTitle: (invocation: { title: string }) => invocation.title,
      };
      throw new Error(`Unexpected dashboard dependency: ${id}`);
    },
    useState: () => vue.ref(buildTime),
  });
  const dashboard = exports as {
    invocations: { value: Array<{ id: string; createdAt: string }> };
    items: { value: Array<{ id: string; startedAt: string }> };
    selected: { value: { id: string; createdAt: string } };
    select(item: { id: string }): void;
  };

  expect(dashboard.invocations.value[0]!.createdAt).toBe(new Date(buildTime - 1_200_000).toISOString());
  dashboard.select(dashboard.items.value[2]!);
  const selectedId = dashboard.selected.value.id;
  expect(mounted).toHaveLength(1);
  mounted[0]!();

  expect(dashboard.invocations.value[0]!.createdAt).toBe(new Date(clientTime - 1_200_000).toISOString());
  expect(dashboard.items.value[0]!.startedAt).toBe(new Date(clientTime - 1_199_000).toISOString());
  expect(dashboard.selected.value.id).toBe(selectedId);
  expect(dashboard.selected.value.createdAt).toBe(new Date(clientTime - 2_400_000).toISOString());
});

it("refreshes the running invocation and its observations after hydration", () => {
  const buildTime = Date.parse("2026-01-01T00:00:00Z");
  const clientTime = Date.parse("2026-01-08T00:00:00Z");
  vi.useFakeTimers();
  vi.setSystemTime(clientTime);
  const mounted: Array<() => void> = [];
  const source = readFileSync(new URL("../app/components/content/examples/InvocationRunningExample.vue", import.meta.url), "utf8");
  const script = source.split('<script setup lang="ts">')[1]!.split("</script>")[0]!;
  const code = transpileModule(`${script}\nexport { invocation };`, {
    compilerOptions: { module: ModuleKind.CommonJS },
  }).outputText;
  const exports = {};
  runInNewContext(code, {
    Date,
    exports,
    require(id: string) {
      if (id === "vue") return { ...vue, onMounted: (callback: () => void) => mounted.push(callback) };
      throw new Error(`Unexpected running example dependency: ${id}`);
    },
    useState: () => vue.ref(buildTime),
  });
  const { invocation } = exports as {
    invocation: { value: { createdAt: string; observations: Array<{ timestamp: string }> } };
  };
  expect(invocation.value.createdAt).toBe(new Date(buildTime - 844_000).toISOString());
  expect(mounted).toHaveLength(1);
  mounted[0]!();
  expect(invocation.value.createdAt).toBe(new Date(clientTime - 844_000).toISOString());
  expect(invocation.value.observations[2]!.timestamp).toBe(new Date(clientTime - 20_000).toISOString());
});
