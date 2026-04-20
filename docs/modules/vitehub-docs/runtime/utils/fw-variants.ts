import type { Ref } from "vue";
import {
  defaultFramework,
  frameworkLabels,
  frameworks,
  type Framework,
} from "./frameworks";

export type FwGroupContext = { selectedId: Ref<string | null> };
export const fwGroupContextKey = Symbol("vitehub.docs.fw-group");

const usageModeDefs = [
  { id: "dev", label: "Dev", description: "Local development flow", icon: "i-lucide-wrench" },
  { id: "build", label: "Build", description: "Production build flow", icon: "i-lucide-hammer" },
] as const;

export type UsageMode = (typeof usageModeDefs)[number]["id"];

type FwVariant = {
  framework: Framework;
  mode: UsageMode;
  id: `${Framework}:${UsageMode}`;
};

export const usageModes = usageModeDefs.map(entry => entry.id) as UsageMode[];
export const defaultUsageMode: UsageMode = "dev";
export const usageModeLabels = Object.fromEntries(
  usageModeDefs.map(entry => [entry.id, entry.label]),
) as Record<UsageMode, string>;
const usageModeDescriptions = Object.fromEntries(
  usageModeDefs.map(entry => [entry.id, entry.description]),
) as Record<UsageMode, string>;
const usageModeIcons = Object.fromEntries(
  usageModeDefs.map(entry => [entry.id, entry.icon]),
) as Record<UsageMode, string>;

function isFramework(value: string): value is Framework {
  return frameworks.includes(value as Framework);
}

function isUsageMode(value: string): value is UsageMode {
  return usageModes.includes(value as UsageMode);
}

export function createFwVariant(framework = defaultFramework, mode = defaultUsageMode): FwVariant {
  return {
    framework,
    mode,
    id: `${framework}:${mode}`,
  };
}

export function parseFwVariants(input: string) {
  return input
    .split(/[\s,]+/)
    .map(part => part.trim())
    .filter(Boolean)
    .map((token) => {
      const [framework, mode] = token.split(":");
      if (!framework || !mode || !isFramework(framework) || !isUsageMode(mode)) {
        return null;
      }

      return {
        framework,
        mode,
        id: `${framework}:${mode}` as const,
      } satisfies FwVariant;
    })
    .filter((variant): variant is FwVariant => Boolean(variant));
}

function isTruthyFrameworkProp(value: unknown) {
  return value !== false
    && value !== null
    && value !== undefined
    && value !== "false"
    && value !== "0"
    && value !== 0;
}

export function getFwVariantsFromProps(props: Record<string, unknown> = {}) {
  const explicitId = typeof props.id === "string" ? props.id : "";
  const explicitVariants = parseFwVariants(explicitId);

  if (explicitVariants.length > 0) {
    return explicitVariants;
  }

  const variants = Object.entries(props)
    .flatMap(([key, value]) => {
      const framework = key.replace(/^:/, "");

      if (!isFramework(framework) || !isTruthyFrameworkProp(value)) {
        return [];
      }

      return usageModes.map((mode) => {
        return {
          framework,
          mode,
          id: `${framework}:${mode}` as const,
        } satisfies FwVariant;
      });
    });

  return variants.filter((variant, index, items) => {
    return items.findIndex(item => item.id === variant.id) === index;
  });
}

export function getFwVariantIdFromProps(props: Record<string, unknown> = {}) {
  return getFwVariantsFromProps(props)
    .map(variant => variant.id)
    .join(" ");
}

export function matchesFwVariant(variants: FwVariant[], current: Pick<FwVariant, "framework" | "mode">) {
  return variants.some(variant => variant.framework === current.framework && variant.mode === current.mode);
}

export function getFwVariantTabScore(variants: FwVariant[], current: Pick<FwVariant, "framework" | "mode">) {
  if (matchesFwVariant(variants, current)) {
    return 0;
  }

  if (variants.some(variant => variant.framework === current.framework)) {
    return 1;
  }

  return 2;
}

function formatFwVariantLabel(variant: Pick<FwVariant, "framework" | "mode">) {
  return `${frameworkLabels[variant.framework]} ${usageModeLabels[variant.mode]}`;
}
