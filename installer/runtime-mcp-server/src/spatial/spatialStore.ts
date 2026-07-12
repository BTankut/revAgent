import Database from "better-sqlite3";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs";
import { homedir } from "node:os";
import { spawnSync } from "node:child_process";
import { basename, dirname, isAbsolute, join, parse, relative, resolve } from "node:path";
import { spatialSourceKey } from "./spatialLiveness.js";
import {
  canonicalJson,
  cleanStringArray,
  cleanText,
  compareText,
  finiteNumber,
  finiteInteger,
  firstDefined,
  isJsonObject,
  sha256Canonical,
} from "./spatialCanonical.js";
import { getInstallRoot, getRuntimeRoot } from "../utils/runtimeIdentity.js";

export const SPATIAL_STORE_SCHEMA_MAJOR = 1;
export const SPATIAL_STORE_SCHEMA_MINOR = 2;
export const DEFAULT_SPATIAL_RETENTION_DAYS = 30;
export const DEFAULT_SPATIAL_MIN_COMPLETE_SNAPSHOTS = 20;

export const SPATIAL_RETENTION_DAYS_ENV = "REVAGENT_SPATIAL_RETENTION_DAYS";
export const SPATIAL_MIN_COMPLETE_SNAPSHOTS_ENV = "REVAGENT_SPATIAL_MIN_COMPLETE_SNAPSHOTS";
export const SPATIAL_RETENTION_DISABLED_ENV = "REVAGENT_SPATIAL_RETENTION_DISABLED";

const DEFAULT_CAPTURE_LEASE_MS = 15 * 60 * 1000;
const MILLIS_PER_DAY = 24 * 60 * 60 * 1000;
let backupSerial = 0;

export interface SpatialStoreSchemaVersion {
  major: number;
  minor: number;
}

export interface SpatialStoreTestHooks {
  beforeMigrationCommit?: (
    from: SpatialStoreSchemaVersion,
    to: SpatialStoreSchemaVersion,
  ) => void;
  beforeRecoveryBackupCreate?: () => void;
  beforeRecoveryBackupDelete?: (backupPath: string) => void;
  readWindowsDriveType?: SpatialWindowsDriveTypeReader;
}

export type SpatialWindowsDriveTypeReader = (driveRoot: string) => number | null;

export interface SpatialStoreOptions {
  databasePath?: string;
  artifactRoot?: string;
  now?: () => number;
  testHooks?: SpatialStoreTestHooks;
  retentionPolicy?: Omit<SpatialRetentionOptions, "nowMs"> | false;
  cleanupExpiredStagingOnOpen?: boolean;
}

export interface SpatialAabb {
  minMm: readonly [number, number, number];
  maxMm: readonly [number, number, number];
}

export interface SpatialNodeRecord {
  nodeId: string;
  documentKey: string;
  nodeKind: string;
  elementUniqueId?: string | null;
  linkInstanceUniqueId?: string | null;
  aabb?: SpatialAabb | null;
  payload: unknown;
}

export interface SpatialOmissionRecord {
  documentKey: string;
  reason: string;
  sourceIdentity?: string | null;
  payload: unknown;
}

export interface SpatialSourceRevisionRecord {
  documentKey: string;
  documentSessionId: string;
  trackerSessionId?: string | null;
  loadedVersion: string;
  changeSequence: number;
  changeSequenceState?: string | null;
  oldestRetainedSequence?: number | null;
  journalEntryCount?: number | null;
  journalCapacity?: number | null;
  journalTruncated?: boolean;
  linkInstanceUniqueId?: string | null;
  sourceToHostTransform: unknown;
  documentKeyResolution?: unknown;
  externalLinkUpdateAvailable?: boolean;
  metadata?: unknown;
}

export interface BeginSpatialCaptureInput {
  captureId: string;
  snapshotId: string;
  documentKey: string;
  scopeFingerprint: string;
  revisionFingerprint: string;
  schemaVersion: string;
  extractorVersion: string;
  scope: unknown;
  counts?: unknown;
  effectiveSourcePolicy?: unknown;
  coverage?: unknown;
  transformValidation?: unknown;
  captureMetadata?: unknown;
  capturedAtMs?: number;
  expiresAtMs?: number;
  artifactPaths?: readonly string[];
}

export interface StageSpatialPageInput {
  captureId: string;
  ordinal: number;
  priorPageHash?: string | null;
  pageHash: string;
  hasMore: boolean;
  payloadBytes: number;
  nodes: readonly SpatialNodeRecord[];
  omissions?: readonly SpatialOmissionRecord[];
}

export interface CommitSpatialCaptureInput {
  captureId: string;
  sourceRevisions: readonly SpatialSourceRevisionRecord[];
  counts: unknown;
  effectiveSourcePolicy?: unknown;
  coverage: unknown;
  transformValidation?: unknown;
  expectedPageCount: number;
  expectedPayloadBytes: number;
  expectedNodeCount: number;
  expectedOmissionCount: number;
  expectedNodesByKind: Readonly<Record<string, number>>;
  partial: boolean;
  coverageStatus?: "complete" | "incomplete_omissions" | "incomplete_budget" | null;
  scanStoppedReason: string;
  suggestedNextScopes?: readonly string[];
}

export interface SpatialSnapshotSummary {
  snapshotId: string;
  documentKey: string;
  capturedAtMs: number;
  committedAtMs: number;
  scopeFingerprint: string;
  revisionFingerprint: string;
  schemaVersion: string;
  extractorVersion: string;
  complete: boolean;
  partial: boolean;
  coverageStatus: string | null;
  scanStoppedReason: string;
  pageCount: number;
  payloadBytes: number;
  sourceCount: number;
  nodeCount: number;
  omissionCount: number;
}

export interface SpatialSnapshotRecord extends SpatialSnapshotSummary {
  scope: unknown;
  declaredCounts: unknown | null;
  derivedCounts: unknown;
  effectiveSourcePolicy: unknown | null;
  coverage: unknown | null;
  transformValidation: unknown | null;
  captureMetadata: unknown;
  sourceRevisions: SpatialSourceRevisionRecord[];
}

export interface SpatialIndexedNode {
  snapshotId: string;
  nodeId: string;
  documentKey: string;
  nodeKind: string;
  aabb: SpatialAabb;
}

export interface SpatialStoredNode {
  snapshotId: string;
  nodeId: string;
  documentKey: string;
  nodeKind: string;
  aabb: SpatialAabb | null;
  elementUniqueId: string | null;
  linkInstanceUniqueId: string | null;
  category: string | null;
  builtInCategory: string | null;
  categoryRole: string | null;
  levelUniqueId: string | null;
  levelName: string | null;
  ownerNodeId: string | null;
  systemKey: string | null;
  geometryFingerprint: string | null;
  placementFingerprint: string | null;
  shapeFingerprint: string | null;
  propertyFingerprint: string | null;
  topologyFingerprint: string | null;
  payload: Record<string, unknown>;
}

export interface SpatialStoredOmission {
  snapshotId: string;
  documentKey: string;
  reason: string;
  sourceIdentity: string | null;
  payload: Record<string, unknown>;
}

export interface SpatialStoredEdge {
  snapshotId: string;
  edgeId: string;
  sourceNodeId: string;
  targetNodeId: string;
  relationType: string;
  relationPolicyVersion: string;
  fingerprint: string;
  bidirectional: boolean;
  payload: Record<string, unknown>;
}

export interface SpatialNodeQuery {
  snapshotId: string;
  nodeIds?: readonly string[];
  nodeKinds?: readonly string[];
  categories?: readonly string[];
  builtInCategories?: readonly string[];
  categoryRoles?: readonly string[];
  levelNames?: readonly string[];
  levelUniqueIds?: readonly string[];
  systemKeys?: readonly string[];
  ownerNodeIds?: readonly string[];
  aabb?: SpatialAabb;
  elevationBandMm?: {
    minZ: number;
    maxZ: number;
  };
  afterNodeId?: string | null;
  limit?: number;
}

export interface SpatialStoredNodePage {
  nodes: SpatialStoredNode[];
  hasMore: boolean;
  nextNodeId: string | null;
}

export interface SpatialOmissionQuery {
  snapshotId: string;
  reasons?: readonly string[];
  afterRowId?: number | null;
  limit?: number;
}

export interface SpatialStoredOmissionPage {
  omissions: SpatialStoredOmission[];
  hasMore: boolean;
  nextRowId: number | null;
}

export interface SpatialEdgeQuery {
  snapshotId: string;
  relationTypes?: readonly string[];
  sourceNodeIds?: readonly string[];
  targetNodeIds?: readonly string[];
  incidentNodeIds?: readonly string[];
  afterEdgeId?: string | null;
  limit?: number;
}

export interface SpatialStoredEdgePage {
  edges: SpatialStoredEdge[];
  hasMore: boolean;
  nextEdgeId: string | null;
}

export interface SpatialAdjacentEdgeOptions {
  relationTypes?: readonly string[];
  limit?: number;
}

export interface SpatialSnapshotTopologyCapability {
  snapshotId: string;
  connectorCount: number;
  declaredPeerReferenceCount: number;
  resolvedPeerReferenceCount: number;
  unresolvedPeerReferenceCount: number;
  ambiguousConnectorCount: number;
  readComplete: boolean;
  targetMembershipValidated: boolean;
  unresolvedPeerNodeIds: string[];
}

export interface SpatialRetentionOptions {
  nowMs?: number;
  retentionDays?: number;
  minCompleteSnapshots?: number;
}

export interface SpatialPurgeOptions {
  all?: boolean;
  documentKey?: string;
  snapshotIds?: readonly string[];
}

export interface SpatialPurgeResult {
  purgedSnapshotCount: number;
  purgedStagingCaptureCount: number;
  removedArtifactCount: number;
  artifactWarnings: string[];
}

export interface SpatialPurgePreview {
  snapshotIds: string[];
  stagingCaptureIds: string[];
  snapshotCount: number;
  stagingCaptureCount: number;
}

interface CaptureRow {
  capture_id: string;
  snapshot_id: string;
  document_key: string;
  scope_fingerprint: string;
  revision_fingerprint: string;
  schema_version: string;
  extractor_version: string;
  scope_json: string;
  declared_counts_json: string | null;
  effective_source_policy_json: string | null;
  coverage_json: string | null;
  transform_validation_json: string | null;
  capture_metadata_json: string;
  captured_at_ms: number;
  expires_at_ms: number;
}

interface PageRow {
  page_ordinal: number;
  page_hash: string;
  has_more: number;
}

interface SnapshotRetentionRow {
  snapshot_id: string;
  document_key: string;
  captured_at_ms: number;
  complete: number;
}

interface ArtifactRow {
  artifact_path: string;
}

interface CountRow {
  count: number;
}

interface MetadataRow {
  value: string;
}

