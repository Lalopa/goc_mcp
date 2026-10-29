# src/

Código fuente del servidor MCP. Escrito en TypeScript, compilado a `dist/` con `tsc`.

## Archivos raíz

### `index.ts` — Entry point

Arranca el servidor HTTP Express y monta todas las rutas.

**Responsabilidades:**
- Inicializa Express con middlewares (`json`, `urlencoded`)
- Monta el router OAuth (`/oauth/...` y `/.well-known/...`)
- Expone `GET /health` para health checks
- Maneja `POST /mcp` — el endpoint principal del protocolo MCP

**Flujo del endpoint `/mcp`:**
1. Extrae el `Bearer <jwt>` del header `Authorization`
2. Si no hay token → responde `401 Unauthorized`
3. Verifica con `/permissions/admin-access` que el JWT corresponde a un administrador activo; devuelve 401/403 o 503 si no puede verificarlo. Solo entonces crea el MCP server
4. Crea un `StreamableHTTPServerTransport` en modo stateless (`sessionIdGenerator: undefined`)
5. Conecta servidor y transporte
6. Delega el request al transporte
7. Al cerrar la conexión, limpia servidor y transporte

> El servidor es **stateless**: cada request HTTP crea y destruye su propia instancia. Esto permite que múltiples usuarios con distintos JWTs usen el servidor simultáneamente sin interferencia.

---

### `api-client.ts` — Cliente HTTP hacia goc_api

Encapsula todas las llamadas HTTP al backend GOC.

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
   - `registerEmployeeTools(server, client)`
   - `registerAttendanceTools(server, client)`
   - `registerOrderTools(server, client)`
   - `registerProjectTools(server, client)`
   - `registerPermissionTools(server, client, tracker)` — consulta y edición administrativa de permisos
4. Retorna el servidor listo para conectar a un transporte

Cada llamada a `createMcpServer()` produce una instancia independiente y aislada. No hay estado compartido entre requests.

## Subdirectorios

- [`oauth/`](./oauth/README.md) — Implementación del servidor OAuth 2.0
- [`tools/`](./tools/README.md) — Herramientas MCP por dominio de negocio
