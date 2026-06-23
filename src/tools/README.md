# src/tools/

Herramientas MCP organizadas por dominio de negocio. Cada archivo registra un conjunto de herramientas en el `McpServer` usando la API `server.registerTool()`.

## Patrón común

Todas las herramientas siguen el mismo patrón:

```typescript
server.registerTool(
  "nombre_herramienta",
  {
    description: "Descripción que Claude usa para saber cuándo invocar esta herramienta",
    inputSchema: {
      param: z.string().describe("Descripción del parámetro"),
      optional_param: z.number().optional().describe("Parámetro opcional"),
    },
  },
  async (params) => {
    const data = await client.get("/endpoint/de/goc_api", params);
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  }
);
```

El `inputSchema` usa sintaxis de raw shape (objeto con valores Zod), no `z.object()`. Claude recibe el resultado como texto JSON que luego interpreta y presenta en lenguaje natural.

## Para agregar una nueva herramienta

1. Identificar el endpoint GET correspondiente en `goc_api`
2. Agregar `server.registerTool(...)` en el archivo del dominio correspondiente
3. Si es un dominio nuevo, crear `src/tools/nuevo-dominio.ts` e importarlo en `src/mcp-server.ts`

---

## `employees.ts` — Herramientas de empleados

Conecta con los endpoints `/employees` de `goc_api`.

### `employee_search`

Búsqueda de empleados por nombre o apellido.

- **Endpoint:** `GET /employees/search?q=<query>`
- **Parámetros:** `query: string` (requerido)
- **Uso típico:** "Busca al empleado Juan García", "¿Existe un empleado llamado Martínez?"

### `employee_detail`

Información completa de un empleado individual.

- **Endpoint:** `GET /employees/:id`
- **Parámetros:** `id: string` (requerido)
- **Retorna:** datos personales (nombre, CURP, RFC, dirección, fecha de nacimiento), categoría laboral, estatus de empleo, proyecto asignado, URL de foto e INE
- **Uso típico:** "Dame la información completa del empleado 123"

### `employee_list`

Listado paginado de empleados con filtros opcionales.

- **Endpoint:** `GET /employees`
- **Parámetros opcionales:**
  - `project_id` — filtrar por ID de obra
  - `employment_status` — filtrar por estatus (ACTIVE, INACTIVE, etc.)
  - `page` — número de página
  - `limit` — resultados por página
- **Uso típico:** "¿Cuántos empleados activos hay en la obra 15?", "Lista los empleados inactivos"

---

## `attendance.ts` — Herramientas de asistencia

Conecta con los endpoints `/face-recognition/attendance` y `/face-recognition/stats` de `goc_api`.

### `attendance_history`

Historial de registros de entrada/salida con filtros flexibles.

- **Endpoint:** `GET /face-recognition/attendance/history`
- **Parámetros opcionales:**
  - `employee_id` — filtrar por empleado
  - `project_id` — filtrar por obra
  - `from` — fecha inicio (YYYY-MM-DD)
  - `to` — fecha fin (YYYY-MM-DD)
  - `page`, `limit` — paginación
- **Uso típico:** "¿Cuántas veces asistió el empleado 50 en enero?", "Muestra las asistencias de la obra 12 esta semana"

### `attendance_detail`

Detalle completo de un registro de asistencia específico.

- **Endpoint:** `GET /face-recognition/attendance/history/:id`
- **Parámetros:** `id: string` (requerido)
- **Retorna:** empleado, fecha, hora de entrada (`firstEntryAt`), hora de salida (`lastExitAt`), método (`FACE` / `QR` / `MANUAL`), imágenes de reconocimiento facial
- **Uso típico:** "Dame el detalle de la asistencia 890 — ¿cómo se registró y a qué hora?"

### `attendance_summary`

Vista resumida de asistencias agrupadas por proyecto y día.

- **Endpoint:** `GET /face-recognition/attendance/summary`
- **Parámetros opcionales:** `date` (YYYY-MM-DD, por defecto hoy), `project_id`
- **Uso típico:** "¿Cuántos empleados asistieron hoy a cada obra?", "Resumen de asistencia del 15 de enero"

### `attendance_today`

Snapshot en tiempo real de todas las asistencias del día actual.

- **Endpoint:** `GET /face-recognition/attendance/today`
- **Sin parámetros**
- **Uso típico:** "¿Quién ha entrado hoy?", "¿Hay alguien que ya salió y volvió a entrar hoy?"

### `attendance_stats`

Estadísticas generales y métricas agregadas de asistencia.

- **Endpoint:** `GET /face-recognition/stats`
- **Sin parámetros**
- **Uso típico:** "Dame un resumen estadístico de asistencias", "¿Cuál es el promedio de asistencia diaria?"

---

## `orders.ts` — Herramientas de pedidos

Conecta con los endpoints `/orders` y `/kanban` de `goc_api`.

### `order_detail`

Detalle completo de un pedido de materiales.

- **Endpoint:** `GET /orders/:id`
- **Parámetros:** `id: string` (requerido)
- **Retorna:** materiales solicitados (nombre, cantidad, unidad), estatus de cada material, proveedor asignado, obra destino, comentarios, imágenes de entrega, historial de cambios
- **Uso típico:** "¿Cómo va el pedido 450?", "¿Ya llegaron los materiales del pedido 33?"

### `orders_list`

Listado de pedidos con filtros por obra y estatus.

- **Endpoint:** `GET /orders`
- **Parámetros opcionales:**
  - `project_id` — filtrar por ID de obra
  - `status` — filtrar por estatus (`draft`, `pending`, `paid`, `delivered`, etc.)
- **Uso típico:** "¿Tenemos pedidos pendientes de pago?", "¿Qué pedidos hay para la obra 5?"

### `kanban_cards`

Vista kanban de materiales agrupados por estatus y flujo de entrega.

- **Endpoint:** `GET /kanban/cards`
- **Parámetros opcionales:** `project_id`, `provider_id`
- **Retorna:** tarjetas agrupadas por columna del kanban (borrador → solicitado → cotizado → disponible → pagado → en entrega → entregado)
- **Uso típico:** "Muéstrame el kanban de pedidos de la obra 8", "¿Qué materiales están en camino?"

---

## `projects.ts` — Herramientas de obras

Conecta con los endpoints `/projects` de `goc_api`.

### `project_list`

Catálogo completo de obras/proyectos.

- **Endpoint:** `GET /projects/all`
- **Sin parámetros**
- **Retorna:** lista con `id`, `title`, `color`, `isActive`, `business`, `user` (responsable), `EmployeeProjects`
- **Uso típico:** "¿Cuántas obras activas hay?", "Lista todas las obras"

### `project_detail`

Información detallada de una obra específica.

- **Endpoint:** `GET /projects/:projectId`
- **Parámetros:** `project_id: string` (requerido)
- **Retorna:** título, responsable, empresa, geofences (perímetros geográficos), estatus, fecha de creación
- **Uso típico:** "Dame los detalles de la obra 15", "¿Quién es el responsable de la obra 7?"

### `project_employees`

Empleados asignados a una obra y sus permisos.

- **Endpoint:** `GET /projects/:projectId/employees`
- **Parámetros:** `project_id: string` (requerido)
- **Retorna:** lista de empleados asignados con su nivel de acceso (lectura/edición) y datos básicos
- **Uso típico:** "¿Cuántos empleados están en la obra 15?", "¿Quiénes trabajan en Torre Norte?"
