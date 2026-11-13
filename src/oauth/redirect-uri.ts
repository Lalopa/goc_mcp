export const MAX_REDIRECT_URIS = 10;
export const MAX_REDIRECT_URI_LENGTH = 2048;

// Misma política que goc_api (src/modules/mcp/mcp.validators.ts): si cambia allí, debe cambiar aquí.
// Solo ASCII imprimible sin espacios ni backslash: el parser de URL los normaliza (p. ej. `\` a `/`) y
// una URI distinta de la registrada podría pasar.
const PRINTABLE_ASCII_NO_BACKSLASH = /^[\x21-\x5b\x5d-\x7e]+$/;
// Loopback literal (RFC 8252) con puerto libre. `[::1]` no se acepta: solo `localhost` y `127.0.0.1`.
const LOOPBACK_AUTHORITY = /^(localhost|127\.0\.0\.1)(:\d{1,5})?$/;

/**
 * https con cualquier host, o http solo en loopback literal. Sin fragmento ni credenciales. Se valida la
 * cadena cruda y no solo el resultado de `new URL`, que acepta formas como `http:localhost`, `127.1` o
 * `2130706433`.
 */
export function isAllowedRedirectUri(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_REDIRECT_URI_LENGTH) return false;
  if (!PRINTABLE_ASCII_NO_BACKSLASH.test(value) || value.includes("#")) return false;

  const isHttps = value.startsWith("https://");
  if (!isHttps && !value.startsWith("http://")) return false;

  const authority = value.slice(value.indexOf("//") + 2).split(/[/?]/, 1)[0];
  if (authority === "" || authority.includes("@")) return false;
  if (!isHttps && !LOOPBACK_AUTHORITY.test(authority)) return false;

  try {
    return new URL(value).hostname !== "";
  } catch {
    return false;
  }
}

function isLoopbackHttp(url: URL): boolean {
  return url.protocol === "http:" && (url.hostname === "localhost" || url.hostname === "127.0.0.1");
}

function validPort(url: URL): boolean {
  if (url.port === "") return true;
  const port = Number(url.port);
  return port >= 1 && port <= 65535;
}

function sameDestination(presented: URL, registered: URL): boolean {
  if (isLoopbackHttp(presented)) {
    // RFC 8252 §7.3: el puerto de loopback puede variar; esquema, host, ruta y query deben coincidir.
    return (
      isLoopbackHttp(registered) &&
      validPort(presented) &&
      presented.hostname === registered.hostname &&
      presented.pathname === registered.pathname &&
      presented.search === registered.search
    );
  }
  // `href` equipara host en mayúsculas, puerto por defecto y ruta vacía con `/`; no `/cb` con `/cb/`,
  // ni queries distintas, ni prefijos.
  return presented.href === registered.href;
}

/** La URI presentada debe cumplir la política y coincidir con alguna de las registradas por el cliente. */
export function matchesRegisteredRedirectUri(presented: unknown, registered: readonly unknown[]): boolean {
  if (!isAllowedRedirectUri(presented)) return false;
  let presentedUrl: URL;
  try {
    presentedUrl = new URL(presented);
  } catch {
    return false;
  }
  for (const candidate of registered) {
    if (typeof candidate !== "string") continue;
    let registeredUrl: URL;
    try {
      registeredUrl = new URL(candidate);
    } catch {
      continue;
    }
    if (sameDestination(presentedUrl, registeredUrl)) return true;
  }
  return false;
}
