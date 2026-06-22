import { spawn } from "child_process";
import { existsSync } from "fs";
import { mkdir, readFile, readdir, stat } from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";

interface IndexOptions {
    revitVersion?: string;
    rootPath?: string;
}

interface AssemblyPair {
    assemblyName: string;
    dllPath: string;
    xmlPath: string;
}

interface IndexConfig {
    revitVersion: string;
    rootPath: string;
    assemblyPairs: AssemblyPair[];
    cacheDir: string;
    cacheFile: string;
}

interface ApiSymbol {
    id: string;
    kind: string;
    name: string;
    fullName: string;
    assembly: string;
    namespace: string;
    summary?: string;
    signature?: string;
    declaringType?: string;
    [key: string]: any;
}

interface ApiType extends ApiSymbol {
    baseType?: string;
    interfaces?: string[];
    simpleName?: string;
}

interface ApiMember extends ApiSymbol {
    declaringType: string;
}

interface NamespaceEntry {
    name: string;
    types: ApiType[];
}

interface RawIndex {
    version: string;
    sourceRoot: string;
    schemaVersion?: number;
    types: ApiType[];
    members: ApiMember[];
    [key: string]: any;
}

interface HydratedIndex extends RawIndex {
    typeById: Map<string, ApiType>;
    typeByFullName: Map<string, ApiType>;
    typesByName: Map<string, ApiType[]>;
    membersById: Map<string, ApiMember>;
    membersByFullName: Map<string, ApiMember[]>;
    membersByName: Map<string, ApiMember[]>;
    membersByType: Map<string, ApiMember[]>;
    namespaces: Map<string, NamespaceEntry>;
    searchItems: ApiSymbol[];
}

interface MemberAlias {
    memberName: string;
    kind: string;
    parameterType: string | null;
    reason: string;
}

type MemberGroupKey = "constructors" | "methods" | "properties" | "fields" | "events";
type MemberGroups = Record<MemberGroupKey, ApiSymbol[]>;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function resolvePackageRoot(): string {
    const candidates = [
        path.resolve(__dirname, "..", ".."),
        path.resolve(__dirname, ".."),
    ];
    for (const candidate of candidates) {
        if (existsSync(path.join(candidate, "scripts", "build-index.ps1"))) {
            return candidate;
        }
    }
    return candidates[0];
}

const PACKAGE_ROOT = resolvePackageRoot();
const INDEX_SCRIPT = path.join(PACKAGE_ROOT, "scripts", "build-index.ps1");
const DEFAULT_REVIT_VERSION = "2022";
const INDEX_SCHEMA_VERSION = 2;
const INDEX_CACHE = new Map<string, HydratedIndex>();

function parseJson(text: string): RawIndex {
    return JSON.parse(String(text).replace(/^\uFEFF/, ""));
}

function normalize(text: unknown): string {
    return String(text || "").trim().toLowerCase();
}

function uniqueBy<T>(items: T[], keySelector: (item: T) => string): T[] {
    const seen = new Set<string>();
    return items.filter((item) => {
        const key = keySelector(item);
        if (seen.has(key)) {
            return false;
        }
        seen.add(key);
        return true;
    });
}

function defaultRevitRoot(version: string): string {
    return path.join("C:\\Program Files\\Autodesk", `Revit ${version}`);
}

function defaultCacheDir() {
    if (process.env.ProgramData) {
        return path.join(process.env.ProgramData, "DPE", "RevitMCP", "state", "revit-api-docs", "cache");
    }
    return path.join("C:\\ProgramData", "DPE", "RevitMCP", "state", "revit-api-docs", "cache");
}

async function discoverAssemblyPairs(rootPath: string): Promise<AssemblyPair[]> {
    const entries = await readdir(rootPath, { withFileTypes: true });
    return entries
        .filter((entry) => entry.isFile() && /^RevitAPI.*\.dll$/i.test(entry.name))
        .map((entry) => {
        const dllPath = path.join(rootPath, entry.name);
        const xmlPath = path.join(rootPath, `${path.parse(entry.name).name}.xml`);
        return {
            assemblyName: path.parse(entry.name).name,
            dllPath,
            xmlPath,
        };
    })
        .filter((pair) => existsSync(pair.xmlPath))
        .sort((left, right) => left.assemblyName.localeCompare(right.assemblyName));
}

