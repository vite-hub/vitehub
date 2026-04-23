import type { Nitro } from 'nitro/types';
export type ServerImport = {
    name: string;
    from: string;
    as?: string;
    type?: boolean;
    meta?: Record<string, unknown>;
};
export interface FeatureManifest {
    alias: string;
    aliasPath: string;
    imports?: ServerImport[];
    typeTemplate?: {
        filename: string;
        contents: string;
    };
    nitroPlugin?: string;
}
export interface GeneratedArtifact {
    key: string;
    filename: string;
    contents?: string;
    getContents?: (artifacts: ReadonlyMap<string, EmittedArtifact>) => string | Promise<string>;
}
export interface EmittedArtifact extends GeneratedArtifact {
    contents: string;
    dst: string;
}
export interface FeatureAliasRegistration {
    key: string;
    value?: string;
    artifactKey?: string;
}
export interface FeatureHandlerRegistration {
    route: string;
    method?: string;
    handler?: string;
    artifactKey?: string;
}
export interface FeatureRuntimePlan {
    manifest: FeatureManifest;
    aliases?: FeatureAliasRegistration[];
    artifacts?: GeneratedArtifact[];
    handlers?: FeatureHandlerRegistration[];
    extendNitro?: (target: Nitro['options'] & Record<string, unknown>, artifacts: ReadonlyMap<string, EmittedArtifact>) => void | Promise<void>;
    onCompiled?: (nitro: Nitro, artifacts: ReadonlyMap<string, EmittedArtifact>) => void | Promise<void>;
}
export declare function emitNitroArtifacts(nitro: Nitro, artifacts?: GeneratedArtifact[]): Promise<Map<string, EmittedArtifact>>;
export declare function registerNitroFeature(nitro: Nitro, registration: FeatureManifest): Promise<void>;
export declare function applyFeaturePlanToNitro(nitro: Nitro, plan: FeatureRuntimePlan): Promise<void>;
