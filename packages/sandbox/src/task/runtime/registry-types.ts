import type { Buffer } from 'node:buffer'
import type { SandboxTaskDefinitionModules } from '#vitehub-sandbox-task-registry'

export type SandboxTaskDefinitionName = keyof SandboxTaskDefinitionModules

export type SandboxTaskRegistryDefinition<TName extends keyof SandboxTaskDefinitionModules>
  = SandboxTaskDefinitionModules[TName]

export type SandboxTaskPayload<TDefinition>
  = TDefinition extends { payload: infer TPayload } ? TPayload : unknown

export type SandboxTaskResult<TDefinition>
  = TDefinition extends { result: infer TResult } ? DecodedSandboxValue<TResult> : unknown

type DecodedSandboxValue<TValue, TApplyToJSON extends boolean = true> =
  TValue extends Response ? Response
  : TValue extends Blob ? Blob
  : TValue extends Buffer ? Buffer
  : TValue extends Uint8Array ? Uint8Array
  : TApplyToJSON extends false ? DecodedSandboxJson<TValue>
  : TValue extends { toJSON(key: string): infer TSerialized }
    ? DecodedSandboxValue<TSerialized, false> | (TValue extends Date ? null : never)
    : DecodedSandboxJson<TValue>

type DecodedSandboxJson<TValue> =
  TValue extends string | number | boolean | null ? TValue
  : TValue extends InstanceType<StringConstructor> ? string
  : TValue extends InstanceType<NumberConstructor> ? number
  : TValue extends InstanceType<BooleanConstructor> ? boolean
  : TValue extends readonly unknown[] ? { [TIndex in keyof TValue]: DecodedSandboxValue<TValue[TIndex]> }
  : TValue extends ((...args: never[]) => unknown) | undefined | bigint | symbol ? never
  : TValue extends object ? {
    [TKey in keyof TValue as TKey extends symbol ? never
      : TValue[TKey] extends (...args: never[]) => unknown ? never : TKey]: DecodedSandboxValue<TValue[TKey]>
  }
  : TValue
