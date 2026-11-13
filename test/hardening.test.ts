import test from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import express from "express";
import axios, { AxiosError } from "axios";
import type { AxiosAdapter, InternalAxiosRequestConfig } from "axios";
import { createAxiosHttpClient, createGocAuthApi } from "../src/oauth/goc-auth-api.js";
import { configureTrustProxy, parseTrustProxyHops } from "../src/oauth/trust-proxy.js";
import { createOauthErrorHandler } from "../src/oauth/error-handler.js";
import { createApp } from "../src/app.js";
import { CLIENT_REGISTRY_TIMEOUT_MS, getClientTrackingMetadata, registerOAuthClientInApi } from "../src/oauth/client-registry.js";
import { REFRESH_ENDPOINT_MISSING_MESSAGE, REVOKE_ENDPOINT_MISSING_MESSAGE } from "../src/oauth/routes.js";
import { pendingCodeCount } from "../src/oauth/store.js";
import {
  CLIENT_ID, REDIRECT, SECRETS, VERIFIER, buildDeps, buildRouter, captureConsole, fakeHttp, fakeReq, fakeRes, invokeApp, loginAndGetCode, loginBody, runRoute,
} from "./helpers.js";

// ---------------- trust proxy ----------------

test("trust-proxy: entero >= 0 se respeta; vacío, negativo, decimal, texto o ausente caen a 1", () => {
  assert.equal(parseTrustProxyHops("0"), 0);
  assert.equal(parseTrustProxyHops("2"), 2);
  assert.equal(parseTrustProxyHops(" 3 "), 3);
  for (const bad of [undefined, "", "-1", "1.5", "abc", "true", "1e2", "99999"]) {
    assert.equal(parseTrustProxyHops(bad), 1, String(bad));
  }
});

function requestThrough(app: express.Express, forwardedFor: string) {
  return Object.assign(Object.create(app.request), {
    headers: { "x-forwarded-for": forwardedFor },
    socket: { remoteAddress: "10.0.0.1" },
  });
}

test("trust-proxy: con 1 salto, lo que el cliente escribe en X-Forwarded-For no cambia req.ip", () => {
  const app = express();
  configureTrustProxy(app, undefined);
  // nginx añade la IP real al final; el cliente falsificó el valor de la izquierda.
  assert.equal(requestThrough(app, "6.6.6.6, 203.0.113.5").ip, "203.0.113.5");
  assert.equal(requestThrough(app, "7.7.7.7, 203.0.113.5").ip, "203.0.113.5");
});

test("trust-proxy: con 0 saltos req.ip es la conexión directa", () => {
  const app = express();
  configureTrustProxy(app, "0");
  assert.equal(requestThrough(app, "6.6.6.6").ip, "10.0.0.1");
});

function appWith(hops: string | undefined, overrides = {}) {
  const f = fakeHttp();
  const { deps, logs } = buildDeps(f.http, overrides);
  return { app: createApp(deps, { trustProxyHops: hops }), f, logs };
}

const refreshRequest = (forwardedFor?: string) => ({
  method: "POST",
  url: "/oauth/token",
  headers: {
    "content-type": "application/json",
    ...(forwardedFor ? { "x-forwarded-for": forwardedFor } : {}),
  },
  body: JSON.stringify({ grant_type: "refresh_token", refresh_token: "r", client_id: "c" }),
});

test("app: la IP que llega a la API sale de TRUST_PROXY_HOPS (0, 1 y 2 saltos) y no de lo que escribe el cliente", async () => {
  const xff = "6.6.6.6, 7.7.7.7, 203.0.113.5";
  const seen: Record<string, unknown> = {};
  for (const hops of ["0", "1", "2"]) {
    const { app, f } = appWith(hops);
    const res = await invokeApp(app, refreshRequest(xff));
    assert.equal(res.status, 200);
    seen[hops] = (f.callsTo("/public/mcp/sessions/refresh")[0].body as any).ipAddress;
  }
  assert.deepEqual(seen, { "0": "10.0.0.1", "1": "203.0.113.5", "2": "7.7.7.7" });
});

