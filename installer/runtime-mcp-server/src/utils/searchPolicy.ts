type JsonObject = Record<string, any>;

export type SearchBudgetName = "fast" | "balanced" | "deep";
export type SearchRiskLevel = "unknown" | "low" | "medium" | "high";

export interface SearchBudgetPreset {
    name: SearchBudgetName;
    maxElementsScanned: number;
    maxElapsedMs: number;
    socketTimeoutMs: number;
}

export interface FindElementsSearchPolicy {
    originalQuery: string;
    effectiveQuery: string;
    inferredScope: JsonObject;
    effectiveCategoryNames: string[];
    riskPolicy: SearchRiskPolicy;
    linkScope: string;
    searchBudget: SearchBudgetName;
    maxElementsScanned: number;
    maxElapsedMs: number;
    timeoutMs: number;
    guarded: boolean;
    reason?: string;
    message?: string;
    warnings: string[];
    suggestedNextScopes: string[];
}

export interface SearchRiskPolicy {
    riskLevel: SearchRiskLevel;
    reasons: string[];
    recommendedFirstScope: string[];
    requiresUserControl: boolean;
}

const DEFAULT_BUDGET: SearchBudgetName = "fast";

const SEARCH_BUDGETS: Record<SearchBudgetName, SearchBudgetPreset> = {
    fast: {
        name: "fast",
        maxElementsScanned: 5000,
        maxElapsedMs: 4500,
        socketTimeoutMs: 12000,
    },
    balanced: {
        name: "balanced",
        maxElementsScanned: 25000,
        maxElapsedMs: 18000,
        socketTimeoutMs: 30000,
    },
    deep: {
        name: "deep",
        maxElementsScanned: 150000,
        maxElapsedMs: 90000,
        socketTimeoutMs: 120000,
    },
};

interface ConceptMapping {
    concept: string;
    terms: string[];
    categories: string[];
}

const CONCEPT_MAPPINGS: ConceptMapping[] = [
    {
        concept: "fan_coil",
        terms: ["fan coil", "fancoil", "fcu"],
        categories: ["Mechanical Equipment"],
    },
    {
        concept: "air_handling_unit",
        terms: ["ahu", "air handling unit", "klima santrali"],
        categories: ["Mechanical Equipment"],
    },
    {
        concept: "pump",
        terms: ["pump", "pompa"],
        categories: ["Mechanical Equipment"],
    },
    {
        concept: "valve",
        terms: ["valve", "vana"],
        categories: ["Pipe Accessories", "Pipe Fittings"],
    },
    {
        concept: "damper",
        terms: ["damper"],
        categories: ["Duct Accessories", "Mechanical Equipment"],
    },
    {
        concept: "air_terminal",
        terms: ["diffuser", "grille", "air terminal", "difuzor", "menfez"],
        categories: ["Air Terminals"],
    },
    {
        concept: "duct",
        terms: ["duct", "kanal"],
        categories: ["Ducts", "Duct Fittings", "Duct Accessories"],
    },
    {
        concept: "pipe",
        terms: ["pipe", "boru"],
        categories: ["Pipes", "Pipe Fittings", "Pipe Accessories"],
    },
    {
        concept: "sprinkler",
        terms: ["sprinkler"],
        categories: ["Sprinklers"],
    },
    {
        concept: "plumbing_fixture",
        terms: ["plumbing fixture", "sanitary fixture", "sihhi tesisat armatür", "armatür"],
        categories: ["Plumbing Fixtures"],
    },
];

const GENERIC_QUERY_PATTERN = /^[\p{L}\p{N}_\- ]{1,24}$/u;

function normalizeText(value: unknown) {
    return String(value || "")
        .normalize("NFD")
        .replace(/\p{Diacritic}/gu, "")
        .replace(/ı/g, "i")
        .replace(/İ/g, "I")
        .toLowerCase()
        .replace(/\s+/g, " ")
        .trim();
}

function uniqueStrings(values: unknown[]) {
    const seen = new Set<string>();
    const result: string[] = [];
    for (const value of values) {
        const text = String(value || "").trim();
        if (!text) continue;
        const key = text.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        result.push(text);
    }
    return result;
}