const INITIAL_SCHEMA_SQL = `
  CREATE TABLE spatial_store_metadata (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE spatial_snapshots (
    snapshot_id TEXT PRIMARY KEY,
    document_key TEXT NOT NULL,
    captured_at_ms INTEGER NOT NULL,
    committed_at_ms INTEGER NOT NULL,
    scope_fingerprint TEXT NOT NULL,
    revision_fingerprint TEXT NOT NULL,
    schema_version TEXT NOT NULL,
    extractor_version TEXT NOT NULL,
    complete INTEGER NOT NULL CHECK (complete IN (0, 1)),
    partial INTEGER NOT NULL CHECK (partial IN (0, 1)),
    coverage_status TEXT,
    scan_stopped_reason TEXT NOT NULL,
    suggested_next_scopes_json TEXT NOT NULL,
    counts_json TEXT NOT NULL,
    page_count INTEGER NOT NULL CHECK (page_count > 0),
    payload_bytes INTEGER NOT NULL CHECK (payload_bytes >= 0)
  );

  CREATE INDEX spatial_snapshots_document_time
    ON spatial_snapshots(document_key, captured_at_ms DESC, snapshot_id);

  CREATE TABLE spatial_snapshot_sources (
    snapshot_id TEXT NOT NULL,
    source_key TEXT NOT NULL,
    document_key TEXT NOT NULL,
    document_session_id TEXT NOT NULL,
    loaded_version TEXT NOT NULL,
    change_sequence INTEGER NOT NULL CHECK (change_sequence >= 0),
    oldest_retained_sequence INTEGER CHECK (oldest_retained_sequence >= 0),
    link_instance_unique_id TEXT,
    source_to_host_transform_json TEXT NOT NULL,
    external_link_update_available INTEGER NOT NULL DEFAULT 0
      CHECK (external_link_update_available IN (0, 1)),
    PRIMARY KEY (snapshot_id, source_key),
    FOREIGN KEY (snapshot_id) REFERENCES spatial_snapshots(snapshot_id) ON DELETE CASCADE
  );

  CREATE INDEX spatial_snapshot_sources_document
    ON spatial_snapshot_sources(document_key, snapshot_id);

  CREATE TABLE spatial_nodes (
    node_rowid INTEGER PRIMARY KEY AUTOINCREMENT,
    snapshot_id TEXT NOT NULL,
    node_id TEXT NOT NULL,
    document_key TEXT NOT NULL,
    node_kind TEXT NOT NULL,
    element_unique_id TEXT,
    link_instance_unique_id TEXT,
    min_x REAL,
    max_x REAL,
    min_y REAL,
    max_y REAL,
    min_z REAL,
    max_z REAL,
    payload_json TEXT NOT NULL,
    UNIQUE (snapshot_id, node_id),
    FOREIGN KEY (snapshot_id) REFERENCES spatial_snapshots(snapshot_id) ON DELETE CASCADE,
    CHECK (
      (min_x IS NULL AND max_x IS NULL AND min_y IS NULL AND max_y IS NULL AND min_z IS NULL AND max_z IS NULL)
      OR
      (min_x IS NOT NULL AND max_x IS NOT NULL AND min_y IS NOT NULL AND max_y IS NOT NULL AND min_z IS NOT NULL AND max_z IS NOT NULL
       AND min_x <= max_x AND min_y <= max_y AND min_z <= max_z)
    )
  );

  CREATE INDEX spatial_nodes_snapshot ON spatial_nodes(snapshot_id, node_id);
  CREATE INDEX spatial_nodes_document ON spatial_nodes(document_key, snapshot_id);

  CREATE VIRTUAL TABLE spatial_node_rtree USING rtree(
    node_rowid,
    min_x, max_x,
    min_y, max_y,
    min_z, max_z
  );

  CREATE TRIGGER spatial_nodes_rtree_insert
  AFTER INSERT ON spatial_nodes
  WHEN NEW.min_x IS NOT NULL
  BEGIN
    INSERT INTO spatial_node_rtree(
      node_rowid, min_x, max_x, min_y, max_y, min_z, max_z
    ) VALUES (
      NEW.node_rowid, NEW.min_x, NEW.max_x, NEW.min_y, NEW.max_y, NEW.min_z, NEW.max_z
    );
  END;

  CREATE TRIGGER spatial_nodes_rtree_delete
  AFTER DELETE ON spatial_nodes
  BEGIN
    DELETE FROM spatial_node_rtree WHERE node_rowid = OLD.node_rowid;
  END;

  CREATE TABLE spatial_omissions (
    omission_rowid INTEGER PRIMARY KEY AUTOINCREMENT,
    snapshot_id TEXT NOT NULL,
    document_key TEXT NOT NULL,
    reason TEXT NOT NULL,
    source_identity TEXT,
    payload_json TEXT NOT NULL,
    FOREIGN KEY (snapshot_id) REFERENCES spatial_snapshots(snapshot_id) ON DELETE CASCADE
  );

  CREATE INDEX spatial_omissions_snapshot ON spatial_omissions(snapshot_id, reason);
  CREATE INDEX spatial_omissions_document ON spatial_omissions(document_key, snapshot_id);

  CREATE TABLE spatial_snapshot_artifacts (
    snapshot_id TEXT NOT NULL,
    artifact_path TEXT NOT NULL,
    PRIMARY KEY (snapshot_id, artifact_path),
    FOREIGN KEY (snapshot_id) REFERENCES spatial_snapshots(snapshot_id) ON DELETE CASCADE
  );

  CREATE TABLE spatial_capture_staging (
    capture_id TEXT PRIMARY KEY,
    snapshot_id TEXT NOT NULL UNIQUE,
    document_key TEXT NOT NULL,
    scope_fingerprint TEXT NOT NULL,
    revision_fingerprint TEXT NOT NULL,
    schema_version TEXT NOT NULL,
    extractor_version TEXT NOT NULL,
    captured_at_ms INTEGER NOT NULL,
    created_at_ms INTEGER NOT NULL,
    updated_at_ms INTEGER NOT NULL,
    expires_at_ms INTEGER NOT NULL
  );

  CREATE INDEX spatial_capture_staging_expiry
    ON spatial_capture_staging(expires_at_ms, capture_id);

  CREATE TABLE spatial_staging_pages (
    capture_id TEXT NOT NULL,
    page_ordinal INTEGER NOT NULL CHECK (page_ordinal >= 0),
    prior_page_hash TEXT,
    page_hash TEXT NOT NULL,
    has_more INTEGER NOT NULL CHECK (has_more IN (0, 1)),
    payload_bytes INTEGER NOT NULL CHECK (payload_bytes >= 0),
    record_count INTEGER NOT NULL CHECK (record_count >= 0),
    omission_count INTEGER NOT NULL CHECK (omission_count >= 0),
    PRIMARY KEY (capture_id, page_ordinal),
    FOREIGN KEY (capture_id) REFERENCES spatial_capture_staging(capture_id) ON DELETE CASCADE
  );

  CREATE TABLE spatial_staging_nodes (
    staging_node_rowid INTEGER PRIMARY KEY AUTOINCREMENT,
    capture_id TEXT NOT NULL,
    page_ordinal INTEGER NOT NULL,
    node_id TEXT NOT NULL,
    document_key TEXT NOT NULL,
    node_kind TEXT NOT NULL,
    element_unique_id TEXT,
    link_instance_unique_id TEXT,
    min_x REAL,
    max_x REAL,
    min_y REAL,
    max_y REAL,
    min_z REAL,
    max_z REAL,
    payload_json TEXT NOT NULL,
    UNIQUE (capture_id, node_id),
    FOREIGN KEY (capture_id, page_ordinal)
      REFERENCES spatial_staging_pages(capture_id, page_ordinal) ON DELETE CASCADE
  );

  CREATE TABLE spatial_staging_omissions (
    staging_omission_rowid INTEGER PRIMARY KEY AUTOINCREMENT,
    capture_id TEXT NOT NULL,
    page_ordinal INTEGER NOT NULL,
    document_key TEXT NOT NULL,
    reason TEXT NOT NULL,
    source_identity TEXT,
    payload_json TEXT NOT NULL,
    FOREIGN KEY (capture_id, page_ordinal)
      REFERENCES spatial_staging_pages(capture_id, page_ordinal) ON DELETE CASCADE
  );

  CREATE TABLE spatial_staging_artifacts (
    capture_id TEXT NOT NULL,
    artifact_path TEXT NOT NULL,
    PRIMARY KEY (capture_id, artifact_path),
    FOREIGN KEY (capture_id) REFERENCES spatial_capture_staging(capture_id) ON DELETE CASCADE
  );
`;

const SCHEMA_1_1_MIGRATION_SQL = `
  ALTER TABLE spatial_capture_staging ADD COLUMN scope_json TEXT NOT NULL DEFAULT '{}';
  ALTER TABLE spatial_capture_staging ADD COLUMN declared_counts_json TEXT;
  ALTER TABLE spatial_capture_staging ADD COLUMN effective_source_policy_json TEXT;
  ALTER TABLE spatial_capture_staging ADD COLUMN coverage_json TEXT;
  ALTER TABLE spatial_capture_staging ADD COLUMN transform_validation_json TEXT;
  ALTER TABLE spatial_capture_staging ADD COLUMN capture_metadata_json TEXT NOT NULL DEFAULT '{}';

  ALTER TABLE spatial_snapshots ADD COLUMN scope_json TEXT NOT NULL DEFAULT '{}';
  ALTER TABLE spatial_snapshots ADD COLUMN declared_counts_json TEXT;
  ALTER TABLE spatial_snapshots ADD COLUMN effective_source_policy_json TEXT;
  ALTER TABLE spatial_snapshots ADD COLUMN coverage_json TEXT;
  ALTER TABLE spatial_snapshots ADD COLUMN transform_validation_json TEXT;
  ALTER TABLE spatial_snapshots ADD COLUMN capture_metadata_json TEXT NOT NULL DEFAULT '{}';

  ALTER TABLE spatial_snapshot_sources ADD COLUMN tracker_session_id TEXT;
  ALTER TABLE spatial_snapshot_sources ADD COLUMN change_sequence_state TEXT;
  ALTER TABLE spatial_snapshot_sources ADD COLUMN journal_entry_count INTEGER
    CHECK (journal_entry_count IS NULL OR journal_entry_count >= 0);
  ALTER TABLE spatial_snapshot_sources ADD COLUMN journal_capacity INTEGER
    CHECK (journal_capacity IS NULL OR journal_capacity >= 0);
  ALTER TABLE spatial_snapshot_sources ADD COLUMN journal_truncated INTEGER NOT NULL DEFAULT 0
    CHECK (journal_truncated IN (0, 1));
  ALTER TABLE spatial_snapshot_sources ADD COLUMN document_key_resolution_json TEXT;
  ALTER TABLE spatial_snapshot_sources ADD COLUMN source_revision_json TEXT NOT NULL DEFAULT '{}';
`;

const SCHEMA_1_2_EDGE_SQL = `
  CREATE TABLE spatial_edges (
    edge_rowid INTEGER PRIMARY KEY AUTOINCREMENT,
    snapshot_id TEXT NOT NULL,
    edge_id TEXT NOT NULL,
    source_node_id TEXT NOT NULL,
    target_node_id TEXT NOT NULL,
    relation_type TEXT NOT NULL,
    relation_policy_version TEXT NOT NULL,
    fingerprint TEXT NOT NULL,
    bidirectional INTEGER NOT NULL DEFAULT 0 CHECK (bidirectional IN (0, 1)),
    payload_json TEXT NOT NULL,
    UNIQUE (snapshot_id, source_node_id, target_node_id, relation_type),
    UNIQUE (snapshot_id, edge_id),
    FOREIGN KEY (snapshot_id) REFERENCES spatial_snapshots(snapshot_id) ON DELETE CASCADE
  );
  CREATE INDEX spatial_edges_source
    ON spatial_edges(snapshot_id, source_node_id, relation_type, target_node_id);
  CREATE INDEX spatial_edges_target
    ON spatial_edges(snapshot_id, target_node_id, relation_type, source_node_id);
  CREATE INDEX spatial_edges_relation
    ON spatial_edges(snapshot_id, relation_type, edge_id);

`;

const SCHEMA_1_2_TOPOLOGY_SQL = `
  CREATE TABLE IF NOT EXISTS spatial_snapshot_topology (
    snapshot_id TEXT PRIMARY KEY,
    connector_count INTEGER NOT NULL CHECK (connector_count >= 0),
    declared_peer_reference_count INTEGER NOT NULL CHECK (declared_peer_reference_count >= 0),
    resolved_peer_reference_count INTEGER NOT NULL CHECK (resolved_peer_reference_count >= 0),
    unresolved_peer_reference_count INTEGER NOT NULL CHECK (unresolved_peer_reference_count >= 0),
    ambiguous_connector_count INTEGER NOT NULL CHECK (ambiguous_connector_count >= 0),
    read_complete INTEGER NOT NULL CHECK (read_complete IN (0, 1)),
    target_membership_validated INTEGER NOT NULL CHECK (target_membership_validated IN (0, 1)),
    payload_json TEXT NOT NULL,
    FOREIGN KEY (snapshot_id) REFERENCES spatial_snapshots(snapshot_id) ON DELETE CASCADE
  );
`;

const SPATIAL_NODE_PROJECTION_COLUMNS = [
  "category",
  "built_in_category",
  "category_role",
  "level_unique_id",
  "level_name",
  "owner_node_id",
  "system_key",
  "geometry_fingerprint",
  "placement_fingerprint",
  "shape_fingerprint",
  "property_fingerprint",
  "topology_fingerprint",
] as const;

export class SpatialStoreMigrationError extends Error {
  public readonly backupPath: string | null;

  public constructor(message: string, backupPath: string | null, options?: ErrorOptions) {
    super(message, options);
    this.name = "SpatialStoreMigrationError";
    this.backupPath = backupPath;
  }
}

export class SpatialStoreIntegrityError extends Error {
  public constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "SpatialStoreIntegrityError";
  }
}

export class SpatialRTreeUnavailableError extends Error {
  public constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "SpatialRTreeUnavailableError";
  }
}

export class SpatialStorePathError extends Error {
  public readonly reason: "network_path" | "managed_package_path" | "artifact_path";

  public constructor(
    reason: "network_path" | "managed_package_path" | "artifact_path",
    message: string,
  ) {
    super(message);
    this.name = "SpatialStorePathError";
    this.reason = reason;
  }
}

function isTruthy(value: unknown): boolean {
  return /^(1|true|yes|on)$/i.test(String(value ?? "").trim());
}

function isNetworkLikePath(value: string): boolean {
  const trimmed = value.trim();
  if (/^(?:\\\\|\/\/)/.test(trimmed) || /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) {
    return true;
  }
  const root = parse(resolve(trimmed)).root;
  return /^(?:\\\\|\/\/)/.test(root);
}

const windowsDriveTypeCache = new Map<string, number>();

function readWindowsDriveType(driveRoot: string): number | null {
  const cacheKey = driveRoot.toUpperCase();
  const cached = windowsDriveTypeCache.get(cacheKey);
  if (cached !== undefined) {
    return cached;
  }
  const script = [
    "$rootPath = [Environment]::GetEnvironmentVariable('REVAGENT_SPATIAL_DRIVE_ROOT')",
    "try { $drive = [System.IO.DriveInfo]::new($rootPath); if (-not $drive.IsReady) { exit 3 }; [Console]::Out.Write([int]$drive.DriveType); exit 0 } catch { exit 2 }",
  ].join("; ");
  const probe = spawnSync("powershell.exe", [
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    script,
  ], {
    encoding: "utf8",
    timeout: 2_000,
    windowsHide: true,
    env: { ...process.env, REVAGENT_SPATIAL_DRIVE_ROOT: driveRoot },
  });
  if (probe.error || probe.status !== 0) {
    return null;
  }
  const driveType = Number.parseInt(String(probe.stdout ?? "").trim(), 10);
  if (!Number.isSafeInteger(driveType) || driveType < 0 || driveType > 6) {
    return null;
  }
  windowsDriveTypeCache.set(cacheKey, driveType);
  return driveType;
}

export function assertSpatialLocalFilesystemPath(
  value: string,
  field: string,
  driveTypeReader?: SpatialWindowsDriveTypeReader,
): string {
  if (isNetworkLikePath(value)) {
    throw new SpatialStorePathError(
      "network_path",
      `${field} must remain on a local filesystem; network/UNC paths are not allowed.`,
    );
  }
  const normalized = resolve(value);
  if (process.platform === "win32" || driveTypeReader !== undefined) {
    const driveRoot = parse(normalized).root;
    const driveType = driveRoot ? (driveTypeReader ?? readWindowsDriveType)(driveRoot) : null;
    if (driveType === 4) {
      throw new SpatialStorePathError(
        "network_path",
        `${field} must remain on a local filesystem; mapped network drives are not allowed.`,
      );
    }
    if (driveType === null || ![2, 3, 6].includes(driveType)) {
      throw new SpatialStorePathError(
        "network_path",
        `${field} drive readiness/type is unavailable or not an allowed local writable drive; storage is rejected fail-closed.`,
      );
    }
  }
  const managedRoots = [...new Set([getRuntimeRoot(), getInstallRoot()].map((root) => resolve(root)))];
  if (managedRoots.some((root) => pathContains(root, normalized))) {
    throw new SpatialStorePathError(
      "managed_package_path",
      `${field} may not be stored inside the managed revAgent runtime/package directory.`,
    );
  }
  return normalized;
}

