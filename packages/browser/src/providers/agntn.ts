import { browserProviderError } from "../errors.ts";
import { getViteHubErrorShape } from "@vite-hub/runtime";

import type { CDPBrowserConnection } from "../internal/connections.ts";
import type {
  BrowserProvider,
  BrowserProviderOpenOptions,
  BrowserProviderSession,
} from "../types.ts";

/** The session shape exposed by @agntn/browsers providers. */
export interface AgntnBrowserSession {
  cdpUrl?: string;
  id: string;
  metadata?: Record<string, unknown>;
  provider: string;
}

/** The session operations required from an @agntn/browsers provider. */
export interface AgntnBrowserProvider {
  createSession(options?: Record<string, unknown>): Promise<AgntnBrowserSession>;
  getCdpUrl?(session: AgntnBrowserSession): string | undefined;
  name(): string;
  releaseSession(sessionId: string): Promise<void>;
}

export interface AgntnBrowserOptions {
  /** Provider-specific session options passed to createSession(). */
  sessionOptions?:
    | Record<string, unknown>
    | ((options: BrowserProviderOpenOptions) => Record<string, unknown>);
  /**
   * Converts an Agntn session into a ViteHub CDP connection.
   * Defaults to the provider's getCdpUrl() method or session.cdpUrl.
   */
  connection?: (session: AgntnBrowserSession) => CDPBrowserConnection | undefined;
  provider: AgntnBrowserProvider;
}

function defaultConnection(
  provider: AgntnBrowserProvider,
  session: AgntnBrowserSession,
): CDPBrowserConnection {
  const endpoint = provider.getCdpUrl?.(session) || session.cdpUrl;
  if (!endpoint) {
    throw browserProviderError("agntn", "resolve a CDP endpoint", {
      cause: new Error(`Provider ${provider.name()} did not return a CDP endpoint.`),
    });
  }
  return { endpoint, kind: "cdp" };
}

/**
 * Adapts an @agntn/browsers provider to ViteHub's session lifecycle.
 *
 * This adapter only contains provider-neutral session plumbing. Import
 * @agntn/browsers from a trusted Node host and keep its Node-only package out
 * of Worker bundles.
 */
export function agntnBrowser(options: AgntnBrowserOptions): BrowserProvider<CDPBrowserConnection> {
  if (!options?.provider) {
    throw browserProviderError("agntn", "create a provider adapter");
  }

  const provider = options.provider;
  const name = `agntn:${provider.name()}`;

  return {
    features: { liveHandoff: false },
    isolation: "provider",
    name,
    async open(openOptions = {}): Promise<BrowserProviderSession<CDPBrowserConnection>> {
      let session: AgntnBrowserSession | undefined;
      try {
        const sessionOptions =
          typeof options.sessionOptions === "function"
            ? options.sessionOptions(openOptions)
            : options.sessionOptions;
        session = await provider.createSession(sessionOptions);
        let connection: CDPBrowserConnection;
        try {
          connection = options.connection?.(session) || defaultConnection(provider, session);
        } catch (error) {
          await provider.releaseSession(session.id).catch(() => {});
          session = undefined;
          throw error;
        }
        let closed = false;
        return {
          connection,
          id: session.id,
          async close() {
            if (closed) return;
            closed = true;
            await provider.releaseSession(session!.id);
          },
        };
      } catch (error) {
        if (session) await provider.releaseSession(session.id).catch(() => {});
        if (getViteHubErrorShape(error)?.code === "BROWSER_PROVIDER_ERROR") throw error;
        throw browserProviderError(name, "open a session", { cause: error });
      }
    },
  };
}