function parseBudget(value: unknown): SearchBudgetName {
    const text = String(value || "").toLowerCase();
    if (text === "balanced" || text === "deep" || text === "fast") {
        return text;
    }
    return DEFAULT_BUDGET;
}

function toPositiveInt(value: unknown, fallback: number, min: number, max: number) {
    const parsed = Number.parseInt(String(value ?? ""), 10);
    if (!Number.isFinite(parsed)) {
        return fallback;
    }
    return Math.max(min, Math.min(max, parsed));
}

function stripConceptTerms(query: string, matchedTerms: string[]) {
    let effective = query;
    for (const term of matchedTerms.sort((a, b) => b.length - a.length)) {
        const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+");
        effective = effective.replace(new RegExp(`(?<!\\p{L})${escaped}(?!\\p{L})`, "igu"), " ");
    }
    return effective.replace(/\s+/g, " ").trim();
}

function inferScopeFromQuery(query: string) {
    const normalizedQuery = normalizeText(query);
    const matchedConcepts: JsonObject[] = [];
    const matchedTerms: string[] = [];
    const categories: string[] = [];

    for (const mapping of CONCEPT_MAPPINGS) {
        const terms = mapping.terms.filter((term) => normalizedQuery.includes(normalizeText(term)));
        if (terms.length === 0) continue;
        matchedConcepts.push({
            concept: mapping.concept,
            terms,
            categories: mapping.categories,
        });
        matchedTerms.push(...terms);
        categories.push(...mapping.categories);
    }

    return {
        matchedConcepts,
        matchedTerms,
        categories: uniqueStrings(categories),
        effectiveQuery: stripConceptTerms(query, matchedTerms),
    };
}

function buildSuggestedNextScopes(args: JsonObject = {}) {
    const suggestions = ["levelNames", "activeViewOnly", "familyName", "typeName", "systemName"];
    if (!args.sheetQuery && !Array.isArray(args.sheetIds)) {
        suggestions.push("sheetQuery");
    }
    if (!args.nameQuery && !Array.isArray(args.scheduleIds)) {
        suggestions.push("scheduleIds/nameQuery");
    }
    suggestions.push("allowExpensiveSearch", "searchBudget=deep");
    return suggestions;
}

function readNumberFromObjects(objects: JsonObject[], names: string[]) {
    for (const source of objects) {
        if (!source || typeof source !== "object") continue;
        for (const name of names) {
            const raw = source[name];
            const parsed = Number.parseInt(String(raw ?? ""), 10);
            if (Number.isFinite(parsed)) {
                return parsed;
            }
        }
    }
    return null;
}

function buildRecommendedFirstScope(args: JsonObject, effectiveCategoryNames: string[]) {
    const scopes: string[] = [];
    if (effectiveCategoryNames.length > 0) {
        scopes.push(`categoryNames=${effectiveCategoryNames.join("|")}`);
    }
    if (Array.isArray(args.levelNames) && args.levelNames.length > 0) {
        scopes.push("levelNames");
    }
    if (args.activeViewOnly === true || args.viewId) {
        scopes.push("activeViewOnly/viewId");
    }
    if (args.familyName) scopes.push("familyName");
    if (args.typeName) scopes.push("typeName");
    if (args.systemName) scopes.push("systemName");
    if (scopes.length > 0) {
        return scopes;
    }
    return ["categoryNames", "levelNames", "activeViewOnly", "familyName/typeName", "systemName"];
}

function hasBoundedScope(args: JsonObject = {}, effectiveCategoryNames: string[] = []) {
    return Boolean(
        effectiveCategoryNames.length > 0 ||
        args.activeViewOnly === true ||
        args.viewId ||
        (Array.isArray(args.levelIds) && args.levelIds.length > 0) ||
        (Array.isArray(args.levelNames) && args.levelNames.length > 0) ||
        args.familyName ||
        args.typeName ||
        args.systemName ||
        (Array.isArray(args.worksetIds) && args.worksetIds.length > 0) ||
        (Array.isArray(args.worksetNames) && args.worksetNames.length > 0) ||
        (Array.isArray(args.elementIds) && args.elementIds.length > 0) ||
        (Array.isArray(args.uniqueIds) && args.uniqueIds.length > 0)
    );
}

