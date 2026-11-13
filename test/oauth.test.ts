import test from "node:test";
import assert from "node:assert/strict";
import { pendingCodeCount } from "../src/oauth/store.js";
import {
  CHALLENGE, CLIENT_ID, REDIRECT, SECRETS, VERIFIER, buildRouter, captureConsole, fakeHttp, fakeReq, loginAndGetCode, loginBody, makeJwt, nowSeconds, runRoute,
} from "./helpers.js";

const tokenReq = (body: Record<string, unknown>, extra = {}) => fakeReq(body, extra);
const codeBody = (code: string, extra: Record<string, unknown> = {}) => ({
  grant_type: "authorization_code", code, redirect_uri: REDIRECT, client_id: CLIENT_ID, code_verifier: VERIFIER, ...extra,
});
const refreshBody = (extra: Record<string, unknown> = {}) => ({
  grant_type: "refresh_token", refresh_token: SECRETS.clientRefreshToken, client_id: "client-1", ...extra,
});

// ---------------- refresh ----------------

test("refresh: sin Authorization llama a la API con el cuerpo exacto y devuelve el par con no-store", async () => {
  const f = fakeHttp();
  const { router, events } = buildRouter(f.http);
  const res = await runRoute(router, "post", "/oauth/token", tokenReq(refreshBody()));
  assert.equal(res.statusCode, 200);
  const [call] = f.callsTo("/public/mcp/sessions/refresh");
  assert.deepEqual(call.body, {
    refreshToken: SECRETS.clientRefreshToken, clientId: "client-1", ipAddress: "203.0.113.10", userAgent: "test-agent",
  });
  assert.equal(call.headers?.Authorization, undefined);
  const body = res.body as Record<string, unknown>;
  assert.equal(body.token_type, "Bearer");
  assert.equal(body.expires_in, 7200);
  assert.equal(body.refresh_token, SECRETS.renewedRefreshToken);
  assert.equal(typeof body.access_token, "string");
  assert.equal(res.headers["cache-control"], "no-store");
  assert.equal(events.length, 0);
});

test("refresh: el Authorization entrante no se reenvía a la API", async () => {
  const f = fakeHttp();
  const { router } = buildRouter(f.http);
  await runRoute(router, "post", "/oauth/token", tokenReq(refreshBody(), { headers: { authorization: "Bearer expired.jwt.value" } }));
  const [call] = f.callsTo("/public/mcp/sessions/refresh");
  assert.equal(call.headers?.Authorization, undefined);
  assert.equal(JSON.stringify(call).includes("expired.jwt.value"), false);
});

test("refresh: sin refresh_token o sin client_id da invalid_request y no llama a la API", async () => {
  for (const body of [refreshBody({ refresh_token: undefined }), refreshBody({ client_id: undefined })]) {
    const f = fakeHttp();
    const { router } = buildRouter(f.http);
    const res = await runRoute(router, "post", "/oauth/token", tokenReq(body));
    assert.equal(res.statusCode, 400);
    assert.equal((res.body as any).error, "invalid_request");
    assert.equal(f.calls.length, 0);
  }
});

test("refresh: API 401 y API 400 dan 400 invalid_grant", async () => {
  for (const status of [401, 400]) {
    const f = fakeHttp({ "POST /public/mcp/sessions/refresh": { status, data: { statusCode: status, message: "x" } } });
    const { router } = buildRouter(f.http);
    const res = await runRoute(router, "post", "/oauth/token", tokenReq(refreshBody()));
    assert.equal(res.statusCode, 400, `status ${status}`);
    assert.equal((res.body as any).error, "invalid_grant");
  }
});

test("refresh: 429, 5xx, 404, 403, timeout y red caída dan 503 temporarily_unavailable, nunca invalid_grant", async () => {
  const cases: Array<number | Error> = [429, 500, 502, 503, 404, 403, new Error("timeout of 10000ms exceeded"), new Error("ECONNREFUSED")];
  for (const c of cases) {
    const f = fakeHttp({ "POST /public/mcp/sessions/refresh": c instanceof Error ? c : { status: c, data: "Too Many Requests" } });
    const { router } = buildRouter(f.http);
    const res = await runRoute(router, "post", "/oauth/token", tokenReq(refreshBody()));
    assert.equal(res.statusCode, 503, String(c));
    assert.equal((res.body as any).error, "temporarily_unavailable");
    assert.equal(res.headers["cache-control"], "no-store");
  }
});

