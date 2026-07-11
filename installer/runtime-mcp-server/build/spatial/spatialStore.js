import Database from "better-sqlite3";
import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, statSync, } from "node:fs";
import { homedir } from "node:os";
import { spawnSync } from "node:child_process";
import { basename, dirname, isAbsolute, join, parse, relative, resolve } from "node:path";
import { spatialSourceKey } from "./spatialLiveness.js";
import { getInstallRoot, getRuntimeRoot } from "../utils/runtimeIdentity.js";
export const SPATIAL_STORE_SCHEMA_MAJOR = 1;
export const SPATIAL_STORE_SCHEMA_MINOR = 1;
export const DEFAULT_SPATIAL_RETENTION_DAYS = 30;
export const DEFAULT_SPATIAL_MIN_COMPLETE_SNAPSHOTS = 20;
export const SPATIAL_RETENTION_DAYS_ENV = "REVAGENT_SPATIAL_RETENTION_DAYS";
export const SPATIAL_MIN_COMPLETE_SNAPSHOTS_ENV = "REVAGENT_SPATIAL_MIN_COMPLETE_SNAPSHOTS";
export const SPATIAL_RETENTION_DISABLED_ENV = "REVAGENT_SPATIAL_RETENTION_DISABLED";
const DEFAULT_CAPTURE_LEASE_MS = 15 * 60 * 1000;
const MILLIS_PER_DAY = 24 * 60 * 60 * 1000;
let backupSerial = 0;
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
export class SpatialStoreMigrationError extends Error {
    backupPath;
    constructor(message, backupPath, options) {
        super(message, options);
        this.name = "SpatialStoreMigrationError";
        this.backupPath = backupPath;
    }
}
export class SpatialStoreIntegrityError extends Error {
    constructor(message, options) {
        super(message, options);
        this.name = "SpatialStoreIntegrityError";
    }
}
export class SpatialRTreeUnavailableError extends Error {
    constructor(message, options) {
        super(message, options);
        this.name = "SpatialRTreeUnavailableError";
    }
}
export class SpatialStorePathError extends Error {
    reason;
    constructor(reason, message) {
        super(message);
        this.name = "SpatialStorePathError";
        this.reason = reason;
    }
}
function isTruthy(value) {
    return /^(1|true|yes|on)$/i.test(String(value ?? "").trim());
}
function isNetworkLikePath(value) {
    const trimmed = value.trim();
    if (/^(?:\\\\|\/\/)/.test(trimmed) || /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) {
        return true;
    }
    const root = parse(resolve(trimmed)).root;
    return /^(?:\\\\|\/\/)/.test(root);
}
const windowsDriveTypeCache = new Map();
function readWindowsDriveType(driveRoot) {
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
export function assertSpatialLocalFilesystemPath(value, field, driveTypeReader) {
    if (isNetworkLikePath(value)) {
        throw new SpatialStorePathError("network_path", `${field} must remain on a local filesystem; network/UNC paths are not allowed.`);
    }
    const normalized = resolve(value);
    if (process.platform === "win32" || driveTypeReader !== undefined) {
        const driveRoot = parse(normalized).root;
        const driveType = driveRoot ? (driveTypeReader ?? readWindowsDriveType)(driveRoot) : null;
        if (driveType === 4) {
            throw new SpatialStorePathError("network_path", `${field} must remain on a local filesystem; mapped network drives are not allowed.`);
        }
        if (driveType === null || ![2, 3, 6].includes(driveType)) {
            throw new SpatialStorePathError("network_path", `${field} drive readiness/type is unavailable or not an allowed local writable drive; storage is rejected fail-closed.`);
        }
    }
    const managedRoots = [...new Set([getRuntimeRoot(), getInstallRoot()].map((root) => resolve(root)))];
    if (managedRoots.some((root) => pathContains(root, normalized))) {
        throw new SpatialStorePathError("managed_package_path", `${field} may not be stored inside the managed revAgent runtime/package directory.`);
    }
    return normalized;
}
export function resolveSpatialDatabasePath(explicitPath, driveTypeReader) {
    const configured = explicitPath?.trim() || process.env.REVAGENT_SPATIAL_DB_PATH?.trim();
    if (configured) {
        return assertSpatialLocalFilesystemPath(configured, "Spatial database", driveTypeReader);
    }
    const localAppData = process.env.LOCALAPPDATA?.trim()
        || join(homedir(), "AppData", "Local");
    return assertSpatialLocalFilesystemPath(join(localAppData, "revAgent", "spatial", "spatial.db"), "Spatial database", driveTypeReader);
}
export function resolveSpatialArtifactRoot(databasePath, explicitRoot, driveTypeReader) {
    const configured = explicitRoot?.trim() || join(dirname(databasePath), "artifacts");
    const artifactRoot = assertSpatialLocalFilesystemPath(configured, "Spatial artifact root", driveTypeReader);
    if (artifactRoot === resolve(databasePath)
        || pathContains(artifactRoot, databasePath)
        || pathContains(databasePath, artifactRoot)) {
        throw new SpatialStorePathError("artifact_path", "The spatial artifact root must be a dedicated sibling location and may not contain the database.");
    }
    return artifactRoot;
}
function readEnvironmentRetentionPolicy() {
    if (isTruthy(process.env[SPATIAL_RETENTION_DISABLED_ENV])) {
        return false;
    }
    const parseOptional = (name) => {
        const raw = process.env[name]?.trim();
        if (!raw)
            return undefined;
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
function requireText(value, field) {
    const normalized = value.trim();
    if (!normalized) {
        throw new TypeError(`${field} must be a non-empty string.`);
    }
    return normalized;
}
function requireNonNegativeInteger(value, field) {
    if (!Number.isSafeInteger(value) || value < 0) {
        throw new RangeError(`${field} must be a non-negative safe integer.`);
    }
    return value;
}
function stringifyJson(value, field) {
    const encoded = JSON.stringify(value);
    if (encoded === undefined) {
        throw new TypeError(`${field} must be JSON serializable.`);
    }
    return encoded;
}
function parseJson(value, field) {
    if (value === null) {
        return null;
    }
    try {
        return JSON.parse(value);
    }
    catch (error) {
        throw new SpatialStoreIntegrityError(`Stored ${field} JSON is invalid.`, { cause: error });
    }
}
function normalizeAabb(aabb) {
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
function versionNumber(version) {
    return version.major * 1_000 + version.minor;
}
function compareVersions(left, right) {
    return versionNumber(left) - versionNumber(right);
}
function tableExists(database, tableName) {
    const row = database.prepare("SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = ?").get(tableName);
    return row?.found === 1;
}
function readSchemaVersion(database) {
    if (!tableExists(database, "spatial_store_metadata")) {
        return { major: 0, minor: 0 };
    }
    const rows = database.prepare("SELECT key, value FROM spatial_store_metadata WHERE key IN ('schema_major', 'schema_minor')").all();
    const values = new Map(rows.map((row) => [row.key, row.value]));
    const major = Number.parseInt(values.get("schema_major") ?? "", 10);
    const minor = Number.parseInt(values.get("schema_minor") ?? "", 10);
    if (!Number.isSafeInteger(major) || major < 0 || !Number.isSafeInteger(minor) || minor < 0) {
        throw new SpatialStoreIntegrityError("Spatial store schema metadata is missing or invalid.");
    }
    return { major, minor };
}
function quickCheck(database) {
    const rows = database.pragma("quick_check");
    const results = rows.flatMap((row) => Object.values(row).map(String));
    if (results.length !== 1 || results[0].toLowerCase() !== "ok") {
        throw new SpatialStoreIntegrityError(`SQLite quick_check failed: ${results.join("; ") || "no result"}`);
    }
}
function backupCandidates(databasePath) {
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
        }
        catch {
            return false;
        }
    })
        .sort((left, right) => statSync(right).mtimeMs - statSync(left).mtimeMs);
}
function removeSqliteSidecars(databasePath) {
    rmSync(`${databasePath}-wal`, { force: true });
    rmSync(`${databasePath}-shm`, { force: true });
}
function restoreDatabaseFile(databasePath, backupPath) {
    removeSqliteSidecars(databasePath);
    copyFileSync(backupPath, databasePath);
}
function createMigrationBackup(database, databasePath, nowMs) {
    const suffix = `${nowMs}-${process.pid}-${backupSerial++}`;
    const backupPath = `${databasePath}.migration-backup-${suffix}`;
    const escaped = backupPath.replaceAll("'", "''");
    database.exec(`VACUUM INTO '${escaped}'`);
    let verification = null;
    try {
        verification = new Database(backupPath, { readonly: true, fileMustExist: true });
        quickCheck(verification);
    }
    catch (error) {
        try {
            verification?.close();
        }
        catch {
        }
        rmSync(backupPath, { force: true });
        throw new SpatialStoreIntegrityError(`New spatial recovery backup failed SQLite quick_check: ${backupPath}`, { cause: error });
    }
    verification.close();
    return backupPath;
}
function pruneMigrationBackups(databasePath, keep = 3) {
    for (const oldBackup of backupCandidates(databasePath).slice(keep)) {
        rmSync(oldBackup, { force: true });
    }
}
function configureDatabase(database) {
    database.pragma("foreign_keys = ON");
    database.pragma("busy_timeout = 5000");
    database.pragma("journal_mode = WAL");
    database.pragma("synchronous = FULL");
}
function openWithRecovery(databasePath) {
    let database = null;
    try {
        database = new Database(databasePath);
        quickCheck(database);
        configureDatabase(database);
        return { database, recoveredFromBackupPath: null };
    }
    catch (error) {
        try {
            database?.close();
        }
        catch {
        }
        const backupPath = backupCandidates(databasePath)[0];
        if (!backupPath) {
            throw new SpatialStoreIntegrityError("Spatial store failed SQLite quick_check and no migration backup is available.", { cause: error });
        }
        restoreDatabaseFile(databasePath, backupPath);
        let recovered = null;
        try {
            recovered = new Database(databasePath);
            quickCheck(recovered);
            configureDatabase(recovered);
            return { database: recovered, recoveredFromBackupPath: backupPath };
        }
        catch (recoveryError) {
            try {
                recovered?.close();
            }
            catch {
            }
            throw new SpatialStoreIntegrityError(`Spatial store recovery from ${backupPath} failed.`, { cause: recoveryError });
        }
    }
}
function writeSchemaVersion(database, version) {
    const upsert = database.prepare("INSERT OR REPLACE INTO spatial_store_metadata(key, value) VALUES (?, ?)");
    upsert.run("schema_major", String(version.major));
    upsert.run("schema_minor", String(version.minor));
    upsert.run("schema_version", `${version.major}.${version.minor}`);
    database.pragma(`user_version = ${versionNumber(version)}`);
}
function applyMigrations(database, databasePath, existedBeforeOpen, nowMs, hooks) {
    const current = readSchemaVersion(database);
    const target = {
        major: SPATIAL_STORE_SCHEMA_MAJOR,
        minor: SPATIAL_STORE_SCHEMA_MINOR,
    };
    if (compareVersions(current, target) > 0) {
        throw new SpatialStoreMigrationError(`Spatial store schema ${current.major}.${current.minor} is newer than supported ${target.major}.${target.minor}.`, null);
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
            if (compareVersions(working, target) !== 0) {
                throw new Error(`No migration path from ${working.major}.${working.minor}.`);
            }
            hooks?.beforeMigrationCommit?.(current, target);
        })();
        quickCheck(database);
        pruneMigrationBackups(databasePath);
    }
    catch (error) {
        try {
            database.close();
        }
        finally {
            if (backupPath) {
                restoreDatabaseFile(databasePath, backupPath);
            }
        }
        throw new SpatialStoreMigrationError(`Spatial store migration ${current.major}.${current.minor} -> ${target.major}.${target.minor} failed${backupPath ? " and the pre-migration backup was restored" : ""}.`, backupPath, { cause: error });
    }
}
function assertRTree(database) {
    try {
        database.prepare("SELECT count(*) AS count FROM spatial_node_rtree").get();
    }
    catch (error) {
        throw new SpatialRTreeUnavailableError("SQLite R*Tree support is unavailable; spatial indexing cannot fall back to a full table scan.", { cause: error });
    }
}
function pathContains(parentPath, childPath) {
    const pathFromParent = relative(resolve(parentPath), resolve(childPath));
    return pathFromParent === "" || (!pathFromParent.startsWith("..") && !isAbsolute(pathFromParent));
}
function removeArtifacts(paths, artifactRoot) {
    let removed = 0;
    const warnings = [];
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
        }
        catch (error) {
            warnings.push(`Failed to remove registered spatial artifact ${normalized}: ${String(error)}`);
        }
    }
    return { removed, warnings };
}
export class SpatialStore {
    databasePath;
    artifactRoot;
    recoveredFromBackupPath;
    now;
    testHooks;
    configuredRetentionPolicy;
    database;
    closed = false;
    constructor(options = {}) {
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
            applyMigrations(this.database, this.databasePath, existedBeforeOpen, this.now(), options.testHooks);
            assertRTree(this.database);
            if (options.cleanupExpiredStagingOnOpen !== false) {
                this.cleanupExpiredStaging(this.now());
            }
            this.applyConfiguredRetention();
        }
        catch (error) {
            try {
                this.database.close();
            }
            catch {
            }
            this.closed = true;
            throw error;
        }
    }
    close() {
        if (this.closed) {
            return;
        }
        this.database.pragma("wal_checkpoint(TRUNCATE)");
        this.database.close();
        this.closed = true;
    }
    getSchemaVersion() {
        this.assertOpen();
        return readSchemaVersion(this.database);
    }
    isRTreeAvailable() {
        this.assertOpen();
        assertRTree(this.database);
        return true;
    }
    beginCapture(input) {
        this.assertOpen();
        const nowMs = requireNonNegativeInteger(this.now(), "current time");
        const capturedAtMs = requireNonNegativeInteger(input.capturedAtMs ?? nowMs, "capturedAtMs");
        const expiresAtMs = requireNonNegativeInteger(input.expiresAtMs ?? nowMs + DEFAULT_CAPTURE_LEASE_MS, "expiresAtMs");
        if (expiresAtMs <= nowMs) {
            throw new RangeError("expiresAtMs must be in the future when a capture begins.");
        }
        const artifactPaths = (input.artifactPaths ?? []).map((artifactPath) => {
            const normalized = resolve(requireText(artifactPath, "artifactPath"));
            if (normalized === this.artifactRoot || !pathContains(this.artifactRoot, normalized)) {
                throw new SpatialStorePathError("artifact_path", `A spatial artifact must be a child of the dedicated artifact root ${this.artifactRoot}: ${normalized}`);
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
      `).run(requireText(input.captureId, "captureId"), requireText(input.snapshotId, "snapshotId"), requireText(input.documentKey, "documentKey"), requireText(input.scopeFingerprint, "scopeFingerprint"), requireText(input.revisionFingerprint, "revisionFingerprint"), requireText(input.schemaVersion, "schemaVersion"), requireText(input.extractorVersion, "extractorVersion"), stringifyJson(input.scope, "scope"), input.counts === undefined ? null : stringifyJson(input.counts, "counts"), input.effectiveSourcePolicy === undefined
                ? null
                : stringifyJson(input.effectiveSourcePolicy, "effectiveSourcePolicy"), input.coverage === undefined ? null : stringifyJson(input.coverage, "coverage"), input.transformValidation === undefined
                ? null
                : stringifyJson(input.transformValidation, "transformValidation"), stringifyJson(input.captureMetadata ?? {}, "captureMetadata"), capturedAtMs, nowMs, nowMs, expiresAtMs);
            const insertArtifact = this.database.prepare("INSERT INTO spatial_staging_artifacts(capture_id, artifact_path) VALUES (?, ?)");
            for (const artifactPath of new Set(artifactPaths)) {
                insertArtifact.run(input.captureId, artifactPath);
            }
        })();
    }
    stagePage(input) {
        this.assertOpen();
        const ordinal = requireNonNegativeInteger(input.ordinal, "page ordinal");
        const payloadBytes = requireNonNegativeInteger(input.payloadBytes, "payloadBytes");
        const omissions = input.omissions ?? [];
        this.database.transaction(() => {
            const capture = this.database.prepare("SELECT * FROM spatial_capture_staging WHERE capture_id = ?").get(input.captureId);
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
      `).get(input.captureId);
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
      `).run(input.captureId, ordinal, priorPageHash, requireText(input.pageHash, "pageHash"), input.hasMore ? 1 : 0, payloadBytes, input.nodes.length, omissions.length);
            const insertNode = this.database.prepare(`
        INSERT INTO spatial_staging_nodes(
          capture_id, page_ordinal, node_id, document_key, node_kind,
          element_unique_id, link_instance_unique_id,
          min_x, max_x, min_y, max_y, min_z, max_z, payload_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
            for (const node of input.nodes) {
                const bounds = normalizeAabb(node.aabb);
                insertNode.run(input.captureId, ordinal, requireText(node.nodeId, "nodeId"), requireText(node.documentKey, "node.documentKey"), requireText(node.nodeKind, "nodeKind"), node.elementUniqueId?.trim() || null, node.linkInstanceUniqueId?.trim() || null, ...bounds, stringifyJson(node.payload, "node.payload"));
            }
            const insertOmission = this.database.prepare(`
        INSERT INTO spatial_staging_omissions(
          capture_id, page_ordinal, document_key, reason, source_identity, payload_json
        ) VALUES (?, ?, ?, ?, ?, ?)
      `);
            for (const omission of omissions) {
                insertOmission.run(input.captureId, ordinal, requireText(omission.documentKey, "omission.documentKey"), requireText(omission.reason, "omission.reason"), omission.sourceIdentity?.trim() || null, stringifyJson(omission.payload, "omission.payload"));
            }
            this.database.prepare("UPDATE spatial_capture_staging SET updated_at_ms = ? WHERE capture_id = ?").run(this.now(), input.captureId);
        })();
    }
    commitCapture(input) {
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
        const expectedNodesByKind = Object.fromEntries(Object.entries(input.expectedNodesByKind).map(([nodeKind, count]) => [
            requireText(nodeKind, "expected node kind"),
            requireNonNegativeInteger(count, `expectedNodesByKind.${nodeKind}`),
        ]));
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
            const capture = this.database.prepare("SELECT * FROM spatial_capture_staging WHERE capture_id = ?").get(input.captureId);
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
      `).all(input.captureId);
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
      `).get(input.captureId);
            const nodesByKind = this.database.prepare(`
        SELECT node_kind, count(*) AS count
        FROM spatial_staging_nodes
        WHERE capture_id = ?
        GROUP BY node_kind
        ORDER BY node_kind
      `).all(input.captureId);
            const omissionsByReason = this.database.prepare(`
        SELECT reason, count(*) AS count
        FROM spatial_staging_omissions
        WHERE capture_id = ?
        GROUP BY reason
        ORDER BY reason
      `).all(input.captureId);
            const actualNodesByKind = Object.fromEntries(nodesByKind.map((row) => [row.node_kind, row.count]));
            const countMismatches = [];
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
                throw new SpatialStoreIntegrityError(`Atomic spatial capture count reconciliation failed: ${countMismatches.join("; ")}.`);
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
      `).run(capture.snapshot_id, capture.document_key, capture.captured_at_ms, this.now(), capture.scope_fingerprint, capture.revision_fingerprint, capture.schema_version, capture.extractor_version, capture.scope_json, finalCountsJson, finalEffectiveSourcePolicyJson, finalCoverageJson, finalTransformValidationJson, capture.capture_metadata_json, input.partial ? 0 : 1, input.partial ? 1 : 0, input.coverageStatus ?? null, requireText(input.scanStoppedReason, "scanStoppedReason"), stringifyJson(input.suggestedNextScopes ?? [], "suggestedNextScopes"), countsJson, pages.length, aggregate.payload_bytes);
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
            const sourceKeys = new Set();
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
                insertSource.run(capture.snapshot_id, sourceKey, requireText(source.documentKey, "source.documentKey"), requireText(source.documentSessionId, "source.documentSessionId"), source.trackerSessionId?.trim() || null, requireText(source.loadedVersion, "source.loadedVersion"), source.changeSequence, source.changeSequenceState?.trim() || null, source.oldestRetainedSequence ?? null, source.journalEntryCount ?? null, source.journalCapacity ?? null, source.journalTruncated ? 1 : 0, source.linkInstanceUniqueId?.trim() || null, stringifyJson(source.sourceToHostTransform, "source.sourceToHostTransform"), source.documentKeyResolution === undefined
                    ? null
                    : stringifyJson(source.documentKeyResolution, "source.documentKeyResolution"), source.externalLinkUpdateAvailable ? 1 : 0, stringifyJson(source, "source revision"));
            }
            this.database.prepare(`
        INSERT INTO spatial_nodes(
          snapshot_id, node_id, document_key, node_kind,
          element_unique_id, link_instance_unique_id,
          min_x, max_x, min_y, max_y, min_z, max_z, payload_json
        )
        SELECT ?, node_id, document_key, node_kind,
          element_unique_id, link_instance_unique_id,
          min_x, max_x, min_y, max_y, min_z, max_z, payload_json
        FROM spatial_staging_nodes
        WHERE capture_id = ?
        ORDER BY page_ordinal, staging_node_rowid
      `).run(capture.snapshot_id, input.captureId);
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
            this.database.prepare("DELETE FROM spatial_capture_staging WHERE capture_id = ?").run(input.captureId);
            return capture.snapshot_id;
        })();
        const summary = this.getSnapshot(snapshotId);
        if (!summary) {
            throw new SpatialStoreIntegrityError(`Committed spatial snapshot ${snapshotId} is not readable.`);
        }
        return summary;
    }
    getSnapshot(snapshotId) {
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
    `).get(snapshotId);
        return row ? { ...row, complete: row.complete === 1, partial: row.partial === 1 } : null;
    }
    getSnapshotSources(snapshotId) {
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
    `).all(snapshotId);
        return rows.map((row) => {
            const raw = parseJson(row.source_revision_json, "source revision");
            const fallback = raw && typeof raw === "object" && !Array.isArray(raw)
                ? raw
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
                sourceToHostTransform: parseJson(row.source_to_host_transform_json, "source-to-host transform"),
                documentKeyResolution: parseJson(row.document_key_resolution_json, "document-key resolution"),
                externalLinkUpdateAvailable: row.external_link_update_available === 1,
            };
        });
    }
    getSnapshotRecord(snapshotId) {
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
    `).get(snapshotId);
        return {
            ...summary,
            scope: parseJson(row.scope_json, "snapshot scope"),
            declaredCounts: parseJson(row.declared_counts_json, "declared snapshot counts"),
            derivedCounts: parseJson(row.counts_json, "derived snapshot counts"),
            effectiveSourcePolicy: parseJson(row.effective_source_policy_json, "effective source policy"),
            coverage: parseJson(row.coverage_json, "snapshot coverage"),
            transformValidation: parseJson(row.transform_validation_json, "transform validation"),
            captureMetadata: parseJson(row.capture_metadata_json, "capture metadata"),
            sourceRevisions: this.getSnapshotSources(snapshotId),
        };
    }
    listSnapshots(documentKey) {
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
        return ids
            .map((row) => this.getSnapshot(row.snapshot_id))
            .filter((row) => row !== null);
    }
    queryIntersectingAabbs(aabb, snapshotId) {
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
    `).all(...parameters, ...(snapshotId ? [snapshotId] : []));
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
    countRTreeEntries(snapshotId) {
        this.assertOpen();
        assertRTree(this.database);
        const row = snapshotId
            ? this.database.prepare(`
          SELECT count(*) AS count
          FROM spatial_node_rtree r
          JOIN spatial_nodes n ON n.node_rowid = r.node_rowid
          WHERE n.snapshot_id = ?
        `).get(snapshotId)
            : this.database.prepare("SELECT count(*) AS count FROM spatial_node_rtree").get();
        return row.count;
    }
    getStagingCaptureCount() {
        this.assertOpen();
        return this.database.prepare("SELECT count(*) AS count FROM spatial_capture_staging").get().count;
    }
    abandonCapture(captureId) {
        this.assertOpen();
        const artifacts = this.database.prepare(`
      SELECT artifact_path FROM spatial_staging_artifacts WHERE capture_id = ?
    `).all(captureId);
        const result = this.database.prepare("DELETE FROM spatial_capture_staging WHERE capture_id = ?").run(captureId);
        const removed = removeArtifacts(artifacts.map((row) => row.artifact_path), this.artifactRoot);
        return {
            purgedSnapshotCount: 0,
            purgedStagingCaptureCount: result.changes,
            removedArtifactCount: removed.removed,
            artifactWarnings: removed.warnings,
        };
    }
    cleanupExpiredStaging(nowMs = this.now()) {
        this.assertOpen();
        requireNonNegativeInteger(nowMs, "nowMs");
        const captureIds = this.database.prepare(`
      SELECT capture_id FROM spatial_capture_staging WHERE expires_at_ms <= ?
    `).all(nowMs);
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
    `).all(...values);
        const purged = this.database.prepare(`
      DELETE FROM spatial_capture_staging WHERE capture_id IN (${placeholders})
    `).run(...values);
        const removed = removeArtifacts(artifacts.map((row) => row.artifact_path), this.artifactRoot);
        return {
            purgedSnapshotCount: 0,
            purgedStagingCaptureCount: purged.changes,
            removedArtifactCount: removed.removed,
            artifactWarnings: removed.warnings,
        };
    }
    applyRetention(options = {}) {
        this.assertOpen();
        const nowMs = requireNonNegativeInteger(options.nowMs ?? this.now(), "retention nowMs");
        const retentionDays = requireNonNegativeInteger(options.retentionDays ?? DEFAULT_SPATIAL_RETENTION_DAYS, "retentionDays");
        const minCompleteSnapshots = requireNonNegativeInteger(options.minCompleteSnapshots ?? DEFAULT_SPATIAL_MIN_COMPLETE_SNAPSHOTS, "minCompleteSnapshots");
        const cutoff = nowMs - retentionDays * MILLIS_PER_DAY;
        const rows = this.database.prepare(`
      SELECT snapshot_id, document_key, captured_at_ms, complete
      FROM spatial_snapshots
      ORDER BY document_key, captured_at_ms DESC, snapshot_id DESC
    `).all();
        const completeRankByDocument = new Map();
        const purgeIds = [];
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
    applyConfiguredRetention() {
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
    previewPurge(options) {
        this.assertOpen();
        const targets = this.resolvePurgeTargets(options);
        return {
            snapshotIds: [...targets.snapshotIds],
            stagingCaptureIds: [...targets.stagingCaptureIds],
            snapshotCount: targets.snapshotIds.length,
            stagingCaptureCount: targets.stagingCaptureIds.length,
        };
    }
    purge(options) {
        this.assertOpen();
        const { snapshotIds, stagingCaptureIds } = this.resolvePurgeTargets(options);
        const snapshotArtifacts = this.artifactsForIds("spatial_snapshot_artifacts", "snapshot_id", snapshotIds);
        const stagingArtifacts = this.artifactsForIds("spatial_staging_artifacts", "capture_id", stagingCaptureIds);
        const deleted = this.database.transaction(() => {
            const snapshotCount = this.deleteByIds("spatial_snapshots", "snapshot_id", snapshotIds);
            const stagingCount = this.deleteByIds("spatial_capture_staging", "capture_id", stagingCaptureIds);
            return { snapshotCount, stagingCount };
        })();
        const removed = removeArtifacts([...snapshotArtifacts, ...stagingArtifacts], this.artifactRoot);
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
    resolvePurgeTargets(options) {
        const selectorCount = Number(options.all === true)
            + Number(Boolean(options.documentKey))
            + Number(Boolean(options.snapshotIds));
        if (selectorCount !== 1) {
            throw new Error("Spatial purge requires exactly one explicit selector: all, documentKey, or snapshotIds.");
        }
        let snapshotIds;
        let stagingCaptureIds = [];
        if (options.all) {
            snapshotIds = this.database.prepare("SELECT snapshot_id FROM spatial_snapshots ORDER BY snapshot_id").all().map((row) => row.snapshot_id);
            stagingCaptureIds = this.database.prepare("SELECT capture_id FROM spatial_capture_staging ORDER BY capture_id").all().map((row) => row.capture_id);
        }
        else if (options.documentKey) {
            const documentKey = requireText(options.documentKey, "purge documentKey");
            snapshotIds = this.database.prepare("SELECT snapshot_id FROM spatial_snapshots WHERE document_key = ? ORDER BY snapshot_id").all(documentKey).map((row) => row.snapshot_id);
            stagingCaptureIds = this.database.prepare("SELECT capture_id FROM spatial_capture_staging WHERE document_key = ? ORDER BY capture_id").all(documentKey).map((row) => row.capture_id);
        }
        else {
            const requestedIds = [...new Set((options.snapshotIds ?? []).map((id) => requireText(id, "snapshotId")))];
            if (requestedIds.length === 0) {
                throw new Error("Spatial purge snapshotIds selector requires at least one snapshotId.");
            }
            const placeholders = requestedIds.map(() => "?").join(", ");
            snapshotIds = this.database.prepare(`
        SELECT snapshot_id FROM spatial_snapshots
        WHERE snapshot_id IN (${placeholders})
        ORDER BY snapshot_id
      `).all(...requestedIds).map((row) => row.snapshot_id);
        }
        return { snapshotIds, stagingCaptureIds };
    }
    artifactsForIds(table, idColumn, ids) {
        if (ids.length === 0) {
            return [];
        }
        const placeholders = ids.map(() => "?").join(", ");
        return this.database.prepare(`
      SELECT artifact_path FROM ${table} WHERE ${idColumn} IN (${placeholders})
    `).all(...ids).map((row) => row.artifact_path);
    }
    deleteByIds(table, idColumn, ids) {
        if (ids.length === 0) {
            return 0;
        }
        const placeholders = ids.map(() => "?").join(", ");
        return this.database.prepare(`
      DELETE FROM ${table} WHERE ${idColumn} IN (${placeholders})
    `).run(...ids).changes;
    }
    refreshRecoveryBackupAfterPurge() {
        const warnings = [];
        let freshBackupPath;
        try {
            this.testHooks.beforeRecoveryBackupCreate?.();
            freshBackupPath = createMigrationBackup(this.database, this.databasePath, this.now());
        }
        catch (error) {
            warnings.push(`Failed to create and verify a post-purge spatial recovery backup; previous backups were preserved: ${String(error)}`);
            return warnings;
        }
        for (const backupPath of backupCandidates(this.databasePath)) {
            if (backupPath === freshBackupPath) {
                continue;
            }
            try {
                this.testHooks.beforeRecoveryBackupDelete?.(backupPath);
                rmSync(backupPath, { force: true });
            }
            catch (error) {
                warnings.push(`Failed to remove a pre-purge spatial recovery backup that may retain purged data ${backupPath}: ${String(error)}`);
            }
        }
        return warnings;
    }
    assertOpen() {
        if (this.closed) {
            throw new Error("Spatial store is closed.");
        }
    }
}