test("app: sin TRUST_PROXY_HOPS se confía en 1 salto", async () => {
  const { app, f } = appWith(undefined);
  await invokeApp(app, refreshRequest("6.6.6.6, 203.0.113.5"));
  assert.equal((f.callsTo("/public/mcp/sessions/refresh")[0].body as any).ipAddress, "203.0.113.5");
});

test("app: /oauth/token con JSON roto responde 400 JSON OAuth y no llega al handler ni a la API", async () => {
  const { app, f } = appWith("1");
  const res = await invokeApp(app, { method: "POST", url: "/oauth/token", headers: { "content-type": "application/json" }, body: '{"refresh_token": roto' });
  assert.equal(res.status, 400);
  assert.match(String(res.headers["content-type"]), /application\/json/);
  assert.equal(JSON.parse(res.body).error, "invalid_request");
  assert.equal(f.calls.length, 0);
});

test("app: error de parser en /oauth/register y /oauth/revoke es JSON OAuth; en authorize y login-action, página HTML fija", async () => {
  const { app } = appWith("1");
  for (const url of ["/oauth/register", "/oauth/revoke"]) {
    const res = await invokeApp(app, { method: "POST", url, headers: { "content-type": "application/json" }, body: "{roto" });
    assert.equal(res.status, 400, url);
    assert.equal(JSON.parse(res.body).error, "invalid_request", url);
  }
  for (const url of ["/oauth/login-action", "/oauth/authorize"]) {
    const res = await invokeApp(app, { method: "POST", url, headers: { "content-type": "application/json" }, body: "SEEDED-visible-123" });
    assert.equal(res.status, 400, url);
    assert.match(String(res.headers["content-type"]), /text\/html/, url);
    assert.match(res.body, /<html/);
    assert.equal(res.body.includes("SEEDED-visible-123"), false, "la página no refleja el cuerpo");
  }
});

test("app: /mcp sigue delegando sus errores a Express (no los convierte en respuesta OAuth)", async () => {
  const { app } = appWith("1");
  const { result: broken } = await captureConsole(() =>
    invokeApp(app, { method: "POST", url: "/mcp", headers: { "content-type": "application/json" }, body: "{roto" })
  );
  assert.equal(broken.status, 400);
  assert.match(String(broken.headers["content-type"]), /text\/html/);
  assert.equal(broken.body.includes("invalid_request"), false);

  const noAuth = await invokeApp(app, { method: "POST", url: "/mcp", headers: { "content-type": "application/json" }, body: "{}" });
  assert.equal(noAuth.status, 401);
  assert.match(String(noAuth.headers["www-authenticate"]), /resource_metadata="https:\/\/mcp\.test\/\.well-known\/oauth-protected-resource"/);
  const get = await invokeApp(app, { method: "GET", url: "/mcp" });
  assert.equal(get.status, 405);
});

// ---------------- cliente HTTP real (adaptador falso) ----------------

function fakeAdapter(status: number, seen: { config?: InternalAxiosRequestConfig }): AxiosAdapter {
  return async (config) => {
    seen.config = config;
    const response = { data: { message: "x" }, status, statusText: "", headers: {}, config };
    if (config.validateStatus ? config.validateStatus(status) : status >= 200 && status < 300) return response;
    throw new AxiosError(`Request failed with status code ${status}`, undefined, config, null, response);
  };
}

test("createAxiosHttpClient: 401 y 500 se devuelven como status, sin lanzar", async () => {
  for (const status of [401, 500]) {
    const http = createAxiosHttpClient("https://api.test/api/v2", { adapter: fakeAdapter(status, {}) });
    assert.equal((await http.post("/x", {})).status, status);
    assert.equal((await http.get("/x")).status, status);
  }
});

