import { h } from "vue";
import { brandIcons, type BrandIconId } from "./brand-icons.ts";

const brands = {
  alibaba: { icon: "qwen", label: "Alibaba" },
  anthropic: { icon: "anthropic", label: "Anthropic" },
  aws: { icon: "aws", label: "AWS" },
  azure: { icon: "azure", label: "Azure" },
  bedrock: { icon: "bedrock", label: "Amazon Bedrock" },
  cerebras: { icon: "cerebras", label: "Cerebras" },
  cloudflare: { icon: "cloudflare", label: "Cloudflare" },
  codex: { icon: "openai", label: "Codex" },
  cohere: { icon: "cohere", label: "Cohere" },
  deepseek: { icon: "deepseek", label: "DeepSeek" },
  fireworks: { icon: "fireworks", label: "Fireworks AI" },
  google: { icon: "google", label: "Google" },
  groq: { icon: "groq", label: "Groq" },
  huggingface: { icon: "huggingface", label: "Hugging Face" },
  meta: { icon: "meta", label: "Meta" },
  minimax: { icon: "minimax", label: "MiniMax" },
  mistral: { icon: "mistral", label: "Mistral AI" },
  moonshot: { icon: "moonshot", label: "Moonshot AI" },
  nvidia: { icon: "nvidia", label: "NVIDIA" },
  ollama: { icon: "ollama", label: "Ollama" },
  openai: { icon: "openai", label: "OpenAI" },
  openrouter: { icon: "openrouter", label: "OpenRouter" },
  perplexity: { icon: "perplexity", label: "Perplexity" },
  qwen: { icon: "qwen", label: "Qwen" },
  replicate: { icon: "replicate", label: "Replicate" },
  together: { icon: "together", label: "Together AI" },
  xai: { icon: "xai", label: "xAI" },
  zai: { icon: "zai", label: "Z.AI" },
} satisfies Record<string, { icon: BrandIconId; label: string }>;

type BrandId = keyof typeof brands;

export type InvocationBrand =
  | { icon: BrandIconId; id: BrandId; label: string }
  | { id: "fallback"; label: string };

// Provider ids from AI SDK, gateways, and hosts that differ from the brand id.
const providerAliases: Readonly<Record<string, BrandId>> = {
  "alibaba-cloud": "alibaba",
  "amazon-bedrock": "bedrock",
  "amazon-web-services": "aws",
  amazon: "aws",
  "fireworks-ai": "fireworks",
  "google-vertex": "google",
  "hugging-face": "huggingface",
  "microsoft-azure": "azure",
  mistralai: "mistral",
  "moonshot-ai": "moonshot",
  moonshotai: "moonshot",
  "together-ai": "together",
  togetherai: "together",
  vertex: "google",
  "vertex-ai": "google",
  "x-ai": "xai",
  "z-ai": "zai",
  zhipu: "zai",
};

// Model name prefixes for model ids without an owner segment.
const modelFamilies: ReadonlyArray<readonly [string, BrandId]> = [
  ["claude", "anthropic"],
  ["codestral", "mistral"],
  ["command", "cohere"],
  ["deepseek", "deepseek"],
  ["devstral", "mistral"],
  ["gemini", "google"],
  ["gemma", "google"],
  ["glm", "zai"],
  ["gpt", "openai"],
  ["grok", "xai"],
  ["kimi", "moonshot"],
  ["llama", "meta"],
  ["minimax", "minimax"],
  ["mistral", "mistral"],
  ["qwen", "qwen"],
];

function isBrandId(value: string): value is BrandId {
  return Object.hasOwn(brands, value);
}

function brandId(value: string): BrandId | undefined {
  if (isBrandId(value)) return value;
  if (Object.hasOwn(providerAliases, value)) return providerAliases[value];
}

function brand(id: BrandId): InvocationBrand {
  return { id, ...brands[id] };
}

/** Resolve a provider or driver id such as `openrouter`, `anthropic.messages`, or `z-ai`. */
export function invocationBrand(value: string | undefined): InvocationBrand | undefined {
  const id = value?.trim().toLocaleLowerCase();
  if (!id) return;
  const known = brandId(id) ?? brandId(id.split(/[.:/]/)[0] ?? "") ?? (id.includes("openrouter") ? "openrouter" : undefined);
  if (known) return brand(known);
  return {
    id: "fallback",
    label: id
      .split(/[._-]/g)
      .filter(Boolean)
      .map(part => part.length <= 3 ? part.toLocaleUpperCase() : `${part[0]?.toLocaleUpperCase() ?? ""}${part.slice(1)}`)
      .join(" "),
  };
}

/** Resolve the company that made a model from ids such as `anthropic/claude-sonnet-4.5` or `gpt-5.6`. */
export function invocationModelMaker(modelId: string | undefined): InvocationBrand | undefined {
  const id = modelId?.trim().toLocaleLowerCase();
  if (!id) return;
  const segments = id.split("/");
  const owner = segments.length > 1 ? brandId(segments[0] ?? "") : undefined;
  if (owner) return brand(owner);
  const name = segments.at(-1) ?? "";
  const family = modelFamilies.find(([prefix]) => name.startsWith(prefix));
  return family ? brand(family[1]) : undefined;
}

export function invocationBrandMark(value: InvocationBrand | undefined, className: string) {
  if (!value) return null;
  if (value.id === "fallback") return h("svg", {
    "aria-hidden": "true",
    class: `vh-invocation-brand__logo ${className}`,
    fill: "none",
    stroke: "currentColor",
    "stroke-width": 1.5,
    viewBox: "0 0 24 24",
  }, [
    h("rect", { height: 14, rx: 3, width: 14, x: 5, y: 5 }),
    h("path", { d: "M9 2v3m6-3v3M9 19v3m6-3v3M2 9h3m-3 6h3m14-6h3m-3 6h3M9 9h6v6H9z" }),
  ]);
  const paths: ReadonlyArray<{ clipRule?: "evenodd"; d: string; fillOpacity?: string }> = brandIcons[value.icon];
  return h("svg", {
    "aria-hidden": "true",
    class: `vh-invocation-brand__logo ${className}`,
    "data-brand": value.id,
    "fill-rule": "evenodd",
    viewBox: "0 0 24 24",
  }, paths.map(path => h("path", {
    "clip-rule": path.clipRule,
    d: path.d,
    "fill-opacity": path.fillOpacity,
  })));
}
