// Página de error mínima para las rutas que ve una persona (/oauth/authorize, /oauth/login-action).
// El texto es fijo: nunca se refleja nada que venga de la petición.
export function renderErrorPage(message: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>GOC — Error</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #f5f5f5;
      display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; }
    .card { background: white; border-radius: 12px; padding: 40px; max-width: 380px; box-shadow: 0 2px 16px rgba(0,0,0,0.08); }
    .logo { font-size: 24px; font-weight: 700; color: #1a1a1a; margin-bottom: 12px; }
    p { font-size: 14px; color: #444; line-height: 1.5; }
  </style>
</head>
<body>
  <div class="card">
    <div class="logo">GOC</div>
    <p>${message}</p>
  </div>
</body>
</html>`;
}

export const INVALID_REQUEST_PAGE_TEXT = "The request could not be processed. Go back to the application and try connecting again.";
export const UNAVAILABLE_PAGE_TEXT = "The service is temporarily unavailable. Go back to the application and try connecting again in a few minutes.";
