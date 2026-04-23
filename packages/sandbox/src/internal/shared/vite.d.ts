import type { ConfigEnv, Plugin, UserConfig } from 'vite';
export interface FeatureViteContext<TConfig> {
    rootDir: string;
    config: TConfig;
    deps: Record<string, string>;
    runtimeConfig: Record<string, unknown>;
    hosting?: string;
    command: ConfigEnv['command'];
    mode: string;
}
export interface FeatureViteSetupResult {
    config?: UserConfig;
}
export interface FeatureViteState<TConfig> extends FeatureViteContext<TConfig> {
    virtualModules: Map<string, string>;
    resolvedIds: Map<string, string>;
}
type ViteFeatureFactoryOptions<TOptions, TInput, TConfig = TInput> = {
    name: string;
    feature: string;
    configKey: string;
    defaultOptions?: TOptions | (() => TOptions);
    loadDeps?: boolean;
    normalizeOptions: (options: TOptions | undefined) => TInput | undefined;
    resolveConfig?: (config: TInput, hosting?: string) => TConfig;
    assignRuntimeConfig?: (runtimeConfig: Record<string, unknown>, config: TConfig) => void;
    readOptions: (config: Record<string, unknown>, env: ConfigEnv) => TOptions | undefined;
    setup?: (context: FeatureViteContext<TConfig>) => Promise<FeatureViteSetupResult | void> | FeatureViteSetupResult | void;
};
export declare function createFeatureVitePlugin<TOptions, TInput, TConfig = TInput>(options: ViteFeatureFactoryOptions<TOptions, TInput, TConfig>): Plugin;
