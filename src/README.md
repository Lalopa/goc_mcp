# src/

Código fuente del servidor MCP. Escrito en TypeScript, compilado a `dist/` con `tsc`.

## Archivos raíz

### `index.ts` — Entry point

Carga `dotenv`, crea la app con `createApp()` y la pone a escuchar en `PORT` (3002 por defecto). Es lo único que abre un puerto.

---

### `app.ts` — Aplicación Express

`createApp(deps?, options?)` construye la app sin abrir un puerto, de modo que los tests la ejecutan completa.

**Responsabilidades:**
- Configura `trust proxy` desde `TRUST_PROXY_HOPS` (de ello depende `req.ip`)
- Inicializa Express con middlewares (`json`, `urlencoded`)
- Monta el router OAuth (`/oauth/...` y `/.well-known/...`) y, justo después, el manejador que convierte los errores de los parsers en `/oauth/*` en respuestas OAuth
- Expone `GET /health` para health checks
- Maneja `POST /mcp` — el endpoint principal del protocolo MCP

**Flujo del endpoint `/mcp`:**
1. Extrae el `Bearer <jwt>` del header `Authorization`
2. Si no hay token, está mal formado o ya venció → responde `401` con `WWW-Authenticate` (el cliente renueva con su refresh token o abre el login)
3. Verifica con `/permissions/admin-access` que el JWT corresponde a un administrador activo; devuelve 401/403 o 503 si no puede verificarlo. Solo entonces crea el MCP server
4. Resuelve la sesión activa para el tracking
5. Crea un `StreamableHTTPServerTransport` en modo stateless (`sessionIdGenerator: undefined`)
6. Conecta servidor y transporte
7. Delega el request al transporte
8. Al cerrar la conexión, limpia servidor y transporte

> El servidor es **stateless**: cada request HTTP crea y destruye su propia instancia. Esto permite que múltiples usuarios con distintos JWTs usen el servidor simultáneamente sin interferencia. Las sesiones OAuth no viven aquí sino en `goc_api`.

---

### `api-client.ts` — Cliente HTTP hacia goc_api

Encapsula las llamadas HTTP de las herramientas y del tracking al backend GOC, siempre con el JWT del usuario. Las llamadas del flujo OAuth (login, sesión, renovación) están en `oauth/goc-auth-api.ts`.

**Clase `GocApiClient`:**

```typescript
new GocApiClient(jwt: string)
```

- Recibe el JWT del usuario en el constructor
- Crea una instancia de `axios` con `baseURL = GOC_API_URL` y `Authorization: Bearer <jwt>`
- Expone `get`, `post` y `patch`, y `assertAdministrator()` para validar acceso vigente mediante la API

**Manejo de errores:**
- `401 / 403` → lanza error con mensaje descriptivo para re-autenticación
- Otros errores de axios → lanza error con código HTTP y mensaje de goc_api
- Errores de red → relanza el error original

---

### `mcp-server.ts` — Factory del MCP Server

Crea y configura una instancia de `McpServer` con todas las herramientas registradas.

**Función `createMcpServer(client: GocApiClient, tracker: McpTracker): McpServer`:**

1. Instancia `new McpServer({ name: "goc", version: "1.0.0" })`
2. Recibe el cliente autenticado y el tracker de la petición
3. Registra todas las herramientas por dominio:
   - `registerEmployeeTools(server, client, tracker)`
   - `registerAttendanceTools(server, client, tracker)`
   - `registerOrderTools(server, client, tracker)`
   - `registerProjectTools(server, client, tracker)`
   - `registerPermissionTools(server, client, tracker)` — consulta y edición administrativa de permisos
4. Retorna el servidor listo para conectar a un transporte

Cada llamada a `createMcpServer()` produce una instancia independiente y aislada. No hay estado compartido entre requests.

---

### `tracker.ts`, `tool-wrapper.ts` y `tracking-context.ts` — Tracking

`McpTracker` envía a `goc_api` (best-effort, sin esperar ni propagar errores) los eventos y las llamadas a herramientas; `withTracking()` envuelve cada herramienta para medir y registrar su duración y resultado; `tracking-context.ts` extrae el id de la petición MCP. No deben registrar tokens ni datos sensibles.

## Subdirectorios

- [`oauth/`](./oauth/README.md) — Implementación del servidor OAuth 2.0
- [`tools/`](./tools/README.md) — Herramientas MCP por dominio de negocio