test("refresh: un 200 malformado de la API da 503", async () => {
  for (const data of [{}, { accessToken: "a", refreshToken: "r" }, { accessToken: "a", refreshToken: "r", expiresIn: "7200" }, null]) {
    const f = fakeHttp({ "POST /public/mcp/sessions/refresh": { status: 200, data } });
    const { router } = buildRouter(f.http);
    const res = await runRoute(router, "post", "/oauth/token", tokenReq(refreshBody()));
    assert.equal(res.statusCode, 503);
    assert.equal((res.body as any).error, "temporarily_unavailable");
  }
});

// ---------------- authorization_code ----------------

test("canje: usa el refresh token de la API, Bearer del login, cuerpo del alta y expires_in del exp", async () => {
  const jwt = makeJwt(nowSeconds() + 5400);
  const f = fakeHttp({}, jwt);
  const { router, events } = buildRouter(f.http);
  const code = await loginAndGetCode(router);
  const res = await runRoute(router, "post", "/oauth/token", tokenReq(codeBody(code)));
  assert.equal(res.statusCode, 200);
  const body = res.body as Record<string, any>;
  assert.equal(body.refresh_token, SECRETS.apiRefreshToken);
  assert.equal(body.access_token, jwt);
  assert.ok(body.expires_in > 5390 && body.expires_in <= 5400, `expires_in=${body.expires_in}`);
  assert.equal(res.headers["cache-control"], "no-store");

  const [create] = f.callsTo("/mcp/sessions");
  assert.equal(create.headers?.Authorization, `Bearer ${jwt}`);
  assert.deepEqual(create.body, {
    gocRefreshToken: SECRETS.gocRefreshToken, clientId: "client-1", ipAddress: "203.0.113.10", userAgent: "test-agent",
    metadata: { client_id: "client-1", client_name: "Test Agent" },
  });
  assert.deepEqual(events.map((e) => e.event.eventType), ["auth_success"]);
  assert.equal(events[0].jwt, jwt);
});

test("canje: alta 400/401/403 da invalid_grant y no entrega ningún token", async () => {
  for (const status of [400, 401, 403]) {
    const f = fakeHttp({ "POST /mcp/sessions": { status, data: { message: "no" } } });
    const { router, events } = buildRouter(f.http);
    const code = await loginAndGetCode(router);
    const res = await runRoute(router, "post", "/oauth/token", tokenReq(codeBody(code)));
    assert.equal(res.statusCode, 400, `status ${status}`);
    assert.equal((res.body as any).error, "invalid_grant");
    assert.equal((res.body as any).access_token, undefined);
    assert.equal((res.body as any).refresh_token, undefined);
    assert.equal(events.length, 0);
  }
});

test("canje: alta 5xx, 429, timeout o 201 sin refreshToken da 503 sin tokens", async () => {
  const cases: Array<{ status: number; data: unknown } | Error> = [
    { status: 500, data: {} }, { status: 429, data: "x" }, { status: 404, data: {} },
    new Error("timeout"), { status: 201, data: { success: true, data: { id: 1 } } },
  ];
  for (const c of cases) {
    const f = fakeHttp({ "POST /mcp/sessions": c });
    const { router, events } = buildRouter(f.http);
    const code = await loginAndGetCode(router);
    const res = await runRoute(router, "post", "/oauth/token", tokenReq(codeBody(code)));
    assert.equal(res.statusCode, 503);
    assert.equal((res.body as any).error, "temporarily_unavailable");
    assert.equal((res.body as any).access_token, undefined);
    assert.equal((res.body as any).refresh_token, undefined);
    assert.equal(events.length, 0);
  }
});

