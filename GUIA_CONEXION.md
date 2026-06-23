# Cómo conectar Claude al MCP de GOC

Con esta configuración podrás preguntarle a Claude cosas como:
- "¿Quién asistió hoy en la obra Polideportivo?"
- "¿Cómo va el pedido con ID 456?"
- "¿Cuántos empleados tiene la obra Torre Norte?"

---

## Requisitos

- Tener instalado **Claude Desktop** (Mac/Windows) o **Claude Code** (terminal/VS Code)
- Tener una cuenta activa en el sistema GOC

---

## Opción A — Claude Desktop (app de escritorio)

Claude Desktop no soporta servidores MCP remotos directamente, pero funciona con `mcp-remote`, un puente que se instala con Node.js.

### Requisito previo — Node.js

Verifica que lo tienes instalado:
```bash
node --version
```
Si no lo tienes, descárgalo en [nodejs.org](https://nodejs.org).

### Paso 1 — Editar la configuración

Abre el archivo de configuración según tu sistema:

- **Mac:** `~/Library/Application Support/Claude/claude_desktop_config.json`
- **Windows:** `%APPDATA%\Claude\claude_desktop_config.json`

Agrega el bloque `"goc"` dentro de `"mcpServers"`:

```json
{
  "mcpServers": {
    "goc": {
      "command": "npx",
      "args": [
        "mcp-remote",
        "https://mcp.gocconstructores.com/mcp"
      ]
    }
  }
}
```

> **Importante:** No uses `"type": "http"` — Claude Desktop no lo soporta. El wrapper `mcp-remote` hace el puente automáticamente.

### Paso 2 — Reiniciar Claude Desktop

Cierra y vuelve a abrir la app.

### Paso 3 — Iniciar sesión

La primera vez que uses el MCP, `mcp-remote` abrirá tu navegador automáticamente con el formulario de inicio de sesión de GOC. Ingresa tu **usuario** y **contraseña**.

> Si el navegador muestra un error de conexión después del login, es normal. Copia la URL completa de la barra del navegador, vuelve a Claude Desktop y pégala cuando te lo pida.

---

## Opción B — Claude Code (terminal o VS Code)

### Paso 1 — Agregar el MCP

Abre una terminal y ejecuta:

```bash
claude mcp add --transport http goc https://mcp.gocconstructores.com/mcp
```

> Si prefieres hacerlo manualmente, edita `~/.claude/claude.json` y agrega dentro de `"mcpServers"`:
> ```json
> "goc": {
>   "type": "http",
>   "url": "https://mcp.gocconstructores.com/mcp"
> }
> ```

### Paso 2 — Iniciar sesión

La primera vez que uses el MCP, Claude Code iniciará el flujo de autenticación automáticamente.

Si no lo hace, escribe en el chat de Claude:

```
/mcp
```

y selecciona **goc → Authenticate**.

Se abrirá tu navegador con el formulario de inicio de sesión de GOC. Ingresa tu **usuario** y **contraseña**.

> Si el navegador muestra un error de conexión después del login, copia la URL completa de la barra del navegador y pégala en el chat de Claude cuando te lo pida.

---

## Usar el MCP

Una vez autenticado en cualquiera de las dos opciones, simplemente habla con Claude en lenguaje natural:

| Pregunta | Lo que hace |
|---|---|
| "¿Quién asistió hoy en la obra X?" | Consulta asistencias del día |
| "Dame el detalle del empleado Juan García" | Busca y muestra info del empleado |
| "¿Cómo va el pedido 123?" | Muestra estatus y materiales del pedido |
| "¿Tenemos pedidos pendientes para la obra Y?" | Lista pedidos filtrados por obra |
| "¿Cuántos empleados tiene la obra Torre Norte?" | Lista empleados de esa obra |
| "Muéstrame las asistencias de esta semana" | Historial de asistencias con filtros |

---

## Herramientas disponibles

El MCP incluye **14 herramientas** de solo lectura:

**Empleados**
- `employee_search` — Buscar por nombre
- `employee_detail` — Info completa de un empleado
- `employee_list` — Listar con filtros

**Asistencias**
- `attendance_today` — Asistencias del día actual
- `attendance_history` — Historial con filtros (empleado, obra, fechas)
- `attendance_detail` — Detalle de un registro (quién, cuándo, cómo)
- `attendance_summary` — Resumen por obra y día
- `attendance_stats` — Estadísticas generales

**Pedidos**
- `order_detail` — Detalle completo de un pedido
- `orders_list` — Listar pedidos con filtros
- `kanban_cards` — Vista kanban de pedidos

**Obras**
- `project_list` — Listar todas las obras
- `project_detail` — Detalle de una obra
- `project_employees` — Empleados en una obra

---

## Notas

- El MCP es de **solo lectura** — no puede crear ni modificar datos
- Cada usuario se autentica con **su propia cuenta GOC** — los permisos del sistema aplican igual
- Si tu sesión expira, vuelve a autenticarte desde `/mcp` (Claude Code) o reiniciando la app (Claude Desktop)
