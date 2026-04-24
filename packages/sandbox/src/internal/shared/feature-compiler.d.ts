import type { Nitro } from 'nitro/types';
import type { FeatureRuntimePlan } from './runtime-artifacts';
export interface FeatureCompilerContext<TConfig> {
    nitro: Nitro;
    config: TConfig;
    deps: Record<string, string>;
    runtimeConfig: Record<string, unknown>;
    hosting?: string;
    scanRoots: string[];
}
export interface FeatureCompiler<TConfig> {
    feature: string;
    compile: (context: FeatureCompilerContext<TConfig>) => Promise<FeatureRuntimePlan> | FeatureRuntimePlan;
}
export declare function defineFeatureCompiler<TConfig>(compiler: FeatureCompiler<TConfig>): FeatureCompiler<TConfig>;
export declare function compileFeatureIntoNitro<TConfig>(nitro: Nitro, config: TConfig | undefined, deps: Record<string, string>, compiler: FeatureCompiler<TConfig>): Promise<boolean>;
