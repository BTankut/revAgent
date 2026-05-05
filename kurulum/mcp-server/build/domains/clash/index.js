import { classifyAabbClash, classifyMepClashPriority, proposeOrthogonalReroute, solveOrthogonalReroute, summarizeMepClashPriorities } from "./calculations.js";

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
            "MEP clash priority classification by system, pipe size, and horizontal/vertical orientation",
            "clearance/insulation/maintenance clearance categories",
            "orthogonal reroute preview around a rectangular obstacle envelope",
            "multi-candidate orthogonal reroute solver with clearance validation",
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
            rerouteSolver: solveOrthogonalReroute({
                routePoints: [{ x: 0, y: 0, z: 0 }, { x: 8, y: 0, z: 0 }],
                obstacleBoxes: [
                    { min: { x: 2, y: -0.25, z: -0.25 }, max: { x: 3, y: 0.25, z: 0.25 } },
                    { min: { x: 5, y: -0.35, z: -0.2 }, max: { x: 6, y: 0.35, z: 0.2 } },
                ],
                clearanceM: 0.25,
                candidateOffsetAxes: ["y", "z"],
            }),
            mepPriority: classifyMepClashPriority({
                classification: "hard_clash",
                elementB: {
                    category: "Pipe Curves",
                    systemType: "Fire Protection Wet",
                    diameterM: 0.025,
                    orientation: "vertical",
                },
            }),
            mepPrioritySummary: summarizeMepClashPriorities([
                {
                    classification: "hard_clash",
                    elementB: {
                        category: "Pipe Curves",
                        systemType: "Fire Protection Wet",
                        diameterM: 0.08,
                        orientation: "horizontal",
                    },
                },
                {
                    classification: "hard_clash",
                    elementB: {
                        category: "Pipe Curves",
                        systemType: "Hydronic Supply",
                        diameterM: 0.025,
                        orientation: "vertical",
                    },
                },
            ]),
        },
        canCommit: false,
    };
}
