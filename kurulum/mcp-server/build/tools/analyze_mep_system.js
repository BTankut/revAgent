import { z } from "zod";
import { analyzeClashCoordination } from "../domains/clash/index.js";
import { analyzeDomesticWater } from "../domains/domestic-water/index.js";
import { analyzeEquipmentSelection } from "../domains/equipment/index.js";
import { analyzeFireProtection } from "../domains/fire/index.js";
import { analyzeHvacAirside } from "../domains/hvac/index.js";
import { analyzeHydronic } from "../domains/hydronic/index.js";
import { analyzeDomainPlacement } from "../domains/placement/index.js";
import { analyzeSanitaryStorm } from "../domains/sanitary-storm/index.js";
import { mergeOfficeStandards } from "../office-standards/defaults.js";
import { buildAnalysisReport } from "../reporting/reportBuilder.js";
import { buildAnalysisWritePlanProposal } from "./analysis_write_plan_proposal.js";
import { formatJsonContent } from "../utils/revitToolHelpers.js";

export function registerAnalyzeMepSystemTool(server) {
    server.tool("analyze_mep_system", "Read-only MEP system analysis foundation. Produces discipline summaries, assumptions, missing office standards, and write-plan proposal readiness without mutating the model.", {
        discipline: z.enum(["all", "hvac", "hydronic", "domestic_water", "sanitary", "fire", "sprinkler", "clash", "equipment", "general"]).optional(),
        includeRevitRead: z.boolean().optional().describe("Run live read-only Revit collectors where implemented. Defaults true."),
        includeConnectorGraph: z.boolean().optional().describe("Include full live connector graph summary where implemented. Defaults true; set false for targeted pathfinding probes."),
        networkPathfindingOnly: z.boolean().optional().describe("When true with a network root, skip broad summary loops and return only targeted live connector pathfinding."),
        boqOnly: z.boolean().optional().describe("When true, run short read-only live BOQ collectors without connector graph traversal."),
        hydraulicResistanceOnly: z.boolean().optional().describe("When true for hydronic analysis, run short read-only pipe length/diameter sampling and resistance calibration."),
        resistanceSampleLimit: z.number().optional().describe("Maximum number of pipe samples for hydraulicResistanceOnly. Defaults 25."),
        referenceFlowLs: z.number().optional().describe("Reference flow in L/s for pipe resistance calibration. Defaults 1."),
        hydronicDesignFlowsByElementId: z.any().optional().describe("Optional map of Revit pipe element id to confirmed design flow in L/s for hydronic resize proposals."),
        hydronicDefaultDesignFlowLs: z.number().optional().describe("Optional default design flow in L/s for sampled hydronic pipes without an explicit element flow."),
        hydronicPipeSizingTargetElementIds: z.array(z.number()).optional().describe("Optional pipe element ids to include in hydronic resize proposal output."),
        criticalPathLocalLossPressurePa: z.number().optional().describe("Optional externally verified critical-circuit local-loss pressure in Pa for hydronic resize proposals."),
        criticalPathLocalLossComplete: z.boolean().optional().describe("Set true only when criticalPathLocalLossPressurePa is from a complete targeted critical-circuit local-loss dataset."),
        localLossOnly: z.boolean().optional().describe("When true for HVAC/hydronic analysis, run short read-only fitting/accessory/equipment local-loss parameter extraction."),
        localLossSampleLimit: z.number().optional().describe("Maximum number of fitting/accessory/equipment samples for localLossOnly. Defaults 25."),
        localLossElementIds: z.array(z.number()).optional().describe("Optional explicit Revit element ids for targeted local-loss extraction, for example a verified critical path/circuit element set."),
        localLossFromNetworkPath: z.boolean().optional().describe("When true with a network root and terminals, first find the live connector path, then target local-loss extraction to the selected reachable critical path/circuit."),
        ductSizingOnly: z.boolean().optional().describe("When true for HVAC analysis, run short read-only duct length/size sampling for resize proposals."),
        ductSizingSampleLimit: z.number().optional().describe("Maximum number of duct samples for ductSizingOnly. Defaults 25."),
        hvacDesignFlowsByElementId: z.any().optional().describe("Optional map of Revit duct element id to confirmed design airflow in m3/h for HVAC resize proposals."),
        hvacDefaultDesignFlowM3h: z.number().optional().describe("Optional default design airflow in m3/h for sampled HVAC ducts without an explicit element flow."),
        hvacDuctSizingTargetElementIds: z.array(z.number()).optional().describe("Optional duct element ids to include in HVAC resize proposal output."),
        networkRootElementId: z.number().optional().describe("Optional Revit element id used as the root for live connector graph pathfinding in HVAC/hydronic analyses."),
        networkTerminalElementIds: z.array(z.number()).optional().describe("Optional terminal Revit element ids for live connector graph pathfinding."),
        placementRequests: z.array(z.any()).optional().describe("Optional domain placement requests that become proposal-only place_family_instance write-plan steps, for example air_terminal, damper, valve, pump, or fire_cabinet."),
        defaultPlacementLevelId: z.number().optional().describe("Optional default Revit level id used by placementRequests when a request omits levelId."),
        officeStandards: z.any().optional().describe("Optional office standards override object."),
    }, async (args) => {
        const discipline = args.discipline || "all";
        const officeStandards = mergeOfficeStandards(args.officeStandards || {});
        const includeRevitRead = args.includeRevitRead !== false;
        const includeConnectorGraph = args.includeConnectorGraph !== false;
        const networkPathRequest = {
            rootElementId: args.networkRootElementId,
            terminalElementIds: args.networkTerminalElementIds || [],
            includeConnectorGraph,
            pathfindingOnly: args.networkPathfindingOnly === true,
            boqOnly: args.boqOnly === true,
            hydraulicResistanceOnly: args.hydraulicResistanceOnly === true,
            sampleLimit: args.resistanceSampleLimit,
            referenceFlowLs: args.referenceFlowLs,
            hydronicDesignFlowsByElementId: args.hydronicDesignFlowsByElementId || {},
            hydronicDefaultDesignFlowLs: args.hydronicDefaultDesignFlowLs,
            hydronicPipeSizingTargetElementIds: args.hydronicPipeSizingTargetElementIds || [],
            criticalPathLocalLossPressurePa: args.criticalPathLocalLossPressurePa,
            criticalPathLocalLossComplete: args.criticalPathLocalLossComplete === true,
            localLossOnly: args.localLossOnly === true,
            localLossSampleLimit: args.localLossSampleLimit,
            localLossElementIds: args.localLossElementIds || [],
            localLossFromNetworkPath: args.localLossFromNetworkPath === true,
            ductSizingOnly: args.ductSizingOnly === true,
            ductSizingSampleLimit: args.ductSizingSampleLimit,
            hvacDesignFlowsByElementId: args.hvacDesignFlowsByElementId || {},
            hvacDefaultDesignFlowM3h: args.hvacDefaultDesignFlowM3h,
            hvacDuctSizingTargetElementIds: args.hvacDuctSizingTargetElementIds || [],
        };
        try {
            const analyses = [];
            if (discipline === "all" || discipline === "hvac" || discipline === "general") {
                analyses.push(await analyzeHvacAirside({ includeRevitRead, officeStandards, networkPathRequest }));
            }
            if (discipline === "all" || discipline === "hydronic" || discipline === "general") {
                analyses.push(await analyzeHydronic({ includeRevitRead, officeStandards, networkPathRequest }));
            }
            if (discipline === "all" || discipline === "domestic_water" || discipline === "general") {
                analyses.push(analyzeDomesticWater({ officeStandards }));
            }
            if (discipline === "all" || discipline === "sanitary" || discipline === "general") {
                analyses.push(analyzeSanitaryStorm({ officeStandards }));
            }
            if (discipline === "all" || discipline === "fire" || discipline === "sprinkler" || discipline === "general") {
                analyses.push(await analyzeFireProtection({ includeRevitRead, officeStandards }));
            }
            if (discipline === "all" || discipline === "clash" || discipline === "general") {
                analyses.push(analyzeClashCoordination());
            }
            if (discipline === "all" || discipline === "equipment" || discipline === "general") {
                analyses.push(analyzeEquipmentSelection());
            }
            if ((args.placementRequests || []).length > 0) {
                analyses.push(analyzeDomainPlacement({
                    discipline,
                    placementRequests: args.placementRequests || [],
                    defaultPlacementLevelId: args.defaultPlacementLevelId,
                }));
            }
            const reporting = buildAnalysisReport({
                analyses,
                delimiter: officeStandards.reporting?.csvDelimiter,
            });
            const writePlanProposal = buildAnalysisWritePlanProposal({
                analyses,
                discipline,
                revitVersion: args.revitVersion || "2022",
            });
            return formatJsonContent({
                success: true,
                discipline,
                mutateModel: false,
                analyses,
                reporting,
                writePlanProposal,
            });
        }
        catch (error) {
            return formatJsonContent({
                success: false,
                discipline,
                mutateModel: false,
                error: error instanceof Error ? error.message : String(error),
            });
        }
    });
}
