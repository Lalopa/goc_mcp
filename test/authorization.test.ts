import test from "node:test";
import assert from "node:assert/strict";
import axios, { AxiosError } from "axios";
import type { AxiosAdapter } from "axios";
import { createHash } from "node:crypto";
import { isValidCodeChallenge, isValidCodeVerifier, verifyPkce } from "../src/oauth/pkce.js";
import { isAllowedRedirectUri, matchesRegisteredRedirectUri } from "../src/oauth/redirect-uri.js";
import { createCode, pendingCodeCount, redeemCode } from "../src/oauth/store.js";
import { findOAuthClient } from "../src/oauth/client-registry.js";
import {
  CHALLENGE, CLIENT_ID, REDIRECT, SECRETS, VERIFIER, buildRouter, fakeHttp, fakeReq, loginAndGetCode, loginBody, runRoute,
} from "./helpers.js";

const OTHER_VERIFIER = "A".repeat(43);

// ---------------- PKCE ----------------

test("pkce: el par del RFC 7636 (Apéndice B) verifica", () => {
  assert.equal(verifyPkce(VERIFIER, CHALLENGE), true);
});

test("pkce: verificador incorrecto, corto, largo o con caracteres ilegales no verifica", () => {
  assert.equal(verifyPkce(OTHER_VERIFIER, CHALLENGE), false);
  assert.equal(verifyPkce(VERIFIER.slice(0, 42), CHALLENGE), false);
  assert.equal(verifyPkce("a".repeat(129), CHALLENGE), false);
  assert.equal(verifyPkce(`${VERIFIER.slice(0, 42)}!`, CHALLENGE), false);
  assert.equal(verifyPkce(undefined, CHALLENGE), false);
  // El challenge no sirve como verificador (modo plain).
  assert.equal(verifyPkce(CHALLENGE, CHALLENGE), false);
});

test("pkce: formato de challenge (43 caracteres base64url) y de verificador (43-128)", () => {
  assert.equal(isValidCodeChallenge(CHALLENGE), true);
  for (const bad of [CHALLENGE.slice(1), `${CHALLENGE}a`, `${CHALLENGE.slice(1)}=`, `${CHALLENGE.slice(1)}+`, "", undefined, 5]) {
    assert.equal(isValidCodeChallenge(bad), false, String(bad));
  }
  assert.equal(isValidCodeVerifier("a".repeat(43)), true);
  assert.equal(isValidCodeVerifier("a".repeat(128)), true);
  assert.equal(isValidCodeVerifier("a".repeat(42)), false);
  assert.equal(isValidCodeVerifier("a".repeat(129)), false);
});

test("pkce: un verificador fuera de formato no verifica aunque su hash sea el challenge (RFC 7636: 43 a 128 caracteres)", () => {
  const short = "corto";
  const challengeOfShort = createHash("sha256").update(short).digest("base64url");
  assert.equal(verifyPkce(short, challengeOfShort), false);
  const illegal = `${"a".repeat(43)}!`;
  assert.equal(verifyPkce(illegal, createHash("sha256").update(illegal).digest("base64url")), false);
});

// ---------------- política y coincidencia de redirect_uri ----------------

test("redirect-uri: política igual a la de la API", () => {
  for (const ok of [
    "https://claude.ai/api/mcp/auth_callback", "https://a.test", "https://a.test:8443/cb?x=1",
    "http://localhost/cb", "http://localhost:3000/cb", "http://127.0.0.1:54321/callback", "https://[::1]/cb",
  ]) assert.equal(isAllowedRedirectUri(ok), true, ok);
  for (const bad of [
    "http://evil.test/cb", "http://[::1]:3000/cb", "http://127.1/cb", "http://LOCALHOST/cb", "HTTPS://a.test/cb",
    "https://a.test/cb#frag", "https://user@a.test/cb", "https://a.test\\cb", "https://a.test/c b", "javascript:alert(1)",
    "ftp://a.test", "claude://cb", "", `https://a.test/${"x".repeat(2048)}`, 5, null, undefined,
  ]) assert.equal(isAllowedRedirectUri(bad), false, String(bad));
});

