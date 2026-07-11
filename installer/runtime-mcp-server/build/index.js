import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerTools } from "./tools/register.js";
import { recordRuntimeSessionStart } from "./utils/telemetry.js";
import { initializeSpatialStore } from "./spatial/spatialStoreManager.js";
import { runSpatialStoreCli } from "./spatial/spatialStoreCli.js";
async function main() {
    if (process.argv[2] === "spatial-store") {
        process.exitCode = runSpatialStoreCli(process.argv.slice(3));
        return;
    }
    const server = new McpServer({
        name: "revAgent",
        version: "1.0.0",
    });
    await registerTools(server);
    const spatialStore = initializeSpatialStore();
    const transport = new StdioServerTransport();
    await server.connect(transport);
    recordRuntimeSessionStart();
    console.error(`revAgent spatial store ${spatialStore.available ? "ready" : `guarded:${spatialStore.reason}`}`);
    console.error("revAgent runtime start success");
}
main().catch((error) => {
    console.error("Error starting revAgent runtime:", error);
    process.exit(1);
});
