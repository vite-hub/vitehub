export type HostingProvider = 'cloudflare' | 'netlify' | 'vercel';
export interface HostingDetectionTarget {
    options: {
        nitro?: {
            preset?: string | null;
        };
        preset?: string | null;
    };
}
export declare function normalizeHosting(hosting?: string | null): string;
export declare function detectHosting(target: HostingDetectionTarget): string;
export declare function getHostingProvider(hosting?: string | null): HostingProvider | undefined;
export declare function getSupportedHostingProvider<TProvider extends HostingProvider>(hosting: string | undefined, supportedProviders: readonly TProvider[]): TProvider;