test("redirect-uri: coincidencia exacta y canónica; no por prefijo, ni por ruta, query o esquema distintos", () => {
  const reg = ["https://claude.ai/api/mcp/auth_callback"];
  assert.equal(matchesRegisteredRedirectUri("https://claude.ai/api/mcp/auth_callback", reg), true);
  assert.equal(matchesRegisteredRedirectUri("https://CLAUDE.ai/api/mcp/auth_callback", reg), true, "host en mayúsculas: mismo destino");
  assert.equal(matchesRegisteredRedirectUri("https://claude.ai:443/api/mcp/auth_callback", reg), true);
  assert.equal(matchesRegisteredRedirectUri("https://claude.ai/api/mcp/auth_callback/", reg), false);
  assert.equal(matchesRegisteredRedirectUri("https://claude.ai/api/mcp/auth_callback/evil", reg), false);
  assert.equal(matchesRegisteredRedirectUri("https://claude.ai/api/mcp/auth_callback?x=1", reg), false);
  assert.equal(matchesRegisteredRedirectUri("https://claude.ai/api/mcp/other", reg), false);
  assert.equal(matchesRegisteredRedirectUri("https://evil.test/api/mcp/auth_callback", reg), false);
  assert.equal(matchesRegisteredRedirectUri("https://claude.ai.evil.test/api/mcp/auth_callback", reg), false);
  assert.equal(matchesRegisteredRedirectUri("https://claude.ai/api/mcp/auth_callback", []), false);
  assert.equal(matchesRegisteredRedirectUri("https://x.test/cb", [5, null, "no es url", "https://x.test/cb"]), true);
  // Origen sin ruta: `https://a.test` y `https://a.test/` son el mismo destino.
  assert.equal(matchesRegisteredRedirectUri("https://a.test/", ["https://a.test"]), true);
  assert.equal(matchesRegisteredRedirectUri("https://a.test", ["https://a.test/"]), true);
});

test("redirect-uri: una URI fuera de política no coincide ni siquiera con una idéntica registrada (cliente legado)", () => {
  for (const uri of ["http://evil.test/cb", "ftp://a.test/cb", "https://a.test/cb#frag", "claude://callback"]) {
    assert.equal(matchesRegisteredRedirectUri(uri, [uri]), false, uri);
  }
});

test("redirect-uri: en loopback http el puerto es libre; el resto debe coincidir", () => {
  const reg = ["http://localhost:3000/callback"];
  assert.equal(matchesRegisteredRedirectUri("http://localhost:54321/callback", reg), true);
  assert.equal(matchesRegisteredRedirectUri("http://localhost/callback", reg), true);
  assert.equal(matchesRegisteredRedirectUri("http://localhost:3000/other", reg), false);
  assert.equal(matchesRegisteredRedirectUri("http://localhost:3000/callback?x=1", reg), false);
  assert.equal(matchesRegisteredRedirectUri("http://127.0.0.1:3000/callback", reg), false, "localhost y 127.0.0.1 no son equivalentes");
  assert.equal(matchesRegisteredRedirectUri("http://localhost:0/callback", reg), false);
  assert.equal(matchesRegisteredRedirectUri("http://localhost:65536/callback", reg), false);
  assert.equal(matchesRegisteredRedirectUri("https://localhost:3000/callback", reg), false, "http y https no son equivalentes");
  assert.equal(matchesRegisteredRedirectUri("http://localhost:3000/callback", ["http://127.0.0.1:3000/callback"]), false);
  assert.equal(matchesRegisteredRedirectUri("http://127.0.0.1:9/cb", ["http://127.0.0.1/cb"]), true);
});

test("redirect-uri: https no recibe flexibilidad de puerto, tampoco https://localhost", () => {
  assert.equal(matchesRegisteredRedirectUri("https://a.test:8444/cb", ["https://a.test:8443/cb"]), false);
  assert.equal(matchesRegisteredRedirectUri("https://localhost:2/cb", ["https://localhost:1/cb"]), false);
  assert.equal(matchesRegisteredRedirectUri("https://localhost:1/cb", ["https://localhost:1/cb"]), true);
});

