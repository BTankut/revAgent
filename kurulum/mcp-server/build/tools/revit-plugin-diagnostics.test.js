import assert from "node:assert/strict";
import path from "node:path";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildRevitPluginDiagnostics } from "./revit_plugin_diagnostics.js";

const toolsDir = dirname(fileURLToPath(import.meta.url));
const pluginRoot = join(toolsDir, "..", "..", "..", "revit-plugin", "revit_mcp_plugin");
const diagnostics = buildRevitPluginDiagnostics({ pluginRoot, revitVersion: "2022" });

assert.equal(diagnostics.ok, true, JSON.stringify({
    errors: diagnostics.errors,
    warnings: diagnostics.warnings,
}, null, 2));
assert.equal(diagnostics.commandRegistry.commandCount, 5);

const registryCommands = diagnostics.commandRegistry.commands.map((command) => [
    command.commandName,
    path.basename(command.absoluteAssemblyPath),
]);

assert.deepEqual(registryCommands, [
    ["get_current_view_elements", "RevitMCPCommandSet.dll"],
    ["get_current_view_info", "RevitMCPCommandSet.dll"],
    ["get_selected_elements", "RevitMCPCommandSet.dll"],
    ["send_code_to_revit", "RevitMCPCommandSet.dll"],
    ["execute_write_plan", "RevitMCPWritePlanCommandSet.dll"],
]);

console.log("revit plugin diagnostics tests passed");
