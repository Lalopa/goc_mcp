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
**Autenticación:** OAuth 2.0 Authorization Code Flow  
**Modo:** Stateless — cada request es independiente  
**Acceso:** Exclusivo para administradores activos. Consultas y edición de permisos mediante la API GOC.

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

### Despliegue y base de datos

Desplegar primero el backend y después el MCP. Esta funcionalidad reutiliza las tablas existentes y no necesita migraciones ni registros iniciales. No se realizan cambios manuales en producción. Cualquier cambio futuro de esquema o datos iniciales debe versionarse mediante migraciones y ejecutarse por el pipeline al hacer merge a `main`. Las asignaciones solicitadas por administradores son operaciones funcionales de la API, no migraciones por cada edición.

## Flujo de autenticación

El backend verifica firma y expiración del JWT y consulta el rol y estado **actuales** del usuario. El MCP comprueba acceso administrativo al iniciar sesión, intercambiar códigos, renovar tokens y en cada petición a `/mcp`, antes de exponer herramientas. Las herramientas de permisos y sus endpoints también exigen esta validación. Un cambio de rol o desactivación impide las peticiones posteriores aunque el JWT no haya vencido.

El servidor implementa OAuth 2.0 Authorization Code Flow. Los clientes MCP compatibles (Claude Code, Claude.ai) abren el browser automáticamente al primer uso.

```
1. Usuario agrega el MCP con solo la URL
2. Claude Code abre el browser → página de login GOC
3. Usuario inicia sesión con sus credenciales GOC
4. El MCP genera un auth_code temporal (TTL 5 min)
5. Claude Code lo intercambia por el JWT de GOC
6. El JWT se envía como Bearer en cada llamada futura
```

## Requisitos

- Node.js 20+
- `goc_api` corriendo y accesible
- Cuenta GOC activa con rol Administrador
- Backend con `/permissions/admin-access`, `POST /permissions/query` y `PATCH /permissions/manage` desplegados

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
GOC_API_URL=https://api.goc.com/api/v2   # URL del backend GOC
MCP_BASE_URL=https://mcp.goc.com         # URL pública de este servidor
PORT=3002
```

Ver [.env.example](.env.example) para referencia.

## Desarrollo local

```bash
npm run dev      # tsx watch — recarga automática
```

El servidor queda en `http://localhost:3002`.

Para probar el flujo OAuth localmente:
1. Abrir en browser: `http://localhost:3002/oauth/authorize?redirect_uri=http://localhost:9999/callback&state=test`
2. Iniciar sesión con credenciales GOC
3. Capturar el `code` de la URL de callback
4. Intercambiar: `POST /oauth/token` con `grant_type=authorization_code`

## Producción (EC2 + pm2 + nginx)

```bash
npm run build                                    # Compila TypeScript → dist/
pm2 start dist/index.js --name goc-mcp          # Registrar en pm2
pm2 save                                         # Persistir en reinicios
```

Ver [docs de despliegue](#despliegue) para la configuración completa de nginx.

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

## Estructura del proyecto

```
goc_mcp/
├── src/
│   ├── index.ts          # Entry point — Express + rutas MCP
│   ├── api-client.ts     # Cliente HTTP hacia goc_api
│   ├── mcp-server.ts     # Factory del MCP server con tools registradas
│   ├── oauth/            # Implementación OAuth 2.0
│   │   ├── routes.ts     # Endpoints OAuth
│   │   ├── store.ts      # Store en memoria de auth codes
│   │   └── login-page.ts # Página HTML de login
│   └── tools/            # Herramientas MCP por dominio
│       ├── employees.ts
│       ├── attendance.ts
│       ├── orders.ts
│       └── projects.ts
├── .env.example
├── package.json
└── tsconfig.json
```

## Endpoints del servidor

| Endpoint | Método | Descripción |
|---|---|---|
| `/health` | GET | Health check |
| `/.well-known/oauth-authorization-server` | GET | Metadata OAuth (descubrimiento automático) |
| `/oauth/authorize` | GET | Página de login |
| `/oauth/token` | POST | Intercambio code → JWT |
| `/mcp` | POST | Endpoint principal MCP (requiere Bearer JWT) |