// ---------------- store ----------------

const entry = { jwt: "j", gocRefreshToken: "g", redirect_uri: "https://a.test/cb", client_id: "c-1", code_challenge: CHALLENGE };
const grant = { redirect_uri: entry.redirect_uri, client_id: "c-1", code_verifier: VERIFIER };

test("store: verificador o client_id incorrectos fallan y queman el código", () => {
  for (const wrong of [{ code_verifier: OTHER_VERIFIER }, { client_id: "otro" }, { code_verifier: "corto" }]) {
    const code = createCode(entry);
    assert.equal(redeemCode(code, { ...grant, ...wrong }), null);
    assert.equal(redeemCode(code, grant), null, "el código ya no sirve ni con los datos correctos");
  }
  assert.ok(redeemCode(createCode(entry), grant));
});

test("store: un verificador fuera de formato falla aunque coincida con el challenge guardado", () => {
  const short = "corto";
  const code = createCode({ ...entry, code_challenge: createHash("sha256").update(short).digest("base64url") });
  assert.equal(redeemCode(code, { ...grant, code_verifier: short }), null);
});

// ---------------- authorize ----------------

const authorizeQuery = (extra: Record<string, unknown> = {}) => {
  const q: Record<string, unknown> = {
    response_type: "code", client_id: CLIENT_ID, redirect_uri: REDIRECT, state: "st",
    code_challenge: CHALLENGE, code_challenge_method: "S256", ...extra,
  };
  for (const k of Object.keys(q)) if (q[k] === undefined) delete q[k];
  return { ...fakeReq({}), query: q };
};

const html = (res: { body: unknown }) => String(res.body);

test("authorize: petición válida muestra el formulario con los campos ocultos, el cliente y el host", async () => {
  const { router } = buildRouter(fakeHttp().http);
  const res = await runRoute(router, "get", "/oauth/authorize", authorizeQuery());
  assert.equal(res.statusCode, 200);
  const page = html(res);
  for (const [name, value] of [
    ["client_id", CLIENT_ID], ["redirect_uri", REDIRECT], ["state", "st"],
    ["code_challenge", CHALLENGE], ["code_challenge_method", "S256"],
  ]) assert.ok(page.includes(`name="${name}" value="${value}"`), name);
  assert.ok(page.includes("Test Agent"));
  assert.ok(page.includes("claude.test"));
  assert.equal(res.redirectedTo, undefined);
});

test("authorize: cliente desconocido o ausente da página de error 400, sin formulario ni redirección", async () => {
  const { router } = buildRouter(fakeHttp().http);
  for (const q of [{ client_id: "no-existe" }, { client_id: undefined }, { client_id: "x".repeat(256) }]) {
    const res = await runRoute(router, "get", "/oauth/authorize", authorizeQuery(q));
    assert.equal(res.statusCode, 400);
    assert.equal(res.redirectedTo, undefined);
    assert.equal(html(res).includes("<form"), false);
  }
});

test("authorize: redirect_uri no registrada o ausente da página de error 400 y nunca se redirige a ella", async () => {
  const { router } = buildRouter(fakeHttp().http);
  for (const redirect_uri of ["https://evil.test/cb", `${REDIRECT}/extra`, `${REDIRECT}?x=1`, "http://evil.test/cb", undefined]) {
    const res = await runRoute(router, "get", "/oauth/authorize", authorizeQuery({ redirect_uri }));
    assert.equal(res.statusCode, 400, String(redirect_uri));
    assert.equal(res.redirectedTo, undefined, String(redirect_uri));
    assert.equal(html(res).includes("<form"), false);
  }
});

