import { buildAirflowAssignments, summarizeAirflow } from "./airflow.js";
import { buildDiffuserPlans } from "./diffusers.js";
import { asBoolean, asRecord, flattenIssues, makeIssue, validationStatus } from "./helpers.js";
import { validateConnectedDuctNetwork, validateNativeSizing, validateRoutePreview } from "./routes.js";
import type { DuctingProductionInput, DuctingProductionReport, EngineeringIssue, WorkflowStage } from "./types.js";

function workflowStage(value: unknown): WorkflowStage {
    const normalized = String(value ?? "dry-run").trim().toLowerCase();
    if (["preview", "validate", "commit", "report"].includes(normalized)) return normalized as WorkflowStage;
    if (["dryrun", "dry_run", "dry-run"].includes(normalized)) return "dry-run";
    return "dry-run";
}

function commitApproved(input: DuctingProductionInput): boolean {
    const commit = asRecord(input.commit);
    return asBoolean(commit.approved) === true || asBoolean(commit.commitApproved) === true;
}

function reviewedRoute(routePreview: ReturnType<typeof validateRoutePreview>): boolean {
    const best = routePreview.options.find((option) => option.status === "pass" || option.status === "warn");
    return !!best && best.reviewed === true;
}

function nextAction(stage: WorkflowStage, canCommit: boolean, blockingIssues: EngineeringIssue[]): DuctingProductionReport["workflow"]["nextAllowedAction"] {
    if (canCommit) return "commit_ready";
    if (blockingIssues.length > 0) return "commit_blocked";
    if (stage === "dry-run") return "preview";
    if (stage === "preview") return "validate";
    return "report";
}

function foundationFollowUps(report: {
    nativeSizing: ReturnType<typeof validateNativeSizing>;
    connectedNetwork: ReturnType<typeof validateConnectedDuctNetwork>;
}): string[] {
    const followUps: string[] = [];
    if (report.nativeSizing.status === "not_run") {
        followUps.push("Consider documenting how Revit native sizing result fields should be attached to connector graph reports without changing ducting branch schema.");
    }
    if (report.connectedNetwork.summary.directionAmbiguityCount && Number(report.connectedNetwork.summary.directionAmbiguityCount) > 0) {
        followUps.push("Foundation graph should expose reviewed direction-resolution evidence for ambiguous connector flow direction.");
    }
    return followUps;
}

export function evaluateDuctingProduction(input: DuctingProductionInput = {}): DuctingProductionReport {
    const stage = workflowStage(input.workflowStage);
    const rules = input.projectRules ?? {};
    const airflow = buildAirflowAssignments(input.spaces ?? [], input.airBalanceRows ?? []);
    const diffuser = buildDiffuserPlans(
        airflow.assignments,
        input.diffuserCatalog ?? [],
        rules,
        input.plenumVolumes ?? [],
        input.plenumObstacleIntersections ?? [],
    );
    const routePreview = validateRoutePreview(input.routeCandidates ?? [], rules);
    const connectedNetwork = validateConnectedDuctNetwork(input.connectorGraph, input.expectedNetworkNodeIds ?? [], rules);
    const nativeSizingValidation = validateNativeSizing(input.nativeSizing, rules);

    const allIssues = flattenIssues([
        airflow.issues,
        ...airflow.assignments,
        diffuser.issues,
        ...diffuser.plans,
        routePreview,
        connectedNetwork,
        nativeSizingValidation,
    ]);
    if (stage === "commit" && !commitApproved(input)) {
        allIssues.push(makeIssue("commit_approval_missing", "error", "Commit stage requires explicit commit.approved=true; this report does not write Revit elements."));
    }
    if (stage === "commit" && !reviewedRoute(routePreview)) {
        allIssues.push(makeIssue("commit_route_review_missing", "error", "Commit stage requires a reviewed route candidate."));
    }
    if (stage === "commit" && connectedNetwork.status !== "pass") {
        allIssues.push(makeIssue("commit_connected_network_validation_not_pass", "error", "Commit stage requires connected duct network validation to pass.", {
            connectedNetworkStatus: connectedNetwork.status,
        }));
    }
    if (stage === "commit" && nativeSizingValidation.status !== "pass") {
        allIssues.push(makeIssue("commit_native_sizing_validation_not_pass", "error", "Commit stage requires Revit native sizing validation to pass.", {
            nativeSizingStatus: nativeSizingValidation.status,
        }));
    }

    const blockingIssues = allIssues.filter((issue) => issue.severity === "error");
    const canCommit =
        stage === "commit" &&
        commitApproved(input) &&
        reviewedRoute(routePreview) &&
        connectedNetwork.status === "pass" &&
        nativeSizingValidation.status === "pass" &&
        blockingIssues.length === 0;
    const commitReasons = [];
    if (stage !== "commit") commitReasons.push("workflow_stage_is_not_commit");
    if (!commitApproved(input)) commitReasons.push("explicit_commit_approval_missing");
    if (!reviewedRoute(routePreview)) commitReasons.push("reviewed_route_candidate_missing");
    for (const issue of blockingIssues) commitReasons.push(issue.code);

    const totalDiffuserCount = diffuser.plans.reduce((sum, plan) => sum + plan.candidates.length, 0);
    const reportBits = { nativeSizing: nativeSizingValidation, connectedNetwork };
    const issuesStatus = validationStatus(allIssues);

    return {
        schemaVersion: "ducting-production-assessment.v1",
        workflow: {
            stage,
            revitWriteAction: "none",
            nextAllowedAction: nextAction(stage, canCommit, blockingIssues),
        },
        summary: {
            status: issuesStatus,
            spaceCount: airflow.spaces.length,
            airBalanceRowCount: airflow.rows.length,
            diffuserTypeCount: diffuser.catalog.length,
            diffuserCandidateCount: totalDiffuserCount,
            routeCandidateCount: routePreview.options.length,
            blockingIssueCount: blockingIssues.length,
            warningCount: allIssues.filter((issue) => issue.severity === "warning").length,
            commitReady: canCommit,
        },
        airBalance: {
            summary: summarizeAirflow(airflow.assignments),
            assignments: airflow.assignments,
            issues: airflow.issues,
        },
        diffuserPlans: diffuser.plans,
        routePreview,
        connectedNetwork,
        nativeSizingValidation,
        commitGate: {
            canCommit,
            reasons: canCommit ? [] : Array.from(new Set(commitReasons)),
        },
        foundationFollowUps: foundationFollowUps(reportBits),
        issues: allIssues,
    };
}