export function resolveSpatialDatabasePath(
  explicitPath?: string,
  driveTypeReader?: SpatialWindowsDriveTypeReader,
): string {
  const configured = explicitPath?.trim() || process.env.REVAGENT_SPATIAL_DB_PATH?.trim();
  if (configured) {
    return assertSpatialLocalFilesystemPath(configured, "Spatial database", driveTypeReader);
  }
  const localAppData = process.env.LOCALAPPDATA?.trim()
    || join(homedir(), "AppData", "Local");
  return assertSpatialLocalFilesystemPath(
    join(localAppData, "revAgent", "spatial", "spatial.db"),
    "Spatial database",
    driveTypeReader,
  );
}

export function resolveSpatialArtifactRoot(
  databasePath: string,
  explicitRoot?: string,
  driveTypeReader?: SpatialWindowsDriveTypeReader,
): string {
  const configured = explicitRoot?.trim() || join(dirname(databasePath), "artifacts");
  const artifactRoot = assertSpatialLocalFilesystemPath(configured, "Spatial artifact root", driveTypeReader);
  if (artifactRoot === resolve(databasePath)
    || pathContains(artifactRoot, databasePath)
    || pathContains(databasePath, artifactRoot)) {
    throw new SpatialStorePathError(
      "artifact_path",
      "The spatial artifact root must be a dedicated sibling location and may not contain the database.",
    );
  }
  return artifactRoot;
}

function readEnvironmentRetentionPolicy(): Omit<SpatialRetentionOptions, "nowMs"> | false | undefined {
  if (isTruthy(process.env[SPATIAL_RETENTION_DISABLED_ENV])) {
    return false;
  }
  const parseOptional = (name: string): number | undefined => {
    const raw = process.env[name]?.trim();
    if (!raw) return undefined;
    const parsed = Number(raw);
    if (!Number.isSafeInteger(parsed) || parsed < 0) {
      throw new RangeError(`${name} must be a non-negative integer.`);
    }
    return parsed;
  };
  const retentionDays = parseOptional(SPATIAL_RETENTION_DAYS_ENV);
  const minCompleteSnapshots = parseOptional(SPATIAL_MIN_COMPLETE_SNAPSHOTS_ENV);
  return retentionDays === undefined && minCompleteSnapshots === undefined
    ? undefined
    : { retentionDays, minCompleteSnapshots };
}

function requireText(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized) {
    throw new TypeError(`${field} must be a non-empty string.`);
  }
  return normalized;
}

function requireNonNegativeInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${field} must be a non-negative safe integer.`);
  }
  return value;
}

function stringifyJson(value: unknown, field: string): string {
  const encoded = JSON.stringify(value);
  if (encoded === undefined) {
    throw new TypeError(`${field} must be JSON serializable.`);
  }
  return encoded;
}

function parseJson(value: string | null, field: string): unknown | null {
  if (value === null) {
    return null;
  }
  try {
    return JSON.parse(value) as unknown;
  } catch (error) {
    throw new SpatialStoreIntegrityError(`Stored ${field} JSON is invalid.`, { cause: error });
  }
}

interface SpatialNodeProjection {
  category: string | null;
  builtInCategory: string | null;
  categoryRole: string | null;
  levelUniqueId: string | null;
  levelName: string | null;
  ownerNodeId: string | null;
  systemKey: string | null;
  geometryFingerprint: string | null;
  placementFingerprint: string | null;
  shapeFingerprint: string | null;
  propertyFingerprint: string | null;
  topologyFingerprint: string | null;
}

function projectedText(payload: unknown, paths: readonly (readonly string[])[]): string | null {
  return cleanText(firstDefined(payload, paths));
}

function projectSpatialNodePayload(payload: unknown): SpatialNodeProjection {
  return {
    category: projectedText(payload, [["category"]]),
    builtInCategory: projectedText(payload, [["builtInCategory"]]),
    categoryRole: projectedText(payload, [["categoryRole"]]),
    levelUniqueId: projectedText(payload, [
      ["levelRef", "sourceLevelUniqueId"],
      ["level", "uniqueId"],
      ["levelUniqueId"],
    ]),
    levelName: projectedText(payload, [
      ["levelRef", "sourceLevelName"],
      ["level", "name"],
      ["levelName"],
    ]),
    ownerNodeId: projectedText(payload, [
      ["ownerNodeId"],
      ["connectorRef", "ownerNodeId"],
      ["nodeRef", "connectorRef", "ownerNodeId"],
    ]),
    systemKey: projectedText(payload, [
      ["spatialProperties", "systemKey"],
      ["system", "systemKey"],
      ["system", "uniqueId"],
      ["systemKey"],
      ["systemName"],
    ]),
    geometryFingerprint: projectedText(payload, [
      ["fingerprints", "geometry"],
      ["geometry", "geometryFingerprint"],
    ]),
    placementFingerprint: projectedText(payload, [["fingerprints", "placement"]]),
    shapeFingerprint: projectedText(payload, [["fingerprints", "shape"]]),
    propertyFingerprint: projectedText(payload, [["fingerprints", "property"]]),
    topologyFingerprint: projectedText(payload, [["fingerprints", "topology"]]),
  };
}

function spatialPoint3(value: unknown): readonly [number, number, number] | null {
  if (!Array.isArray(value) || value.length !== 3) return null;
  const coordinates = value.map(finiteNumber);
  return coordinates.every((coordinate) => coordinate !== null)
    ? coordinates as [number, number, number]
    : null;
}

function exactAnalyticEnvelope(payload: unknown): SpatialAabb | null {
  const shape = cleanText(firstDefined(payload, [["profile", "shape"]]))?.toLowerCase() ?? null;
  const diameterMm = finiteNumber(firstDefined(payload, [["profile", "diameterMm"]]));
  const insulationThicknessMm = finiteNumber(firstDefined(payload, [["profile", "insulationThicknessMm"]]));
  const curveType = cleanText(firstDefined(payload, [["geometry", "centerline", "curveType"]]))?.toLowerCase() ?? null;
  const rawPoints = firstDefined(payload, [["geometry", "centerline", "points"]]);
  if (shape !== "round" || diameterMm === null || diameterMm < 0
    || insulationThicknessMm === null || insulationThicknessMm < 0
    || curveType !== "line" || !Array.isArray(rawPoints) || rawPoints.length !== 2) return null;
  const points = rawPoints.map(spatialPoint3);
  if (points.some((point) => point === null)) return null;
  const radiusMm = diameterMm / 2 + insulationThicknessMm;
  return {
    minMm: [0, 1, 2].map((axis) => Math.min(...points.map((point) => point![axis])) - radiusMm) as [number, number, number],
    maxMm: [0, 1, 2].map((axis) => Math.max(...points.map((point) => point![axis])) + radiusMm) as [number, number, number],
  };
}

function assertExactAnalyticEnvelope(payload: unknown, nodeId: string): void {
  const required = exactAnalyticEnvelope(payload);
  if (!required) return;
  const minimum = spatialPoint3(firstDefined(payload, [["geometry", "aabb", "min"]]));
  const maximum = spatialPoint3(firstDefined(payload, [["geometry", "aabb", "max"]]));
  const toleranceMm = 0.01;
  if (!minimum || !maximum || [0, 1, 2].some((axis) =>
    minimum[axis] > required.minMm[axis] + toleranceMm
    || maximum[axis] < required.maxMm[axis] - toleranceMm)) {
    throw new SpatialStoreIntegrityError(
      `Spatial v0.3 exact analytic profile AABB does not contain its diameter plus insulation envelope: ${nodeId}`,
    );
  }
}

function parseStoredObject(value: string, field: string): Record<string, unknown> {
  const parsed = parseJson(value, field);
  if (!isJsonObject(parsed)) {
    throw new SpatialStoreIntegrityError(`${field} is not a JSON object.`);
  }
  return parsed;
}

function boundedQueryLimit(value: number | undefined, fallback: number, maximum: number): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError("Spatial query limit must be a positive integer.");
  }
  return Math.min(value, maximum);
}

function cleanQueryValues(values: readonly string[] | undefined, maximum = 2_000): string[] {
  if (values && values.length > maximum) {
    throw new RangeError(`Spatial query accepts at most ${maximum} values for one filter.`);
  }
  return cleanStringArray(values ?? [], maximum);
}

function placeholders(count: number): string {
  return new Array(count).fill("?").join(", ");
}

function connectedPeerNodeIds(payload: unknown): string[] {
  const candidates = firstDefined(payload, [
    ["connectedToNodeIds"],
    ["peerNodeIds"],
    ["topology", "connectedToNodeIds"],
    ["topology", "peerNodeIds"],
    ["connectorTopology", "connectedToNodeIds"],
  ]);
  const explicitPeers = Array.isArray(candidates) ? cleanStringArray(candidates) : [];
  const connectionRefs = firstDefined(payload, [["connectionRefs"]]);
  const resolvedReferencePeers = Array.isArray(connectionRefs)
    ? cleanStringArray(connectionRefs.map((reference) => isJsonObject(reference) && reference.resolved === true
      ? reference.targetConnectorNodeId
      : null))
    : [];
  if (explicitPeers.length > 0 || resolvedReferencePeers.length > 0) {
    return cleanStringArray([...explicitPeers, ...resolvedReferencePeers]);
  }
  const relations = firstDefined(payload, [
    ["connections"],
    ["topology", "connections"],
  ]);
  if (!Array.isArray(relations)) return [];
  return cleanStringArray(relations.map((relation) => isJsonObject(relation)
    ? relation.targetNodeId ?? relation.peerNodeId ?? relation.nodeId
    : relation));
}

function connectorTopologyEvidence(payload: unknown) {
  const coverage = firstDefined(payload, [
    ["topologyCoverage"],
    ["topology", "coverage"],
    ["connectorTopology", "coverage"],
  ]);
  const coverageObject = isJsonObject(coverage) ? coverage : {};
  const reasons = cleanStringArray(coverageObject.reasons);
  const ambiguousCount = finiteInteger(
    coverageObject.ambiguousConnectorCount
    ?? coverageObject.ambiguousReferenceCount
    ?? firstDefined(payload, [["topology", "ambiguousReferenceCount"]]),
  ) ?? (coverageObject.ambiguous === true || reasons.some((reason) => reason.includes("ambiguous")) ? 1 : 0);
  const nativeUnresolvedCount = Math.max(0, finiteInteger(
    coverageObject.unresolvedConnectorCount
    ?? coverageObject.unresolvedPeerReferenceCount
    ?? coverageObject.unresolvedReferenceCount,
  ) ?? 0);
  const isConnected = firstDefined(payload, [["isConnected"]]) === true;
  const peers = connectedPeerNodeIds(payload);
  const connectedWithoutAllRefs = reasons.includes("connected_without_all_refs")
    || (isConnected && peers.length === 0 && nativeUnresolvedCount === 0);
  const declaredReferencedConnectorCount = finiteInteger(coverageObject.referencedConnectorCount);
  const declaredResolvedConnectorNodeCount = finiteInteger(coverageObject.resolvedConnectorNodeCount);
  const referencedConnectorCount = Math.max(0,
    declaredReferencedConnectorCount ?? peers.length + nativeUnresolvedCount);
  const resolvedConnectorNodeCount = Math.max(0,
    declaredResolvedConnectorNodeCount ?? peers.length);
  const countMismatchCount = declaredReferencedConnectorCount === null
      || declaredResolvedConnectorNodeCount === null
    ? 0
    : Math.abs(resolvedConnectorNodeCount - peers.length)
      + Math.abs(referencedConnectorCount - resolvedConnectorNodeCount - nativeUnresolvedCount);
  const declaredUnresolvedCount = nativeUnresolvedCount
    + (connectedWithoutAllRefs ? 1 : 0)
    + countMismatchCount;
  const readComplete = coverageObject.complete === true
    && coverageObject.isConnectedRead === true
    && coverageObject.allRefsRead === true
    && declaredUnresolvedCount === 0
    && ambiguousCount === 0;
  return {
    peers,
    ambiguousCount: Math.max(0, ambiguousCount),
    declaredUnresolvedCount: Math.max(0, declaredUnresolvedCount),
    referencedConnectorCount,
    resolvedConnectorNodeCount,
    countMismatchCount,
    readComplete,
    isConnected,
    reasons,
  };
}

function edgeIdentifier(relationType: string, sourceNodeId: string, targetNodeId: string): string {
  return `edge:${relationType}:${sha256Canonical([sourceNodeId, targetNodeId]).slice("sha256:".length)}`;
}

interface StoredNodeRow {
  snapshot_id: string;
  node_id: string;
  document_key: string;
  node_kind: string;
  element_unique_id: string | null;
  link_instance_unique_id: string | null;
  min_x: number | null;
  max_x: number | null;
  min_y: number | null;
  max_y: number | null;
  min_z: number | null;
  max_z: number | null;
  payload_json: string;
  category: string | null;
  built_in_category: string | null;
  category_role: string | null;
  level_unique_id: string | null;
  level_name: string | null;
  owner_node_id: string | null;
  system_key: string | null;
  geometry_fingerprint: string | null;
  placement_fingerprint: string | null;
  shape_fingerprint: string | null;
  property_fingerprint: string | null;
  topology_fingerprint: string | null;
}

const STORED_NODE_SELECT = `
  n.snapshot_id, n.node_id, n.document_key, n.node_kind,
  n.element_unique_id, n.link_instance_unique_id,
  n.min_x, n.max_x, n.min_y, n.max_y, n.min_z, n.max_z,
  n.payload_json, n.category, n.built_in_category, n.category_role,
  n.level_unique_id, n.level_name, n.owner_node_id, n.system_key,
  n.geometry_fingerprint, n.placement_fingerprint, n.shape_fingerprint,
  n.property_fingerprint, n.topology_fingerprint