test("authorize: loopback con otro puerto pasa; con otra ruta no", async () => {
  const { router } = buildRouter(fakeHttp().http);
  const ok = await runRoute(router, "get", "/oauth/authorize", authorizeQuery({ redirect_uri: "http://localhost:51234/callback" }));
  assert.equal(ok.statusCode, 200);
  const bad = await runRoute(router, "get", "/oauth/authorize", authorizeQuery({ redirect_uri: "http://localhost:51234/otra" }));
  assert.equal(bad.statusCode, 400);
});

test("authorize: sin PKCE válido redirige a la redirect_uri registrada con invalid_request y state", async () => {
  const { router } = buildRouter(fakeHttp().http);
  const cases: Array<Record<string, unknown>> = [
    { code_challenge: undefined },
    { code_challenge_method: undefined },
    { code_challenge_method: "plain" },
    { code_challenge_method: "s256" },
    { code_challenge: CHALLENGE.slice(1) },
    { code_challenge: `${CHALLENGE}a` },
    { code_challenge: ["a", "b"] },
  ];
  for (const extra of cases) {
    const res = await runRoute(router, "get", "/oauth/authorize", authorizeQuery(extra));
    assert.equal(res.statusCode, 302, JSON.stringify(extra));
    const url = new URL(res.redirectedTo!);
    assert.equal(url.origin + url.pathname, REDIRECT);
    assert.equal(url.searchParams.get("error"), "invalid_request");
    assert.equal(url.searchParams.get("state"), "st");
    assert.equal(url.searchParams.get("code"), null);
  }
});

test("authorize: response_type distinto de code redirige con unsupported_response_type", async () => {
  const { router } = buildRouter(fakeHttp().http);
  for (const response_type of ["token", undefined]) {
    const res = await runRoute(router, "get", "/oauth/authorize", authorizeQuery({ response_type }));
    assert.equal(new URL(res.redirectedTo!).searchParams.get("error"), "unsupported_response_type");
  }
});

test("authorize: API de clientes caída (o con forma inválida) da 503 sin formulario ni redirección", async () => {
  for (const findClient of [
    async () => ({ kind: "unavailable" as const }),
    async () => { throw new Error("boom"); },
  ]) {
    const { router } = buildRouter(fakeHttp().http, { findClient: findClient as any });
    const res = await runRoute(router, "get", "/oauth/authorize", authorizeQuery());
    assert.equal(res.statusCode, 503);
    assert.equal(res.redirectedTo, undefined);
    assert.equal(html(res).includes("<form"), false);
  }
});

test("authorize: parámetros repetidos (arrays) o de otro tipo cuentan como ausentes y no lanzan", async () => {
  const { router } = buildRouter(fakeHttp().http);
  for (const extra of [{ client_id: [CLIENT_ID, CLIENT_ID] }, { redirect_uri: [REDIRECT] }, { client_id: { a: 1 } }]) {
    const res = await runRoute(router, "get", "/oauth/authorize", authorizeQuery(extra));
    assert.equal(res.statusCode, 400);
    assert.equal(res.redirectedTo, undefined);
  }
});

test("authorize: un parámetro repetido no se reduce a su texto aunque la consulta al registro lo acepte como cadena", async () => {
  // axios/encodeURIComponent convertiría [CLIENT_ID] en "client-1": el servidor no debe llegar a consultarlo.
  const { router } = buildRouter(fakeHttp().http, {
    findClient: async (id) => String(id) === CLIENT_ID
      ? { kind: "found", clientName: "A", redirectUris: [REDIRECT] }
      : { kind: "not_found" },
  });
  const res = await runRoute(router, "get", "/oauth/authorize", authorizeQuery({ client_id: [CLIENT_ID] }));
  assert.equal(res.statusCode, 400);
  const res2 = await runRoute(router, "post", "/oauth/login-action", fakeReq(loginBody({ client_id: [CLIENT_ID] })));
  assert.equal(res2.statusCode, 400);
});

