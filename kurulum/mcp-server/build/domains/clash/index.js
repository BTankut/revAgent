import { classifyAabbClash, proposeOrthogonalReroute } from "./calculations.js";

export function analyzeClashCoordination() {
    return {
        discipline: "clash",
        engine: "clash-coordination-foundation",
        status: "foundation",
        assumptions: [
            "Clash resolution must produce reroute preview and verification before any commit.",
        ],
        checksAvailable: [
            "hard clash AABB classification",
            "clearance/insulation/maintenance clearance categories",
            "orthogonal reroute preview around a rectangular obstacle envelope",
            "preview_reroute and commit_reroute write-plan operation slots",
        ],
        calculationExamples: {
            hardClash: classifyAabbClash({
                boxA: { min: { x: 0, y: 0, z: 0 }, max: { x: 1, y: 1, z: 1 } },
                boxB: { min: { x: 0.5, y: 0.5, z: 0.5 }, max: { x: 1.5, y: 1.5, z: 1.5 } },
                clearanceM: 0.1,
            }),
            reroutePreview: proposeOrthogonalReroute({
                routePoints: [{ x: 0, y: 0, z: 0 }, { x: 5, y: 0, z: 0 }],
                obstacleBox: { min: { x: 2, y: -0.25, z: -0.25 }, max: { x: 3, y: 0.25, z: 0.25 } },
                clearanceM: 0.25,
                offsetAxis: "y",
            }),
        },
        canCommit: false,
    };
}
