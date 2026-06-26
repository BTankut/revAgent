import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerTools } from "./tools/register.js";
import { recordRuntimeSessionStart } from "./utils/telemetry.js";

const server = new McpServer({
    name: "revAgent",
    version: "1.0.0",
});

async function main() {
    await registerTools(server);
    const transport = new StdioServerTransport();
    await server.connect(transport);
    recordRuntimeSessionStart();
    console.error("revAgent runtime start success");
}
main().catch((error) => {
    console.error("Error starting revAgent runtime:", error);
    process.exit(1);
});