test("canje: tras un fallo del alta el código queda quemado", async () => {
  const f = fakeHttp({ "POST /mcp/sessions": { status: 500, data: {} } });
  const { router } = buildRouter(f.http);
  const code = await loginAndGetCode(router);
  await runRoute(router, "post", "/oauth/token", tokenReq(codeBody(code)));
  const second = await runRoute(router, "post", "/oauth/token", tokenReq(codeBody(code)));
  assert.equal((second.body as any).error, "invalid_grant");
  assert.equal(f.callsTo("/mcp/sessions").length, 1);
});

test("canje: administrador denegado da invalid_grant y no se llama al alta", async () => {
  const f = fakeHttp();
  const { router } = buildRouter(f.http);
  const code = await loginAndGetCode(router);
  const denied = fakeHttp({ "GET /permissions/admin-access": { status: 403, data: {} } });
  // Mismo store en memoria: se canjea con un router cuya API deniega al admin.
  const { router: router2 } = buildRouter(denied.http);
  const res = await runRoute(router2, "post", "/oauth/token", tokenReq(codeBody(code)));
  assert.equal((res.body as any).error, "invalid_grant");
  assert.equal(denied.callsTo("/mcp/sessions").length, 0);
});

test("canje: sin client_id da invalid_request y NO quema el código", async () => {
  const f = fakeHttp();
  const { router } = buildRouter(f.http);
  const code = await loginAndGetCode(router);
  const bad = await runRoute(router, "post", "/oauth/token", tokenReq(codeBody(code, { client_id: undefined })));
  assert.equal(bad.statusCode, 400);
  assert.equal((bad.body as any).error, "invalid_request");
  const ok = await runRoute(router, "post", "/oauth/token", tokenReq(codeBody(code)));
  assert.equal(ok.statusCode, 200);
});

test("canje: el código no se puede canjear dos veces", async () => {
  const f = fakeHttp();
  const { router } = buildRouter(f.http);
  const code = await loginAndGetCode(router);
  const first = await runRoute(router, "post", "/oauth/token", tokenReq(codeBody(code)));
  const second = await runRoute(router, "post", "/oauth/token", tokenReq(codeBody(code)));
  assert.equal(first.statusCode, 200);
  assert.equal((second.body as any).error, "invalid_grant");
});

// ---------------- revoke ----------------

test("revoke: pasa el token del cuerpo a la API pública sin Authorization", async () => {
  const f = fakeHttp();
  const { router } = buildRouter(f.http);
  const res = await runRoute(router, "post", "/oauth/revoke", fakeReq({ token: SECRETS.clientRefreshToken }, { headers: { authorization: "Bearer other.jwt.x" } }));
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, {});
  const [call] = f.callsTo("/public/mcp/sessions/revoke");
  assert.deepEqual(call.body, { token: SECRETS.clientRefreshToken, ipAddress: "203.0.113.10", userAgent: "test-agent" });
  assert.equal(call.headers?.Authorization, undefined);
});

test("revoke: siempre 200 {} aunque la API falle, sin token o con cuerpo vacío", async () => {
  const cases: Array<{ status: number; data: unknown } | Error> = [{ status: 401, data: {} }, { status: 500, data: {} }, { status: 429, data: {} }, new Error("red")];
  for (const c of cases) {
    const f = fakeHttp({ "POST /public/mcp/sessions/revoke": c });
    const { router } = buildRouter(f.http);
    const res = await runRoute(router, "post", "/oauth/revoke", fakeReq({ token: "t" }));
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body, {});
  }
  const f = fakeHttp();
  const { router } = buildRouter(f.http);
  for (const body of [{}, { token: "" }]) {
    const res = await runRoute(router, "post", "/oauth/revoke", fakeReq(body));
    assert.equal(res.statusCode, 200);
  }
  assert.equal(f.calls.length, 0);
});

test("revoke: un access token (JWT) se pasa a la API tal cual y se responde 200", async () => {
  const f = fakeHttp();
  const { router } = buildRouter(f.http);
  const jwt = makeJwt(nowSeconds() + 100);
  const res = await runRoute(router, "post", "/oauth/revoke", fakeReq({ token: jwt, token_type_hint: "access_token" }));
  assert.equal(res.statusCode, 200);
  assert.equal((f.callsTo("/public/mcp/sessions/revoke")[0].body as any).token, jwt);
  assert.equal(f.callsTo("/public/mcp/sessions/revoke")[0].headers?.Authorization, undefined);
});