`;

function mapStoredNode(row: StoredNodeRow): SpatialStoredNode {
  const payload = parseStoredObject(row.payload_json, "spatial node payload");
  const projection = projectSpatialNodePayload(payload);
  const hasBounds = [row.min_x, row.max_x, row.min_y, row.max_y, row.min_z, row.max_z]
    .every((value) => typeof value === "number" && Number.isFinite(value));
  return {
    snapshotId: row.snapshot_id,
    nodeId: row.node_id,
    documentKey: row.document_key,
    nodeKind: row.node_kind,
    elementUniqueId: row.element_unique_id,
    linkInstanceUniqueId: row.link_instance_unique_id,
    aabb: hasBounds ? {
      minMm: [row.min_x!, row.min_y!, row.min_z!],
      maxMm: [row.max_x!, row.max_y!, row.max_z!],
    } : null,
    category: row.category ?? projection.category,
    builtInCategory: row.built_in_category ?? projection.builtInCategory,
    categoryRole: row.category_role ?? projection.categoryRole,
    levelUniqueId: row.level_unique_id ?? projection.levelUniqueId,
    levelName: row.level_name ?? projection.levelName,
    ownerNodeId: row.owner_node_id ?? projection.ownerNodeId,
    systemKey: row.system_key ?? projection.systemKey,
    geometryFingerprint: row.geometry_fingerprint ?? projection.geometryFingerprint,
    placementFingerprint: row.placement_fingerprint ?? projection.placementFingerprint,
    shapeFingerprint: row.shape_fingerprint ?? projection.shapeFingerprint,
    propertyFingerprint: row.property_fingerprint ?? projection.propertyFingerprint,
    topologyFingerprint: row.topology_fingerprint ?? projection.topologyFingerprint,
    payload,
  };
}

interface StoredEdgeRow {
  snapshot_id: string;
  edge_id: string;
  source_node_id: string;
  target_node_id: string;
  relation_type: string;
  relation_policy_version: string;
  fingerprint: string;
  bidirectional: number;
  payload_json: string;
}

function mapStoredEdge(row: StoredEdgeRow): SpatialStoredEdge {
  return {
    snapshotId: row.snapshot_id,
    edgeId: row.edge_id,
    sourceNodeId: row.source_node_id,
    targetNodeId: row.target_node_id,
    relationType: row.relation_type,
    relationPolicyVersion: row.relation_policy_version,
    fingerprint: row.fingerprint,
    bidirectional: row.bidirectional === 1,
    payload: parseStoredObject(row.payload_json, "spatial edge payload"),
  };
}

function normalizeAabb(aabb: SpatialAabb | null | undefined): readonly (number | null)[] {
  if (!aabb) {
    return [null, null, null, null, null, null];
  }
  const values = [...aabb.minMm, ...aabb.maxMm];
  if (values.some((value) => !Number.isFinite(value))) {
    throw new RangeError("Spatial AABB coordinates must be finite numbers.");
  }
  for (let axis = 0; axis < 3; axis += 1) {
    if (aabb.minMm[axis] > aabb.maxMm[axis]) {
      throw new RangeError(`Spatial AABB min exceeds max on axis ${axis}.`);
    }
  }
  return [
    aabb.minMm[0], aabb.maxMm[0],
    aabb.minMm[1], aabb.maxMm[1],
    aabb.minMm[2], aabb.maxMm[2],
  ];
}

function versionNumber(version: SpatialStoreSchemaVersion): number {
  return version.major * 1_000 + version.minor;
}

function compareVersions(
  left: SpatialStoreSchemaVersion,
  right: SpatialStoreSchemaVersion,
): number {
  return versionNumber(left) - versionNumber(right);
}

function tableExists(database: Database.Database, tableName: string): boolean {
  const row = database.prepare(
    "SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = ?",
  ).get(tableName) as { found: number } | undefined;
  return row?.found === 1;
}

function tableColumns(database: Database.Database, tableName: string): Set<string> {
  if (!tableExists(database, tableName)) return new Set<string>();
  const rows = database.pragma(`table_info('${tableName.replaceAll("'", "''")}')`) as Array<{ name: string }>;
  return new Set(rows.map((row) => row.name));
}

function applySchema12Migration(database: Database.Database): void {
  for (const tableName of ["spatial_nodes", "spatial_staging_nodes"]) {
    if (!tableExists(database, tableName)) continue;
    const columns = tableColumns(database, tableName);
    for (const column of SPATIAL_NODE_PROJECTION_COLUMNS) {
      if (!columns.has(column)) {
        database.exec(`ALTER TABLE ${tableName} ADD COLUMN ${column} TEXT`);
      }
    }
  }

  const nodeColumns = tableColumns(database, "spatial_nodes");
  const createNodeIndex = (name: string, columns: readonly string[]) => {
    if (columns.every((column) => nodeColumns.has(column))) {
      database.exec(`CREATE INDEX IF NOT EXISTS ${name} ON spatial_nodes(${columns.join(", ")})`);
    }
  };
  createNodeIndex("spatial_nodes_kind", ["snapshot_id", "node_kind", "node_id"]);
  createNodeIndex("spatial_nodes_category", ["snapshot_id", "category", "node_id"]);
  createNodeIndex("spatial_nodes_built_in_category", ["snapshot_id", "built_in_category", "node_id"]);
  createNodeIndex("spatial_nodes_role", ["snapshot_id", "category_role", "node_id"]);
  createNodeIndex("spatial_nodes_level_name", ["snapshot_id", "level_name", "node_id"]);
  createNodeIndex("spatial_nodes_level_unique_id", ["snapshot_id", "level_unique_id", "node_id"]);
  createNodeIndex("spatial_nodes_system", ["snapshot_id", "system_key", "node_id"]);
  createNodeIndex("spatial_nodes_owner", ["snapshot_id", "owner_node_id", "node_id"]);
  createNodeIndex("spatial_nodes_z_band", ["snapshot_id", "min_z", "max_z", "node_id"]);

  if (!tableExists(database, "spatial_edges")) {
    database.exec(SCHEMA_1_2_EDGE_SQL);
  }
  database.exec(SCHEMA_1_2_TOPOLOGY_SQL);
}

function readSchemaVersion(database: Database.Database): SpatialStoreSchemaVersion {
  if (!tableExists(database, "spatial_store_metadata")) {
    return { major: 0, minor: 0 };
  }
  const rows = database.prepare(
    "SELECT key, value FROM spatial_store_metadata WHERE key IN ('schema_major', 'schema_minor')",
  ).all() as Array<{ key: string; value: string }>;
  const values = new Map(rows.map((row) => [row.key, row.value]));
  const major = Number.parseInt(values.get("schema_major") ?? "", 10);
  const minor = Number.parseInt(values.get("schema_minor") ?? "", 10);
  if (!Number.isSafeInteger(major) || major < 0 || !Number.isSafeInteger(minor) || minor < 0) {
    throw new SpatialStoreIntegrityError("Spatial store schema metadata is missing or invalid.");
  }
  return { major, minor };
}

function quickCheck(database: Database.Database): void {
  const rows = database.pragma("quick_check") as Array<Record<string, unknown>>;
  const results = rows.flatMap((row) => Object.values(row).map(String));
  if (results.length !== 1 || results[0].toLowerCase() !== "ok") {
    throw new SpatialStoreIntegrityError(`SQLite quick_check failed: ${results.join("; ") || "no result"}`);
  }
}

function backupCandidates(databasePath: string): string[] {
  const folder = dirname(databasePath);
  const prefix = `${basename(databasePath)}.migration-backup-`;
  if (!existsSync(folder)) {
    return [];
  }
  return readdirSync(folder)
    .filter((entry) => entry.startsWith(prefix))
    .map((entry) => join(folder, entry))
    .filter((entry) => {
      try {
        return statSync(entry).isFile();
      } catch {
        return false;
      }
    })
    .sort((left, right) => {
      const modifiedOrder = statSync(right).mtimeMs - statSync(left).mtimeMs;
      if (modifiedOrder !== 0) return modifiedOrder;
      return right < left ? -1 : right > left ? 1 : 0;
    });
}

function removeSqliteSidecars(databasePath: string): void {
  rmSync(`${databasePath}-wal`, { force: true });
  rmSync(`${databasePath}-shm`, { force: true });
}

function restoreDatabaseFile(databasePath: string, backupPath: string): void {
  removeSqliteSidecars(databasePath);
  copyFileSync(backupPath, databasePath);
}

function createMigrationBackup(
  database: Database.Database,
  databasePath: string,
  nowMs: number,
): string {
  const suffix = `${nowMs}-${process.pid}-${backupSerial++}`;
  const backupPath = `${databasePath}.migration-backup-${suffix}`;
  const escaped = backupPath.replaceAll("'", "''");
  database.exec(`VACUUM INTO '${escaped}'`);
  let verification: Database.Database | null = null;
  try {
    verification = new Database(backupPath, { readonly: true, fileMustExist: true });
    quickCheck(verification);
  } catch (error) {
    try {
      verification?.close();
    } catch {
      // Preserve the verification error.
    }
    rmSync(backupPath, { force: true });
    throw new SpatialStoreIntegrityError(
      `New spatial recovery backup failed SQLite quick_check: ${backupPath}`,
      { cause: error },
    );
  }
  verification.close();
  return backupPath;
}

function pruneMigrationBackups(databasePath: string, keep = 3): void {
  for (const oldBackup of backupCandidates(databasePath).slice(keep)) {
    rmSync(oldBackup, { force: true });
  }
}

function configureDatabase(database: Database.Database): void {
  database.pragma("foreign_keys = ON");
  database.pragma("busy_timeout = 5000");
  database.pragma("journal_mode = WAL");
  database.pragma("synchronous = FULL");
}

function openWithRecovery(databasePath: string): {
  database: Database.Database;
  recoveredFromBackupPath: string | null;
} {
  let database: Database.Database | null = null;
  try {
    database = new Database(databasePath);
    quickCheck(database);
    configureDatabase(database);
    return { database, recoveredFromBackupPath: null };
  } catch (error) {
    try {
      database?.close();
    } catch {
      // Best effort before file restoration.
    }
    const backupPath = backupCandidates(databasePath)[0];
    if (!backupPath) {
      throw new SpatialStoreIntegrityError(
        "Spatial store failed SQLite quick_check and no migration backup is available.",
        { cause: error },
      );
    }
    restoreDatabaseFile(databasePath, backupPath);
    let recovered: Database.Database | null = null;
    try {
      recovered = new Database(databasePath);
      quickCheck(recovered);
      configureDatabase(recovered);
      return { database: recovered, recoveredFromBackupPath: backupPath };
    } catch (recoveryError) {
      try {
        recovered?.close();
      } catch {
        // Preserve the recovery error.
      }
      throw new SpatialStoreIntegrityError(
        `Spatial store recovery from ${backupPath} failed.`,
        { cause: recoveryError },
      );
    }
  }
}

function writeSchemaVersion(
  database: Database.Database,
  version: SpatialStoreSchemaVersion,
): void {
  const upsert = database.prepare(
    "INSERT OR REPLACE INTO spatial_store_metadata(key, value) VALUES (?, ?)",
  );
  upsert.run("schema_major", String(version.major));
  upsert.run("schema_minor", String(version.minor));
  upsert.run("schema_version", `${version.major}.${version.minor}`);
  database.pragma(`user_version = ${versionNumber(version)}`);
}

function applyMigrations(
  database: Database.Database,
  databasePath: string,
  existedBeforeOpen: boolean,
  nowMs: number,
  hooks: SpatialStoreTestHooks | undefined,
): void {
  const current = readSchemaVersion(database);
  const target = {
    major: SPATIAL_STORE_SCHEMA_MAJOR,
    minor: SPATIAL_STORE_SCHEMA_MINOR,
  };
  if (compareVersions(current, target) > 0) {
    throw new SpatialStoreMigrationError(
      `Spatial store schema ${current.major}.${current.minor} is newer than supported ${target.major}.${target.minor}.`,
      null,
    );
  }
  if (compareVersions(current, target) === 0) {
    return;
  }

  const backupPath = existedBeforeOpen && existsSync(databasePath) && statSync(databasePath).size > 0
    ? createMigrationBackup(database, databasePath, nowMs)
    : null;

  try {
    database.transaction(() => {
      let working = current;
      if (current.major === 0 && current.minor === 0) {
        database.exec(INITIAL_SCHEMA_SQL);
        working = { major: 1, minor: 0 };
        writeSchemaVersion(database, working);
      }
      if (working.major === 1 && working.minor === 0) {
        database.exec(SCHEMA_1_1_MIGRATION_SQL);
        working = { major: 1, minor: 1 };
        writeSchemaVersion(database, working);
      }
      if (working.major === 1 && working.minor === 1) {
        applySchema12Migration(database);
        working = { major: 1, minor: 2 };
        writeSchemaVersion(database, working);
      }
      if (compareVersions(working, target) !== 0) {
        throw new Error(`No migration path from ${working.major}.${working.minor}.`);
      }
      hooks?.beforeMigrationCommit?.(current, target);
    })();
    quickCheck(database);
    pruneMigrationBackups(databasePath);
  } catch (error) {
    try {
      database.close();
    } finally {
      if (backupPath) {
        restoreDatabaseFile(databasePath, backupPath);
      }
    }
    throw new SpatialStoreMigrationError(
      `Spatial store migration ${current.major}.${current.minor} -> ${target.major}.${target.minor} failed${backupPath ? " and the pre-migration backup was restored" : ""}.`,
      backupPath,
      { cause: error },
    );
  }
}

function assertRTree(database: Database.Database): void {
  try {
    database.prepare("SELECT count(*) AS count FROM spatial_node_rtree").get();
  } catch (error) {
    throw new SpatialRTreeUnavailableError(
      "SQLite R*Tree support is unavailable; spatial indexing cannot fall back to a full table scan.",
      { cause: error },
    );
  }
}

function pathContains(parentPath: string, childPath: string): boolean {
  const pathFromParent = relative(resolve(parentPath), resolve(childPath));
  return pathFromParent === "" || (!pathFromParent.startsWith("..") && !isAbsolute(pathFromParent));
}

function removeArtifacts(
  paths: readonly string[],
  artifactRoot: string,
): { removed: number; warnings: string[] } {
  let removed = 0;
  const warnings: string[] = [];
  for (const artifactPath of [...new Set(paths)]) {
    const normalized = resolve(artifactPath);
    if (normalized === artifactRoot || !pathContains(artifactRoot, normalized)) {
      warnings.push(`Refused to remove an artifact outside the dedicated spatial artifact root: ${normalized}`);
      continue;
    }
    try {
      if (existsSync(normalized)) {
        rmSync(normalized, { recursive: true, force: true });
        removed += 1;
      }
    } catch (error) {
      warnings.push(`Failed to remove registered spatial artifact ${normalized}: ${String(error)}`);
    }
  }
  return { removed, warnings };
}