async function getConfig(options: IndexOptions = {}) {
    const revitVersion = String(options.revitVersion || process.env.REVIT_API_DOCS_VERSION || DEFAULT_REVIT_VERSION);
    const rootPath = options.rootPath || process.env.REVIT_API_DOCS_ROOT || defaultRevitRoot(revitVersion);
    if (!existsSync(rootPath)) {
        throw new Error(`Revit API root not found: ${rootPath}`);
    }
    const assemblyPairs = await discoverAssemblyPairs(rootPath);
    if (assemblyPairs.length === 0) {
        throw new Error(`No RevitAPI*.dll + .xml pairs were found under ${rootPath}`);
    }
    const cacheDir = process.env.REVIT_API_DOCS_CACHE_DIR || defaultCacheDir();
    const cacheFile = path.join(cacheDir, `revit-api-docs-${revitVersion}.json`);
    return {
        revitVersion,
        rootPath,
        assemblyPairs,
        cacheDir,
        cacheFile,
    };
}

async function cacheIsStale(config: IndexConfig): Promise<boolean> {
    if (!existsSync(config.cacheFile)) {
        return true;
    }
    const cacheStats = await stat(config.cacheFile);
    for (const pair of config.assemblyPairs) {
        const dllStats = await stat(pair.dllPath);
        const xmlStats = await stat(pair.xmlPath);
        if (dllStats.mtimeMs > cacheStats.mtimeMs || xmlStats.mtimeMs > cacheStats.mtimeMs) {
            return true;
        }
    }
    return false;
}

async function runIndexBuilder(config: IndexConfig): Promise<void> {
    await mkdir(config.cacheDir, { recursive: true });
    await new Promise<void>((resolve, reject) => {
        const child = spawn("powershell", [
            "-ExecutionPolicy",
            "Bypass",
            "-File",
            INDEX_SCRIPT,
            "-RevitRoot",
            config.rootPath,
            "-Version",
            config.revitVersion,
            "-OutputPath",
            config.cacheFile,
        ], {
            windowsHide: true,
        });
        let stderr = "";
        let stdout = "";
        child.stdout.on("data", (chunk) => {
            stdout += chunk.toString();
        });
        child.stderr.on("data", (chunk) => {
            stderr += chunk.toString();
        });
        child.on("error", reject);
        child.on("close", (code) => {
            if (code === 0) {
                resolve();
                return;
            }
            reject(new Error(`Index build failed with exit code ${code}\nSTDOUT:\n${stdout}\nSTDERR:\n${stderr}`));
        });
    });
}

function toSummaryRecord(symbol: ApiSymbol): ApiSymbol {
    return {
        id: symbol.id,
        kind: symbol.kind || "type",
        name: symbol.name,
        fullName: symbol.fullName,
        assembly: symbol.assembly,
        namespace: symbol.namespace,
        summary: symbol.summary,
        signature: symbol.signature,
        declaringType: symbol.declaringType,
    };
}

