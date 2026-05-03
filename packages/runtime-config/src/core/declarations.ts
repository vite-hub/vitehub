import type {
  RuntimeConfigBindingDeclaration,
  RuntimeConfigBuildDeclaration,
  RuntimeConfigDeclarationOptions,
  RuntimeConfigLiteralDefineDeclaration,
  RuntimeConfigRuntimeDeclaration,
} from "../types.ts"

export interface RuntimeConfigHelpers {
  build: {
    define: {
      pkg: (key: string, schema: unknown, options?: RuntimeConfigDeclarationOptions) => RuntimeConfigBuildDeclaration
      value: (value: unknown, schema: unknown, options?: RuntimeConfigDeclarationOptions) => RuntimeConfigLiteralDefineDeclaration
    }
    env: (envName: string, schema: unknown, options?: RuntimeConfigDeclarationOptions) => RuntimeConfigBuildDeclaration
  }
  cloudflare: {
    binding: {
      ai: (name: string) => RuntimeConfigBindingDeclaration
      d1: (name: string) => RuntimeConfigBindingDeclaration
      durableObject: (name: string, type?: string) => RuntimeConfigBindingDeclaration
      kv: (name: string) => RuntimeConfigBindingDeclaration
      queue: (name: string) => RuntimeConfigBindingDeclaration
      r2: (name: string) => RuntimeConfigBindingDeclaration
      service: (name: string, type?: string) => RuntimeConfigBindingDeclaration
      unknown: (name: string, type?: string) => RuntimeConfigBindingDeclaration
      vectorize: (name: string) => RuntimeConfigBindingDeclaration
      workflow: (name: string, type?: string) => RuntimeConfigBindingDeclaration
    }
  }
  runtime: {
    env: (envName: string, schema: unknown, options?: RuntimeConfigDeclarationOptions) => RuntimeConfigRuntimeDeclaration
    secret: (envName: string, schema: unknown, options?: RuntimeConfigDeclarationOptions) => RuntimeConfigRuntimeDeclaration
  }
}

function buildEnv(envName: string, schema: unknown, options: RuntimeConfigDeclarationOptions = {}): RuntimeConfigBuildDeclaration {
  return {
    default: options.default,
    envName,
    kind: "build-env",
    schema,
    type: options.type,
  }
}

function defineLiteral(value: unknown, schema: unknown, options: RuntimeConfigDeclarationOptions = {}): RuntimeConfigLiteralDefineDeclaration {
  return {
    kind: "define-literal",
    schema,
    type: options.type,
    value,
  }
}

function definePackageValue(key: string, schema: unknown, options: RuntimeConfigDeclarationOptions = {}): RuntimeConfigBuildDeclaration {
  return {
    key,
    kind: "package-value",
    schema,
    type: options.type,
  }
}

function runtimeEnv(envName: string, schema: unknown, options: RuntimeConfigDeclarationOptions = {}): RuntimeConfigRuntimeDeclaration {
  return {
    default: options.default,
    envName,
    kind: "runtime-env",
    schema,
    type: options.type,
  }
}

function runtimeSecret(envName: string, schema: unknown, options: RuntimeConfigDeclarationOptions = {}): RuntimeConfigRuntimeDeclaration {
  return {
    default: options.default,
    envName,
    kind: "runtime-secret",
    schema,
    type: options.type,
  }
}

function binding(bindingType: RuntimeConfigBindingDeclaration["bindingType"], bindingName: string, type?: string): RuntimeConfigBindingDeclaration {
  return {
    bindingName,
    bindingType,
    kind: "cloudflare-binding",
    type,
  }
}

export const rc: RuntimeConfigHelpers = {
  build: {
    define: {
      pkg: definePackageValue,
      value: defineLiteral,
    },
    env: buildEnv,
  },
  cloudflare: {
    binding: {
      ai: (name: string) => binding("ai", name, "Ai"),
      d1: (name: string) => binding("d1", name, "D1Database"),
      durableObject: (name: string, type = "DurableObjectNamespace") => binding("durable-object", name, type),
      kv: (name: string) => binding("kv", name, "KVNamespace"),
      queue: (name: string) => binding("queue", name, "Queue"),
      r2: (name: string) => binding("r2", name, "R2Bucket"),
      service: (name: string, type = "Fetcher") => binding("service", name, type),
      vectorize: (name: string) => binding("vectorize", name, "VectorizeIndex"),
      workflow: (name: string, type = "Workflow") => binding("workflow", name, type),
      unknown: (name: string, type = "unknown") => binding("unknown", name, type),
    },
  },
  runtime: {
    env: runtimeEnv,
    secret: runtimeSecret,
  },
}
