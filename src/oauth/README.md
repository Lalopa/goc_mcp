# src/oauth/

Implementación del servidor de autorización OAuth 2.0 según la [especificación MCP para servidores remotos](https://modelcontextprotocol.io/docs/concepts/transports#authorization).

## Por qué OAuth 2.0

Los clientes MCP modernos (Claude Code, Claude.ai) soportan OAuth 2.0 de forma nativa. Al implementarlo, el usuario solo necesita configurar la URL del servidor — el cliente abre el browser automáticamente, el usuario inicia sesión, y el token queda guardado. Sin copiar tokens manualmente.

## Flujo completo

```
Cliente MCP                   MCP Server                    goc_api
     │                             │                             │
     │  GET /.well-known/oauth-... │                             │
     │────────────────────────────►│                             │
     │  ◄── metadata (endpoints) ──│                             │
     │                             │                             │
     │  Abre browser →             │                             │
     │  GET /oauth/authorize       │                             │
     │────────────────────────────►│                             │
     │  ◄── HTML página de login ──│                             │
     │                             │                             │
     │  Usuario llena form →       │                             │
     │  POST /oauth/login-action   │                             │
     │────────────────────────────►│                             │
     │                             │  POST /auth/login           │
     │                             │────────────────────────────►│
     │                             │  ◄── { token, user } ───────│
     │                             │                             │
     │                             │  Genera auth_code (UUID)    │
     │                             │  Guarda en store (TTL 5min) │
     │                             │                             │
     │  ◄── redirect → callback?code=<uuid>&state=... ──────────│
     │                             │                             │
     │  POST /oauth/token          │                             │
     │  { code, redirect_uri }     │                             │
     │────────────────────────────►│                             │
     │                             │  redeemCode(code)           │
     │  ◄── { access_token: jwt } ─│                             │
     │                             │                             │
     │  Guarda JWT localmente      │                             │
     │  Usa Bearer en /mcp ────────────────────────────────────► │
```

## Archivos

### `store.ts` — Store de auth codes

Map en memoria que guarda los auth codes temporales generados durante el flujo OAuth.

**Estructura de cada entrada:**
```typescript
{
  jwt: string,          // JWT de goc_api del usuario autenticado
  redirect_uri: string, // URI de callback del cliente MCP
  expiry: number        // timestamp de expiración (Date.now() + 5 min)
}
```

**API:**

```typescript
createCode(jwt, redirect_uri) → string
```
Genera un UUID v4 como auth code, lo almacena con TTL de 5 minutos y lo retorna.

```typescript
redeemCode(code, redirect_uri) → string | null
```
Canjea el code: lo elimina del store y retorna el JWT. Retorna `null` si el code no existe, expiró, o el `redirect_uri` no coincide (protección contra ataques de intercepción).

> El store es in-memory. Si el servidor se reinicia, los codes en vuelo se pierden — el usuario simplemente hace login de nuevo. Para producción de alta disponibilidad con múltiples instancias, reemplazar por Redis.

---

### `login-page.ts` — Página HTML de login

Genera el HTML de la página de login que el usuario ve en su browser.

**Función:**
```typescript
renderLoginPage(params: LoginPageParams) → string
```

Parámetros recibidos via query string desde el cliente MCP:
- `redirect_uri` — URL de callback del cliente (required)
- `state` — valor opaco del cliente para prevenir CSRF (optional)
- `client_id` — identificador del cliente MCP (optional)
- `error` — mensaje de error a mostrar si el login previo falló (optional)

El HTML resultante incluye:
- Formulario con campos `username` y `password`
- Hidden fields con `redirect_uri`, `state` y `client_id` para preservarlos en el POST
- Estilos CSS inline (sin dependencias externas)
- Escape de HTML en todos los parámetros de entrada para prevenir XSS

El form hace `POST /oauth/login-action` con todos los datos.

---

### `routes.ts` — Endpoints OAuth

Router Express que implementa los 4 endpoints del flujo OAuth.

#### `GET /.well-known/oauth-authorization-server`

Metadata del servidor de autorización (RFC 8414). Permite que los clientes MCP descubran los endpoints automáticamente.

Respuesta:
```json
{
  "issuer": "https://mcp.goc.com",
  "authorization_endpoint": "https://mcp.goc.com/oauth/authorize",
  "token_endpoint": "https://mcp.goc.com/oauth/token",
  "response_types_supported": ["code"],
  "grant_types_supported": ["authorization_code"],
  "code_challenge_methods_supported": ["S256"],
  "scopes_supported": ["read"]
}
```

#### `GET /oauth/authorize`

Renderiza la página de login. Requiere `redirect_uri` como query param.

Query params esperados: `redirect_uri`, `state`, `client_id`, `error` (opcional, para mostrar error de login anterior).

#### `POST /oauth/login-action`

Recibe las credenciales del formulario, las valida contra `goc_api`, y redirige al cliente.

Body (form-encoded): `username`, `password`, `redirect_uri`, `state`, `client_id`

**Flujo:**
1. Llama `POST {GOC_API_URL}/auth/login` con `{ username, password }`
2. Extrae el JWT de `response.data.token`
3. Genera un auth_code con `createCode(jwt, redirect_uri)`
4. Redirige a `redirect_uri?code=<auth_code>&state=<state>`
5. Si falla → redirige a `/oauth/authorize` con el mensaje de error

#### `POST /oauth/token`

Intercambia un auth_code por el JWT de GOC.

Body (JSON): `grant_type`, `code`, `redirect_uri`

**Validaciones:**
- `grant_type` debe ser `"authorization_code"`
- `code` y `redirect_uri` son requeridos
- El code debe existir en el store, no haber expirado, y el `redirect_uri` debe coincidir

Respuesta exitosa:
```json
{
  "access_token": "<jwt-de-goc>",
  "token_type": "Bearer"
}
```

## Seguridad

| Riesgo | Mitigación |
|---|---|
| CSRF | El parámetro `state` es generado y verificado por el cliente MCP |
| Intercepción de auth codes | El `redirect_uri` se valida al canjear el code |
| Reutilización de codes | El code se elimina del store al primer uso |
| Codes expirados | TTL de 5 minutos estricto |
| XSS en la página de login | Todos los parámetros son escapados con `escapeHtml()` |
| Exposición de JWT en logs | El JWT nunca se loguea, solo se almacena en el store temporalmente |