export class SpatialStore {
  public readonly databasePath: string;
  public readonly artifactRoot: string;
  public readonly recoveredFromBackupPath: string | null;
  private readonly now: () => number;
  private readonly testHooks: SpatialStoreTestHooks;
  private readonly configuredRetentionPolicy: Omit<SpatialRetentionOptions, "nowMs"> | false;
  private database: Database.Database;
  private closed = false;

  public constructor(options: SpatialStoreOptions = {}) {
    const driveTypeReader = options.testHooks?.readWindowsDriveType;
    this.databasePath = resolveSpatialDatabasePath(options.databasePath, driveTypeReader);
    this.artifactRoot = resolveSpatialArtifactRoot(this.databasePath, options.artifactRoot, driveTypeReader);
    this.now = options.now ?? Date.now;
    this.testHooks = options.testHooks ?? {};
    const environmentRetention = options.retentionPolicy === undefined
      ? readEnvironmentRetentionPolicy()
      : undefined;
    const retentionPolicy = options.retentionPolicy !== undefined
      ? options.retentionPolicy
      : environmentRetention;
    this.configuredRetentionPolicy = retentionPolicy === false
      ? false
      : { ...(retentionPolicy ?? {}) };
    mkdirSync(dirname(this.databasePath), { recursive: true });
    mkdirSync(this.artifactRoot, { recursive: true });
    const existedBeforeOpen = existsSync(this.databasePath);
    const opened = openWithRecovery(this.databasePath);
    this.database = opened.database;
    this.recoveredFromBackupPath = opened.recoveredFromBackupPath;
    try {
      applyMigrations(
        this.database,
        this.databasePath,
        existedBeforeOpen,
        this.now(),
        options.testHooks,
      );
      assertRTree(this.database);
      if (options.cleanupExpiredStagingOnOpen !== false) {
        this.cleanupExpiredStaging(this.now());
      }
      this.applyConfiguredRetention();
    } catch (error) {
      try {
        this.database.close();
      } catch {
        // Preserve the initialization failure. A closed/failed constructor is
        // never published by the store manager.
      }
      this.closed = true;
      throw error;
    }
  }

  public close(): void {
    if (this.closed) {
      return;
    }
    this.database.pragma("wal_checkpoint(TRUNCATE)");
    this.database.close();
    this.closed = true;
  }

  public getSchemaVersion(): SpatialStoreSchemaVersion {
    this.assertOpen();
    return readSchemaVersion(this.database);
  }

  public isRTreeAvailable(): boolean {
    this.assertOpen();
    assertRTree(this.database);
    return true;
  }