test("authorize: state, nombre de cliente y error se escapan en el HTML", async () => {
  const attack = `"><img src=x onerror=alert(1)>'`;
  const { router } = buildRouter(fakeHttp().http, {
    findClient: async () => ({ kind: "found", clientName: "<script>alert(1)</script>", redirectUris: [REDIRECT] }),
  });
  const res = await runRoute(router, "get", "/oauth/authorize", authorizeQuery({ state: attack, error: attack }));
  const page = html(res);
  assert.equal(page.includes("<img"), false);
  assert.equal(page.includes("<script>"), false);
  assert.ok(page.includes("&quot;&gt;&lt;img src=x onerror=alert(1)&gt;&#39;"));
  assert.ok(page.includes("&lt;script&gt;"));
});

// ---------------- login-action ----------------

const post = (router: any, body: Record<string, unknown>) => runRoute(router, "post", "/oauth/login-action", fakeReq(body));

test("login-action: POST directo con redirect_uri ajena no llama al login, no crea código ni redirige a esa URI", async () => {
  const f = fakeHttp();
  const { router } = buildRouter(f.http);
  const before = pendingCodeCount();
  const res = await post(router, loginBody({ redirect_uri: "https://evil.test/cb" }));
  assert.equal(res.statusCode, 400);
  assert.equal(res.redirectedTo, undefined);
  assert.equal(f.callsTo("/auth/login").length, 0);
  assert.equal(pendingCodeCount(), before);
});

test("login-action: cliente desconocido, sin client_id o sin redirect_uri: 400 sin login ni código", async () => {
  for (const extra of [{ client_id: "no-existe" }, { client_id: undefined }, { redirect_uri: undefined }]) {
    const f = fakeHttp();
    const { router } = buildRouter(f.http);
    const before = pendingCodeCount();
    const res = await post(router, loginBody(extra));
    assert.equal(res.statusCode, 400, JSON.stringify(extra));
    assert.equal(f.callsTo("/auth/login").length, 0);
    assert.equal(pendingCodeCount(), before);
  }
});

test("login-action: sin PKCE válido redirige con invalid_request a la redirect_uri registrada, sin login ni código", async () => {
  for (const extra of [{ code_challenge: undefined }, { code_challenge_method: "plain" }, { code_challenge: "corto" }]) {
    const f = fakeHttp();
    const { router } = buildRouter(f.http);
    const before = pendingCodeCount();
    const res = await post(router, loginBody(extra));
    const url = new URL(res.redirectedTo!);
    assert.equal(url.origin + url.pathname, REDIRECT);
    assert.equal(url.searchParams.get("error"), "invalid_request");
    assert.equal(url.searchParams.get("code"), null);
    assert.equal(f.callsTo("/auth/login").length, 0);
    assert.equal(pendingCodeCount(), before);
  }
});

test("login-action: API de clientes caída da 503, sin login ni código (falla cerrado)", async () => {
  const f = fakeHttp();
  const { router } = buildRouter(f.http, { findClient: async () => ({ kind: "unavailable" }) });
  const before = pendingCodeCount();
  const res = await post(router, loginBody());
  assert.equal(res.statusCode, 503);
  assert.equal(res.redirectedTo, undefined);
  assert.equal(f.callsTo("/auth/login").length, 0);
  assert.equal(pendingCodeCount(), before);
});

test("login-action: la contraseña no llega a la API cuando la petición es inválida", async () => {
  const f = fakeHttp();
  const { router } = buildRouter(f.http);
  await post(router, loginBody({ redirect_uri: "https://evil.test/cb" }));
  assert.equal(JSON.stringify(f.calls).includes(SECRETS.password), false);
});

test("login-action + canje de punta a punta: con el verificador correcto se obtiene el token", async () => {
  const f = fakeHttp();
  const { router } = buildRouter(f.http);
  const res = await post(router, loginBody({ state: "xyz" }));
  const url = new URL(res.redirectedTo!);
  assert.equal(url.origin + url.pathname, REDIRECT);
  assert.equal(url.searchParams.get("state"), "xyz");
  const token = await runRoute(router, "post", "/oauth/token", fakeReq({
    grant_type: "authorization_code", code: url.searchParams.get("code"), redirect_uri: REDIRECT, client_id: CLIENT_ID, code_verifier: VERIFIER,
  }));
  assert.equal(token.statusCode, 200);
});