function hydrateIndex(raw: RawIndex): HydratedIndex {
    const typeById = new Map<string, ApiType>();
    const typeByFullName = new Map<string, ApiType>();
    const typesByName = new Map<string, ApiType[]>();
    const membersById = new Map<string, ApiMember>();
    const membersByFullName = new Map<string, ApiMember[]>();
    const membersByName = new Map<string, ApiMember[]>();
    const membersByType = new Map<string, ApiMember[]>();
    const namespaces = new Map<string, NamespaceEntry>();
    const searchItems: ApiSymbol[] = [];

    for (const type of raw.types) {
        const hydratedType = {
            ...type,
            simpleName: type.name,
        };
        typeById.set(normalize(type.id), hydratedType);
        typeByFullName.set(normalize(type.fullName), hydratedType);
        const typeList = typesByName.get(normalize(type.name)) || [];
        typeList.push(hydratedType);
        typesByName.set(normalize(type.name), typeList);
        if (!namespaces.has(type.namespace)) {
            namespaces.set(type.namespace, { name: type.namespace, types: [] });
        }
        const namespaceEntry = namespaces.get(type.namespace);
        if (namespaceEntry) {
            namespaceEntry.types.push(hydratedType);
        }
        searchItems.push({
            id: type.id,
            kind: "type",
            name: type.name,
            fullName: type.fullName,
            assembly: type.assembly,
            namespace: type.namespace,
            summary: type.summary,
            searchText: [type.id, type.name, type.fullName, type.namespace, type.summary].join(" ").toLowerCase(),
        });
    }

    for (const member of raw.members) {
        const hydratedMember = {
            ...member,
            fullName: `${member.declaringType}.${member.name}`,
        };
        membersById.set(normalize(member.id), hydratedMember);
        const fullNameKey = normalize(hydratedMember.fullName);
        const sameFullName = membersByFullName.get(fullNameKey) || [];
        sameFullName.push(hydratedMember);
        membersByFullName.set(fullNameKey, sameFullName);
        const nameKey = normalize(hydratedMember.name);
        const sameName = membersByName.get(nameKey) || [];
        sameName.push(hydratedMember);
        membersByName.set(nameKey, sameName);
        const typeKey = normalize(hydratedMember.declaringType);
        const sameType = membersByType.get(typeKey) || [];
        sameType.push(hydratedMember);
        membersByType.set(typeKey, sameType);
        searchItems.push({
            id: member.id,
            kind: member.kind,
            name: member.name,
            fullName: hydratedMember.fullName,
            assembly: member.assembly,
            namespace: member.namespace,
            summary: member.summary,
            signature: member.signature,
            declaringType: member.declaringType,
            searchText: [member.id, member.name, hydratedMember.fullName, member.signature, member.summary, member.declaringType].join(" ").toLowerCase(),
        });
    }

    const namespaceItems = [...namespaces.values()].map((entry) => ({
        id: `N:${entry.name}`,
        kind: "namespace",
        name: entry.name.split(".").at(-1) ?? entry.name,
        fullName: entry.name,
        namespace: entry.name,
        assembly: uniqueBy(entry.types, (type) => type.assembly).map((type) => type.assembly).join(", "),
        summary: `Namespace with ${entry.types.length} public types.`,
        searchText: entry.name.toLowerCase(),
    }));

    return {
        ...raw,
        typeById,
        typeByFullName,
        typesByName,
        membersById,
        membersByFullName,
        membersByName,
        membersByType,
        namespaces,
        searchItems: [...searchItems, ...namespaceItems],
    };
}

async function loadIndex(options: IndexOptions = {}): Promise<HydratedIndex> {
    const config = await getConfig(options);
    const cacheKey = `${config.revitVersion}|${config.rootPath}`;
    const stale = await cacheIsStale(config);
    if (!stale && INDEX_CACHE.has(cacheKey)) {
        const cached = INDEX_CACHE.get(cacheKey);
        if (cached) {
            return cached;
        }
    }
    if (stale) {
        await runIndexBuilder(config);
    }
    const raw = parseJson(await readFile(config.cacheFile, "utf8"));
    if (raw.version !== config.revitVersion ||
        normalize(raw.sourceRoot) !== normalize(config.rootPath) ||
        Number(raw.schemaVersion || 0) !== INDEX_SCHEMA_VERSION) {
        await runIndexBuilder(config);
        const rebuilt = parseJson(await readFile(config.cacheFile, "utf8"));
        const hydrated = hydrateIndex(rebuilt);
        INDEX_CACHE.set(cacheKey, hydrated);
        return hydrated;
    }
    const hydrated = hydrateIndex(raw);
    INDEX_CACHE.set(cacheKey, hydrated);
    return hydrated;
}