  public beginCapture(input: BeginSpatialCaptureInput): void {
    this.assertOpen();
    const nowMs = requireNonNegativeInteger(this.now(), "current time");
    const capturedAtMs = requireNonNegativeInteger(input.capturedAtMs ?? nowMs, "capturedAtMs");
    const expiresAtMs = requireNonNegativeInteger(
      input.expiresAtMs ?? nowMs + DEFAULT_CAPTURE_LEASE_MS,
      "expiresAtMs",
    );
    if (expiresAtMs <= nowMs) {
      throw new RangeError("expiresAtMs must be in the future when a capture begins.");
    }
    const artifactPaths = (input.artifactPaths ?? []).map((artifactPath) => {
      const normalized = resolve(requireText(artifactPath, "artifactPath"));
      if (normalized === this.artifactRoot || !pathContains(this.artifactRoot, normalized)) {
        throw new SpatialStorePathError(
          "artifact_path",
          `A spatial artifact must be a child of the dedicated artifact root ${this.artifactRoot}: ${normalized}`,
        );
      }
      return normalized;
    });

    this.database.transaction(() => {
      this.database.prepare(`
        INSERT INTO spatial_capture_staging(
          capture_id, snapshot_id, document_key, scope_fingerprint,
          revision_fingerprint, schema_version, extractor_version,
          scope_json, declared_counts_json, effective_source_policy_json,
          coverage_json, transform_validation_json, capture_metadata_json,
          captured_at_ms, created_at_ms, updated_at_ms, expires_at_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        requireText(input.captureId, "captureId"),
        requireText(input.snapshotId, "snapshotId"),
        requireText(input.documentKey, "documentKey"),
        requireText(input.scopeFingerprint, "scopeFingerprint"),
        requireText(input.revisionFingerprint, "revisionFingerprint"),
        requireText(input.schemaVersion, "schemaVersion"),
        requireText(input.extractorVersion, "extractorVersion"),
        stringifyJson(input.scope, "scope"),
        input.counts === undefined ? null : stringifyJson(input.counts, "counts"),
        input.effectiveSourcePolicy === undefined
          ? null
          : stringifyJson(input.effectiveSourcePolicy, "effectiveSourcePolicy"),
        input.coverage === undefined ? null : stringifyJson(input.coverage, "coverage"),
        input.transformValidation === undefined
          ? null
          : stringifyJson(input.transformValidation, "transformValidation"),
        stringifyJson(input.captureMetadata ?? {}, "captureMetadata"),
        capturedAtMs,
        nowMs,
        nowMs,
        expiresAtMs,
      );
      const insertArtifact = this.database.prepare(
        "INSERT INTO spatial_staging_artifacts(capture_id, artifact_path) VALUES (?, ?)",
      );
      for (const artifactPath of new Set(artifactPaths)) {
        insertArtifact.run(input.captureId, artifactPath);
      }
    })();
  }

  public stagePage(input: StageSpatialPageInput): void {
    this.assertOpen();
    const ordinal = requireNonNegativeInteger(input.ordinal, "page ordinal");
    const payloadBytes = requireNonNegativeInteger(input.payloadBytes, "payloadBytes");
    const omissions = input.omissions ?? [];

    this.database.transaction(() => {
      const capture = this.database.prepare(
        "SELECT * FROM spatial_capture_staging WHERE capture_id = ?",
      ).get(input.captureId) as CaptureRow | undefined;
      if (!capture) {
        throw new Error(`Unknown spatial capture: ${input.captureId}`);
      }
      if (capture.expires_at_ms <= this.now()) {
        throw new Error(`Spatial capture lease expired: ${input.captureId}`);
      }
      const previous = this.database.prepare(`
        SELECT page_ordinal, page_hash, has_more
        FROM spatial_staging_pages
        WHERE capture_id = ?
        ORDER BY page_ordinal DESC
        LIMIT 1
      `).get(input.captureId) as PageRow | undefined;
      const expectedOrdinal = previous ? previous.page_ordinal + 1 : 0;
      if (ordinal !== expectedOrdinal) {
        throw new Error(`Expected spatial page ordinal ${expectedOrdinal}, received ${ordinal}.`);
      }
      if (previous && previous.has_more !== 1) {
        throw new Error("Cannot append a page after a terminal spatial page.");
      }
      const priorPageHash = input.priorPageHash?.trim() || null;
      if (previous && priorPageHash !== previous.page_hash) {
        throw new Error("Spatial page priorPageHash does not match the staged page chain.");
      }
      if (!previous && priorPageHash !== null) {
        throw new Error("The first spatial page must not declare a priorPageHash.");
      }

      this.database.prepare(`
        INSERT INTO spatial_staging_pages(
          capture_id, page_ordinal, prior_page_hash, page_hash, has_more,
          payload_bytes, record_count, omission_count
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        input.captureId,
        ordinal,
        priorPageHash,
        requireText(input.pageHash, "pageHash"),
        input.hasMore ? 1 : 0,
        payloadBytes,
        input.nodes.length,
        omissions.length,
      );

      const insertNode = this.database.prepare(`
        INSERT INTO spatial_staging_nodes(
          capture_id, page_ordinal, node_id, document_key, node_kind,
          element_unique_id, link_instance_unique_id,
          min_x, max_x, min_y, max_y, min_z, max_z, payload_json,
          category, built_in_category, category_role,
          level_unique_id, level_name, owner_node_id, system_key,
          geometry_fingerprint, placement_fingerprint, shape_fingerprint,
          property_fingerprint, topology_fingerprint
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const node of input.nodes) {
        const bounds = normalizeAabb(node.aabb);
        const projection = projectSpatialNodePayload(node.payload);
        insertNode.run(
          input.captureId,
          ordinal,
          requireText(node.nodeId, "nodeId"),
          requireText(node.documentKey, "node.documentKey"),
          requireText(node.nodeKind, "nodeKind"),
          node.elementUniqueId?.trim() || null,
          node.linkInstanceUniqueId?.trim() || null,
          ...bounds,
          stringifyJson(node.payload, "node.payload"),
          projection.category,
          projection.builtInCategory,
          projection.categoryRole,
          projection.levelUniqueId,
          projection.levelName,
          projection.ownerNodeId,
          projection.systemKey,
          projection.geometryFingerprint,
          projection.placementFingerprint,
          projection.shapeFingerprint,
          projection.propertyFingerprint,
          projection.topologyFingerprint,
        );
      }

      const insertOmission = this.database.prepare(`
        INSERT INTO spatial_staging_omissions(
          capture_id, page_ordinal, document_key, reason, source_identity, payload_json
        ) VALUES (?, ?, ?, ?, ?, ?)
      `);
      for (const omission of omissions) {
        insertOmission.run(
          input.captureId,
          ordinal,
          requireText(omission.documentKey, "omission.documentKey"),
          requireText(omission.reason, "omission.reason"),
          omission.sourceIdentity?.trim() || null,
          stringifyJson(omission.payload, "omission.payload"),
        );
      }
      this.database.prepare(
        "UPDATE spatial_capture_staging SET updated_at_ms = ? WHERE capture_id = ?",
      ).run(this.now(), input.captureId);
    })();
  }

  public commitCapture(input: CommitSpatialCaptureInput): SpatialSnapshotSummary {
    this.assertOpen();
    if (input.sourceRevisions.length === 0) {
      throw new Error("An atomic spatial snapshot requires at least one source revision.");
    }
    if (!input.partial && input.coverageStatus && input.coverageStatus !== "complete") {
      throw new Error("A non-partial spatial snapshot cannot have incomplete coverageStatus.");
    }
    const expectedPageCount = requireNonNegativeInteger(input.expectedPageCount, "expectedPageCount");
    const expectedPayloadBytes = requireNonNegativeInteger(input.expectedPayloadBytes, "expectedPayloadBytes");
    const expectedNodeCount = requireNonNegativeInteger(input.expectedNodeCount, "expectedNodeCount");
    const expectedOmissionCount = requireNonNegativeInteger(input.expectedOmissionCount, "expectedOmissionCount");
    if (expectedPageCount < 1) {
      throw new RangeError("expectedPageCount must be greater than zero.");
    }
    const expectedNodesByKind = Object.fromEntries(
      Object.entries(input.expectedNodesByKind).map(([nodeKind, count]) => [
        requireText(nodeKind, "expected node kind"),
        requireNonNegativeInteger(count, `expectedNodesByKind.${nodeKind}`),
      ]),
    );
    if (Object.values(expectedNodesByKind).reduce((sum, count) => sum + count, 0) !== expectedNodeCount) {
      throw new SpatialStoreIntegrityError("Expected node-kind counts do not sum to expectedNodeCount.");
    }
    const finalCountsJson = stringifyJson(input.counts, "final counts");
    const finalEffectiveSourcePolicyJson = input.effectiveSourcePolicy === undefined
      ? null
      : stringifyJson(input.effectiveSourcePolicy, "final effectiveSourcePolicy");
    const finalCoverageJson = stringifyJson(input.coverage, "final coverage");
    const finalTransformValidationJson = input.transformValidation === undefined
      ? null
      : stringifyJson(input.transformValidation, "final transformValidation");

    const snapshotId = this.database.transaction(() => {
      const capture = this.database.prepare(
        "SELECT * FROM spatial_capture_staging WHERE capture_id = ?",
      ).get(input.captureId) as CaptureRow | undefined;
      if (!capture) {
        throw new Error(`Unknown spatial capture: ${input.captureId}`);
      }
      if (capture.expires_at_ms <= this.now()) {
        throw new Error(`Spatial capture lease expired: ${input.captureId}`);
      }
      if (!input.sourceRevisions.some((source) => source.documentKey === capture.document_key)) {
        throw new Error("Spatial source revisions do not include the capture host documentKey.");
      }

      const pages = this.database.prepare(`
        SELECT page_ordinal, page_hash, has_more
        FROM spatial_staging_pages
        WHERE capture_id = ?
        ORDER BY page_ordinal
      `).all(input.captureId) as PageRow[];
      if (pages.length === 0 || pages.at(-1)?.has_more !== 0) {
        throw new Error("Atomic spatial capture cannot commit before its terminal page is staged.");
      }
      pages.forEach((page, index) => {
        if (page.page_ordinal !== index) {
          throw new Error("Atomic spatial capture contains a non-contiguous page sequence.");
        }
      });

      const aggregate = this.database.prepare(`
        SELECT
          COALESCE(SUM(payload_bytes), 0) AS payload_bytes,
          COALESCE(SUM(record_count), 0) AS node_count,
          COALESCE(SUM(omission_count), 0) AS omission_count
        FROM spatial_staging_pages
        WHERE capture_id = ?
      `).get(input.captureId) as {
        payload_bytes: number;
        node_count: number;
        omission_count: number;
      };
      const nodesByKind = this.database.prepare(`
        SELECT node_kind, count(*) AS count
        FROM spatial_staging_nodes
        WHERE capture_id = ?
        GROUP BY node_kind
        ORDER BY node_kind
      `).all(input.captureId) as Array<{ node_kind: string; count: number }>;
      const omissionsByReason = this.database.prepare(`
        SELECT reason, count(*) AS count
        FROM spatial_staging_omissions
        WHERE capture_id = ?
        GROUP BY reason
        ORDER BY reason
      `).all(input.captureId) as Array<{ reason: string; count: number }>;
      const actualNodesByKind = Object.fromEntries(
        nodesByKind.map((row) => [row.node_kind, row.count]),
      ) as Record<string, number>;
      const countMismatches: string[] = [];
      if (pages.length !== expectedPageCount) {
        countMismatches.push(`pages expected ${expectedPageCount}, staged ${pages.length}`);
      }
      if (aggregate.payload_bytes !== expectedPayloadBytes) {
        countMismatches.push(`payloadBytes expected ${expectedPayloadBytes}, staged ${aggregate.payload_bytes}`);
      }
      if (aggregate.node_count !== expectedNodeCount) {
        countMismatches.push(`nodes expected ${expectedNodeCount}, staged ${aggregate.node_count}`);
      }
      if (aggregate.omission_count !== expectedOmissionCount) {
        countMismatches.push(`omissions expected ${expectedOmissionCount}, staged ${aggregate.omission_count}`);
      }
      for (const nodeKind of new Set([
        ...Object.keys(expectedNodesByKind),
        ...Object.keys(actualNodesByKind),
      ])) {
        const expected = expectedNodesByKind[nodeKind] ?? 0;
        const actual = actualNodesByKind[nodeKind] ?? 0;
        if (expected !== actual) {
          countMismatches.push(`${nodeKind} nodes expected ${expected}, staged ${actual}`);
        }
      }
      if (countMismatches.length > 0) {
        throw new SpatialStoreIntegrityError(
          `Atomic spatial capture count reconciliation failed: ${countMismatches.join("; ")}.`,
        );
      }
      const countsJson = stringifyJson({
        totalNodes: aggregate.node_count,
        nodesByKind: Object.fromEntries(nodesByKind.map((row) => [row.node_kind, row.count])),
        omittedSupportedNodes: aggregate.omission_count,
        omissionsByReason: Object.fromEntries(omissionsByReason.map((row) => [row.reason, row.count])),
      }, "snapshot counts");

      this.database.prepare(`
        INSERT INTO spatial_snapshots(
          snapshot_id, document_key, captured_at_ms, committed_at_ms,
          scope_fingerprint, revision_fingerprint, schema_version, extractor_version,
          scope_json, declared_counts_json, effective_source_policy_json,
          coverage_json, transform_validation_json, capture_metadata_json,
          complete, partial, coverage_status, scan_stopped_reason,
          suggested_next_scopes_json, counts_json, page_count, payload_bytes
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        capture.snapshot_id,
        capture.document_key,
        capture.captured_at_ms,
        this.now(),
        capture.scope_fingerprint,
        capture.revision_fingerprint,
        capture.schema_version,
        capture.extractor_version,
        capture.scope_json,
        finalCountsJson,
        finalEffectiveSourcePolicyJson,
        finalCoverageJson,
        finalTransformValidationJson,
        capture.capture_metadata_json,
        input.partial ? 0 : 1,
        input.partial ? 1 : 0,
        input.coverageStatus ?? null,
        requireText(input.scanStoppedReason, "scanStoppedReason"),
        stringifyJson(input.suggestedNextScopes ?? [], "suggestedNextScopes"),
        countsJson,
        pages.length,
        aggregate.payload_bytes,
      );

      const insertSource = this.database.prepare(`
        INSERT INTO spatial_snapshot_sources(
          snapshot_id, source_key, document_key, document_session_id,
          tracker_session_id, loaded_version, change_sequence, change_sequence_state,
          oldest_retained_sequence, journal_entry_count, journal_capacity,
          journal_truncated, link_instance_unique_id, source_to_host_transform_json,
          document_key_resolution_json, external_link_update_available,
          source_revision_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      const sourceKeys = new Set<string>();
      for (const source of input.sourceRevisions) {
        requireNonNegativeInteger(source.changeSequence, "source changeSequence");
        if (source.oldestRetainedSequence !== undefined && source.oldestRetainedSequence !== null) {
          requireNonNegativeInteger(source.oldestRetainedSequence, "source oldestRetainedSequence");
        }
        if (source.journalEntryCount !== undefined && source.journalEntryCount !== null) {
          requireNonNegativeInteger(source.journalEntryCount, "source journalEntryCount");
        }
        if (source.journalCapacity !== undefined && source.journalCapacity !== null) {
          requireNonNegativeInteger(source.journalCapacity, "source journalCapacity");
          if (source.journalCapacity === 0) {
            throw new RangeError("source journalCapacity must be greater than zero.");
          }
        }
        if (source.journalEntryCount !== undefined && source.journalEntryCount !== null
          && source.journalCapacity !== undefined && source.journalCapacity !== null
          && source.journalEntryCount > source.journalCapacity) {
          throw new RangeError("source journalEntryCount cannot exceed journalCapacity.");
        }
        const sourceKey = spatialSourceKey(source);
        if (sourceKeys.has(sourceKey)) {
          throw new Error(`Duplicate spatial source revision: ${sourceKey}`);
        }
        sourceKeys.add(sourceKey);
        insertSource.run(
          capture.snapshot_id,
          sourceKey,
          requireText(source.documentKey, "source.documentKey"),
          requireText(source.documentSessionId, "source.documentSessionId"),
          source.trackerSessionId?.trim() || null,
          requireText(source.loadedVersion, "source.loadedVersion"),
          source.changeSequence,
          source.changeSequenceState?.trim() || null,
          source.oldestRetainedSequence ?? null,
          source.journalEntryCount ?? null,
          source.journalCapacity ?? null,
          source.journalTruncated ? 1 : 0,
          source.linkInstanceUniqueId?.trim() || null,
          stringifyJson(source.sourceToHostTransform, "source.sourceToHostTransform"),
          source.documentKeyResolution === undefined
            ? null
            : stringifyJson(source.documentKeyResolution, "source.documentKeyResolution"),
          source.externalLinkUpdateAvailable ? 1 : 0,
          stringifyJson(source, "source revision"),
        );
      }

      this.database.prepare(`
        INSERT INTO spatial_nodes(
          snapshot_id, node_id, document_key, node_kind,
          element_unique_id, link_instance_unique_id,
          min_x, max_x, min_y, max_y, min_z, max_z, payload_json,
          category, built_in_category, category_role,
          level_unique_id, level_name, owner_node_id, system_key,
          geometry_fingerprint, placement_fingerprint, shape_fingerprint,
          property_fingerprint, topology_fingerprint
        )
        SELECT ?, node_id, document_key, node_kind,
          element_unique_id, link_instance_unique_id,
          min_x, max_x, min_y, max_y, min_z, max_z, payload_json,
          category, built_in_category, category_role,
          level_unique_id, level_name, owner_node_id, system_key,
          geometry_fingerprint, placement_fingerprint, shape_fingerprint,
          property_fingerprint, topology_fingerprint
        FROM spatial_staging_nodes
        WHERE capture_id = ?
        ORDER BY page_ordinal, staging_node_rowid
      `).run(capture.snapshot_id, input.captureId);

      this.rebuildSnapshotEdges(capture.snapshot_id);

      this.database.prepare(`
        INSERT INTO spatial_omissions(
          snapshot_id, document_key, reason, source_identity, payload_json
        )
        SELECT ?, document_key, reason, source_identity, payload_json
        FROM spatial_staging_omissions
        WHERE capture_id = ?
        ORDER BY page_ordinal, staging_omission_rowid
      `).run(capture.snapshot_id, input.captureId);

      this.database.prepare(`
        INSERT INTO spatial_snapshot_artifacts(snapshot_id, artifact_path)
        SELECT ?, artifact_path
        FROM spatial_staging_artifacts
        WHERE capture_id = ?
      `).run(capture.snapshot_id, input.captureId);

      this.database.prepare(
        "DELETE FROM spatial_capture_staging WHERE capture_id = ?",
      ).run(input.captureId);
      return capture.snapshot_id;
    })();

    const summary = this.getSnapshot(snapshotId);
    if (!summary) {
      throw new SpatialStoreIntegrityError(`Committed spatial snapshot ${snapshotId} is not readable.`);
    }
    return summary;
  }

  private rebuildSnapshotEdges(snapshotId: string): void {
    const snapshotRow = this.database.prepare(`
      SELECT schema_version AS schemaVersion
      FROM spatial_snapshots WHERE snapshot_id = ?
    `).get(snapshotId) as { schemaVersion: string } | undefined;
    const schemaVersion = snapshotRow?.schemaVersion ?? "";
    const rows = this.database.prepare(`
      SELECT node_id, node_kind, owner_node_id, payload_json
      FROM spatial_nodes
      WHERE snapshot_id = ?
      ORDER BY node_id
    `).all(snapshotId) as Array<{
      node_id: string;
      node_kind: string;
      owner_node_id: string | null;
      payload_json: string;
    }>;
    const nodeKinds = new Map(rows.map((row) => [row.node_id, row.node_kind] as const));
    let connectorCount = 0;
    let declaredPeerReferenceCount = 0;
    let resolvedPeerReferenceCount = 0;
    let nativeUnresolvedPeerReferenceCount = 0;
    let membershipUnresolvedPeerReferenceCount = 0;
    let ambiguousConnectorCount = 0;
    let readComplete = schemaVersion === "0.3";
    const unresolvedPeerNodeIds = new Set<string>();
    const insert = this.database.prepare(`
      INSERT OR IGNORE INTO spatial_edges(
        snapshot_id, edge_id, source_node_id, target_node_id,
        relation_type, relation_policy_version, fingerprint,
        bidirectional, payload_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const policyVersion = "phase1b-topology/1";
    const connectorEntries = rows
      .filter((row) => row.node_kind === "connector")
      .map((row) => {
      const payload = parseStoredObject(row.payload_json, "spatial connector payload");
        return {
          row,
          payload,
          topologyEvidence: connectorTopologyEvidence(payload),
          ownerNodeId: row.owner_node_id ?? projectSpatialNodePayload(payload).ownerNodeId,
        };
      });
    if (schemaVersion === "0.3") {
      for (const row of rows) {
        assertExactAnalyticEnvelope(
          parseStoredObject(row.payload_json, `spatial node ${row.node_id} payload`),
          row.node_id,
        );
      }
    }
    const connectorEvidenceByNodeId = new Map(connectorEntries.map((entry) => [
      entry.row.node_id,
      entry.topologyEvidence,
    ] as const));
    connectorCount = connectorEntries.length;
    for (const { row, topologyEvidence, ownerNodeId } of connectorEntries) {
      readComplete = readComplete && topologyEvidence.readComplete;
      ambiguousConnectorCount += topologyEvidence.ambiguousCount;
      nativeUnresolvedPeerReferenceCount += topologyEvidence.declaredUnresolvedCount;
      declaredPeerReferenceCount += topologyEvidence.referencedConnectorCount;
      if (ownerNodeId && nodeKinds.get(ownerNodeId) === "revit_element") {
        const edgePayload = {
          basis: "connector_owner_identity",
          precisionClass: "measured",
          verdictCapability: "context_only",
        };
        insert.run(
          snapshotId,
          edgeIdentifier("owns_connector", ownerNodeId, row.node_id),
          ownerNodeId,
          row.node_id,
          "owns_connector",
          policyVersion,
          sha256Canonical({ ownerNodeId, connectorNodeId: row.node_id, policyVersion }),
          0,
          canonicalJson(edgePayload),
        );
      } else {
        membershipUnresolvedPeerReferenceCount += 1;
        unresolvedPeerNodeIds.add(ownerNodeId ?? `<missing_owner:${row.node_id}>`);
      }
      for (const peerNodeId of topologyEvidence.peers) {
        const peerTopologyEvidence = connectorEvidenceByNodeId.get(peerNodeId);
        const reciprocal = peerTopologyEvidence?.peers.includes(row.node_id) === true;
        if (peerNodeId === row.node_id || nodeKinds.get(peerNodeId) !== "connector" || !reciprocal) {
          membershipUnresolvedPeerReferenceCount += 1;
          unresolvedPeerNodeIds.add(!reciprocal && nodeKinds.get(peerNodeId) === "connector"
            ? `<nonreciprocal:${row.node_id}->${peerNodeId}>`
            : peerNodeId);
          continue;
        }
        resolvedPeerReferenceCount += 1;
        const [sourceNodeId, targetNodeId] = row.node_id < peerNodeId
          ? [row.node_id, peerNodeId]
          : [peerNodeId, row.node_id];
        const edgePayload = {
          basis: "revit_connector_all_refs",
          precisionClass: "measured",
          verdictCapability: "context_only",
          targetMembershipValidated: true,
        };
        insert.run(
          snapshotId,
          edgeIdentifier("connected_to", sourceNodeId, targetNodeId),
          sourceNodeId,
          targetNodeId,
          "connected_to",
          policyVersion,
          sha256Canonical({ sourceNodeId, targetNodeId, policyVersion }),
          1,
          canonicalJson(edgePayload),
        );
      }
    }
    const unresolvedPeerReferenceCount = nativeUnresolvedPeerReferenceCount
      + membershipUnresolvedPeerReferenceCount;
    const targetMembershipValidated = readComplete
      && ambiguousConnectorCount === 0
      && unresolvedPeerReferenceCount === 0;
    const topologyPayload = {
      basis: "committed_snapshot_connector_membership",
      connectorCount,
      declaredPeerReferenceCount,
      resolvedPeerReferenceCount,
      unresolvedPeerReferenceCount,
      ambiguousConnectorCount,
      readComplete,
      targetMembershipValidated,
      unresolvedPeerNodeIds: [...unresolvedPeerNodeIds].sort().slice(0, 1_000),
    };
    this.database.prepare(`
      INSERT OR REPLACE INTO spatial_snapshot_topology(
        snapshot_id, connector_count, declared_peer_reference_count,
        resolved_peer_reference_count, unresolved_peer_reference_count,
        ambiguous_connector_count, read_complete,
        target_membership_validated, payload_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      snapshotId,
      connectorCount,
      declaredPeerReferenceCount,
      resolvedPeerReferenceCount,
      unresolvedPeerReferenceCount,
      ambiguousConnectorCount,
      readComplete ? 1 : 0,
      targetMembershipValidated ? 1 : 0,
      canonicalJson(topologyPayload),
    );
  }

  public getSnapshot(snapshotId: string): SpatialSnapshotSummary | null {
    this.assertOpen();
    const row = this.database.prepare(`
      SELECT
        s.snapshot_id AS snapshotId,
        s.document_key AS documentKey,
        s.captured_at_ms AS capturedAtMs,
        s.committed_at_ms AS committedAtMs,
        s.scope_fingerprint AS scopeFingerprint,
        s.revision_fingerprint AS revisionFingerprint,
        s.schema_version AS schemaVersion,
        s.extractor_version AS extractorVersion,
        s.complete AS complete,
        s.partial AS partial,
        s.coverage_status AS coverageStatus,
        s.scan_stopped_reason AS scanStoppedReason,
        s.page_count AS pageCount,
        s.payload_bytes AS payloadBytes,
        (SELECT count(*) FROM spatial_snapshot_sources x WHERE x.snapshot_id = s.snapshot_id) AS sourceCount,
        (SELECT count(*) FROM spatial_nodes n WHERE n.snapshot_id = s.snapshot_id) AS nodeCount,
        (SELECT count(*) FROM spatial_omissions o WHERE o.snapshot_id = s.snapshot_id) AS omissionCount
      FROM spatial_snapshots s
      WHERE s.snapshot_id = ?
    `).get(snapshotId) as Omit<SpatialSnapshotSummary, "complete" | "partial"> & {
      complete: number;
      partial: number;
    } | undefined;
    return row ? { ...row, complete: row.complete === 1, partial: row.partial === 1 } : null;
  }

  public getSnapshotSources(snapshotId: string): SpatialSourceRevisionRecord[] {
    this.assertOpen();
    const rows = this.database.prepare(`
      SELECT
        document_key, document_session_id, tracker_session_id, loaded_version,
        change_sequence, change_sequence_state, oldest_retained_sequence,
        journal_entry_count, journal_capacity, journal_truncated,
        link_instance_unique_id, source_to_host_transform_json,
        document_key_resolution_json, external_link_update_available,
        source_revision_json
      FROM spatial_snapshot_sources
      WHERE snapshot_id = ?
      ORDER BY source_key
    `).all(snapshotId) as Array<{
      document_key: string;
      document_session_id: string;
      tracker_session_id: string | null;
      loaded_version: string;
      change_sequence: number;
      change_sequence_state: string | null;
      oldest_retained_sequence: number | null;
      journal_entry_count: number | null;
      journal_capacity: number | null;
      journal_truncated: number;
      link_instance_unique_id: string | null;
      source_to_host_transform_json: string;
      document_key_resolution_json: string | null;
      external_link_update_available: number;
      source_revision_json: string;
    }>;
    return rows.map((row) => {
      const raw = parseJson(row.source_revision_json, "source revision");
      const fallback = raw && typeof raw === "object" && !Array.isArray(raw)
        ? raw as Record<string, unknown>
        : {};
      return {
        ...fallback,
        documentKey: row.document_key,
        documentSessionId: row.document_session_id,
        trackerSessionId: row.tracker_session_id,
        loadedVersion: row.loaded_version,
        changeSequence: row.change_sequence,
        changeSequenceState: row.change_sequence_state,
        oldestRetainedSequence: row.oldest_retained_sequence,
        journalEntryCount: row.journal_entry_count,
        journalCapacity: row.journal_capacity,
        journalTruncated: row.journal_truncated === 1,
        linkInstanceUniqueId: row.link_instance_unique_id,
        sourceToHostTransform: parseJson(
          row.source_to_host_transform_json,
          "source-to-host transform",
        ),
        documentKeyResolution: parseJson(
          row.document_key_resolution_json,
          "document-key resolution",
        ),
        externalLinkUpdateAvailable: row.external_link_update_available === 1,
      } as SpatialSourceRevisionRecord;
    });
  }

  public getSnapshotTopologyCapability(snapshotId: string): SpatialSnapshotTopologyCapability | null {
    this.assertOpen();
    const row = this.database.prepare(`
      SELECT snapshot_id, connector_count, declared_peer_reference_count,
        resolved_peer_reference_count, unresolved_peer_reference_count,
        ambiguous_connector_count, read_complete,
        target_membership_validated, payload_json
      FROM spatial_snapshot_topology
      WHERE snapshot_id = ?
    `).get(requireText(snapshotId, "snapshotId")) as {
      snapshot_id: string;
      connector_count: number;
      declared_peer_reference_count: number;
      resolved_peer_reference_count: number;
      unresolved_peer_reference_count: number;
      ambiguous_connector_count: number;
      read_complete: number;
      target_membership_validated: number;
      payload_json: string;
    } | undefined;
    if (!row) return null;
    const payload = parseStoredObject(row.payload_json, "spatial topology capability payload");
    return {
      snapshotId: row.snapshot_id,
      connectorCount: row.connector_count,
      declaredPeerReferenceCount: row.declared_peer_reference_count,
      resolvedPeerReferenceCount: row.resolved_peer_reference_count,
      unresolvedPeerReferenceCount: row.unresolved_peer_reference_count,
      ambiguousConnectorCount: row.ambiguous_connector_count,
      readComplete: row.read_complete === 1,
      targetMembershipValidated: row.target_membership_validated === 1,
      unresolvedPeerNodeIds: cleanStringArray(payload.unresolvedPeerNodeIds),
    };
  }

  public getSnapshotRecord(snapshotId: string): SpatialSnapshotRecord | null {
    this.assertOpen();
    const summary = this.getSnapshot(snapshotId);
    if (!summary) {
      return null;
    }
    const row = this.database.prepare(`
      SELECT scope_json, declared_counts_json, counts_json,
        effective_source_policy_json, coverage_json,
        transform_validation_json, capture_metadata_json
      FROM spatial_snapshots
      WHERE snapshot_id = ?
    `).get(snapshotId) as {
      scope_json: string;
      declared_counts_json: string | null;
      counts_json: string;
      effective_source_policy_json: string | null;
      coverage_json: string | null;
      transform_validation_json: string | null;
      capture_metadata_json: string;
    };
    return {
      ...summary,
      scope: parseJson(row.scope_json, "snapshot scope"),
      declaredCounts: parseJson(row.declared_counts_json, "declared snapshot counts"),
      derivedCounts: parseJson(row.counts_json, "derived snapshot counts"),
      effectiveSourcePolicy: parseJson(
        row.effective_source_policy_json,
        "effective source policy",
      ),
      coverage: parseJson(row.coverage_json, "snapshot coverage"),
      transformValidation: parseJson(
        row.transform_validation_json,
        "transform validation",
      ),
      captureMetadata: parseJson(row.capture_metadata_json, "capture metadata"),
      sourceRevisions: this.getSnapshotSources(snapshotId),
    };
  }

  public listSnapshots(documentKey?: string): SpatialSnapshotSummary[] {
    this.assertOpen();
    const ids = documentKey
      ? this.database.prepare(`
          SELECT snapshot_id FROM spatial_snapshots
          WHERE document_key = ? ORDER BY captured_at_ms DESC, snapshot_id
        `).all(documentKey)
      : this.database.prepare(`
          SELECT snapshot_id FROM spatial_snapshots
          ORDER BY document_key, captured_at_ms DESC, snapshot_id
        `).all();
    return (ids as Array<{ snapshot_id: string }>)
      .map((row) => this.getSnapshot(row.snapshot_id))
      .filter((row): row is SpatialSnapshotSummary => row !== null);
  }

  public getStoredNode(snapshotId: string, nodeId: string): SpatialStoredNode | null {
    this.assertOpen();
    const row = this.database.prepare(`
      SELECT ${STORED_NODE_SELECT}
      FROM spatial_nodes n
      WHERE n.snapshot_id = ? AND n.node_id = ?
    `).get(requireText(snapshotId, "snapshotId"), requireText(nodeId, "nodeId")) as StoredNodeRow | undefined;
    return row ? mapStoredNode(row) : null;
  }

  public getStoredNodesByIds(snapshotId: string, nodeIds: readonly string[]): SpatialStoredNode[] {
    this.assertOpen();
    if (nodeIds.length > 100_000) {
      throw new RangeError("Spatial node identity lookup is bounded to 100000 ids.");
    }
    const ids = cleanStringArray(nodeIds, 100_000);
    if (ids.length === 0) return [];
    const normalizedSnapshotId = requireText(snapshotId, "snapshotId");
    const rows: StoredNodeRow[] = [];
    for (let offset = 0; offset < ids.length; offset += 900) {
      const chunk = ids.slice(offset, offset + 900);
      rows.push(...this.database.prepare(`
        SELECT ${STORED_NODE_SELECT}
        FROM spatial_nodes n
        WHERE n.snapshot_id = ? AND n.node_id IN (${placeholders(chunk.length)})
        ORDER BY n.node_id
      `).all(normalizedSnapshotId, ...chunk) as StoredNodeRow[]);
    }
    return rows.sort((left, right) => compareText(left.node_id, right.node_id)).map(mapStoredNode);
  }

  public queryStoredNodes(query: SpatialNodeQuery): SpatialStoredNodePage {
    this.assertOpen();
    const snapshotId = requireText(query.snapshotId, "snapshotId");
    const limit = boundedQueryLimit(query.limit, 100, 1_000);
    const conditions = ["n.snapshot_id = ?"];
    const parameters: unknown[] = [snapshotId];
    const addValues = (column: string, values: readonly string[] | undefined) => {
      const cleaned = cleanQueryValues(values);
      if (cleaned.length === 0) return;
      conditions.push(`${column} IN (${placeholders(cleaned.length)})`);
      parameters.push(...cleaned);
    };
    addValues("n.node_id", query.nodeIds);
    addValues("n.node_kind", query.nodeKinds);
    addValues("n.category", query.categories);
    addValues("n.built_in_category", query.builtInCategories);
    addValues("n.category_role", query.categoryRoles);
    addValues("n.level_name", query.levelNames);
    addValues("n.level_unique_id", query.levelUniqueIds);
    addValues("n.system_key", query.systemKeys);
    addValues("n.owner_node_id", query.ownerNodeIds);
    const afterNodeId = cleanText(query.afterNodeId);
    if (afterNodeId) {
      conditions.push("n.node_id > ?");
      parameters.push(afterNodeId);
    }
    let join = "";
    if (query.aabb) {
      const bounds = normalizeAabb(query.aabb);
      if (bounds.some((value) => value === null)) {
        throw new RangeError("Spatial node query AABB must contain finite min/max coordinates.");
      }
      join = "JOIN spatial_node_rtree r ON r.node_rowid = n.node_rowid";
      conditions.push(
        "r.min_x <= ? AND r.max_x >= ?",
        "r.min_y <= ? AND r.max_y >= ?",
        "r.min_z <= ? AND r.max_z >= ?",
      );
      parameters.push(bounds[1], bounds[0], bounds[3], bounds[2], bounds[5], bounds[4]);
    }
    if (query.elevationBandMm) {
      const minZ = finiteNumber(query.elevationBandMm.minZ);
      const maxZ = finiteNumber(query.elevationBandMm.maxZ);
      if (minZ === null || maxZ === null || minZ > maxZ) {
        throw new RangeError("Spatial elevationBandMm requires finite minZ <= maxZ.");
      }
      if (!join) join = "JOIN spatial_node_rtree r ON r.node_rowid = n.node_rowid";
      conditions.push("r.min_z <= ? AND r.max_z >= ?");
      parameters.push(maxZ, minZ);
    }
    const rows = this.database.prepare(`
      SELECT ${STORED_NODE_SELECT}
      FROM spatial_nodes n
      ${join}
      WHERE ${conditions.join(" AND ")}
      ORDER BY n.node_id
      LIMIT ?
    `).all(...parameters, limit + 1) as StoredNodeRow[];
    const hasMore = rows.length > limit;
    const selected = hasMore ? rows.slice(0, limit) : rows;
    return {
      nodes: selected.map(mapStoredNode),
      hasMore,
      nextNodeId: hasMore && selected.length > 0 ? selected[selected.length - 1].node_id : null,
    };
  }

  public getStoredOmissions(query: SpatialOmissionQuery): SpatialStoredOmissionPage {
    this.assertOpen();
    const snapshotId = requireText(query.snapshotId, "snapshotId");
    const limit = boundedQueryLimit(query.limit, 100, 1_000);
    const conditions = ["snapshot_id = ?"];
    const parameters: unknown[] = [snapshotId];
    const reasons = cleanQueryValues(query.reasons);
    if (reasons.length > 0) {
      conditions.push(`reason IN (${placeholders(reasons.length)})`);
      parameters.push(...reasons);
    }
    if (query.afterRowId !== undefined && query.afterRowId !== null) {
      requireNonNegativeInteger(query.afterRowId, "afterRowId");
      conditions.push("omission_rowid > ?");
      parameters.push(query.afterRowId);
    }
    const rows = this.database.prepare(`
      SELECT omission_rowid, snapshot_id, document_key, reason, source_identity, payload_json
      FROM spatial_omissions
      WHERE ${conditions.join(" AND ")}
      ORDER BY omission_rowid
      LIMIT ?
    `).all(...parameters, limit + 1) as Array<{
      omission_rowid: number;
      snapshot_id: string;
      document_key: string;
      reason: string;
      source_identity: string | null;
      payload_json: string;
    }>;
    const hasMore = rows.length > limit;
    const selected = hasMore ? rows.slice(0, limit) : rows;
    return {
      omissions: selected.map((row) => ({
        snapshotId: row.snapshot_id,
        documentKey: row.document_key,
        reason: row.reason,
        sourceIdentity: row.source_identity,
        payload: parseStoredObject(row.payload_json, "spatial omission payload"),
      })),
      hasMore,
      nextRowId: hasMore && selected.length > 0 ? selected[selected.length - 1].omission_rowid : null,
    };
  }

  public queryStoredEdges(query: SpatialEdgeQuery): SpatialStoredEdgePage {
    this.assertOpen();
    const snapshotId = requireText(query.snapshotId, "snapshotId");
    const limit = boundedQueryLimit(query.limit, 200, 2_000);
    const conditions = ["snapshot_id = ?"];
    const parameters: unknown[] = [snapshotId];
    const addValues = (column: string, values: readonly string[] | undefined) => {
      const cleaned = cleanQueryValues(values);
      if (cleaned.length === 0) return;
      conditions.push(`${column} IN (${placeholders(cleaned.length)})`);
      parameters.push(...cleaned);
    };
    addValues("relation_type", query.relationTypes);
    addValues("source_node_id", query.sourceNodeIds);
    addValues("target_node_id", query.targetNodeIds);
    const incident = cleanQueryValues(query.incidentNodeIds);
    if (incident.length > 0) {
      conditions.push(`(source_node_id IN (${placeholders(incident.length)}) OR target_node_id IN (${placeholders(incident.length)}))`);
      parameters.push(...incident, ...incident);
    }
    const afterEdgeId = cleanText(query.afterEdgeId);
    if (afterEdgeId) {
      conditions.push("edge_id > ?");
      parameters.push(afterEdgeId);
    }
    const rows = this.database.prepare(`
      SELECT snapshot_id, edge_id, source_node_id, target_node_id,
        relation_type, relation_policy_version, fingerprint, bidirectional, payload_json
      FROM spatial_edges
      WHERE ${conditions.join(" AND ")}
      ORDER BY edge_id
      LIMIT ?
    `).all(...parameters, limit + 1) as StoredEdgeRow[];
    const hasMore = rows.length > limit;
    const selected = hasMore ? rows.slice(0, limit) : rows;
    return {
      edges: selected.map(mapStoredEdge),
      hasMore,
      nextEdgeId: hasMore && selected.length > 0 ? selected[selected.length - 1].edge_id : null,
    };
  }

  public getAdjacentStoredEdges(
    snapshotId: string,
    nodeId: string,
    options: SpatialAdjacentEdgeOptions = {},
  ): SpatialStoredEdge[] {
    return this.queryStoredEdges({
      snapshotId,
      incidentNodeIds: [requireText(nodeId, "nodeId")],
      relationTypes: options.relationTypes,
      limit: boundedQueryLimit(options.limit, 500, 2_000),
    }).edges;
  }

  public queryIntersectingAabbs(aabb: SpatialAabb, snapshotId?: string): SpatialIndexedNode[] {
    this.assertOpen();
    assertRTree(this.database);
    const bounds = normalizeAabb(aabb);
    const parameters = [bounds[1], bounds[0], bounds[3], bounds[2], bounds[5], bounds[4]];
    const rows = this.database.prepare(`
      SELECT n.snapshot_id, n.node_id, n.document_key, n.node_kind,
        n.min_x, n.max_x, n.min_y, n.max_y, n.min_z, n.max_z
      FROM spatial_node_rtree r
      JOIN spatial_nodes n ON n.node_rowid = r.node_rowid
      WHERE r.min_x <= ? AND r.max_x >= ?
        AND r.min_y <= ? AND r.max_y >= ?
        AND r.min_z <= ? AND r.max_z >= ?
        ${snapshotId ? "AND n.snapshot_id = ?" : ""}
      ORDER BY n.snapshot_id, n.node_id
    `).all(...parameters, ...(snapshotId ? [snapshotId] : [])) as Array<{
      snapshot_id: string;
      node_id: string;
      document_key: string;
      node_kind: string;
      min_x: number;
      max_x: number;
      min_y: number;
      max_y: number;
      min_z: number;
      max_z: number;
    }>;
    return rows.map((row) => ({
      snapshotId: row.snapshot_id,
      nodeId: row.node_id,
      documentKey: row.document_key,
      nodeKind: row.node_kind,
      aabb: {
        minMm: [row.min_x, row.min_y, row.min_z],
        maxMm: [row.max_x, row.max_y, row.max_z],
      },
    }));
  }

  public countRTreeEntries(snapshotId?: string): number {
    this.assertOpen();
    assertRTree(this.database);
    const row = snapshotId
      ? this.database.prepare(`
          SELECT count(*) AS count
          FROM spatial_node_rtree r
          JOIN spatial_nodes n ON n.node_rowid = r.node_rowid
          WHERE n.snapshot_id = ?
        `).get(snapshotId) as CountRow
      : this.database.prepare("SELECT count(*) AS count FROM spatial_node_rtree").get() as CountRow;
    return row.count;
  }

  public getStagingCaptureCount(): number {
    this.assertOpen();
    return (this.database.prepare(
      "SELECT count(*) AS count FROM spatial_capture_staging",
    ).get() as CountRow).count;
  }

  public abandonCapture(captureId: string): SpatialPurgeResult {
    this.assertOpen();
    const artifacts = this.database.prepare(`
      SELECT artifact_path FROM spatial_staging_artifacts WHERE capture_id = ?
    `).all(captureId) as ArtifactRow[];
    const result = this.database.prepare(
      "DELETE FROM spatial_capture_staging WHERE capture_id = ?",
    ).run(captureId);
    const removed = removeArtifacts(
      artifacts.map((row) => row.artifact_path),
      this.artifactRoot,
    );
    return {
      purgedSnapshotCount: 0,
      purgedStagingCaptureCount: result.changes,
      removedArtifactCount: removed.removed,
      artifactWarnings: removed.warnings,
    };
  }

  public cleanupExpiredStaging(nowMs = this.now()): SpatialPurgeResult {
    this.assertOpen();
    requireNonNegativeInteger(nowMs, "nowMs");
    const captureIds = this.database.prepare(`
      SELECT capture_id FROM spatial_capture_staging WHERE expires_at_ms <= ?
    `).all(nowMs) as Array<{ capture_id: string }>;
    if (captureIds.length === 0) {
      return {
        purgedSnapshotCount: 0,
        purgedStagingCaptureCount: 0,
        removedArtifactCount: 0,
        artifactWarnings: [],
      };
    }
    const placeholders = captureIds.map(() => "?").join(", ");
    const values = captureIds.map((row) => row.capture_id);
    const artifacts = this.database.prepare(`
      SELECT artifact_path FROM spatial_staging_artifacts
      WHERE capture_id IN (${placeholders})
    `).all(...values) as ArtifactRow[];
    const purged = this.database.prepare(`
      DELETE FROM spatial_capture_staging WHERE capture_id IN (${placeholders})
    `).run(...values);
    const removed = removeArtifacts(
      artifacts.map((row) => row.artifact_path),
      this.artifactRoot,
    );
    return {
      purgedSnapshotCount: 0,
      purgedStagingCaptureCount: purged.changes,
      removedArtifactCount: removed.removed,
      artifactWarnings: removed.warnings,
    };
  }

  public applyRetention(options: SpatialRetentionOptions = {}): SpatialPurgeResult {
    this.assertOpen();
    const nowMs = requireNonNegativeInteger(options.nowMs ?? this.now(), "retention nowMs");
    const retentionDays = requireNonNegativeInteger(
      options.retentionDays ?? DEFAULT_SPATIAL_RETENTION_DAYS,
      "retentionDays",
    );
    const minCompleteSnapshots = requireNonNegativeInteger(
      options.minCompleteSnapshots ?? DEFAULT_SPATIAL_MIN_COMPLETE_SNAPSHOTS,
      "minCompleteSnapshots",
    );
    const cutoff = nowMs - retentionDays * MILLIS_PER_DAY;
    const rows = this.database.prepare(`
      SELECT snapshot_id, document_key, captured_at_ms, complete
      FROM spatial_snapshots
      ORDER BY document_key, captured_at_ms DESC, snapshot_id DESC
    `).all() as SnapshotRetentionRow[];
    const completeRankByDocument = new Map<string, number>();
    const purgeIds: string[] = [];
    for (const row of rows) {
      let completeRank = completeRankByDocument.get(row.document_key) ?? 0;
      if (row.complete === 1) {
        completeRank += 1;
        completeRankByDocument.set(row.document_key, completeRank);
      }
      const isRecent = row.captured_at_ms >= cutoff;
      const isProtectedComplete = row.complete === 1 && completeRank <= minCompleteSnapshots;
      if (!isRecent && !isProtectedComplete) {
        purgeIds.push(row.snapshot_id);
      }
    }
    return purgeIds.length === 0
      ? {
          purgedSnapshotCount: 0,
          purgedStagingCaptureCount: 0,
          removedArtifactCount: 0,
          artifactWarnings: [],
        }
      : this.purge({ snapshotIds: purgeIds });
  }

  public applyConfiguredRetention(): SpatialPurgeResult {
    this.assertOpen();
    if (this.configuredRetentionPolicy === false) {
      return {
        purgedSnapshotCount: 0,
        purgedStagingCaptureCount: 0,
        removedArtifactCount: 0,
        artifactWarnings: [],
      };
    }
    return this.applyRetention({
      ...this.configuredRetentionPolicy,
      nowMs: this.now(),
    });
  }

  public previewPurge(options: SpatialPurgeOptions): SpatialPurgePreview {
    this.assertOpen();
    const targets = this.resolvePurgeTargets(options);
    return {
      snapshotIds: [...targets.snapshotIds],
      stagingCaptureIds: [...targets.stagingCaptureIds],
      snapshotCount: targets.snapshotIds.length,
      stagingCaptureCount: targets.stagingCaptureIds.length,
    };
  }

  public purge(options: SpatialPurgeOptions): SpatialPurgeResult {
    this.assertOpen();
    const { snapshotIds, stagingCaptureIds } = this.resolvePurgeTargets(options);

    const snapshotArtifacts = this.artifactsForIds(
      "spatial_snapshot_artifacts",
      "snapshot_id",
      snapshotIds,
    );
    const stagingArtifacts = this.artifactsForIds(
      "spatial_staging_artifacts",
      "capture_id",
      stagingCaptureIds,
    );

    const deleted = this.database.transaction(() => {
      const snapshotCount = this.deleteByIds("spatial_snapshots", "snapshot_id", snapshotIds);
      const stagingCount = this.deleteByIds(
        "spatial_capture_staging",
        "capture_id",
        stagingCaptureIds,
      );
      return { snapshotCount, stagingCount };
    })();
    const removed = removeArtifacts(
      [...snapshotArtifacts, ...stagingArtifacts],
      this.artifactRoot,
    );
    const backupWarnings = deleted.snapshotCount > 0
      ? this.refreshRecoveryBackupAfterPurge()
      : [];
    return {
      purgedSnapshotCount: deleted.snapshotCount,
      purgedStagingCaptureCount: deleted.stagingCount,
      removedArtifactCount: removed.removed,
      artifactWarnings: [...removed.warnings, ...backupWarnings],
    };
  }

  private resolvePurgeTargets(options: SpatialPurgeOptions): {
    snapshotIds: string[];
    stagingCaptureIds: string[];
  } {
    const selectorCount = Number(options.all === true)
      + Number(Boolean(options.documentKey))
      + Number(Boolean(options.snapshotIds));
    if (selectorCount !== 1) {
      throw new Error("Spatial purge requires exactly one explicit selector: all, documentKey, or snapshotIds.");
    }

    let snapshotIds: string[];
    let stagingCaptureIds: string[] = [];
    if (options.all) {
      snapshotIds = (this.database.prepare(
        "SELECT snapshot_id FROM spatial_snapshots ORDER BY snapshot_id",
      ).all() as Array<{ snapshot_id: string }>).map((row) => row.snapshot_id);
      stagingCaptureIds = (this.database.prepare(
        "SELECT capture_id FROM spatial_capture_staging ORDER BY capture_id",
      ).all() as Array<{ capture_id: string }>).map((row) => row.capture_id);
    } else if (options.documentKey) {
      const documentKey = requireText(options.documentKey, "purge documentKey");
      snapshotIds = (this.database.prepare(
        "SELECT snapshot_id FROM spatial_snapshots WHERE document_key = ? ORDER BY snapshot_id",
      ).all(documentKey) as Array<{ snapshot_id: string }>).map((row) => row.snapshot_id);
      stagingCaptureIds = (this.database.prepare(
        "SELECT capture_id FROM spatial_capture_staging WHERE document_key = ? ORDER BY capture_id",
      ).all(documentKey) as Array<{ capture_id: string }>).map((row) => row.capture_id);
    } else {
      const requestedIds = [...new Set((options.snapshotIds ?? []).map((id) => requireText(id, "snapshotId")))];
      if (requestedIds.length === 0) {
        throw new Error("Spatial purge snapshotIds selector requires at least one snapshotId.");
      }
      const placeholders = requestedIds.map(() => "?").join(", ");
      snapshotIds = (this.database.prepare(`
        SELECT snapshot_id FROM spatial_snapshots
        WHERE snapshot_id IN (${placeholders})
        ORDER BY snapshot_id
      `).all(...requestedIds) as Array<{ snapshot_id: string }>).map((row) => row.snapshot_id);
    }
    return { snapshotIds, stagingCaptureIds };
  }

  private artifactsForIds(table: string, idColumn: string, ids: readonly string[]): string[] {
    if (ids.length === 0) {
      return [];
    }
    const placeholders = ids.map(() => "?").join(", ");
    return (this.database.prepare(`
      SELECT artifact_path FROM ${table} WHERE ${idColumn} IN (${placeholders})
    `).all(...ids) as ArtifactRow[]).map((row) => row.artifact_path);
  }

  private deleteByIds(table: string, idColumn: string, ids: readonly string[]): number {
    if (ids.length === 0) {
      return 0;
    }
    const placeholders = ids.map(() => "?").join(", ");
    return this.database.prepare(`
      DELETE FROM ${table} WHERE ${idColumn} IN (${placeholders})
    `).run(...ids).changes;
  }

  private refreshRecoveryBackupAfterPurge(): string[] {
    const warnings: string[] = [];
    let freshBackupPath: string;
    try {
      this.testHooks.beforeRecoveryBackupCreate?.();
      freshBackupPath = createMigrationBackup(this.database, this.databasePath, this.now());
    } catch (error) {
      warnings.push(
        `Failed to create and verify a post-purge spatial recovery backup; previous backups were preserved: ${String(error)}`,
      );
      return warnings;
    }
    for (const backupPath of backupCandidates(this.databasePath)) {
      if (backupPath === freshBackupPath) {
        continue;
      }
      try {
        this.testHooks.beforeRecoveryBackupDelete?.(backupPath);
        rmSync(backupPath, { force: true });
      } catch (error) {
        warnings.push(
          `Failed to remove a pre-purge spatial recovery backup that may retain purged data ${backupPath}: ${String(error)}`,
        );
      }
    }
    return warnings;
  }

  private assertOpen(): void {
    if (this.closed) {
      throw new Error("Spatial store is closed.");
    }
  }
}