function isGenericUnscopedQuery(query: string) {
    const trimmed = String(query || "").trim();
    return Boolean(trimmed && GENERIC_QUERY_PATTERN.test(trimmed));
}

function buildSearchRiskPolicy(args: JsonObject, options: {
    originalQuery: string;
    boundedScope: boolean;
    effectiveCategoryNames: string[];
    linkScope: string;
    allowExpensiveSearch: boolean;
    broadLinkedSearch: boolean;
    verifiedBroadSearch: boolean;
    searchBudget: SearchBudgetName;
}): SearchRiskPolicy {
    const reasons: string[] = [];
    let score = 0;
    const cheapSignalSources = [
        args.largeModelRisk,
        args.modelRisk,
        args.modelSignals,
        args.sessionSummary,
    ].filter(Boolean) as JsonObject[];

    const linkCount = readNumberFromObjects(cheapSignalSources, ["linkCount", "linkInstances", "loadedLinks", "loadedLinkCount"]);
    const worksetCount = readNumberFromObjects(cheapSignalSources, ["worksetCount", "worksets"]);
    const sheetCount = readNumberFromObjects(cheapSignalSources, ["sheetCount", "sheets"]);
    const scheduleCount = readNumberFromObjects(cheapSignalSources, ["scheduleCount", "schedules"]);

    if (linkCount !== null && linkCount >= 25) {
        score += 2;
        reasons.push("high_link_count");
    }
    else if (linkCount !== null && linkCount >= 10) {
        score += 1;
        reasons.push("moderate_link_count");
    }

    if (worksetCount !== null && worksetCount >= 40) {
        score += 2;
        reasons.push("high_workset_count");
    }
    else if (worksetCount !== null && worksetCount >= 20) {
        score += 1;
        reasons.push("moderate_workset_count");
    }

    if (sheetCount !== null && sheetCount >= 1000) {
        score += 1;
        reasons.push("large_sheet_set");
    }
    if (scheduleCount !== null && scheduleCount >= 500) {
        score += 1;
        reasons.push("large_schedule_set");
    }

    if (!options.boundedScope && isGenericUnscopedQuery(options.originalQuery)) {
        score += 3;
        reasons.push("generic_unscoped_query");
    }
    if (!options.boundedScope && !options.originalQuery) {
        score += 3;
        reasons.push("missing_search_scope");
    }
    if (options.broadLinkedSearch) {
        score += 2;
        reasons.push("linked_search_without_expensive_approval");
    }
    if (options.verifiedBroadSearch) {
        score += 2;
        reasons.push("verified_plan_candidates_without_bounded_scope");
    }
    if (options.searchBudget === "deep" || options.allowExpensiveSearch) {
        reasons.push("operator_approved_expensive_search");
    }
    if (options.boundedScope && reasons.length === 0) {
        reasons.push("bounded_first_pass_scope");
    }

    const riskLevel: SearchRiskLevel = score >= 4
        ? "high"
        : score >= 2
            ? "medium"
            : score >= 1 || options.boundedScope
                ? "low"
                : "unknown";

    const requiresUserControl = !options.allowExpensiveSearch && (
        options.broadLinkedSearch ||
        options.verifiedBroadSearch ||
        (!options.boundedScope && score >= 2)
    );

    return {
        riskLevel,
        reasons,
        recommendedFirstScope: buildRecommendedFirstScope(args, options.effectiveCategoryNames),
        requiresUserControl,
    };
}