test("createAxiosHttpClient: URL = baseURL + ruta (conserva /api/v2), el timeout y las cabeceras llegan a la config", async () => {
  const seen: { config?: InternalAxiosRequestConfig } = {};
  const http = createAxiosHttpClient("https://api.test/api/v2", { adapter: fakeAdapter(200, seen) });
  await http.post("/public/mcp/sessions/refresh", { a: 1 }, { timeoutMs: 10_000, headers: { "X-Test": "1" } });
  assert.equal(axios.getUri(seen.config!), "https://api.test/api/v2/public/mcp/sessions/refresh");
  assert.equal(seen.config!.timeout, 10_000);
  assert.equal(seen.config!.headers.get("X-Test"), "1");
});

test("createAxiosHttpClient: con la API real, un 401 de refresh sale como rechazo (no como indisponible)", async () => {
  const http = createAxiosHttpClient("https://api.test/api/v2", { adapter: fakeAdapter(401, {}) });
  const api = createGocAuthApi(http);
  const out = await api.refreshSession({ refreshToken: "r", clientId: "c" });
  assert.deepEqual(out, { ok: false, kind: "rejected", status: 401 });
});

// ---------------- client-registry: timeouts ----------------

async function withAxiosAdapter<T>(adapter: AxiosAdapter, fn: () => Promise<T>): Promise<T> {
  const original = axios.defaults.adapter;
  axios.defaults.adapter = adapter;
  try {
    return await fn();
  } finally {
    axios.defaults.adapter = original;
  }
}

test("client-registry: la consulta y el alta de cliente llevan timeout de 5 s", async () => {
  assert.equal(CLIENT_REGISTRY_TIMEOUT_MS, 5000);
  const timeouts: Array<number | undefined> = [];
  const adapter: AxiosAdapter = async (config) => {
    timeouts.push(config.timeout);
    return { data: { data: { clientId: "c", clientName: "Agente" } }, status: 200, statusText: "", headers: {}, config };
  };
  await withAxiosAdapter(adapter, async () => {
    await getClientTrackingMetadata("c");
    await registerOAuthClientInApi({ clientId: "c", clientName: "n", redirectUris: ["https://a.test/cb"] });
  });
  assert.deepEqual(timeouts, [5000, 5000]);
});

test("client-registry: si la consulta vence o falla, se sigue sin nombre de cliente", async () => {
  const adapter: AxiosAdapter = async (config) => {
    throw new AxiosError("timeout of 5000ms exceeded", "ECONNABORTED", config);
  };
  const meta = await withAxiosAdapter(adapter, () => getClientTrackingMetadata("c-1"));
  assert.deepEqual(meta, { client_id: "c-1" });
});

test("canje: si getClientMeta lanza, el canje sigue sin nombre de cliente", async () => {
  const f = fakeHttp();
  const { router } = buildRouter(f.http, { getClientMeta: async () => { throw new Error("boom"); } });
  const code = await loginAndGetCode(router);
  const res = await runRoute(router, "post", "/oauth/token", fakeReq({
    grant_type: "authorization_code", code, redirect_uri: REDIRECT, client_id: CLIENT_ID, code_verifier: VERIFIER,
  }));
  assert.equal(res.statusCode, 200);
  assert.deepEqual((f.callsTo("/mcp/sessions")[0].body as any).metadata, { client_id: "client-1" });
});

// ---------------- errores de los parsers en /oauth/* ----------------

function parserError(raw: string, contentType = "application/json"): Promise<any> {
  const buffer = Buffer.from(raw);
  const req = Object.assign(Readable.from([buffer]), {
    headers: { "content-type": contentType, "content-length": String(buffer.length) },
    method: "POST",
  });
  const middleware = contentType.includes("json") ? express.json() : express.urlencoded({ extended: true });
  return new Promise((resolve) => {
    (middleware as any)(req, fakeRes(), (err: unknown) => resolve(err));
  });
}

