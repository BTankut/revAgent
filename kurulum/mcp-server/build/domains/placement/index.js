import { buildFamilyPlacementProposal } from "../equipment/calculations.js";

const placementDisciplineByKind = {
    air_terminal: "hvac",
    diffuser: "hvac",
    damper: "hvac",
    vav: "hvac",
    vav_or_air_device: "hvac",
    air_device: "hvac",
    valve: "hydronic",
    pump: "hydronic",
    coil: "hydronic",
    coil_connection: "hydronic",
    sprinkler: "fire",
    fire_cabinet: "fire",
    hose_cabinet: "fire",
    fixture_connection: "domestic_water",
    domestic_fixture: "domestic_water",
    sanitary_fixture: "sanitary",
};

export function analyzeDomainPlacement({
    discipline = "general",
    placementRequests = [],
    defaultPlacementLevelId,
} = {}) {
    const normalizedDiscipline = normalizeDiscipline(discipline);
    const normalizedRequests = Array.isArray(placementRequests) ? placementRequests : [];
    const applicableRequests = normalizedRequests.filter((request) => requestMatchesDiscipline(request, normalizedDiscipline));
    const ignoredRequestCount = normalizedRequests.length - applicableRequests.length;
    const placementProposal = buildFamilyPlacementProposal({
        discipline: normalizedDiscipline === "all" ? "general" : normalizedDiscipline,
        placementKind: "domain_placement",
        requests: applicableRequests,
        defaultLevelId: defaultPlacementLevelId,
    });
    return {
        discipline: normalizedDiscipline === "all" ? "general" : normalizedDiscipline,
        engine: "domain-placement-foundation",
        status: "foundation",
        assumptions: [
            "Domain placement is a proposal handoff to the native place_family_instance operation.",
            "Placement does not imply connector tie-in, routing, system assignment, balancing, or fire/hydraulic approval.",
            "Family/type availability, host requirements, orientation, and clearances must be verified during preview/readback.",
        ],
        checksAvailable: [
            "placement request discipline routing",
            "family/type or symbol identity validation",
            "proposal-only place_family_instance write-plan step generation",
        ],
        requestCount: normalizedRequests.length,
        applicableRequestCount: applicableRequests.length,
        ignoredRequestCount,
        ...(ignoredRequestCount > 0 ? {
            warnings: [`${ignoredRequestCount} placement request(s) did not match discipline ${normalizedDiscipline}.`],
        } : {}),
        placementProposal,
        canCommit: false,
    };
}

function requestMatchesDiscipline(request = {}, discipline) {
    if (discipline === "all" || discipline === "general" || discipline === "equipment") return true;
    const explicit = normalizeDiscipline(request.discipline || request.domain || "");
    if (explicit && explicit !== "general") {
        if (discipline === "fire" && explicit === "sprinkler") return true;
        if (discipline === "sprinkler" && explicit === "fire") return true;
        return explicit === discipline;
    }
    const kind = normalizeKind(request.placementKind || request.kind || "");
    const mapped = placementDisciplineByKind[kind] || "general";
    if (discipline === "fire" && mapped === "sprinkler") return true;
    if (discipline === "sprinkler" && mapped === "fire") return true;
    return mapped === discipline || mapped === "general";
}

function normalizeDiscipline(value) {
    return String(value || "general").toLowerCase().replace(/-/g, "_");
}

function normalizeKind(value) {
    return String(value || "")
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "_")
        .replace(/^_+|_+$/g, "");
}