test("login-action: login fallido vuelve a authorize conservando todos los parámetros", async () => {
  const f = fakeHttp({ "POST /auth/login": { status: 401, data: { message: "no" } } });
  const { router } = buildRouter(f.http);
  const res = await post(router, loginBody({ state: "st-9" }));
  const url = new URL(`http://x${res.redirectedTo}`);
  assert.equal(url.pathname, "/oauth/authorize");
  const p = url.searchParams;
  assert.deepEqual(
    [p.get("response_type"), p.get("client_id"), p.get("redirect_uri"), p.get("state"), p.get("code_challenge"), p.get("code_challenge_method")],
    ["code", CLIENT_ID, REDIRECT, "st-9", CHALLENGE, "S256"]
  );
  assert.ok(p.get("error"));
  // Y esa URL de reintento es una petición válida para authorize.
  const again = await runRoute(router, "get", "/oauth/authorize", { ...fakeReq({}), query: Object.fromEntries(p) });
  assert.equal(again.statusCode, 200);
});

test("login-action: el limitador va primero: frena aunque las peticiones sean inválidas y conserva los parámetros", async () => {
  const f = fakeHttp();
  let lookups = 0;
  const { router } = buildRouter(f.http, {
    limits: { login: { max: 1, windowMs: 300_000 } },
    findClient: async () => { lookups += 1; return { kind: "found", clientName: "A", redirectUris: [REDIRECT] }; },
  });
  await post(router, loginBody({ redirect_uri: "https://evil.test/cb" })); // inválida: gasta el cupo
  const lookupsBefore = lookups;
  const limited = await post(router, loginBody());
  assert.ok(limited.redirectedTo!.startsWith("/oauth/authorize?"));
  const p = new URL(`http://x${limited.redirectedTo}`).searchParams;
  assert.equal(p.get("code_challenge"), CHALLENGE);
  assert.equal(p.get("code_challenge_method"), "S256");
  assert.equal(p.get("response_type"), "code");
  assert.equal(lookups, lookupsBefore, "limitada: ni consulta de cliente ni login");
  assert.equal(f.callsTo("/auth/login").length, 0);
});

// ---------------- canje ----------------

const tokenBody = (code: string, extra: Record<string, unknown> = {}) => {
  const body: Record<string, unknown> = {
    grant_type: "authorization_code", code, redirect_uri: REDIRECT, client_id: CLIENT_ID, code_verifier: VERIFIER, ...extra,
  };
  for (const k of Object.keys(body)) if (body[k] === undefined) delete body[k];
  return fakeReq(body);
};

test("canje: verificador incorrecto da invalid_grant, no toca la API y quema el código", async () => {
  const f = fakeHttp();
  const { router } = buildRouter(f.http);
  const code = await loginAndGetCode(router);
  const callsBefore = f.calls.length;
  const bad = await runRoute(router, "post", "/oauth/token", tokenBody(code, { code_verifier: OTHER_VERIFIER }));
  assert.equal(bad.statusCode, 400);
  assert.equal((bad.body as any).error, "invalid_grant");
  assert.equal((bad.body as any).access_token, undefined);
  assert.equal(f.calls.length, callsBefore);
  const retry = await runRoute(router, "post", "/oauth/token", tokenBody(code));
  assert.equal((retry.body as any).error, "invalid_grant");
});

test("canje: el verificador de otro código no sirve", async () => {
  const { router } = buildRouter(fakeHttp().http);
  const codeA = await loginAndGetCode(router, { code_challenge: "A".repeat(43) });
  const res = await runRoute(router, "post", "/oauth/token", tokenBody(codeA));
  assert.equal((res.body as any).error, "invalid_grant");
});

