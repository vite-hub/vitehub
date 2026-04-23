import type { Nitro } from 'nitro/types';
export interface ScannedDefinition {
    name: string;
    handler: string;
    _meta: {
        filename: string;
        sourcePath: string;
    };
}
export interface FeatureScanResult {
    feature: string;
    subdir: string;
    definitions: ScannedDefinition[];
}
export interface FeatureSrcScanOptions {
    mode?: 'flat' | 'recursive';
    filter: (relativePath: string) => boolean;
    normalizeName?: (relativePath: string) => string;
}
export declare function resolveNitroScanRoots(nitro: Nitro): string[];
export declare function normalizeDefinitionName(relativePath: string): string;
export declare function toTemplateSafeName(name: string): string;
export declare function createDefinitionRegistryContents(definitions: Pick<ScannedDefinition, 'name' | 'handler'>[]): string;
export declare function loadFeatureDefinitions(options: {
    feature: string;
    scanRoots: string[];
    subdir: string;
    normalizeName?: (relativePath: string) => string;
    srcScan?: FeatureSrcScanOptions;
}): Promise<FeatureScanResult>;
export declare function scanDefinitionsFromRoots(scanRoots: string[], subdir: string): Promise<ScannedDefinition[]>;
export declare function assertNoDuplicateDefinitionNames(feature: string, definitions: Pick<ScannedDefinition, 'name' | 'handler' | '_meta'>[]): void;