export function buildFindElementsSearchPolicy(args: JsonObject = {}): FindElementsSearchPolicy {
    const originalQuery = String(args.query || "").trim();
    const explicitCategories = uniqueStrings(Array.isArray(args.categoryNames) ? args.categoryNames : []);
    const inferred = inferScopeFromQuery(originalQuery);
    const effectiveCategoryNames = uniqueStrings([...explicitCategories, ...inferred.categories]);
    const effectiveQuery = inferred.effectiveQuery || (effectiveCategoryNames.length > explicitCategories.length ? "" : originalQuery);
    const searchBudget = parseBudget(args.searchBudget);
    const preset = SEARCH_BUDGETS[searchBudget];
    const requestedTimeoutMs = args.timeoutMs ? toPositiveInt(args.timeoutMs, preset.socketTimeoutMs, 1000, 120000) : preset.socketTimeoutMs;
    const timeoutMs = Math.max(requestedTimeoutMs, Math.min(120000, preset.maxElapsedMs + 2500));
    const maxElementsScanned = toPositiveInt(args.maxElementsScanned, preset.maxElementsScanned, 1, 500000);
    const maxElapsedDefault = Math.min(preset.maxElapsedMs, Math.max(1000, timeoutMs - 2500));
    const maxElapsedMs = toPositiveInt(args.maxElapsedMs, maxElapsedDefault, 500, Math.max(500, timeoutMs - 1000));
    const boundedScope = hasBoundedScope(args, effectiveCategoryNames);
    const linkScope = String(args.linkScope || "hostOnly");
    const allowExpensiveSearch = args.allowExpensiveSearch === true || searchBudget === "deep";
    const broadLinkedSearch = linkScope !== "hostOnly" && !allowExpensiveSearch;
    const verifiedBroadSearch = String(args.planCandidateMode || "").toLowerCase() === "verified" && !boundedScope;
    const riskPolicy = buildSearchRiskPolicy(args, {
        originalQuery,
        boundedScope,
        effectiveCategoryNames,
        linkScope,
        allowExpensiveSearch,
        broadLinkedSearch,
        verifiedBroadSearch,
        searchBudget,
    });
    const guarded = riskPolicy.requiresUserControl;
    const warnings: string[] = [];

    if (inferred.matchedConcepts.length > 0 && explicitCategories.length === 0) {
        warnings.push("search_scope_inferred_from_mep_terms");
    }
    if (broadLinkedSearch) {
        warnings.push("linked_model_search_requires_allowExpensiveSearch");
    }
    if (verifiedBroadSearch) {
        warnings.push("verified_plan_candidates_require_bounded_scope");
    }
    if (riskPolicy.requiresUserControl) {
        warnings.push("search_requires_user_scope_control");
    }

    return {
        originalQuery,
        effectiveQuery,
        inferredScope: {
            source: "runtime_search_policy",
            concepts: inferred.matchedConcepts,
            strippedTerms: inferred.matchedTerms,
            categoryNames: inferred.categories,
            residualQuery: effectiveQuery,
        },
        effectiveCategoryNames,
        riskPolicy,
        linkScope,
        searchBudget,
        maxElementsScanned,
        maxElapsedMs,
        timeoutMs,
        guarded,
        reason: guarded ? "needs_scope" : undefined,
        message: guarded
            ? "This search would scan a broad model surface. Narrow by category, level, active view, system, family/type, sheet/schedule, or explicitly allow an expensive search."
            : undefined,
        warnings,
        suggestedNextScopes: buildSuggestedNextScopes(args),
    };
}

export function buildGuardedNeedsScopePayload(policy: FindElementsSearchPolicy) {
    return {
        success: true,
        guarded: true,
        state: "guarded",
        action: "find_elements",
        reason: "needs_scope",
        message: policy.message,
        originalQuery: policy.originalQuery,
        query: policy.effectiveQuery,
        inferredScope: policy.inferredScope,
        effectiveScope: {
            categoryNames: policy.effectiveCategoryNames,
            searchBudget: policy.searchBudget,
            linkScope: policy.linkScope,
        },
        riskPolicy: policy.riskPolicy,
        scanPolicy: {
            searchBudget: policy.searchBudget,
            maxElementsScanned: policy.maxElementsScanned,
            maxElapsedMs: policy.maxElapsedMs,
            timeoutMs: policy.timeoutMs,
            allowExpensiveSearch: false,
        },
        suggestedNextScopes: policy.suggestedNextScopes,
        warnings: policy.warnings,
    };
}
