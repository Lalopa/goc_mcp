import "dotenv/config";
import { createApp } from "./app.js";

const app = createApp();

const PORT = process.env.PORT ?? 3002;
app.listen(PORT, () => {
  console.log(`GOC MCP server running on port ${PORT}`);
});
