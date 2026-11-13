export interface LoginPageParams {
  redirect_uri: string;
  state?: string;
  client_id?: string;
  code_challenge: string;
  code_challenge_method: string;
  /** Nombre registrado del cliente (texto libre de quien se registró: siempre escapado). */
  client_name?: string;
  error?: string;
}

function hostOf(uri: string): string {
  try {
    return new URL(uri).host;
  } catch {
    return "";
  }
}

export function renderLoginPage(params: LoginPageParams): string {
  const { redirect_uri, state = "", client_id = "", code_challenge, code_challenge_method, client_name = "", error } = params;
  const host = hostOf(redirect_uri);
  const connecting = client_name || host
    ? `<p class="client">Connecting: <strong>${escapeHtml(client_name || "Unnamed client")}</strong>${host ? ` (returns to ${escapeHtml(host)})` : ""}</p>`
    : "";

  const errorBlock = error
    ? `<p class="error">${escapeHtml(error)}</p>`
    : "";

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>GOC — Sign in</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      background: #f5f5f5;
      display: flex;
      align-items: center;
      justify-content: center;
      min-height: 100vh;
    }
    .card {
      background: white;
      border-radius: 12px;
      padding: 40px;
      width: 100%;
      max-width: 380px;
      box-shadow: 0 2px 16px rgba(0,0,0,0.08);
    }
    .logo {
      font-size: 24px;
      font-weight: 700;
      color: #1a1a1a;
      margin-bottom: 8px;
    }
    .subtitle {
      font-size: 14px;
      color: #666;
      margin-bottom: 28px;
    }
    label {
      display: block;
      font-size: 13px;
      font-weight: 500;
      color: #444;
      margin-bottom: 6px;
    }
    input[type="email"], input[type="password"] {
      width: 100%;
      padding: 10px 14px;
      border: 1px solid #ddd;
      border-radius: 8px;
      font-size: 15px;
      outline: none;
      transition: border-color 0.15s;
      margin-bottom: 18px;
    }
    input:focus { border-color: #4f6ef7; }
    button[type="submit"] {
      width: 100%;
      padding: 12px;
      background: #4f6ef7;
      color: white;
      border: none;
      border-radius: 8px;
      font-size: 15px;
      font-weight: 600;
      cursor: pointer;
      transition: background 0.15s;
    }
    button:hover { background: #3d5ce6; }
    .client {
      font-size: 13px;
      color: #444;
      margin-bottom: 16px;
      word-break: break-word;
    }
    .error {
      background: #fff0f0;
      color: #c0392b;
      border: 1px solid #f5c6c6;
      border-radius: 8px;
      padding: 10px 14px;
      font-size: 14px;
      margin-bottom: 16px;
    }
  </style>
</head>
<body>
  <div class="card">
    <div class="logo">GOC</div>
    <div class="subtitle">Sign in to connect Claude with your account</div>
    ${connecting}
    ${errorBlock}
    <form method="POST" action="/oauth/login-action">
      <input type="hidden" name="redirect_uri" value="${escapeHtml(redirect_uri)}">
      <input type="hidden" name="state" value="${escapeHtml(state)}">
      <input type="hidden" name="client_id" value="${escapeHtml(client_id)}">
      <input type="hidden" name="code_challenge" value="${escapeHtml(code_challenge)}">
      <input type="hidden" name="code_challenge_method" value="${escapeHtml(code_challenge_method)}">
      <label for="username">Username</label>
      <input type="text" id="username" name="username" required autofocus placeholder="username">
      <label for="password">Password</label>
      <input type="password" id="password" name="password" required placeholder="••••••••">
      <button type="submit">Sign in</button>
    </form>
  </div>
</body>
</html>`;
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