test("error de body-parser en /oauth/*: 400 invalid_request JSON, sin cuerpo, mensaje ni error en logs ni respuesta", async () => {
  const seed = "SEEDED-token-9f2";
  // JSON estricto sin comillas: el SyntaxError de body-parser incluye el principio del cuerpo en el MENSAJE.
  const err = await parserError(seed);
  assert.ok(err?.status >= 400 && err.status < 500, "error 4xx real del parser");
  assert.ok(String(err.body).includes(seed), "el parser adjunta el cuerpo crudo al error");
  assert.ok(String(err.message).includes(seed), "el mensaje del error contiene el token sembrado");

  const logs: string[] = [];
  const handler = createOauthErrorHandler((m) => logs.push(m));
  const res = fakeRes();
  let nextCalled = false;
  const { output } = await captureConsole(async () => handler(err, { path: "/oauth/token" } as any, res as any, () => { nextCalled = true; }));
  assert.equal(nextCalled, false);
  assert.equal(res.statusCode, 400);
  assert.equal((res.body as any).error, "invalid_request");
  assert.equal(res.headers["cache-control"], "no-store");
  assert.equal(`${JSON.stringify(res.body)}${logs.join("\n")}${output}`.includes(seed), false);
  assert.ok(logs.length === 1);
  assert.match(logs[0], /status=400 name=SyntaxError code=entity\.parse\.failed/);
});

test("error de parser: se registra el nombre y el código/tipo (sin mensaje), también en el 503 de rutas no previstas", () => {
  const logs: string[] = [];
  const handler = createOauthErrorHandler((m) => logs.push(m));
  const weird = Object.assign(new TypeError("mensaje-secreto"), { code: "ERR_X" });
  handler(weird, { path: "/oauth/register" } as any, fakeRes() as any, () => {});
  handler(Object.assign(new Error("mensaje-secreto"), { name: "malo con espacios y \n" }), { path: "/oauth/authorize" } as any, fakeRes() as any, () => {});
  assert.match(logs[0], /name=TypeError code=ERR_X/);
  assert.match(logs[1], /name=n\/a/);
  assert.equal(logs.join().includes("mensaje-secreto"), false);
});

test("error handler: con la respuesta ya enviada delega a Express y no escribe nada", () => {
  const handler = createOauthErrorHandler(() => {});
  const res = fakeRes();
  res.headersSent = true;
  let delegated: unknown;
  const err = new Error("tarde");
  handler(err, { path: "/oauth/token" } as any, res as any, (e?: unknown) => { delegated = e; });
  assert.equal(delegated, err);
  assert.equal(res.body, undefined);
  assert.equal(res.statusCode, 200);
});

test("error de cuerpo demasiado grande (4xx) también es invalid_request", () => {
  const handler = createOauthErrorHandler(() => {});
  const res = fakeRes();
  handler(Object.assign(new Error("too large"), { status: 413, type: "entity.too.large", body: "x" }), { path: "/oauth/register" } as any, res as any, () => {});
  assert.equal(res.statusCode, 400);
  assert.equal((res.body as any).error, "invalid_request");
});

test("error no previsto en /oauth/*: 503 temporarily_unavailable", () => {
  const handler = createOauthErrorHandler(() => {});
  for (const err of [new Error("boom"), Object.assign(new Error("x"), { status: 500 }), null]) {
    const res = fakeRes();
    handler(err, { path: "/oauth/token" } as any, res as any, () => {});
    assert.equal(res.statusCode, 503);
    assert.equal((res.body as any).error, "temporarily_unavailable");
  }
});

test("error fuera de /oauth/*: se delega a Express sin responder", () => {
  const handler = createOauthErrorHandler(() => {});
  const res = fakeRes();
  let delegated: unknown;
  const err = new Error("otro");
  handler(err, { path: "/mcp" } as any, res as any, (e?: unknown) => { delegated = e; });
  assert.equal(delegated, err);
  assert.equal(res.body, undefined);
});

// ---------------- API sin los endpoints nuevos ----------------