function scoreMatch(item: ApiSymbol, query: string): number {
    const lowered = normalize(query);
    const name = normalize(item.name);
    const fullName = normalize(item.fullName);
    const signature = normalize(item.signature || "");
    const summary = normalize(item.summary || "");
    const qualifiedTail = lowered.includes(".") ? `.${lowered}` : "";
    if (normalize(item.id) === lowered) {
        return 1000;
    }
    if (fullName === lowered || signature === lowered) {
        return 900;
    }
    if (qualifiedTail && (fullName.includes(qualifiedTail) || signature.includes(qualifiedTail))) {
        return 850;
    }
    if (name === lowered) {
        return 800;
    }
    if (fullName.startsWith(lowered) || signature.startsWith(lowered)) {
        return 700;
    }
    if (name.startsWith(lowered)) {
        return 650;
    }
    if (fullName.includes(lowered) || signature.includes(lowered)) {
        return 500;
    }
    if (name.includes(lowered)) {
        return 450;
    }
    if (summary.includes(lowered)) {
        return 150;
    }
    let tokenScore = 0;
    for (const token of lowered.split(/\s+/).filter(Boolean)) {
        if (fullName.includes(token) || signature.includes(token)) {
            tokenScore += 50;
        }
        if (summary.includes(token)) {
            tokenScore += 10;
        }
    }
    return tokenScore;
}

function filterByAssembly<T extends ApiSymbol>(items: T[], assembly?: string): T[] {
    if (!assembly) {
        return items;
    }
    const assemblyFilter = normalize(assembly);
    return items.filter((item) => normalize(item.assembly).includes(assemblyFilter));
}

function filterByKind<T extends ApiSymbol>(items: T[], kind?: string): T[] {
    if (!kind) {
        return items;
    }
    return items.filter((item) => item.kind === kind);
}

function getMemberNameAliases(memberName: string, kind?: string): MemberAlias[] {
    const text = String(memberName || "").trim();
    if (!text) {
        return [];
    }

    const argsMatch = text.match(/\(([^)]*)\)\s*$/);
    const parameterType = resolveGetParameterArgumentType(argsMatch?.[1]);
    const withoutArgs = text.replace(/\s*\([^)]*\)\s*$/, "");
    const aliases: MemberAlias[] = [];
    if (/(^|\.)get_parameter$/i.test(withoutArgs)) {
        aliases.push({
            memberName: withoutArgs.replace(/get_parameter$/i, "Parameter"),
            kind: "property",
            parameterType,
            reason: "revit_xml_docs_parameter_indexer_property",
        });
    }
    if (/^get_parameter$/i.test(withoutArgs)) {
        aliases.push({
            memberName: "Parameter",
            kind: "property",
            parameterType,
            reason: "revit_xml_docs_parameter_indexer_property",
        });
    }

    return uniqueBy(aliases, (alias) => `${normalize(alias.memberName)}|${alias.kind || kind || ""}`);
}

function resolveGetParameterArgumentType(value: unknown): string | null {
    const text = normalize(value);
    if (!text) {
        return null;
    }
    if (text.includes("builtinparameter")) {
        return "Autodesk.Revit.DB.BuiltInParameter";
    }
    if (text.includes("definition")) {
        return "Autodesk.Revit.DB.Definition";
    }
    if (text.includes("guid")) {
        return "System.Guid";
    }
    return null;
}

function findTypeMatches(index: HydratedIndex, typeName: string): ApiType[] {
    const query = normalize(typeName);
    if (!query) {
        return [];
    }
    if (query.startsWith("t:")) {
        const exact = index.typeById.get(query);
        return exact ? [exact] : [];
    }
    const byFullName = index.typeByFullName.get(query);
    if (byFullName) {
        return [byFullName];
    }
    const bySimpleName = index.typesByName.get(query) || [];
    if (bySimpleName.length > 0) {
        return bySimpleName;
    }
    const fuzzy = index.types.filter((type) => normalize(type.fullName).includes(query) || normalize(type.name).includes(query));
    return fuzzy.slice(0, 20);
}

function findDirectMemberMatches(index: HydratedIndex, memberName: string, typeName?: string, kind?: string): ApiMember[] {
    const query = normalize(memberName);
    let matches: ApiMember[] = [];
    if (!query) {
        return matches;
    }
    if (/^[mpefc]:/i.test(memberName)) {
        const exact = index.membersById.get(query);
        matches = exact ? [exact] : [];
    }
    else {
        matches = [
            ...(index.membersByFullName.get(query) || []),
            ...(index.membersByName.get(query) || []),
        ];
        if (matches.length === 0 && query.includes(".")) {
            const lastDot = query.lastIndexOf(".");
            const declaringTypeTail = query.slice(0, lastDot);
            const memberTail = query.slice(lastDot + 1);
            const declaringTypeSuffix = `.${declaringTypeTail}`;
            matches = (index.membersByName.get(memberTail) || [])
                .filter((member) => {
                const declaringType = normalize(member.declaringType);
                return declaringType === declaringTypeTail || declaringType.endsWith(declaringTypeSuffix);
            });
        }
        if (matches.length === 0) {
            matches = index.members.filter((member) => normalize(member.fullName).includes(query) ||
                normalize(member.name).includes(query) ||
                normalize(member.signature).includes(query));
        }
    }
    if (typeName) {
        const types = findTypeMatches(index, typeName);
        const allowed = new Set(types.map((type) => normalize(type.fullName)));
        matches = matches.filter((member) => allowed.has(normalize(member.declaringType)));
    }
    if (kind) {
        matches = matches.filter((member) => member.kind === kind);
    }
    return uniqueBy(matches, (member) => member.id);
}

