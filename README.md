# GOC MCP Server

Servidor [MCP (Model Context Protocol)](https://modelcontextprotocol.io) para el sistema GOC — plataforma de gestión de construcción. Permite a Claude y otros agentes de IA consultar datos de GOC en tiempo real mediante lenguaje natural.

## ¿Qué es esto?

Este servidor expone herramientas de consulta y administración que Claude puede usar para responder preguntas como:

- "¿Cuántas asistencias tuvo Juan García este mes?"
- "¿Cómo va el pedido #450?"
- "¿Qué empleados están asignados a la obra Torre Norte?"
- "¿Quién asistió hoy en la obra 12?"

## Arquitectura

```
Cliente MCP (Claude Code / Claude.ai)
        │
        │  HTTPS (Bearer JWT)
        ▼
  GOC MCP Server  ──────────────────────►  goc_api (Express + Prisma)
  (Este servidor)                              │
        │                                      ▼
        │  OAuth 2.0                      PostgreSQL
        ▼
  Página de login
  (browser del usuario)
```

**Transporte:** HTTP Streamable (especificación MCP 2025)  
**Autenticación:** OAuth 2.0 Authorization Code con PKCE S256, access token de 2 h y refresh token rotativo  
**Modo:** Stateless — cada request es independiente. Las sesiones viven en `goc_api`, no aquí  
**Acceso:** Exclusivo para administradores activos. Casi todas las herramientas consultan datos; `permissions_edit` modifica permisos mediante la API GOC.

## Herramientas disponibles

### Empleados
| Herramienta | Descripción |
|---|---|
| `employee_search` | Buscar empleados por nombre o apellido |
| `employee_detail` | Información completa de un empleado por ID |
| `employee_list` | Listar empleados con filtros (obra, estatus, paginación) |

### Asistencias
| Herramienta | Descripción |
|---|---|
| `attendance_history` | Historial de asistencias filtrable por empleado, obra y fechas |
| `attendance_detail` | Detalle de un registro: quién, cuándo, cómo (FACE/QR/MANUAL) |
| `attendance_summary` | Resumen por proyecto y día |
| `attendance_today` | Asistencias del día actual en tiempo real |
| `attendance_stats` | Estadísticas generales de asistencia |
| `attendance_errors` | Intentos fallidos de registro/verificación (REGISTER, VERIFY, QR_GENERATED, QR_READ) con mensaje de error, fotos capturadas y metadata (dispositivo, IP, ubicación), para diagnosticar por qué un empleado no logró marcar asistencia |

### Pedidos
| Herramienta | Descripción |
|---|---|
| `order_detail` | Detalle completo de un pedido por ID: materiales, código de entrega, comentarios, documentos y cantidades reales |
| `orders_list` | Listar pedidos con filtros (obra, estatus) |
| `kanban_cards` | Vista kanban de pedidos agrupados por estatus y proveedor |

### Obras
| Herramienta | Descripción |
|---|---|
| `project_list` | Listar todas las obras disponibles |
| `project_detail` | Información detallada de una obra |
| `project_employees` | Empleados asignados a una obra |

### Permisos — solo administradores
| Herramienta | Descripción |
|---|---|
| `permissions_view` | Consultar catálogo de módulos, permisos generales por rol/usuarios y asignaciones por obra |
| `permissions_edit` | Modificar parcialmente permisos generales de un rol o asignar, cambiar y revocar permisos por obra |

Ejemplos de argumentos:

```json
{"query":{"scope":"modules","page":1,"limit":25}}
```
```json
{"query":{"scope":"roles","userIds":[7,8],"moduleIds":[10],"action":"edit"}}
```
```json
{"query":{"scope":"users","moduleIds":[10],"action":"edit","page":1,"limit":25}}
```
```json
{"query":{"scope":"project","projectModule":"tools","projectId":12,"roleIds":[3]}}
```
```json
{"edit":{"scope":"roles","roleId":3,"permissions":[{"moduleId":10,"edit":true}]}}
```
```json
{"edit":{"scope":"project","projectId":12,"projectModule":"tools","userIds":[7,8],"permissionType":"edit"}}
```
```json
{"edit":{"scope":"project","projectId":12,"projectModule":"orders","roleIds":[3],"permissionType":null}}
```

- Los IDs son ejemplos: consultar primero los valores reales. Las respuestas paginadas incluyen `hasMore`.
- Los cambios generales de un rol afectan a todos sus usuarios. Las acciones y módulos omitidos se conservan.
- Las acciones no admitidas por un módulo se desactivan; se aplican las dependencias de lectura/escritura y estados de la web. El resultado incluye valores anteriores y finales.
- Los ámbitos por obra existentes son `orders`, `tools` y `employees`; los niveles son `read` y `edit`. `null` revoca la asignación.
- Al seleccionar roles para una obra se resuelven sus usuarios actuales; no se crea herencia para usuarios futuros. Se omiten usuarios inactivos al asignar, pero se permite revocarles acceso. Máximo 500 destinatarios por edición.
- Retirar permisos de empleados conserva las relaciones de la obra. Retirar una asignación no elimina los accesos especiales de administrador ni otros permisos generales.
- Las ediciones se ejecutan en transacciones serializables. Ante un conflicto concurrente o fallo, consultar nuevamente el estado antes de reintentar.

## Flujo de autenticación

El backend verifica firma y expiración del JWT y consulta el rol y estado **actuales** del usuario. El MCP comprueba acceso administrativo al iniciar sesión, canjear códigos y en cada petición a `/mcp`, antes de exponer herramientas; la API lo comprueba también al renovar. Las herramientas de permisos y sus endpoints también exigen esta validación. Un cambio de rol o desactivación impide las peticiones posteriores aunque el JWT no haya vencido.

Los clientes MCP compatibles (Claude Code, Claude.ai) abren el browser automáticamente al primer uso:

```
1. El cliente se registra (POST /oauth/register) con sus redirect_uris
2. Abre el browser → página de login GOC (authorize, con PKCE S256 obligatorio)
3. El usuario inicia sesión con sus credenciales GOC
4. El MCP genera un código de un solo uso (TTL 5 min) y redirige a la redirect_uri registrada
5. El cliente canjea el código con su code_verifier y recibe access token (2 h) + refresh token
6. El access token viaja como Bearer en cada llamada a /mcp
7. Al vencer, el cliente renueva con POST /oauth/token (refresh_token + client_id, sin Authorization)
   y recibe un par nuevo; el refresh token anterior deja de servir
8. «Desconectar» llama a POST /oauth/revoke y la API revoca la sesión
```

El detalle de cada paso, la tabla de errores por endpoint y lo que hace el cliente con cada uno están en [src/oauth/README.md](src/oauth/README.md).

### Política de sesión

| Regla | Valor |
|---|---|
| Access token | 2 horas |
| Sesión sin renovar | 30 días → el siguiente intento termina en login |
| Duración máxima de la sesión | 90 días desde el login, se renueve o no → login |
| Refresh token | De un solo uso: cada renovación entrega uno nuevo. Se guarda en la API solo como hash |
| Refresh token ya usado | Presentado en los 60 s siguientes a su uso se acepta (varios procesos del cliente pueden renovar a la vez); pasado ese tiempo, la API **revoca la sesión entera** |
| Perder el rol de administrador (o quedar inactivo) | Corta el acceso en la siguiente petición a `/mcp` y la renovación se rechaza → login |
| Cambio de contraseña | No revoca la sesión |

### Límites conocidos

- **Desconectar no corta el access token ya emitido**: sigue valiendo hasta 2 h, hasta su vencimiento. Revocar la sesión impide renovarlo, no invalida el access token vigente.
- **Revocar con el access token en vez del refresh token no revoca nada**: `/oauth/revoke` responde `200 {}` igualmente (RFC 7009), pero la API solo reconoce refresh tokens.
- **Renovación con la respuesta perdida**: si la API rota el token y la respuesta no llega al cliente, un reintento dentro de 60 s funciona; uno posterior termina en login (la API lo trata como reuso y revoca la sesión).
- **Una sola instancia**: el código de autorización y los limitadores viven en memoria; se pierden al reiniciar (el usuario simplemente repite el login) y no se comparten entre instancias. Con varias instancias habría que moverlos a un almacén compartido.
- **`resource` y `scope` se ignoran**: aunque los metadatos anuncian `read` y `permissions:write`, el access token es el JWT general de la API y no se restringe por scope.
- Cualquiera puede registrar un cliente OAuth con `redirect_uri` https; por eso la página de login muestra primero el host de retorno y no confía en el nombre del cliente.
- Los clientes registrados antes con `redirect_uri` fuera de la política (p. ej. `http` que no sea loopback) ya no pueden autorizar: deben volver a registrarse.

## Requisitos

- Node.js 20+
- `goc_api` corriendo y accesible
- Cuenta GOC activa con rol Administrador
- Backend con `/permissions/admin-access`, `POST /permissions/query` y `PATCH /permissions/manage` desplegados
- Backend con los endpoints de sesión MCP (`POST /mcp/sessions`, `POST /public/mcp/sessions/refresh`, `POST /public/mcp/sessions/revoke`) y la migración de la familia de refresh tokens (ver [Despliegue](#despliegue))

## Instalación

```bash
git clone git@github.com:Lalopa/goc_mcp.git
cd goc_mcp
npm install
cp .env.example .env
# Editar .env con los valores correctos
```

## Variables de entorno

```env
GOC_API_URL=<url del backend GOC, incluido /api/v2>
MCP_BASE_URL=<url pública de este servidor>
PORT=3002
TRUST_PROXY_HOPS=1
```

| Variable | Descripción |
|---|---|
| `GOC_API_URL` | URL base del backend, con el prefijo `/api/v2` |
| `MCP_BASE_URL` | URL pública de este servidor (sin barra final); aparece en los metadatos OAuth |
| `PORT` | Puerto de escucha (por defecto 3002) |
| `TRUST_PROXY_HOPS` | Número de proxies de confianza delante del MCP. Entero ≥ 0 de hasta 3 cifras; vacío, negativo, decimal, texto o un número de 4 o más cifras caen a `1`. Por defecto `1` (nginx delante) |

Ver [.env.example](.env.example) para referencia. Nunca subas el `.env` real.

### Elegir `TRUST_PROXY_HOPS`

De este valor depende `req.ip`, que usan los limitadores de tasa y los eventos que se registran en la API (`ip_address`). Debe ser el **número de proxies reales** entre internet y el MCP (EC2 + nginx = `1`; con un balanceador o CloudFront delante de nginx, `2`; sin proxy, `0`):

- **Más proxies reales que el valor configurado**: `req.ip` es la IP de un proxy exterior y **todos los clientes comparten la IP**, así que comparten también el cubo de cada limitador (uno solo puede bloquear a todos).
- **Menos proxies reales que el valor configurado**: `req.ip` es lo que el cliente escribió en `X-Forwarded-For`: **la IP es falsificable** y los limitadores se evaden rotándola.

Cómo comprobarlo en el servidor:

1. nginx debe mandar la IP del cliente en `X-Forwarded-For`, por ejemplo con `proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;` en el `location` que apunta al MCP.
2. Haz las renovaciones de los pasos 5 y 6 de la «Prueba de humo» desde una máquina cuya IP pública conozcas y mira los eventos `token_refresh` en `mcp_events`: el campo `ip_address` debe ser **tu IP pública**.
3. El paso 6 añade `-H 'X-Forwarded-For: 1.2.3.4'` al `curl`: su evento debe seguir mostrando tu IP, no `1.2.3.4`. Si muestra `1.2.3.4`, el valor es mayor que el número real de proxies; si muestra la IP de un proxy o del propio servidor (p. ej. `127.0.0.1`), es menor o nginx no está mandando `X-Forwarded-For`.

## Desarrollo local

```bash
npm run dev      # tsx watch — recarga automática
```

El servidor queda en `http://localhost:3002`. Para recorrer el flujo OAuth a mano (registro, PKCE, login, canje y renovación) usa los pasos de «Prueba de humo», con `<MCP_BASE_URL>` = `http://localhost:3002`. Evita apuntar un entorno local a la API de producción.

## Producción (EC2 + pm2 + nginx)

```bash
npm run build                                    # Compila TypeScript → dist/
pm2 start dist/index.js --name goc-mcp          # Registrar en pm2
pm2 save                                         # Persistir en reinicios
```

nginx debe pasar `X-Forwarded-For` con la IP del cliente y `TRUST_PROXY_HOPS` debe coincidir con el número de proxies (ver arriba). Para el despliegue de la sesión OAuth, ver [Despliegue](#despliegue).

## Despliegue

> **ORDEN OBLIGATORIO.** El MCP nuevo depende de endpoints y de una migración de `goc_api`. Sigue los pasos en este orden y haz el paso 4 **el mismo día** que el paso 2.

1. **Migración de `goc_api`** `20261112120000_mcp_session_refresh_family`. Es manual: la ejecuta una persona, no el pipeline. Añade las columnas y la tabla de la familia de refresh tokens y revoca las sesiones que aún guardan tokens en claro.
2. **Desplegar `goc_api`** con los endpoints `POST /public/mcp/sessions/refresh`, `POST /public/mcp/sessions/revoke` y el alta de sesión nueva (`POST /mcp/sessions`).
3. **Volver a correr solo el `UPDATE` de esa migración.** Entre el paso 1 y el 2 la API anterior pudo crear sesiones con tokens en claro; ese `UPDATE` las vacía y las revoca. Solo ese bloque se puede repetir: el resto del archivo (`ALTER TABLE`, `CREATE TABLE`, índices) se ejecuta una única vez.
4. **Desplegar `goc_mcp`** (esta rama) el mismo día.

Qué pasa si se rompe el orden:

- **MCP antes que la API** (paso 4 antes que el 2): el alta de sesión de la API anterior exige campos que el MCP ya no manda y responde 400; el MCP lo traduce a `invalid_grant` y el cliente vuelve a abrir el login una y otra vez: **bucle de login**. La renovación tampoco funciona (el endpoint no existe: `404`, que sale como `temporarily_unavailable` y deja un `console.error` fijo en el log).
- **Ventana entre el paso 2 y el 4** (API nueva, MCP anterior): «Desconectar» **no revoca** la sesión, porque el MCP anterior no usa el endpoint de revocación nuevo. Por eso el paso 4 va el mismo día.

Tras el despliegue **todos los usuarios hacen un login más**: las sesiones existentes no se migran y quedan revocadas.

Las herramientas de permisos reutilizan tablas existentes y no necesitan migraciones propias. Cualquier cambio futuro de esquema o datos iniciales debe versionarse mediante migraciones.

## Prueba de humo tras desplegar

Verifica la renovación contra el servidor real. Corre los pasos **de corrido y en este orden**, en una misma terminal (bash o zsh), porque cada uno usa variables del anterior.

**Requisitos:** `curl`, `jq`, `openssl`, una cuenta GOC con rol Administrador y acceso de lectura a la tabla `mcp_events` de la API.

**Marcadores** que debes sustituir por los valores reales: `<MCP_BASE_URL>` (URL pública del MCP, o `http://localhost:3002` en local), `<CLIENT_ID>` (el que devuelve el registro del paso 1) y `<CODE>` (el `code` que copias en el paso 3). El refresh token nunca se escribe a mano: vive en la variable `$REFRESH_TOKEN` (lo que en otros documentos se llamaría `<REFRESH_TOKEN>`). **No pegues tokens reales en chats, tickets ni en el historial del shell.**

**1 a 4. Obtener un refresh token de prueba sin exponerlo.** Registra un cliente propio, haz el login en el navegador y guarda la respuesta del canje en un archivo privado:

```bash
# 1. Cliente de prueba (anota el client_id de la respuesta)
curl -sS -X POST <MCP_BASE_URL>/oauth/register -H 'Content-Type: application/json' \
  -d '{"redirect_uris":["http://localhost:9999/callback"],"client_name":"prueba-humo"}'

# 2. PKCE: verificador y challenge S256
VERIFIER=$(openssl rand -base64 48 | tr '+/' '-_' | tr -d '=\n' | cut -c1-64)
CHALLENGE=$(printf %s "$VERIFIER" | openssl dgst -sha256 -binary | openssl base64 -A | tr '+/' '-_' | tr -d '=')

# 3. Abre la URL en el navegador, inicia sesión con una cuenta administradora y copia el `code`
#    de la barra de direcciones (la página de callback dará error de conexión: es normal)
echo "<MCP_BASE_URL>/oauth/authorize?response_type=code&client_id=<CLIENT_ID>&redirect_uri=http://localhost:9999/callback&state=x&code_challenge=$CHALLENGE&code_challenge_method=S256"

# 4. Canje; la respuesta (con los tokens) va a un archivo, no a la pantalla
umask 077
curl -sS -X POST <MCP_BASE_URL>/oauth/token \
  -d grant_type=authorization_code -d client_id=<CLIENT_ID> -d code=<CODE> \
  -d redirect_uri=http://localhost:9999/callback -d code_verifier="$VERIFIER" > /tmp/humo.json
read -r REFRESH_TOKEN < <(jq -r .refresh_token /tmp/humo.json)
```

**5. Renovar sin `Authorization`** (el token va por stdin para que no aparezca en la lista de procesos, y la respuesta a un archivo para no mostrarla):

```bash
REFRESH_TOKEN_VIEJO=$REFRESH_TOKEN
printf 'grant_type=refresh_token&client_id=<CLIENT_ID>&refresh_token=%s' "$REFRESH_TOKEN" \
  | curl -sS -o /tmp/humo2.json -w '%{http_code}\n' -X POST <MCP_BASE_URL>/oauth/token --data @-
jq --rawfile viejo <(printf %s "$REFRESH_TOKEN_VIEJO") \
  '{token_type, expires_in, rotado: (.refresh_token != $viejo), access_token_presente: (.access_token != null)}' /tmp/humo2.json
read -r REFRESH_TOKEN < <(jq -r .refresh_token /tmp/humo2.json)   # desde aquí, el token vigente es el nuevo
```

Debe imprimir `200` y un resumen con `expires_in` ≈ 7200, `rotado: true` y `access_token_presente: true`: el par nuevo llegó y el `refresh_token` es distinto del enviado. `$REFRESH_TOKEN_VIEJO` se conserva para el paso 7.

**6. Comprobar la IP (`TRUST_PROXY_HOPS`).** Renueva otra vez, ahora con el token **nuevo** del paso anterior y falsificando `X-Forwarded-For`. Hazlo antes del paso 7: el reuso revoca la sesión y ya no se podría renovar.

```bash
printf 'grant_type=refresh_token&client_id=<CLIENT_ID>&refresh_token=%s' "$REFRESH_TOKEN" \
  | curl -sS -o /tmp/humo3.json -w '%{http_code}\n' -H 'X-Forwarded-For: 1.2.3.4' -X POST <MCP_BASE_URL>/oauth/token --data @-
read -r REFRESH_TOKEN < <(jq -r .refresh_token /tmp/humo3.json)
```

Debe imprimir `200`. En `mcp_events` (ver el paso 8), los eventos `token_refresh` de los pasos 5 y 6 deben mostrar tu IP pública en `ip_address`, y **ninguno** `1.2.3.4`. Cómo interpretar otros valores: ver «Elegir `TRUST_PROXY_HOPS`».

**7. Reuso del token viejo.** Espera más de 60 s y presenta el token **viejo** del paso 5 (ya fue usado):

```bash
sleep 70
printf 'grant_type=refresh_token&client_id=<CLIENT_ID>&refresh_token=%s' "$REFRESH_TOKEN_VIEJO" \
  | curl -sS -X POST <MCP_BASE_URL>/oauth/token --data @-
```

Debe devolver `400 {"error":"invalid_grant", ...}`, y a partir de ahí **también el token vigente deja de servir**: la API revocó la sesión por reuso. Si la respuesta es `503 temporarily_unavailable`, no es necesariamente que falten los endpoints: la API pudo responder 429, un 5xx o no contestar. Se distinguen en el log del MCP: un 404 de la API deja el `console.error` fijo `oauth refresh: la API respondió 404 en el endpoint de renovación…` (API sin desplegar o `GOC_API_URL` mal configurada); los demás casos dejan `oauth refresh unavailable status=<código>` (`n/a` si hubo timeout o error de red). Si es el 404, revisa el orden de despliegue.

**8. Dónde ver los eventos.** En la tabla `mcp_events` de la base de la API:

```sql
SELECT event_type, user_id, client_id, ip_address, created_at, metadata
FROM v2.mcp_events
WHERE event_type IN ('token_refresh', 'token_refresh_failed', 'token_revoked')
  AND client_id = '<CLIENT_ID>'
ORDER BY created_at DESC LIMIT 20;
```

Esperado: dos `token_refresh` (pasos 5 y 6) y, tras el paso 7, un `token_refresh_failed` con `metadata.reason = 'reuse'` (no un `token_refresh`). `token_revoked` aparece al «Desconectar». Los eventos no llevan tokens.

**9. Limpieza.** Borra los archivos con tokens y las variables:

```bash
rm -f /tmp/humo.json /tmp/humo2.json /tmp/humo3.json
unset REFRESH_TOKEN REFRESH_TOKEN_VIEJO VERIFIER CHALLENGE
```

## Configuración en Claude Code

```json
{
  "mcpServers": {
    "goc": {
      "type": "http",
      "url": "https://mcp.goc.com/mcp"
    }
  }
}
```

Al primer uso, Claude Code detecta OAuth y abre el browser automáticamente.

## Tests

```bash
npm run build                                              # tsc
env -u GOC_API_URL -u MCP_BASE_URL -u TRUST_PROXY_HOPS npm test    # node:test + tsx
```

Los tests no usan red, ni puerto, ni el `.env`; por eso conviene ejecutarlos con las tres variables sin definir. Cubren:

- PKCE (vector del RFC 7636), política y coincidencia de `redirect_uri`, y el store de códigos (un solo uso, TTL).
- Authorize, login-action y canje: validación de cliente, URI y PKCE antes de llamar al login; POST directo con URI ajena; falla cerrado cuando la API de clientes no responde.
- Renovación, revocación y alta de sesión contra una API simulada: qué se clasifica como `invalid_grant` y qué como `temporarily_unavailable`, que no se reenvía `Authorization` y que ningún token sale en logs ni respuestas.
- Página de login (host primero, nombre saneado, errores por código, cabeceras), limitadores, `TRUST_PROXY_HOPS`, errores de los parsers y rutas con otras mayúsculas o barra final.
- El cliente HTTP real contra un adaptador falso de axios (timeouts, URL de consulta de clientes).

**No cubren**: clientes reales (Claude Code, claude.ai: qué mandan exactamente) ni el contrato HTTP contra la API real: eso se comprueba con la prueba de humo y con un login real tras desplegar. Tampoco hay lint ni CI.

## Estructura del proyecto

```
goc_mcp/
├── src/
│   ├── index.ts            # Entry point: carga dotenv, crea la app y escucha
│   ├── app.ts              # createApp(): Express, rutas OAuth, /health y /mcp
│   ├── api-client.ts       # Cliente HTTP hacia goc_api (con el JWT del usuario)
│   ├── mcp-server.ts       # Factory del MCP server con las herramientas registradas
│   ├── tracker.ts          # Eventos y llamadas de herramientas hacia la API
│   ├── tool-wrapper.ts     # Medición y registro de cada herramienta
│   ├── tracking-context.ts # IP, user agent e id de la petición MCP
│   ├── oauth/              # Servidor OAuth 2.0 (ver oauth/README.md)
│   │   ├── routes.ts, goc-auth-api.ts, deps.ts, client-registry.ts
│   │   ├── redirect-uri.ts, pkce.ts, store.ts, rate-limit.ts, trust-proxy.ts
│   │   └── login-page.ts, error-page.ts, error-handler.ts, responses.ts, jwt.ts
│   └── tools/              # Herramientas MCP por dominio
│       ├── employees.ts
│       ├── attendance.ts
│       ├── orders.ts
│       ├── projects.ts
│       └── permissions.ts
├── test/                   # Tests (node:test)
├── .env.example
├── package.json
└── tsconfig.json
```

## Endpoints del servidor

| Endpoint | Método | Descripción |
|---|---|---|
| `/health` | GET | Health check |
| `/.well-known/oauth-authorization-server` | GET | Metadata OAuth (descubrimiento automático) |
| `/.well-known/oauth-protected-resource` | GET | Metadata del recurso protegido (RFC 9728) |
| `/oauth/register` | POST | Registro de clientes (solo alta) |
| `/oauth/authorize` | GET | Página de login (PKCE S256 obligatorio) |
| `/oauth/login-action` | POST | Envío del formulario de login |
| `/oauth/token` | POST | Canje de código y renovación con refresh token |
| `/oauth/revoke` | POST | Revocación de la sesión (RFC 7009) |
| `/mcp` | POST | Endpoint principal MCP (requiere Bearer JWT de un administrador activo) |
