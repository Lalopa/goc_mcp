// Segundos que le quedan a un JWT según su claim `exp`. No verifica la firma: solo informa al cliente
// cuánto dura el token que la API acaba de emitir. Sin `exp` válido y futuro devuelve undefined.
export function secondsUntilExpiry(jwt: string, nowMs: number = Date.now()): number | undefined {
  try {
    const payloadB64 = jwt.split(".")[1];
    if (!payloadB64) return undefined;
    const payload = JSON.parse(Buffer.from(payloadB64, "base64url").toString("utf-8"));
    if (typeof payload?.exp !== "number" || !Number.isFinite(payload.exp)) return undefined;
    const seconds = Math.floor(payload.exp - nowMs / 1000);
    return seconds > 0 ? seconds : undefined;
  } catch {
    return undefined;
  }
}