function findMemberMatches(index: HydratedIndex, memberName: string, typeName?: string, kind?: string) {
    const directMatches = findDirectMemberMatches(index, memberName, typeName, kind);
    if (directMatches.length > 0) {
        return {
            matches: directMatches,
            alias: null,
        };
    }

    for (const alias of getMemberNameAliases(memberName, kind)) {
        let aliasMatches = findDirectMemberMatches(index, alias.memberName, typeName, alias.kind || kind);
        if (alias.parameterType) {
            const parameterTypeNeedle = `(${normalize(alias.parameterType)})`;
            aliasMatches = aliasMatches.filter((member) => normalize(member.id).includes(parameterTypeNeedle));
        }
        if (aliasMatches.length > 0) {
            return {
                matches: aliasMatches,
                alias: {
                    requestedMemberName: memberName,
                    resolvedMemberName: alias.memberName,
                    requestedKind: kind || null,
                    resolvedKind: alias.kind || kind || null,
                    resolvedParameterType: alias.parameterType,
                    reason: alias.reason,
                },
            };
        }
    }

    return {
        matches: [],
        alias: null,
    };
}

function groupMembers(members: ApiMember[]): MemberGroups {
    const groups: MemberGroups = {
        constructors: [],
        methods: [],
        properties: [],
        fields: [],
        events: [],
    };
    for (const member of members) {
        const summaryRecord = toSummaryRecord(member);
        if (member.kind === "constructor") {
            groups.constructors.push(summaryRecord);
        }
        else if (member.kind === "method") {
            groups.methods.push(summaryRecord);
        }
        else if (member.kind === "property") {
            groups.properties.push(summaryRecord);
        }
        else if (member.kind === "field") {
            groups.fields.push(summaryRecord);
        }
        else if (member.kind === "event") {
            groups.events.push(summaryRecord);
        }
    }
    for (const key of Object.keys(groups) as MemberGroupKey[]) {
        groups[key].sort((left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id));
    }
    return groups;
}

function resolveUniqueType(index: HydratedIndex, typeName: string): { ambiguous: true; matches: ApiSymbol[] } | { ambiguous: false; type: ApiType } {
    const matches = findTypeMatches(index, typeName);
    if (matches.length === 0) {
        throw new Error(`No type matched '${typeName}'.`);
    }
    if (matches.length > 1) {
        return {
            ambiguous: true,
            matches: matches.slice(0, 20).map(toSummaryRecord),
        };
    }
    return {
        ambiguous: false,
        type: matches[0],
    };
}

export async function searchApi(options: IndexOptions & { query: string; limit?: number; kind?: string; assembly?: string }) {
    const limit = Math.max(1, Math.min(100, Number(options.limit || 20)));
    const index = await loadIndex({ revitVersion: options.revitVersion });
    const filtered = filterByAssembly(filterByKind(index.searchItems, options.kind), options.assembly);
    const ranked = filtered
        .map((item) => ({ item, score: scoreMatch(item, options.query) }))
        .filter((entry) => entry.score > 0)
        .sort((left, right) => right.score - left.score || left.item.fullName.localeCompare(right.item.fullName))
        .slice(0, limit)
        .map((entry) => entry.item);
    return {
        query: options.query,
        revitVersion: index.version,
        sourceRoot: index.sourceRoot,
        resultCount: ranked.length,
        results: ranked.map(toSummaryRecord),
    };
}

