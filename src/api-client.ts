import axios, { AxiosInstance } from "axios";

const GOC_API_URL = process.env.GOC_API_URL!;

export class GocApiClient {
  private http: AxiosInstance;

  constructor(jwt: string) {
    this.http = axios.create({
      baseURL: GOC_API_URL,
      headers: { Authorization: `Bearer ${jwt}` },
    });
  }

  async get<T = unknown>(path: string, params?: Record<string, unknown>): Promise<T> {
    try {
      const res = await this.http.get<T>(path, { params });
      return res.data;
    } catch (err) {
      if (axios.isAxiosError(err)) {
        const status = err.response?.status;
        if (status === 401 || status === 403) {
          throw new Error("Token inválido o sin permisos. Por favor autentícate de nuevo.");
        }
        const msg = err.response?.data?.message ?? err.response?.data?.error ?? err.message;
        throw new Error(`goc_api error ${status}: ${msg}`);
      }
      throw err;
    }
  }
}
