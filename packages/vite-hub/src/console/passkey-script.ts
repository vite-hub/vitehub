/** Better Auth's passkey plugin, `@better-auth/passkey`. Its id in the Auth's plugin list. */
export const consolePasskeyPluginId = "passkey"

/** Whether the Auth signs people in with a passkey: its plugins include `@better-auth/passkey`. */
export function hasConsolePasskey(plugins: ReadonlyArray<{ id?: string }> | undefined): boolean {
  return Boolean(plugins?.some(plugin => plugin.id === consolePasskeyPluginId))
}

/**
 * The browser code of a passkey sign-in, for the inline scripts of the sign-in pages. It defines
 * `passkeyAssertion(authBase)`, which asks the passkey plugin for options, asks the browser for a credential, and returns
 * the body of `POST <authBase>/passkey/verify-authentication`. It needs no bundled library.
 */
export const consolePasskeyScript = `
    const fromBase64Url = value => Uint8Array.from(atob(value.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((value.length + 3) % 4)), character => character.charCodeAt(0));
    const toBase64Url = buffer => btoa(String.fromCharCode(...new Uint8Array(buffer))).replace(/\\+/g, "-").replace(/\\//g, "_").replace(/=+$/, "");
    async function passkeyAssertion(authBase) {
      if (!window.PublicKeyCredential || !navigator.credentials) throw new Error("This browser cannot use passkeys.");
      const response = await fetch(authBase + "/passkey/generate-authenticate-options", { credentials: "same-origin" });
      if (!response.ok) throw new Error("Passkey sign-in did not start. Try again.");
      const options = await response.json();
      let credential;
      try {
        credential = await navigator.credentials.get({
          publicKey: {
            ...options,
            challenge: fromBase64Url(options.challenge),
            allowCredentials: (options.allowCredentials || []).map(entry => ({ ...entry, id: fromBase64Url(entry.id) })),
          },
        });
      } catch {
        throw new Error("No passkey was used. Try again, or use another way to sign in.");
      }
      if (!credential) throw new Error("No passkey was used. Try again, or use another way to sign in.");
      const answer = credential.response;
      return {
        response: {
          id: credential.id,
          rawId: toBase64Url(credential.rawId),
          type: credential.type,
          authenticatorAttachment: credential.authenticatorAttachment || undefined,
          clientExtensionResults: credential.getClientExtensionResults(),
          response: {
            authenticatorData: toBase64Url(answer.authenticatorData),
            clientDataJSON: toBase64Url(answer.clientDataJSON),
            signature: toBase64Url(answer.signature),
            userHandle: answer.userHandle ? toBase64Url(answer.userHandle) : undefined,
          },
        },
      };
    }
`