// ---------------- transversales ----------------

test("sin duplicados: refresh y revoke no llaman a find, PATCH ni eventos desde el MCP", async () => {
  const f = fakeHttp();
  const { router, events } = buildRouter(f.http);
  await runRoute(router, "post", "/oauth/token", tokenReq(refreshBody()));
  await runRoute(router, "post", "/oauth/revoke", fakeReq({ token: "t" }));
  assert.deepEqual(f.calls.map((c) => c.url), ["/public/mcp/sessions/refresh", "/public/mcp/sessions/revoke"]);
  assert.equal(events.length, 0);
});

test("excepción inesperada en /oauth/token sale como 503 JSON temporarily_unavailable", async () => {
  const f = fakeHttp();
  const { router } = buildRouter(f.http, {
    api: {
      refreshSession: async () => { throw new TypeError("fallo no previsto"); },
    } as any,
  });
  const res = await runRoute(router, "post", "/oauth/token", tokenReq(refreshBody()));
  assert.equal(res.statusCode, 503);
  assert.equal((res.body as any).error, "temporarily_unavailable");

  // El store es global: el código se emite con un router sano y se canjea en uno cuya dependencia lanza.
  const code = await loginAndGetCode(buildRouter(f.http).router);
  const { router: r2 } = buildRouter(f.http, {
    api: { assertAdministrator: async () => { throw new Error("boom"); } } as any,
  });
  const res2 = await runRoute(r2, "post", "/oauth/token", tokenReq(codeBody(code)));
  assert.equal(res2.statusCode, 503);
  assert.equal((res2.body as any).error, "temporarily_unavailable");
});

test("excepción inesperada en /oauth/revoke sigue dando 200 {}", async () => {
  const { router } = buildRouter(fakeHttp().http, { api: { revokeSession: async () => { throw new Error("boom"); } } as any });
  const res = await runRoute(router, "post", "/oauth/revoke", fakeReq({ token: "t" }));
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, {});
});

test("grant_type desconocido da 400 JSON unsupported_grant_type", async () => {
  const { router } = buildRouter(fakeHttp().http);
  const res = await runRoute(router, "post", "/oauth/token", tokenReq({ grant_type: "password" }));
  assert.equal(res.statusCode, 400);
  assert.equal((res.body as any).error, "unsupported_grant_type");
});

test("ningún token aparece en logs ni en consola en ningún flujo", async () => {
  const f = fakeHttp({ "POST /mcp/sessions": { status: 401, data: { message: "x" } } });
  const { router, logs } = buildRouter(f.http);
  const { output } = await captureConsole(async () => {
    const code = await loginAndGetCode(router);
    await runRoute(router, "post", "/oauth/token", tokenReq(codeBody(code)));
    await runRoute(router, "post", "/oauth/token", tokenReq(refreshBody()));
    const f2 = fakeHttp({ "POST /public/mcp/sessions/refresh": new Error(`falló con ${SECRETS.clientRefreshToken}`) });
    const b2 = buildRouter(f2.http);
    await runRoute(b2.router, "post", "/oauth/token", tokenReq(refreshBody()));
    await runRoute(b2.router, "post", "/oauth/revoke", fakeReq({ token: SECRETS.clientRefreshToken }));
    logs.push(...b2.logs);
  });
  const all = `${logs.join("\n")}\n${output}`;
  for (const secret of [SECRETS.loginJwtSignature, SECRETS.gocRefreshToken, SECRETS.apiRefreshToken, SECRETS.clientRefreshToken, SECRETS.password]) {
    assert.equal(all.includes(secret), false, `aparece ${secret}`);
  }
  assert.ok(logs.length > 0, "debe haber algún log de rechazo");
});

// ---------------- login-action ----------------

test("login-action: emite un código y redirige al redirect_uri con state", async () => {
  const { router } = buildRouter(fakeHttp().http);
  const res = await runRoute(router, "post", "/oauth/login-action", fakeReq(loginBody({ username: "u", password: "p", state: "xyz" })));
  const url = new URL(res.redirectedTo!);
  assert.equal(url.origin + url.pathname, REDIRECT);
  assert.equal(url.searchParams.get("state"), "xyz");
  assert.ok(url.searchParams.get("code"));
});