test("canje: verificador mal formado da invalid_grant y quema el código", async () => {
  const { router } = buildRouter(fakeHttp().http);
  const code = await loginAndGetCode(router);
  const bad = await runRoute(router, "post", "/oauth/token", tokenBody(code, { code_verifier: "corto" }));
  assert.equal((bad.body as any).error, "invalid_grant");
  const retry = await runRoute(router, "post", "/oauth/token", tokenBody(code));
  assert.equal((retry.body as any).error, "invalid_grant");
});

test("canje: sin code_verifier da invalid_request y NO quema el código", async () => {
  const { router } = buildRouter(fakeHttp().http);
  const code = await loginAndGetCode(router);
  const missing = await runRoute(router, "post", "/oauth/token", tokenBody(code, { code_verifier: undefined }));
  assert.equal(missing.statusCode, 400);
  assert.equal((missing.body as any).error, "invalid_request");
  const ok = await runRoute(router, "post", "/oauth/token", tokenBody(code));
  assert.equal(ok.statusCode, 200);
});

test("canje: client_id distinto da invalid_grant, sin llamadas a la API, y quema el código", async () => {
  const f = fakeHttp();
  const { router } = buildRouter(f.http);
  const code = await loginAndGetCode(router);
  const callsBefore = f.calls.length;
  const bad = await runRoute(router, "post", "/oauth/token", tokenBody(code, { client_id: "otro-cliente" }));
  assert.equal((bad.body as any).error, "invalid_grant");
  assert.equal(f.calls.length, callsBefore);
  const retry = await runRoute(router, "post", "/oauth/token", tokenBody(code));
  assert.equal((retry.body as any).error, "invalid_grant");
});

test("canje: redirect_uri distinta de la de authorize da invalid_grant", async () => {
  const { router } = buildRouter(fakeHttp().http);
  const code = await loginAndGetCode(router);
  const bad = await runRoute(router, "post", "/oauth/token", tokenBody(code, { redirect_uri: "http://localhost:3000/callback" }));
  assert.equal((bad.body as any).error, "invalid_grant");
});

// ---------------- registro ----------------

const register = (router: any, body: Record<string, unknown>, extra = {}) =>
  runRoute(router, "post", "/oauth/register", fakeReq(body, extra));

test("register: redirect_uris fuera de política dan 400 invalid_redirect_uri y no llegan a la API", async () => {
  const registered: unknown[] = [];
  const { router } = buildRouter(fakeHttp().http, { registerClient: async (d) => { registered.push(d); } });
  const many = Array.from({ length: 11 }, (_, i) => `https://a.test/cb${i}`);
  for (const redirect_uris of [
    ["http://evil.test/cb"], ["javascript:alert(1)"], ["https://a.test/cb", "ftp://x"], [5], [null], ["https://a.test/cb#x"], many,
  ]) {
    const res = await register(router, { redirect_uris, client_name: "X" });
    assert.equal(res.statusCode, 400, JSON.stringify(redirect_uris));
    assert.equal((res.body as any).error, "invalid_redirect_uri");
  }
  assert.equal(registered.length, 0);
});

test("register: https y loopback http se registran (201)", async () => {
  const registered: any[] = [];
  const { router } = buildRouter(fakeHttp().http, { registerClient: async (d) => { registered.push(d); } });
  const res = await register(router, { redirect_uris: ["https://claude.ai/api/mcp/auth_callback", "http://localhost:3000/callback", "http://127.0.0.1/cb"], client_name: "Claude" });
  assert.equal(res.statusCode, 201);
  assert.equal(registered.length, 1);
  assert.equal(registered[0].redirectUris.length, 3);
});

test("register: sin redirect_uris, o con client_name o token_endpoint_auth_method inválidos, da 400 invalid_client_metadata", async () => {
  const registered: unknown[] = [];
  const { router } = buildRouter(fakeHttp().http, { registerClient: async (d) => { registered.push(d); } });
  const ok = ["https://a.test/cb"];
  for (const body of [
    {}, { redirect_uris: [] }, { redirect_uris: "https://a.test/cb" },
    { redirect_uris: ok, client_name: "x".repeat(256) }, { redirect_uris: ok, client_name: 5 },
    { redirect_uris: ok, token_endpoint_auth_method: "x".repeat(51) },
  ]) {
    const res = await register(router, body);
    assert.equal(res.statusCode, 400, JSON.stringify(body).slice(0, 60));
    assert.equal((res.body as any).error, "invalid_client_metadata");
  }
  assert.equal(registered.length, 0);
});

