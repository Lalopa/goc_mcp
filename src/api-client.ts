import axios, { AxiosInstance, InternalAxiosRequestConfig } from "axios";

const GOC_API_URL = process.env.GOC_API_URL!;

export interface ApiCallRecord {
  method: string;
  path: string;
  statusCode: number | null;
  durationMs: number;
}

interface TimedConfig extends InternalAxiosRequestConfig {
  _startTime?: number;
}

export class GocApiClient {
  private http: AxiosInstance;
  private apiCallLog: ApiCallRecord[] = [];

  constructor(jwt: string) {
    this.http = axios.create({
      baseURL: GOC_API_URL,
      headers: { Authorization: `Bearer ${jwt}` },
    });

    this.http.interceptors.request.use((config: TimedConfig) => {
      config._startTime = Date.now();
      return config;
    });

    this.http.interceptors.response.use(
      (response) => {
        this.recordCall(response.config as TimedConfig, response.status);
        return response;
      },
      (error) => {
        if (axios.isAxiosError(error) && error.config) {
          this.recordCall(error.config as TimedConfig, error.response?.status ?? null);
        }
        return Promise.reject(error);
      }
    );
  }

  private recordCall(config: TimedConfig, statusCode: number | null): void {
    const path = config.url ?? "";
    if (path.includes("/mcp/")) return;

    this.apiCallLog.push({
      method: (config.method ?? "get").toUpperCase(),
      path,
      statusCode,
      durationMs: Date.now() - (config._startTime ?? Date.now()),
    });
  }

  getAndResetApiCallLog(): ApiCallRecord[] {
    const log = [...this.apiCallLog];
    this.apiCallLog = [];
    return log;
  }

  async get<T = unknown>(path: string, params?: Record<string, unknown>): Promise<T> {
    try {
      const res = await this.http.get<T>(path, { params });
      return res.data;
    } catch (err) {
      if (axios.isAxiosError(err)) {
        const status = err.response?.status;
        if (status === 401 || status === 403) {
          throw new Error("Invalid token or insufficient permissions. Please re-authenticate.");
        }
        const msg = err.response?.data?.message ?? err.response?.data?.error ?? err.message;
        throw new Error(`goc_api error ${status}: ${msg}`);
      }
      throw err;
    }
  }

  async post<T = unknown>(path: string, data?: unknown): Promise<T> {
    try {
      const res = await this.http.post<T>(path, data);
      return res.data;
    } catch (err) {
      if (axios.isAxiosError(err)) {
        const status = err.response?.status;
        const msg = err.response?.data?.message ?? err.response?.data?.error ?? err.message;
        throw new Error(`goc_api error ${status}: ${msg}`);
      }
      throw err;
    }
  }

  async patch<T = unknown>(path: string, data?: unknown): Promise<T> {
    try {
      const res = await this.http.patch<T>(path, data);
      return res.data;
    } catch (err) {
      if (axios.isAxiosError(err)) {
        const status = err.response?.status;
        const msg = err.response?.data?.message ?? err.response?.data?.error ?? err.message;
        throw new Error(`goc_api error ${status}: ${msg}`);
      }
      throw err;
    }
  }
}