export async function getTypeDetails(options: IndexOptions & { typeName: string; includeInherited?: boolean }) {
    const index = await loadIndex({ revitVersion: options.revitVersion });
    const resolution = resolveUniqueType(index, options.typeName);
    if (resolution.ambiguous === true) {
        return {
            typeName: options.typeName,
            ambiguous: true,
            matches: resolution.matches,
        };
    }
    const type = resolution.type;
    const declaredMembers = index.membersByType.get(normalize(type.fullName)) || [];
    const inheritedMembers: Array<{ declaringType: string; members: MemberGroups }> = [];
    if (options.includeInherited) {
        let baseTypeName = type.baseType;
        while (baseTypeName) {
            const baseType = index.typeByFullName.get(normalize(baseTypeName));
            if (!baseType) {
                break;
            }
            inheritedMembers.push({
                declaringType: baseType.fullName,
                members: groupMembers(index.membersByType.get(normalize(baseType.fullName)) || []),
            });
            baseTypeName = baseType.baseType;
        }
    }
    return {
        type: toSummaryRecord(type),
        metadata: {
            assembly: type.assembly,
            namespace: type.namespace,
            baseType: type.baseType,
            interfaces: type.interfaces,
            isAbstract: type.isAbstract,
            isSealed: type.isSealed,
            isInterface: type.isInterface,
            isEnum: type.isEnum,
            isValueType: type.isValueType,
            summary: type.summary,
            remarks: type.remarks,
            since: type.since,
        },
        declaredMembers: groupMembers(declaredMembers),
        inheritedMembers,
    };
}

export async function getMemberDetails(options: IndexOptions & { memberName: string; typeName?: string; kind?: string }) {
    const index = await loadIndex({ revitVersion: options.revitVersion });
    const resolution = findMemberMatches(index, options.memberName, options.typeName, options.kind);
    const matches = resolution.matches;
    if (matches.length === 0) {
        throw new Error(`No member matched '${options.memberName}'.`);
    }
    if (matches.length > 1) {
        return {
            memberName: options.memberName,
            typeName: options.typeName || null,
            ambiguous: true,
            resolvedAlias: resolution.alias,
            matches: matches.slice(0, 25).map(toSummaryRecord),
        };
    }
    const member = matches[0];
    return {
        resolvedAlias: resolution.alias,
        member: {
            id: member.id,
            kind: member.kind,
            name: member.name,
            fullName: member.fullName,
            declaringType: member.declaringType,
            assembly: member.assembly,
            namespace: member.namespace,
            isStatic: member.isStatic,
            signature: member.signature,
            summary: member.summary,
            remarks: member.remarks,
            returns: member.returns,
            value: member.value,
            since: member.since,
            parameters: member.parameters,
            exceptions: member.exceptions,
        },
    };
}

export async function listNamespace(options: IndexOptions & { namespaceName: string; includeChildNamespaces?: boolean }) {
    const index = await loadIndex({ revitVersion: options.revitVersion });
    const exact = index.namespaces.get(options.namespaceName) ||
        [...index.namespaces.values()].find((entry) => normalize(entry.name) === normalize(options.namespaceName));
    if (!exact) {
        const fuzzyMatches = [...index.namespaces.keys()]
            .filter((name) => normalize(name).includes(normalize(options.namespaceName)))
            .slice(0, 20);
        if (fuzzyMatches.length === 0) {
            throw new Error(`Namespace not found: ${options.namespaceName}`);
        }
        return {
            namespace: options.namespaceName,
            ambiguous: true,
            matches: fuzzyMatches,
        };
    }
    const childNamespaces = options.includeChildNamespaces
        ? [...index.namespaces.keys()]
            .filter((name) => name.startsWith(`${exact.name}.`) && name !== exact.name)
            .map((name) => name.slice(exact.name.length + 1))
            .filter((name) => !name.includes("."))
            .sort()
        : [];
    return {
        namespace: exact.name,
        assemblyNames: uniqueBy(exact.types, (type) => type.assembly).map((type) => type.assembly).sort(),
        childNamespaces,
        typeCount: exact.types.length,
        types: exact.types
            .slice()
            .sort((left, right) => left.name.localeCompare(right.name))
            .map(toSummaryRecord),
    };
}
