import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_REVIT_VERSION = "2022";

export function buildRevitPluginDiagnostics(options = {}) {
    const revitVersion = String(options.revitVersion || process.env.REVIT_MCP_REVIT_VERSION || DEFAULT_REVIT_VERSION);
    const pluginRoot = options.pluginRoot || process.env.REVIT_MCP_PLUGIN_ROOT || defaultPluginRoot(revitVersion);
    const commandsRoot = path.join(pluginRoot, "Commands");
    const diagnostics = {
        ok: false,
        revitVersion,
        pluginRoot,
        commandsRoot,
        commandRegistry: inspectCommandRegistry(commandsRoot, revitVersion),
        commandManifests: inspectCommandManifests(commandsRoot),
        latestLog: inspectLatestPluginLog(pluginRoot),
        warnings: [],
        errors: [],
    };

    diagnostics.errors.push(...diagnostics.commandRegistry.errors);
    diagnostics.warnings.push(...diagnostics.commandRegistry.warnings);
    diagnostics.errors.push(...diagnostics.commandManifests.errors);
    diagnostics.warnings.push(...diagnostics.commandManifests.warnings);
    diagnostics.warnings.push(...diagnostics.latestLog.warnings);

    diagnostics.ok = diagnostics.errors.length === 0;
    return diagnostics;
}

export function defaultPluginRoot(revitVersion = DEFAULT_REVIT_VERSION) {
    const appData = process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming");
    return path.join(appData, "Autodesk", "Revit", "Addins", String(revitVersion), "revit_mcp_plugin");
}

function inspectCommandRegistry(commandsRoot, revitVersion) {
    const registryPath = path.join(commandsRoot, "commandRegistry.json");
    const result = {
        path: registryPath,
        exists: fs.existsSync(registryPath),
        commandCount: 0,
        commands: [],
        warnings: [],
        errors: [],
    };

    if (!result.exists) {
        result.errors.push(`commandRegistry.json not found: ${registryPath}`);
        return result;
    }

    let registry;
    try {
        registry = JSON.parse(stripBom(fs.readFileSync(registryPath, "utf8")));
    }
    catch (error) {
        result.errors.push(`commandRegistry.json could not be parsed: ${messageOf(error)}`);
        return result;
    }

    const commands = Array.isArray(registry.Commands) ? registry.Commands : [];
    result.commandCount = commands.length;
    if (commands.length === 0) {
        result.errors.push("commandRegistry.json has no Commands entries.");
    }

    for (const command of commands) {
        const item = inspectRegistryCommand(commandsRoot, revitVersion, command);
        result.commands.push(item);
        result.errors.push(...item.errors);
        result.warnings.push(...item.warnings);
    }

    return result;
}

function inspectRegistryCommand(commandsRoot, revitVersion, command = {}) {
    const commandName = String(command.commandName || "");
    const assemblyPath = String(command.assemblyPath || "");
    const expandedAssemblyPath = assemblyPath.replace(/\{VERSION\}/g, revitVersion);
    const absoluteAssemblyPath = path.isAbsolute(expandedAssemblyPath)
        ? expandedAssemblyPath
        : path.join(commandsRoot, expandedAssemblyPath);
    const item = {
        commandName,
        enabled: command.enabled !== false,
        assemblyPath,
        expandedAssemblyPath,
        absoluteAssemblyPath,
        assemblyExists: fs.existsSync(absoluteAssemblyPath),
        warnings: [],
        errors: [],
    };

    if (!commandName) {
        item.errors.push("Registry command entry is missing commandName.");
    }
    if (!assemblyPath) {
        item.errors.push(`${commandName || "(unnamed)"} is missing assemblyPath.`);
    }
    if (hasRepeatedRelativeSeparator(expandedAssemblyPath)) {
        item.errors.push(`${commandName} assemblyPath contains repeated path separators: ${assemblyPath}`);
    }
    if (hasSampleText(commandName, assemblyPath, command.description, command.developer?.name, command.developer?.organization)) {
        item.errors.push(`${commandName} contains sample naming/text; production package should not expose sample command sets.`);
    }
    if (!item.assemblyExists) {
        item.errors.push(`${commandName} assembly does not exist: ${absoluteAssemblyPath}`);
    }
    const expectedAssembly = expectedAssemblyForCommand(commandName);
    if (expectedAssembly && path.basename(absoluteAssemblyPath) !== expectedAssembly) {
        item.errors.push(`${commandName} must resolve to ${expectedAssembly}.`);
    }

    return item;
}

function expectedAssemblyForCommand(commandName) {
    if (commandName === "execute_write_plan") {
        return "RevitMCPWritePlanCommandSet.dll";
    }
    if (commandName === "normalize_pipe_header_overlap") {
        return "RevitMCPPipeHeaderNormalizeCommandSet.dll";
    }
    return commandName ? "RevitMCPCommandSet.dll" : "";
}