test("refresh 404: console.error propio y fijo (sin tokens), distinto del warn genérico; respuesta 503", async () => {
  const f = fakeHttp({ "POST /public/mcp/sessions/refresh": { status: 404, data: "Cannot POST" } });
  const errors: string[] = [];
  const { router, logs } = buildRouter(f.http, { logError: (m) => errors.push(m) });
  const res = await runRoute(router, "post", "/oauth/token", fakeReq({
    grant_type: "refresh_token", refresh_token: SECRETS.clientRefreshToken, client_id: "c",
  }));
  assert.equal(res.statusCode, 503);
  assert.deepEqual(errors, [REFRESH_ENDPOINT_MISSING_MESSAGE]);
  assert.match(errors[0], /no expone el endpoint/);
  assert.equal(logs.length, 0);
  assert.equal(errors[0].includes(SECRETS.clientRefreshToken), false);
});

test("revoke 404: console.error propio y fijo; sigue respondiendo 200 {}", async () => {
  const f = fakeHttp({ "POST /public/mcp/sessions/revoke": { status: 404, data: "Cannot POST" } });
  const errors: string[] = [];
  const { router, logs } = buildRouter(f.http, { logError: (m) => errors.push(m) });
  const res = await runRoute(router, "post", "/oauth/revoke", fakeReq({ token: SECRETS.clientRefreshToken }));
  assert.equal(res.statusCode, 200);
  assert.deepEqual(errors, [REVOKE_ENDPOINT_MISSING_MESSAGE]);
  assert.match(errors[0], /no expone el endpoint/);
  assert.equal(logs.length, 0);
});

test("404 vs otros fallos: un 500 no dispara el console.error de endpoint ausente", async () => {
  const f = fakeHttp({
    "POST /public/mcp/sessions/refresh": { status: 500, data: {} },
    "POST /public/mcp/sessions/revoke": { status: 500, data: {} },
  });
  const errors: string[] = [];
  const { router, logs } = buildRouter(f.http, { logError: (m) => errors.push(m) });
  await runRoute(router, "post", "/oauth/token", fakeReq({ grant_type: "refresh_token", refresh_token: "r", client_id: "c" }));
  await runRoute(router, "post", "/oauth/revoke", fakeReq({ token: "t" }));
  assert.equal(errors.length, 0);
  assert.equal(logs.length, 2);
});

// ---------------- administrador ----------------

test("assertAdministrator: 200 { administrator: false } se rechaza", async () => {
  const f = fakeHttp({ "GET /permissions/admin-access": { status: 200, data: { administrator: false } } });
  const out = await createGocAuthApi(f.http).assertAdministrator("jwt");
  assert.equal(out.ok, false);
  assert.equal((out as any).kind, "rejected");
});

test("assertAdministrator: administrator no booleano (\"false\", 1, \"true\") se rechaza: solo `true` estricto pasa", async () => {
  for (const administrator of ["false", "true", 1, "yes", null, {}]) {
    const out = await createGocAuthApi(fakeHttp({ "GET /permissions/admin-access": { status: 200, data: { administrator } } }).http).assertAdministrator("jwt");
    assert.equal(out.ok, false, JSON.stringify(administrator));
    assert.equal((out as any).kind, "rejected", JSON.stringify(administrator));
  }
});

test("assertAdministrator: 200 sin el campo administrator se rechaza; 200 true pasa; 500 es indisponible", async () => {
  const check = async (response: { status: number; data: unknown }) =>
    createGocAuthApi(fakeHttp({ "GET /permissions/admin-access": response }).http).assertAdministrator("jwt");
  assert.equal((await check({ status: 200, data: {} })).ok, false);
  assert.equal((await check({ status: 200, data: { administrator: true } })).ok, true);
  const down = await check({ status: 500, data: {} });
  assert.equal(down.ok === false && down.kind, "unavailable");
});

function errorParam(location: string | undefined): string | null {
  return new URL(`http://x${location}`).searchParams.get("error");
}

