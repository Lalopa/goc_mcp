# src/oauth/

Servidor de autorización OAuth 2.0 del MCP, según la [especificación MCP para servidores remotos](https://modelcontextprotocol.io/docs/concepts/transports#authorization). El MCP **no guarda sesiones**: valida la petición, delega en `goc_api` (login, alta de sesión, renovación, revocación) y entrega al cliente lo que la API devuelve.

Para la política de sesión, los límites conocidos, las variables de entorno, el despliegue y la prueba de humo, ver el [README principal](../../README.md).

## Flujo completo

```
Cliente MCP                   MCP Server                          goc_api
     │                             │                                   │
     │  POST /oauth/register       │                                   │
     │  { redirect_uris, ... }     │  POST /mcp/clients/register       │
     │────────────────────────────►│──────────────────────────────────►│
     │  ◄── client_id ─────────────│                                   │
     │                             │                                   │
     │  Abre el browser →          │                                   │
     │  GET /oauth/authorize       │  GET /mcp/clients/<client_id>     │
     │  (PKCE S256)                │──────────────────────────────────►│
     │  ◄── página de login ───────│                                   │
     │                             │                                   │
     │  POST /oauth/login-action   │  GET /mcp/clients/<client_id>     │
     │────────────────────────────►│  POST /auth/login                 │
     │                             │  GET /permissions/admin-access    │
     │                             │──────────────────────────────────►│
     │  ◄── redirect → redirect_uri?code=<code>&state=... ─────────────│
     │                             │                                   │
     │  POST /oauth/token          │  GET /permissions/admin-access    │
     │  (authorization_code +      │  POST /mcp/sessions               │
     │   code_verifier)            │──────────────────────────────────►│
     │  ◄── access_token + refresh_token (el de la API) ───────────────│
     │                             │                                   │
     │  POST /mcp con Bearer ─────►│  GET /permissions/admin-access    │
     │                             │  (en cada petición)               │
     │                             │                                   │
     │  El access token vence (2 h)│                                   │
     │  POST /oauth/token          │  POST /public/mcp/sessions/refresh│
     │  (refresh_token, sin        │  (sin Authorization)              │
     │   Authorization)            │──────────────────────────────────►│
     │  ◄── par nuevo (rotativo) ──│                                   │
     │                             │                                   │
     │  POST /oauth/revoke         │  POST /public/mcp/sessions/revoke │
     │  (Desconectar)              │──────────────────────────────────►│
     │  ◄── 200 {} ────────────────│                                   │
```

1. **Registro** (`POST /oauth/register`). Cada `redirect_uri` debe ser `https://` (cualquier host) o `http://` con host `localhost` o `127.0.0.1` literal, sin fragmento ni credenciales, de hasta 2048 caracteres; hasta 10 por cliente. `[::1]` no se acepta como loopback. Solo se da de alta: el MCP nunca actualiza las URIs de un cliente ya registrado. La política está copiada de `goc_api` (`mcp.validators.ts`): si cambia, debe cambiarse en los dos sitios.
2. **Authorize** (`GET /oauth/authorize`). Exige `response_type=code`, `client_id` registrado, `redirect_uri` igual a una de las registradas (en loopback `http` el puerto puede variar; el resto de la URI debe coincidir) y PKCE: `code_challenge` de 43 caracteres base64url con `code_challenge_method=S256` (`plain` no se admite). La política de `redirect_uri` se comprueba antes de consultar la API de clientes.
3. **Login** (`POST /oauth/login-action`). Repite **toda** la validación del paso anterior en el servidor (los campos ocultos del formulario no son de fiar), y solo entonces llama a `goc_api` para el login y para comprobar que el usuario es administrador activo. Si todo va bien redirige a la `redirect_uri` con un `code` de un solo uso (TTL 5 min).
4. **Canje** (`POST /oauth/token`, `grant_type=authorization_code`). Exige `code`, `redirect_uri`, `client_id` y `code_verifier`; los mismos `redirect_uri` y `client_id` de authorize y un verificador que cumpla PKCE. Vuelve a comprobar que el usuario es administrador, da de alta la sesión en la API (que genera el refresh token) y devuelve `access_token`, `refresh_token` y `expires_in`.
5. **Renovación** (`POST /oauth/token`, `grant_type=refresh_token`). Solo necesita `refresh_token` y `client_id` en el cuerpo: **no lleva encabezado `Authorization`**. La API valida la sesión, rota el refresh token y emite un access token nuevo; el MCP devuelve el par. El refresh token queda ligado al `client_id` con el que se creó la sesión.
6. **Revocación** (`POST /oauth/revoke`, RFC 7009). Pasa el `token` del cuerpo a la API, que revoca la sesión a la que pertenece ese refresh token. Responde `200 {}` también si el token es desconocido o la API falla (el fallo queda en el log del servidor, sin el token). Las únicas excepciones son el limitador (`429`) y un cuerpo ilegible (`400 invalid_request`).

Cuando el access token vence, `POST /mcp` responde `401` con `WWW-Authenticate` y el cliente renueva solo.

## Errores por endpoint y qué hace el cliente

Los clientes OAuth estándar distinguen dos casos en `/oauth/token`:

- `invalid_grant` (y cualquier error desconocido o respuesta que no sea JSON): borran sus credenciales y **abren el login**.
- `temporarily_unavailable`: **conservan sus credenciales** y reintentan más tarde.

Por eso todo fallo transitorio (API caída, timeout, 429, 5xx, 404 por API sin desplegar, respuesta con forma inválida) sale como `temporarily_unavailable`, y `invalid_grant` solo cuando la API rechaza la credencial o la petición.

| Endpoint | Estado | Respuesta | Cuándo |
|---|---|---|---|
| `POST /oauth/register` | 201 | `client_id` y metadatos | Alta correcta |
| | 400 | `invalid_client_metadata` | Falta `redirect_uris`, o `client_name` / `token_endpoint_auth_method` no son texto o pasan de su longitud |
| | 400 | `invalid_redirect_uri` | Alguna URI fuera de política, o más de 10 |
| | 429 | `temporarily_unavailable` + `Retry-After` | Más de 20 altas en 10 min desde la misma IP |
| | 500 | `server_error` | La API no pudo guardar el cliente |
| `GET /oauth/authorize` | 200 | Página de login | Petición válida |
| | 400 | Página de error fija | Cliente ausente o desconocido, `redirect_uri` ausente, fuera de política o no registrada. Nunca se redirige a esa URI |
| | 302 | Redirección a la `redirect_uri` con `error=unsupported_response_type` o `error=invalid_request` (y `state`) | Cliente y URI válidos, pero `response_type` distinto de `code` o PKCE ausente o mal formado |
| | 429 | Página de error fija + `Retry-After` | Más de 60 peticiones por minuto desde la misma IP |
| | 503 | Página de error fija | La API de clientes no responde o devuelve algo inválido (falla cerrado: nunca se acepta por defecto) |
| `POST /oauth/login-action` | 302 | A la `redirect_uri` con `code` y `state` | Login correcto y administrador activo |
| | 302 | De vuelta a `/oauth/authorize` con `error=<código>` | `invalid_credentials` (solo si la API responde 400/401 al login, o faltan usuario o contraseña), `admin_required`, `unavailable` (la API no responde, da 5xx o 429, o contesta sin token) o `too_many_attempts` (más de 10 intentos en 5 min por IP). Conserva todos los parámetros |
| | 400, 503, 302 a la `redirect_uri` | Igual que authorize | Falla la validación de cliente, URI o PKCE; en ese caso no se llama al login |
| | 429 | Página de error fija | Limitador, si la petición no trae `redirect_uri` |
| | 503 | Página de error fija | Fallo inesperado (no se entrega código) |
| `POST /oauth/token` (código) | 200 | `access_token`, `token_type`, `expires_in`, `refresh_token` | Canje correcto |
| | 400 | `invalid_request` | Falta `code`, `redirect_uri`, `client_id` o `code_verifier`. **No** quema el código |
| | 400 | `invalid_grant` | Código vencido, ya usado o inexistente; `redirect_uri` o `client_id` distintos; verificador incorrecto (el código se quema); el usuario ya no es administrador; la API rechaza el alta de sesión |
| | 503 | `temporarily_unavailable` | La API no responde o falla (comprobación de administrador o alta de sesión) |
| `POST /oauth/token` (renovación) | 200 | Par nuevo | Renovación correcta |
| | 400 | `invalid_request` | Falta `refresh_token` o `client_id` |
| | 400 | `invalid_grant` | La API rechaza el token (400/401): desconocido, vencido, sesión revocada, otro cliente, usuario ya no administrador, reuso fuera de la ventana de gracia |
| | 503 | `temporarily_unavailable` | Cualquier otra respuesta de la API, timeout o respuesta malformada |
| `POST /oauth/token` (ambos) | 400 | `unsupported_grant_type` | `grant_type` distinto de los dos soportados |
| | 400 | `invalid_request` | Cuerpo ilegible (JSON roto, demasiado grande) |
| | 429 | `temporarily_unavailable` + `Retry-After` | Más de 60 peticiones por minuto desde la misma IP |
| `POST /oauth/revoke` | 200 | `{}` | Token válido, desconocido, ausente, o la API falla |
| | 400 | `invalid_request` | Cuerpo ilegible (JSON roto, demasiado grande) |
| | 429 | `temporarily_unavailable` + `Retry-After` | Más de 30 peticiones por minuto desde la misma IP |

Todas las respuestas de `/oauth/token` y `/oauth/revoke` llevan `Cache-Control: no-store`. En `/oauth/*`, un cuerpo ilegible en las rutas del navegador (`authorize`, `login-action`) da una página de error fija y en las demás un JSON `invalid_request`; un error inesperado, `503` (`temporarily_unavailable` o página fija). Las rutas se comparan sin distinguir mayúsculas ni barra final, igual que Express las enruta.

## Archivos

| Archivo | Qué hace |
|---|---|
| `routes.ts` | Router con todos los endpoints y los metadatos (`/.well-known/oauth-authorization-server` y `/.well-known/oauth-protected-resource`). Se crea con `createOauthRouter(deps)` |
| `goc-auth-api.ts` | Cliente de las llamadas a `goc_api` (login, administrador, alta, renovación, revocación, eventos). Clasifica cada fallo como `rejected` (la API rechazó) o `unavailable` (no se sabe) |
| `deps.ts` | Cableado real de las dependencias; lee el entorno al llamarse |
| `client-registry.ts` | Alta y consulta de clientes registrados en la API. La consulta falla cerrado: un 404 es «no existe»; cualquier otra cosa que no sea un cliente bien formado **del mismo `client_id`** es «no disponible» |
| `redirect-uri.ts` | Política y coincidencia de `redirect_uri` |
| `pkce.ts` | Validación de `code_challenge` / `code_verifier` y verificación S256 en tiempo constante |
| `store.ts` | Códigos de autorización en memoria: un solo uso, TTL 5 min, guardan `client_id` y `code_challenge` |
| `login-page.ts`, `error-page.ts` | HTML de la página de login y de las páginas de error fijas |
| `rate-limit.ts` | Limitadores de ventana fija en memoria, por IP (`req.ip`) |
| `trust-proxy.ts` | Lee `TRUST_PROXY_HOPS` para que `req.ip` sea la IP real del cliente |
| `error-handler.ts` | Convierte los errores de los parsers de `/oauth/*` en respuestas OAuth |
| `responses.ts`, `jwt.ts` | Helpers de respuesta (`no-store`, `frame-ancestors`) y lectura del `exp` del JWT para `expires_in` |

### Página de login

Cualquiera puede registrar un cliente: el nombre lo elige quien lo registra y la página **no puede garantizar que sea la aplicación que dice ser**. Lo único fiable es el host de la `redirect_uri` (a dónde vuelve el usuario). Por eso:

- El host de la `redirect_uri` va **primero y en su propia línea**; el nombre del cliente va después.
- El nombre se muestra sin caracteres de control, de formato Unicode (incluidos los que invierten el sentido del texto) ni marcas combinantes (texto «Zalgo»), recortado, dentro de `<bdi>`, en una sola línea con elipsis y siempre escapado.
- El subtítulo no afirma de qué aplicación se trata.
- `?error=` **no** se muestra como texto libre: es un código de un conjunto cerrado (`invalid_credentials`, `too_many_attempts`, `admin_required`, `unavailable`) con un texto fijo por código; cualquier otro valor muestra un texto genérico.
- La página y las de error llevan `Cache-Control: no-store`, `Content-Security-Policy: frame-ancestors 'none'` y `X-Frame-Options: DENY`.

### Limitadores

Por IP, en memoria, con un tope de 10 000 cubos por limitador (al llenarse se desalojan los más antiguos y se registra un aviso):

| Endpoint | Tope |
|---|---|
| `/oauth/authorize` | 60 por minuto |
| `/oauth/login-action` | 10 por 5 minutos |
| `/oauth/token` | 60 por minuto |
| `/oauth/revoke` | 30 por minuto |
| `/oauth/register` | 20 por 10 minutos |

La IP sale de `req.ip`, que depende de `TRUST_PROXY_HOPS` (ver el README principal).

## Seguridad

| Riesgo | Mitigación |
|---|---|
| Interceptación del código de autorización | PKCE S256 obligatorio; el canje exige el `code_verifier`, el mismo `client_id` y la misma `redirect_uri` |
| Redirección a un destino ajeno | La `redirect_uri` debe estar registrada por el cliente y cumplir la política; `login-action` la revalida y no confía en el formulario. Si cliente o URI no son de fiar se muestra una página de error, nunca una redirección |
| Reutilización de códigos | El código se borra al primer intento de canje, sea cual sea el resultado |
| Robo del refresh token | Rotación en cada uso; si un token ya usado se presenta pasados 60 s, la API revoca la sesión entera |
| Cliente falso o página de login engañosa | Ver «Página de login» |
| Clickjacking | `frame-ancestors 'none'` y `X-Frame-Options: DENY` |
| XSS en la página de login | Todo valor se escapa con `escapeHtml()` |
| Fuerza bruta de contraseñas | Limitador de `login-action` por IP, antes de validar o llamar a la API |
| Tokens y contraseñas en logs | Nunca se registran: ni JWT, ni refresh tokens, ni credenciales, ni cuerpos de petición ni mensajes de error de los parsers |
| La API de clientes no responde | Falla cerrado (503), nunca «aceptar» |
