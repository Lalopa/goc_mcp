export interface LoginPageParams {
  redirect_uri: string;
  state?: string;
  client_id?: string;
  error?: string;
}

export function renderLoginPage(params: LoginPageParams): string {
  const { redirect_uri, state = "", client_id = "", error } = params;

  const errorBlock = error
    ? `<p class="error">${escapeHtml(error)}</p>`
    : "";

  return `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>GOC — Iniciar sesión</title>
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
    <div class="subtitle">Inicia sesión para conectar Claude con tu cuenta</div>
    ${errorBlock}
    <form method="POST" action="/oauth/login-action">
      <input type="hidden" name="redirect_uri" value="${escapeHtml(redirect_uri)}">
      <input type="hidden" name="state" value="${escapeHtml(state)}">
      <input type="hidden" name="client_id" value="${escapeHtml(client_id)}">
      <label for="username">Usuario</label>
      <input type="text" id="username" name="username" required autofocus placeholder="nombre de usuario">
      <label for="password">Contraseña</label>
      <input type="password" id="password" name="password" required placeholder="••••••••">
      <button type="submit">Iniciar sesión</button>
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
    .replace(/"/g, "&quot;");
}