test("login-action: administrador rechazado (403 o administrator:false) vuelve al login con error y sin código", async () => {
  for (const response of [{ status: 403, data: {} }, { status: 200, data: { administrator: false } }]) {
    const { router } = buildRouter(fakeHttp({ "GET /permissions/admin-access": response }).http);
    const before = pendingCodeCount();
    const res = await runRoute(router, "post", "/oauth/login-action", fakeReq(loginBody({ username: "u", password: "p" })));
    assert.ok(res.redirectedTo!.startsWith("/oauth/authorize?"));
    assert.equal(errorParam(res.redirectedTo), "admin_required");
    assert.equal(pendingCodeCount(), before);
  }
});

test("login-action: API no disponible al verificar al administrador vuelve al login con otro error y sin código", async () => {
  for (const response of [{ status: 500, data: {} }, { status: 429, data: {} }, new Error("red")]) {
    const { router } = buildRouter(fakeHttp({ "GET /permissions/admin-access": response }).http);
    const before = pendingCodeCount();
    const res = await runRoute(router, "post", "/oauth/login-action", fakeReq(loginBody({ username: "u", password: "p" })));
    assert.equal(errorParam(res.redirectedTo), "unavailable");
    assert.equal(pendingCodeCount(), before);
  }
});

test("canje: administrator:false al canjear da invalid_grant y no llama al alta", async () => {
  const code = await loginAndGetCode(buildRouter(fakeHttp().http).router);
  const f = fakeHttp({ "GET /permissions/admin-access": { status: 200, data: { administrator: false } } });
  const { router } = buildRouter(f.http);
  const res = await runRoute(router, "post", "/oauth/token", fakeReq({ grant_type: "authorization_code", code, redirect_uri: REDIRECT, client_id: CLIENT_ID, code_verifier: VERIFIER }));
  assert.equal((res.body as any).error, "invalid_grant");
  assert.equal(f.callsTo("/mcp/sessions").length, 0);
});

// ---------------- rutas: Express no distingue mayúsculas ni barra final ----------------

test("app: el manejador de errores reconoce /oauth/* con otras mayúsculas o barra final", async () => {
  const { app } = appWith("1");
  for (const url of ["/OAUTH/token", "/Oauth/Register", "/oauth/revoke/"]) {
    const res = await invokeApp(app, { method: "POST", url, headers: { "content-type": "application/json" }, body: "{roto" });
    assert.equal(res.status, 400, url);
    assert.match(String(res.headers["content-type"]), /application\/json/, url);
    assert.equal(JSON.parse(res.body).error, "invalid_request", url);
  }
  for (const url of ["/oauth/authorize/", "/OAUTH/Login-Action", "/oauth/login-action/"]) {
    const res = await invokeApp(app, { method: "POST", url, headers: { "content-type": "application/json" }, body: "{roto" });
    assert.equal(res.status, 400, url);
    assert.match(String(res.headers["content-type"]), /text\/html/, url);
    assert.equal(res.headers["x-frame-options"], "DENY", url);
    assert.equal(res.headers["cache-control"], "no-store", url);
  }
});

test("error handler: la normalización no captura rutas ajenas a /oauth/", () => {
  const handler = createOauthErrorHandler(() => {});
  for (const path of ["/MCP", "/mcp/", "/oauthx/token"]) {
    let delegated = false;
    handler(new Error("x"), { path } as any, fakeRes() as any, () => { delegated = true; });
    assert.equal(delegated, true, path);
  }
});

test("error handler: las páginas de error de /oauth/* llevan no-store y no admiten marcos", () => {
  const handler = createOauthErrorHandler(() => {});
  for (const err of [Object.assign(new Error("x"), { status: 400 }), new Error("boom")]) {
    const res = fakeRes();
    handler(err, { path: "/oauth/authorize" } as any, res as any, () => {});
    assert.equal(res.headers["cache-control"], "no-store");
    assert.equal(res.headers["content-security-policy"], "frame-ancestors 'none'");
    assert.equal(res.headers["x-frame-options"], "DENY");
  }
});