function inspectCommandManifests(commandsRoot) {
    const result = {
        root: commandsRoot,
        manifestCount: 0,
        manifests: [],
        warnings: [],
        errors: [],
    };

    if (!fs.existsSync(commandsRoot)) {
        result.errors.push(`Commands directory not found: ${commandsRoot}`);
        return result;
    }

    const manifests = findCommandJsonFiles(commandsRoot);
    result.manifestCount = manifests.length;
    if (manifests.length === 0) {
        result.errors.push(`No command.json manifests found under ${commandsRoot}`);
    }

    for (const manifestPath of manifests) {
        const item = inspectCommandManifest(manifestPath);
        result.manifests.push(item);
        result.errors.push(...item.errors);
        result.warnings.push(...item.warnings);
    }

    return result;
}

function inspectCommandManifest(manifestPath) {
    const manifestDir = path.dirname(manifestPath);
    const item = {
        path: manifestPath,
        commandCount: 0,
        commands: [],
        warnings: [],
        errors: [],
    };

    let manifest;
    try {
        manifest = JSON.parse(stripBom(fs.readFileSync(manifestPath, "utf8")));
    }
    catch (error) {
        item.errors.push(`command.json could not be parsed: ${manifestPath}: ${messageOf(error)}`);
        return item;
    }

    if (hasSampleText(manifest.name, manifest.description, manifest.developer?.name, manifest.developer?.organization)) {
        item.errors.push(`Manifest contains sample naming/text: ${manifestPath}`);
    }

    const commands = Array.isArray(manifest.commands) ? manifest.commands : [];
    item.commandCount = commands.length;
    if (commands.length === 0) {
        item.errors.push(`Manifest has no commands: ${manifestPath}`);
    }

    for (const command of commands) {
        const commandName = String(command.commandName || "");
        const assemblyPath = String(command.assemblyPath || "");
        const absoluteAssemblyPath = path.isAbsolute(assemblyPath)
            ? assemblyPath
            : path.join(manifestDir, assemblyPath);
        const commandItem = {
            commandName,
            assemblyPath,
            absoluteAssemblyPath,
            assemblyExists: fs.existsSync(absoluteAssemblyPath),
        };
        item.commands.push(commandItem);
        if (!commandName) item.errors.push(`Manifest command is missing commandName: ${manifestPath}`);
        if (hasSampleText(commandName, assemblyPath, command.description)) {
            item.errors.push(`Manifest command contains sample naming/text: ${manifestPath}: ${commandName}`);
        }
        if (!commandItem.assemblyExists) {
            item.errors.push(`Manifest command assembly does not exist: ${manifestPath}: ${absoluteAssemblyPath}`);
        }
    }

    return item;
}

function inspectLatestPluginLog(pluginRoot) {
    const logsRoot = path.join(pluginRoot, "Logs");
    const result = {
        logsRoot,
        latestLogPath: null,
        hasMisleadingCreateInstanceMessage: false,
        warnings: [],
    };

    let files = [];
    try {
        files = fs.readdirSync(logsRoot)
            .filter((file) => /^mcp_.*\.log$/i.test(file))
            .map((file) => path.join(logsRoot, file))
            .filter((file) => fs.statSync(file).isFile())
            .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
    }
    catch {
        return result;
    }

    const latest = files[0];
    if (!latest) {
        return result;
    }

    result.latestLogPath = latest;
    const text = tailText(latest, 64 * 1024);
    result.hasMisleadingCreateInstanceMessage = text.includes("Failed to create command instance");
    if (result.hasMisleadingCreateInstanceMessage) {
        result.warnings.push("Current upstream add-in log contains 'Failed to create command instance' lines that may be emitted after successful registration; confirm with a real command call before treating them as load failure.");
    }
    return result;
}

function findCommandJsonFiles(root) {
    const result = [];
    const stack = [root];
    while (stack.length > 0) {
        const dir = stack.pop();
        let entries = [];
        try {
            entries = fs.readdirSync(dir, { withFileTypes: true });
        }
        catch {
            continue;
        }
        for (const entry of entries) {
            const fullPath = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                stack.push(fullPath);
            }
            else if (entry.isFile() && entry.name === "command.json") {
                result.push(fullPath);
            }
        }
    }
    return result.sort();
}

function hasRepeatedRelativeSeparator(value) {
    const text = String(value || "").replace(/\\/g, "/");
    if (!text || text.startsWith("//")) {
        return false;
    }
    return text.includes("//");
}

function hasSampleText(...values) {
    return values.some((value) => /sample/i.test(String(value || "")));
}

function stripBom(text) {
    return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

function tailText(filePath, maxBytes) {
    try {
        const stat = fs.statSync(filePath);
        const bytesToRead = Math.min(stat.size, maxBytes);
        const buffer = Buffer.alloc(bytesToRead);
        const fd = fs.openSync(filePath, "r");
        try {
            fs.readSync(fd, buffer, 0, bytesToRead, Math.max(0, stat.size - bytesToRead));
            return buffer.toString("utf8");
        }
        finally {
            fs.closeSync(fd);
        }
    }
    catch {
        return "";
    }
}

function messageOf(error) {
    return error instanceof Error ? error.message : String(error);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
    console.log(JSON.stringify(buildRevitPluginDiagnostics(), null, 2));
}