test("login-action: login sin refreshToken es error de login y no crea código", async () => {
  const f = fakeHttp({ "POST /auth/login": { status: 200, data: { token: makeJwt(nowSeconds() + 100) } } });
  const { router } = buildRouter(f.http);
  const before = pendingCodeCount();
  const res = await runRoute(router, "post", "/oauth/login-action", fakeReq(loginBody({ username: "u", password: "p" })));
  assert.ok(res.redirectedTo!.startsWith("/oauth/authorize?"));
  assert.ok(new URL(`http://x${res.redirectedTo}`).searchParams.get("error"));
  assert.equal(new URL(`http://x${res.redirectedTo}`).searchParams.get("code"), null);
  assert.equal(pendingCodeCount(), before);
});

test("login-action: login fallido registra un warn sin usuario, contraseña ni mensaje de la API", async () => {
  const f = fakeHttp({ "POST /auth/login": { status: 401, data: { message: "mensaje-de-la-api-sentinel" } } });
  const { router, logs } = buildRouter(f.http);
  const { output } = await captureConsole(() =>
    runRoute(router, "post", "/oauth/login-action", fakeReq(loginBody({ username: "usuario-sentinel" })))
  );
  const all = `${logs.join("\n")}\n${output}`;
  assert.ok(logs.length === 1);
  for (const s of ["usuario-sentinel", SECRETS.password, "mensaje-de-la-api-sentinel"]) assert.equal(all.includes(s), false, s);
});

// ---------------- rate limit (cableado) ----------------

test("rate limit /oauth/token: la petición N+1 da 429 JSON sin tocar la API; otra IP pasa", async () => {
  const f = fakeHttp();
  const { router } = buildRouter(f.http, { limits: { token: { max: 2, windowMs: 60_000 } } });
  await runRoute(router, "post", "/oauth/token", tokenReq(refreshBody()));
  await runRoute(router, "post", "/oauth/token", tokenReq(refreshBody()));
  const callsBefore = f.calls.length;
  const limited = await runRoute(router, "post", "/oauth/token", tokenReq(refreshBody()));
  assert.equal(limited.statusCode, 429);
  assert.equal((limited.body as any).error, "temporarily_unavailable");
  assert.ok(Number(limited.headers["retry-after"]) >= 1);
  assert.equal(limited.headers["cache-control"], "no-store");
  assert.equal(f.calls.length, callsBefore);
  const other = await runRoute(router, "post", "/oauth/token", tokenReq(refreshBody(), { ip: "198.51.100.7" }));
  assert.equal(other.statusCode, 200);
});

test("rate limit /oauth/login-action: exceso redirige con error y no llama al login", async () => {
  const f = fakeHttp();
  const { router } = buildRouter(f.http, { limits: { login: { max: 1, windowMs: 300_000 } } });
  const body = loginBody({ username: "u", password: "p", state: "s" });
  await runRoute(router, "post", "/oauth/login-action", fakeReq(body));
  const loginCalls = f.callsTo("/auth/login").length;
  const limited = await runRoute(router, "post", "/oauth/login-action", fakeReq(body));
  assert.ok(limited.redirectedTo!.startsWith("/oauth/authorize?"));
  assert.ok(new URL(`http://x${limited.redirectedTo}`).searchParams.get("error"));
  assert.equal(f.callsTo("/auth/login").length, loginCalls);
});

test("rate limit /oauth/revoke: exceso da 429 sin tocar la API", async () => {
  const f = fakeHttp();
  const { router } = buildRouter(f.http, { limits: { revoke: { max: 1, windowMs: 60_000 } } });
  await runRoute(router, "post", "/oauth/revoke", fakeReq({ token: "t" }));
  const limited = await runRoute(router, "post", "/oauth/revoke", fakeReq({ token: "t" }));
  assert.equal(limited.statusCode, 429);
  assert.equal(f.callsTo("/public/mcp/sessions/revoke").length, 1);
});
