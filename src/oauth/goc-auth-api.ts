import axios from "axios";

export interface HttpResponse {
  status: number;
  data: unknown;
}

export interface HttpOptions {
  headers?: Record<string, string>;
  timeoutMs?: number;
}

// Un error de red o un timeout lanza; cualquier respuesta HTTP (también 4xx/5xx) se devuelve.
export interface HttpClient {
  get(url: string, options?: HttpOptions): Promise<HttpResponse>;
  post(url: string, body: unknown, options?: HttpOptions): Promise<HttpResponse>;
}

export type Outcome<T> =
  | { ok: true; data: T }
  | { ok: false; kind: "rejected" | "unavailable"; status?: number };

export interface SessionPair {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}

export type LoginResult =
  | { ok: true; jwt: string; gocRefreshToken: string }
  | { ok: false; message: string };

export interface RequestCaller {
  ipAddress?: string;
  userAgent?: string;
}

export interface GocAuthApi {
  login(username: string, password: string): Promise<LoginResult>;
  assertAdministrator(jwt: string): Promise<Outcome<null>>;
  createSession(
    jwt: string,
    body: RequestCaller & { gocRefreshToken: string; clientId: string; metadata?: Record<string, string> }
  ): Promise<Outcome<{ refreshToken: string }>>;
  refreshSession(body: RequestCaller & { refreshToken: string; clientId: string }): Promise<Outcome<SessionPair>>;
  revokeSession(body: RequestCaller & { token: string }): Promise<Outcome<null>>;
  /** Fire-and-forget: nunca lanza ni espera. */
  logEvent(jwt: string, event: ApiEvent): void;
}

export interface ApiEvent {
  eventType: string;
  clientId?: string;
  description?: string;
  metadata?: Record<string, string>;
  ipAddress?: string;
  userAgent?: string;
}

const SESSION_TIMEOUT_MS = 10_000;
const REVOKE_TIMEOUT_MS = 5_000;
const LOGIN_TIMEOUT_MS = 15_000;

export function createAxiosHttpClient(baseUrl: string): HttpClient {
  const instance = axios.create({ baseURL: baseUrl, validateStatus: () => true });
  return {
    async get(url, options) {
      const res = await instance.get(url, { headers: options?.headers, timeout: options?.timeoutMs });
      return { status: res.status, data: res.data };
    },
    async post(url, body, options) {
      const res = await instance.post(url, body, { headers: options?.headers, timeout: options?.timeoutMs });
      return { status: res.status, data: res.data };
    },
  };
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

function field(data: unknown, name: string): unknown {
  return data && typeof data === "object" ? (data as Record<string, unknown>)[name] : undefined;
}

// Rechazo definitivo solo para los status indicados; todo lo demás (429, 5xx, 404 por API sin desplegar…)
// es indisponibilidad transitoria y nunca debe hacer descartar credenciales válidas.
function failure(status: number, rejectedStatuses: number[]): { ok: false; kind: "rejected" | "unavailable"; status: number } {
  return { ok: false, kind: rejectedStatuses.includes(status) ? "rejected" : "unavailable", status };
}

async function guarded<T>(call: () => Promise<Outcome<T>>): Promise<Outcome<T>> {
  try {
    return await call();
  } catch {
    // Sin el error de axios: lleva la configuración de la petición, con cabeceras y cuerpo.
    return { ok: false, kind: "unavailable" };
  }
}

const bearer = (jwt: string) => ({ Authorization: `Bearer ${jwt}` });

export function createGocAuthApi(
  http: HttpClient,
  logEvent: (jwt: string, event: ApiEvent) => void = () => {}
): GocAuthApi {
  return {
    async login(username, password) {
      try {
        const res = await http.post("/auth/login", { username, password }, { timeoutMs: LOGIN_TIMEOUT_MS });
        if (res.status < 200 || res.status >= 300) {
          const message = str(field(res.data, "message")) ?? str(field(res.data, "error")) ?? "Invalid credentials";
          return { ok: false, message };
        }
        const data = res.data;
        const inner = field(data, "data");
        const jwt = str(field(data, "token")) ?? str(field(inner, "accessToken")) ?? str(field(data, "accessToken"));
        if (!jwt) return { ok: false, message: "No token received" };
        const gocRefreshToken = str(field(data, "refreshToken")) ?? str(field(inner, "refreshToken"));
        if (!gocRefreshToken) return { ok: false, message: "No refresh token received" };
        return { ok: true, jwt, gocRefreshToken };
      } catch {
        return { ok: false, message: "Authentication service unavailable" };
      }
    },

    assertAdministrator(jwt) {
      return guarded(async () => {
        const res = await http.get("/permissions/admin-access", { headers: bearer(jwt), timeoutMs: SESSION_TIMEOUT_MS });
        if (res.status === 200) {
          return field(res.data, "administrator") === true
            ? { ok: true, data: null }
            : { ok: false, kind: "rejected", status: 200 };
        }
        return failure(res.status, [401, 403]);
      });
    },

    createSession(jwt, body) {
      return guarded(async () => {
        const res = await http.post("/mcp/sessions", body, { headers: bearer(jwt), timeoutMs: SESSION_TIMEOUT_MS });
        if (res.status !== 201) return failure(res.status, [400, 401, 403]);
        const refreshToken = str(field(field(res.data, "data"), "refreshToken"));
        if (!refreshToken) return { ok: false, kind: "unavailable", status: res.status };
        return { ok: true, data: { refreshToken } };
      });
    },

    refreshSession(body) {
      return guarded(async () => {
        const res = await http.post("/public/mcp/sessions/refresh", body, { timeoutMs: SESSION_TIMEOUT_MS });
        if (res.status !== 200) return failure(res.status, [400, 401]);
        const accessToken = str(field(res.data, "accessToken"));
        const refreshToken = str(field(res.data, "refreshToken"));
        const expiresIn = field(res.data, "expiresIn");
        if (!accessToken || !refreshToken || typeof expiresIn !== "number" || !(expiresIn > 0)) {
          return { ok: false, kind: "unavailable", status: res.status };
        }
        return { ok: true, data: { accessToken, refreshToken, expiresIn } };
      });
    },

    revokeSession(body) {
      return guarded(async () => {
        const res = await http.post("/public/mcp/sessions/revoke", body, { timeoutMs: REVOKE_TIMEOUT_MS });
        return res.status === 200 ? { ok: true, data: null } : failure(res.status, []);
      });
    },

    logEvent(jwt, event) {
      try {
        logEvent(jwt, event);
      } catch {
        // El evento es best-effort.
      }
    },
  };
}
