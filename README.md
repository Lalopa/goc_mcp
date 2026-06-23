# GOC MCP Server

Servidor [MCP (Model Context Protocol)](https://modelcontextprotocol.io) para el sistema GOC — plataforma de gestión de construcción. Permite a Claude y otros agentes de IA consultar datos de GOC en tiempo real mediante lenguaje natural.

## ¿Qué es esto?

Este servidor expone 14 herramientas de solo lectura que Claude puede usar para responder preguntas como:

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
**Acceso:** Solo lectura (únicamente endpoints GET de goc_api)

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

### Pedidos
| Herramienta | Descripción |
|---|---|
| `order_detail` | Detalle completo de un pedido por ID |
| `orders_list` | Listar pedidos con filtros (obra, estatus) |
| `kanban_cards` | Vista kanban de pedidos agrupados por estatus y proveedor |

### Obras
| Herramienta | Descripción |
|---|---|
| `project_list` | Listar todas las obras disponibles |
| `project_detail` | Información detallada de una obra |
| `project_employees` | Empleados asignados a una obra |

## Flujo de autenticación

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
- Cuenta GOC válida para autenticarse

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
