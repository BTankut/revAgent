export type AirSystemKind = "supply" | "return" | "exhaust";
export type WorkflowStage = "dry-run" | "preview" | "validate" | "commit" | "report";
export type IssueSeverity = "info" | "warning" | "error";

export interface EngineeringIssue {
    code: string;
    severity: IssueSeverity;
    message: string;
    context?: Record<string, unknown>;
}

export interface PointMm {
    x: number;
    y: number;
    z: number;
}

export interface AabbMm {
    minX: number;
    minY: number;
    minZ: number;
    maxX: number;
    maxY: number;
    maxZ: number;
}

export interface SpaceRecord {
    id: string;
    number?: string;
    name?: string;
    levelName?: string;
    areaM2?: number;
    centroidMm?: PointMm;
    aabbMm?: AabbMm;
    source?: Record<string, unknown>;
}

export interface FlowSet {
    supplyLps: number;
    returnLps: number;
    exhaustLps: number;
}

export interface AirBalanceRow {
    id: string;
    spaceId?: string;
    spaceNumber?: string;
    spaceName?: string;
    levelName?: string;
    flows: FlowSet;
    source: Record<string, unknown>;
}

export interface AirflowAssignment {
    space: SpaceRecord;
    flows: FlowSet;
    rowId?: string;
    matchKey?: string;
    issues: EngineeringIssue[];
}

export interface DiffuserType {
    id: string;
    model: string;
    system: AirSystemKind;
    minFlowLps: number;
    maxFlowLps: number;
    preferredFlowLps?: number;
    noiseCriterion?: number;
    throwM?: number;
    neckSizeMm?: string;
    source?: Record<string, unknown>;
}

export interface DiffuserSelection {
    system: AirSystemKind;
    diffuserType?: DiffuserType;
    diffuserCount: number;
    airflowPerDiffuserLps: number;
    totalAirflowLps: number;
    issues: EngineeringIssue[];
}

export interface DiffuserCandidate {
    id: string;
    spaceId: string;
    system: AirSystemKind;
    pointMm: PointMm;
    airflowLps: number;
    diffuserTypeId?: string;
}

export interface SpaceDiffuserPlan {
    space: SpaceRecord;
    selections: DiffuserSelection[];
    candidates: DiffuserCandidate[];
    plenumValidation: ValidationResult;
    issues: EngineeringIssue[];
}

export interface ValidationResult {
    status: "pass" | "warn" | "fail" | "not_run";
    issues: EngineeringIssue[];
    summary: Record<string, unknown>;
}

export interface DuctingRules {
    maxDiffusersPerSpace?: number;
    minWallClearanceMm?: number;
    minDiffuserSpacingMm?: number;
    minPlenumHeightMm?: number;
    blockOnPlenumObstacle?: boolean;
    routeElbowPenalty?: number;
    routeConflictPenalty?: number;
    allowOpenEnds?: boolean;
    allowDirectionAmbiguity?: boolean;
    flowTolerancePercent?: number;
    sizeToleranceMm?: number;
    maxVelocityMps?: number;
}

export interface DuctingProductionInput {
    workflowStage?: WorkflowStage | string;
    spaces?: Record<string, unknown>[];
    airBalanceRows?: Record<string, unknown>[];
    diffuserCatalog?: Record<string, unknown>[];
    projectRules?: DuctingRules;
    plenumVolumes?: Record<string, unknown>[];
    plenumObstacleIntersections?: Record<string, unknown>[];
    routeCandidates?: Record<string, unknown>[];
    connectorGraph?: Record<string, unknown>;
    expectedNetworkNodeIds?: string[];
    nativeSizing?: Record<string, unknown> | Record<string, unknown>[];
    commit?: Record<string, unknown>;
}

export interface DuctingProductionReport {
    schemaVersion: "ducting-production-assessment.v1";
    workflow: {
        stage: WorkflowStage;
        revitWriteAction: "none";
        nextAllowedAction: "report" | "preview" | "validate" | "commit_blocked" | "commit_ready";
    };
    summary: Record<string, unknown>;
    airBalance: Record<string, unknown>;
    diffuserPlans: SpaceDiffuserPlan[];
    routePreview: ValidationResult & { options: Record<string, unknown>[] };
    connectedNetwork: ValidationResult;
    nativeSizingValidation: ValidationResult;
    commitGate: {
        canCommit: boolean;
        reasons: string[];
    };
    foundationFollowUps: string[];
    issues: EngineeringIssue[];
}