test("register: limitador propio por IP; excedido da 429 JSON con Retry-After sin tocar la API", async () => {
  const registered: unknown[] = [];
  const { router } = buildRouter(fakeHttp().http, {
    registerClient: async (d) => { registered.push(d); },
    limits: { register: { max: 2, windowMs: 600_000 } },
  });
  const body = { redirect_uris: ["https://a.test/cb"], client_name: "X" };
  assert.equal((await register(router, body)).statusCode, 201);
  assert.equal((await register(router, body)).statusCode, 201);
  const limited = await register(router, body);
  assert.equal(limited.statusCode, 429);
  assert.equal((limited.body as any).error, "temporarily_unavailable");
  assert.ok(Number(limited.headers["retry-after"]) >= 1);
  assert.equal(registered.length, 2);
  assert.equal((await register(router, body, { ip: "198.51.100.9" })).statusCode, 201);
});

test("metadatos: solo S256 y solo lo que se soporta", async () => {
  const { router } = buildRouter(fakeHttp().http);
  const res = await runRoute(router, "get", "/.well-known/oauth-authorization-server", fakeReq({}));
  const meta = res.body as Record<string, unknown>;
  assert.deepEqual(meta.code_challenge_methods_supported, ["S256"]);
  assert.deepEqual(meta.response_types_supported, ["code"]);
  assert.deepEqual(meta.token_endpoint_auth_methods_supported, ["none"]);
});

// ---------------- consulta real del cliente (adaptador falso) ----------------

async function lookupWith(adapter: AxiosAdapter) {
  const original = axios.defaults.adapter;
  axios.defaults.adapter = adapter;
  try {
    return await findOAuthClient("c-1");
  } finally {
    axios.defaults.adapter = original;
  }
}

const answer = (status: number, data: unknown): AxiosAdapter => async (config) => {
  const response = { data, status, statusText: "", headers: {}, config };
  if (config.validateStatus ? config.validateStatus(status) : status >= 200 && status < 300) return response;
  throw new AxiosError(`status ${status}`, undefined, config, null, response);
};

test("findOAuthClient: 200 válido es found; 404 es not_found", async () => {
  const found = await lookupWith(answer(200, { success: true, data: { clientId: "c-1", clientName: "N", redirectUris: ["https://a.test/cb"] } }));
  assert.deepEqual(found, { kind: "found", clientName: "N", redirectUris: ["https://a.test/cb"] });
  assert.deepEqual(await lookupWith(answer(404, { success: false, data: null })), { kind: "not_found" });
});

test("findOAuthClient: 5xx, 429, 401, timeout, cuerpo vacío o redirectUris mal formadas son unavailable, nunca found", async () => {
  const validBody = { success: true, data: { clientId: "c-1", clientName: "N", redirectUris: ["https://a.test/cb"] } };
  for (const status of [500, 503, 429, 401, 403]) {
    assert.deepEqual(await lookupWith(answer(status, {})), { kind: "unavailable" }, String(status));
    assert.deepEqual(await lookupWith(answer(status, validBody)), { kind: "unavailable" }, `${status} con cuerpo válido`);
  }
  assert.deepEqual(await lookupWith(async (config) => { throw new AxiosError("timeout", "ECONNABORTED", config); }), { kind: "unavailable" });
  for (const data of [
    {}, { data: null }, { data: { clientName: "N" } }, { data: { clientName: "N", redirectUris: "https://a.test/cb" } },
    { data: { clientName: "N", redirectUris: ["https://a.test/cb", 5] } }, { data: { clientName: "N", redirectUris: { 0: "x" } } },
  ]) {
    assert.deepEqual(await lookupWith(answer(200, data)), { kind: "unavailable" }, JSON.stringify(data));
  }
});
