import type { Router } from "express";
import { createGocAuthApi } from "../src/oauth/goc-auth-api.js";
import type { HttpClient, HttpResponse } from "../src/oauth/goc-auth-api.js";
import { createOauthRouter } from "../src/oauth/routes.js";
import type { OauthDeps } from "../src/oauth/routes.js";

export const SECRETS = {
  loginJwtSignature: "LOGINSIG-sentinel",
  gocRefreshToken: "goc-refresh-sentinel",
  apiRefreshToken: "api-refresh-sentinel",
  clientRefreshToken: "client-refresh-sentinel",
  renewedJwtSignature: "RENEWEDSIG-sentinel",
  renewedRefreshToken: "renewed-refresh-sentinel",
  password: "password-sentinel",
};

export function makeJwt(expSeconds: number | null, signature: string = SECRETS.loginJwtSignature): string {
  const enc = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const payload = expSeconds === null ? { userId: 1 } : { userId: 1, exp: expSeconds };
  return `${enc({ alg: "HS256" })}.${enc(payload)}.${signature}`;
}

export const nowSeconds = () => Math.floor(Date.now() / 1000);

export interface RecordedCall {
  method: "GET" | "POST";
  url: string;
  body?: unknown;
  headers?: Record<string, string>;
}

type Responder = HttpResponse | Error | ((call: RecordedCall) => HttpResponse);

export function fakeHttp(overrides: Record<string, Responder> = {}, loginJwt: string = makeJwt(nowSeconds() + 7200)) {
  const calls: RecordedCall[] = [];
  const responders: Record<string, Responder> = {
    "POST /auth/login": { status: 200, data: { token: loginJwt, refreshToken: SECRETS.gocRefreshToken } },
    "GET /permissions/admin-access": { status: 200, data: { administrator: true } },
    "POST /mcp/sessions": {
      status: 201,
      data: { success: true, data: { id: 7, refreshToken: SECRETS.apiRefreshToken, expiresAt: "2030-01-01T00:00:00Z" } },
    },
    "POST /public/mcp/sessions/refresh": {
      status: 200,
      data: {
        accessToken: makeJwt(nowSeconds() + 7200, SECRETS.renewedJwtSignature),
        expiresIn: 7200,
        refreshToken: SECRETS.renewedRefreshToken,
      },
    },
    "POST /public/mcp/sessions/revoke": { status: 200, data: {} },
    ...overrides,
  };

  const handle = async (call: RecordedCall): Promise<HttpResponse> => {
    calls.push(call);
    const responder = responders[`${call.method} ${call.url}`];
    if (!responder) throw new Error(`llamada no prevista: ${call.method} ${call.url}`);
    if (responder instanceof Error) throw responder;
    return typeof responder === "function" ? responder(call) : responder;
  };

  const http: HttpClient = {
    get: (url, options) => handle({ method: "GET", url, headers: options?.headers }),
    post: (url, body, options) => handle({ method: "POST", url, body, headers: options?.headers }),
  };
  return { http, calls, callsTo: (url: string) => calls.filter((c) => c.url === url) };
}

export interface FakeRes {
  statusCode: number;
  headers: Record<string, string>;
  body: unknown;
  redirectedTo?: string;
  headersSent: boolean;
  status(code: number): FakeRes;
  json(body: unknown): FakeRes;
  send(body: unknown): FakeRes;
  redirect(url: string): void;
  setHeader(name: string, value: string): FakeRes;
}

export function fakeRes(): FakeRes {
  const res: FakeRes = {
    statusCode: 200,
    headers: {},
    body: undefined,
    headersSent: false,
    status(code) { res.statusCode = code; return res; },
    json(body) { res.body = body; res.headersSent = true; return res; },
    send(body) { res.body = body; res.headersSent = true; return res; },
    redirect(url) { res.redirectedTo = url; res.statusCode = 302; res.headersSent = true; },
    setHeader(name, value) { res.headers[name.toLowerCase()] = value; return res; },
  };
  return res;
}

export function fakeReq(body: Record<string, unknown>, extra: { ip?: string; headers?: Record<string, string> } = {}) {
  return { body, ip: extra.ip ?? "203.0.113.10", headers: { "user-agent": "test-agent", ...(extra.headers ?? {}) }, query: {} };
}

// Ejecuta la cadena real de handlers de la ruta (limitador incluido) sin abrir un puerto.
export async function runRoute(router: Router, method: "get" | "post", path: string, req: object): Promise<FakeRes> {
  const layer = (router as unknown as { stack: any[] }).stack.find(
    (l) => l.route?.path === path && l.route.methods[method]
  );
  if (!layer) throw new Error(`ruta no encontrada: ${method} ${path}`);
  const handlers: Array<{ handle: (...args: unknown[]) => unknown }> = layer.route.stack;
  const res = fakeRes();

  const step = (i: number): Promise<void> => {
    if (i >= handlers.length) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      let advanced = false;
      const next = (err?: unknown) => {
        if (err) return reject(err);
        advanced = true;
        step(i + 1).then(resolve, reject);
      };
      Promise.resolve(handlers[i].handle(req, res, next)).then(() => { if (!advanced) resolve(); }, reject);
    });
  };
  await step(0);
  return res;
}

export function buildRouter(http: HttpClient, overrides: Partial<OauthDeps> = {}) {
  const logs: string[] = [];
  const events: Array<{ jwt: string; event: any }> = [];
  const api = createGocAuthApi(http, (jwt, event) => events.push({ jwt, event }));
  const router = createOauthRouter({
    api,
    mcpBaseUrl: "https://mcp.test",
    getClientMeta: async (clientId) => (clientId ? { client_id: clientId, client_name: "Test Agent" } : {}),
    registerClient: async () => {},
    log: (m) => logs.push(m),
    ...overrides,
  });
  return { router, logs, events };
}

// Captura todo lo que salga por consola mientras corre `fn`.
export async function captureConsole<T>(fn: () => Promise<T>): Promise<{ result: T; output: string }> {
  const lines: string[] = [];
  const original = { log: console.log, warn: console.warn, error: console.error, info: console.info, debug: console.debug };
  const sink = (...args: unknown[]) => { lines.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ")); };
  Object.assign(console, { log: sink, warn: sink, error: sink, info: sink, debug: sink });
  try {
    return { result: await fn(), output: lines.join("\n") };
  } finally {
    Object.assign(console, original);
  }
}

export const REDIRECT = "https://claude.test/callback";

// Hace login por la ruta real y devuelve el código emitido.
export async function loginAndGetCode(router: Router, redirect_uri: string = REDIRECT): Promise<string> {
  const res = await runRoute(router, "post", "/oauth/login-action", fakeReq({
    username: "admin@example.com", password: SECRETS.password, redirect_uri, state: "st", client_id: "client-1",
  }));
  const location = res.redirectedTo ?? "";
  const code = new URL(location).searchParams.get("code");
  if (!code) throw new Error(`login sin código: ${location}`);
  return code;
}
