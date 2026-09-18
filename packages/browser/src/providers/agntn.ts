import { browserProviderError } from "../errors.ts";

import type { CDPBrowserConnection } from "../internal/connections.ts";
import type { BrowserProvider, BrowserProviderOpenOptions } from "../types.ts";

/** The connection fields consumed from an Agntn session. */
export interface AgntnBrowserSession {
  cdpUrl?: string;
  id: string;
}

/** Accepts Agntn providers without importing their Node runtime into ViteHub. */
export interface AgntnBrowserProvider<
  TSession extends AgntnBrowserSession,
  TOptions extends object,
> {
  createSession(options?: TOptions): Promise<TSession>;
  name(): string;
  releaseSession(sessionId: string): Promise<void>;
}

export interface AgntnBrowserOptions<
  TSession extends AgntnBrowserSession,
  TOptions extends object,
> {
  /** Explicit CDP connection, including authentication headers when required. */
  connection?: (session: TSession) => CDPBrowserConnection;
  provider: AgntnBrowserProvider<TSession, TOptions>;
  /** Map ViteHub's idleTimeoutMs explicitly when the provider supports it. */
  sessionOptions?: TOptions | ((options: BrowserProviderOpenOptions) => TOptions);
}

/** Wraps an Agntn CDP session with ViteHub's provider ownership contract. */
export function agntnBrowser<TSession extends AgntnBrowserSession, TOptions extends object>(
  options: AgntnBrowserOptions<TSession, TOptions>,
): BrowserProvider<CDPBrowserConnection> {
  if (!options?.provider || typeof options.provider.name !== "function") {
    throw browserProviderError("agntn", "create a provider adapter");
  }
  const provider = options.provider;
  const providerName = provider.name();
  const name = `agntn:${providerName}`;

  return {
    // CDP availability alone does not prove a provider survives controller release.
    features: { liveHandoff: false },
    isolation: providerName === "playwright" ? "trusted-host" : "provider",
    name,
    async open(openOptions = {}) {
      let session: TSession;
      try {
        if (
          openOptions.idleTimeoutMs !== undefined &&
          typeof options.sessionOptions !== "function"
        ) {
          throw browserProviderError(name, "map idleTimeoutMs through sessionOptions");
        }
        const sessionOptions =
          typeof options.sessionOptions === "function"
            ? options.sessionOptions(openOptions)
            : options.sessionOptions;
        session = await provider.createSession(sessionOptions);
      } catch (error) {
        throw browserProviderError(name, "open a session", { cause: error });
      }

      let connection: CDPBrowserConnection;
      try {
        // Use the returned endpoint. Some getCdpUrl() fallbacks invent endpoints
        // or require authentication that is absent from the session handle.
        if (!options.connection && (!session.cdpUrl || providerName === "cloudflare")) {
          throw browserProviderError(name, "resolve an authenticated CDP connection");
        }
        connection = options.connection
          ? options.connection(session)
          : { endpoint: session.cdpUrl!, kind: "cdp" };
        const protocol = new URL(connection.endpoint).protocol;
        if (connection.kind !== "cdp" || !["ws:", "wss:"].includes(protocol)) {
          throw browserProviderError(name, "resolve a WebSocket CDP endpoint");
        }
      } catch (error) {
        try {
          await provider.releaseSession(session.id);
        } catch (cleanupError) {
          throw browserProviderError(name, "resolve a CDP connection and release the session", {
            cause: new AggregateError([error, cleanupError]),
          });
        }
        throw browserProviderError(name, "resolve a CDP connection", { cause: error });
      }

      let closed = false;
      let closing: Promise<void> | undefined;
      return {
        connection,
        id: session.id,
        async close() {
          if (closed) return;
          if (closing) return await closing;
          closing = (async () => {
            try {
              await provider.releaseSession(session.id);
              closed = true;
            } catch (error) {
              throw browserProviderError(name, "release the session", { cause: error });
            }
          })();
          try {
            await closing;
          } finally {
            closing = undefined;
          }
        },
      };
    },
  };
}
