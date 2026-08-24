using System.Globalization;
using System.Runtime.Versioning;
using System.Security.AccessControl;
using System.Security.Principal;
using Microsoft.Data.Sqlite;

namespace RevAgent.Bridge.Gateway.Storage;

internal sealed partial class RbpJournalStore : IAsyncDisposable
{
    private const int WalAutoCheckpointPages = 1_000;

    private static readonly Lazy<bool> SqliteInitialized = new(
        InitializeSqlite,
        LazyThreadSafetyMode.ExecutionAndPublication);

    private readonly SqliteConnection _connection;
    private readonly RbpJournalWriterLease _writerLease;
    private readonly IRbpResumeTokenProtector _resumeTokenProtector;
    private readonly IRbpRecoveryPayloadProtector _recoveryPayloadProtector;
    private readonly SemaphoreSlim _gate = new(1, 1);
    private readonly Func<long> _nowMilliseconds;
    private readonly IRbpJournalFaultInjector? _faultInjector;
    private readonly int _commandTimeoutSeconds;
    private long _activeConnectionGeneration;
    private bool _closed;
    private bool _sensitiveCompactionUnproven;

    private RbpJournalStore(
        string databasePath,
        SqliteConnection connection,
        RbpJournalWriterLease writerLease,
        IRbpResumeTokenProtector resumeTokenProtector,
        IRbpRecoveryPayloadProtector recoveryPayloadProtector,
        RbpJournalOpenOptions options,
        RbpJournalDurabilityProfile durabilityProfile,
        int schemaVersion)
    {
        DatabasePath = databasePath;
        _connection = connection;
        _writerLease = writerLease;
        _resumeTokenProtector = resumeTokenProtector;
        _recoveryPayloadProtector = recoveryPayloadProtector;
        _nowMilliseconds =
            options.NowMilliseconds ??
            (() => DateTimeOffset.UtcNow.ToUnixTimeMilliseconds());
        _faultInjector = options.FaultInjector;
        _commandTimeoutSeconds = Math.Max(
            1,
            (options.BusyTimeoutMilliseconds + 999) / 1_000);
        DurabilityProfile = durabilityProfile;
        SchemaVersion = schemaVersion;
    }

    internal string DatabasePath { get; }

    internal RbpJournalDurabilityProfile DurabilityProfile { get; }

    internal int SchemaVersion { get; }

    internal static RbpJournalStore Open(
        string databasePath,
        IRbpResumeTokenProtector resumeTokenProtector,
        RbpJournalOpenOptions? options = null,
        IRbpRecoveryPayloadProtector? recoveryPayloadProtector = null,
        IRbpJournalRollbackBackupSeam? rollbackBackupSeam = null)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(databasePath);
        ArgumentNullException.ThrowIfNull(resumeTokenProtector);
        recoveryPayloadProtector ??= UnavailableRbpRecoveryPayloadProtector.Instance;
        rollbackBackupSeam ??= SystemRbpJournalRollbackBackupSeam.Instance;
        options ??= new RbpJournalOpenOptions();
        ValidateOpenOptions(options);

        _ = SqliteInitialized.Value;
        string fullPath = Path.GetFullPath(databasePath);
        string? directory = Path.GetDirectoryName(fullPath);
        if (string.IsNullOrEmpty(directory))
        {
            throw new ArgumentException(
                "The RBP journal path must have a parent directory.",
                nameof(databasePath));
        }

        Directory.CreateDirectory(directory);
        RbpJournalWriterLease? lease = null;
        SqliteConnection? connection = null;
        try
        {
            lease = RbpJournalWriterLease.Acquire(fullPath);
            var connectionString = new SqliteConnectionStringBuilder
            {
                DataSource = fullPath,
                Mode = SqliteOpenMode.ReadWriteCreate,
                Cache = SqliteCacheMode.Private,
                Pooling = false,
                DefaultTimeout = Math.Max(
                    1,
                    (options.BusyTimeoutMilliseconds + 999) / 1_000),
            };
            connection = new SqliteConnection(connectionString.ToString());
            connection.Open();

            RbpJournalDurabilityProfile durabilityProfile =
                ApplyAndVerifyDurability(
                    connection,
                    options.BusyTimeoutMilliseconds);
            RunQuickCheck(connection);
            IReadOnlyList<RbpJournalMigration> migrations =
                RbpJournalSchema.BuildMigrationChain(
                    options.AdditionalMigrations);
            EnsurePreV7RollbackBackup(connection, fullPath, migrations, rollbackBackupSeam);
            int schemaVersion = EnsureSchema(
                connection,
                migrations,
                options.NowMilliseconds?.Invoke() ??
                    DateTimeOffset.UtcNow.ToUnixTimeMilliseconds());
            RunQuickCheck(connection);
            ValidateInboundReceiptIntegrity(connection);
            RunTruncateCheckpoint(connection);

            var store = new RbpJournalStore(
                fullPath,
                connection,
                lease,
                resumeTokenProtector,
                recoveryPayloadProtector,
                options,
                durabilityProfile,
                schemaVersion);
            connection = null;
            lease = null;
            return store;
        }
        catch
        {
            connection?.Dispose();
            lease?.Dispose();
            throw;
        }
    }

    private static void EnsurePreV7RollbackBackup(
        SqliteConnection connection,
        string databasePath,
        IReadOnlyList<RbpJournalMigration> migrations,
        IRbpJournalRollbackBackupSeam seam)
    {
        // Version seven adds opaque protected material whose v6 executable
        // must not attempt to interpret. Before crossing that one-way local
        // format boundary, make an SQLite-consistent offline rollback image.
        // Existing images are retained rather than overwritten.
        if (!TableExists(connection, "journal_meta") ||
            migrations.Count < RbpJournalSchema.CurrentVersion)
        {
            return;
        }
        (_, int current) = ReadJournalMeta(connection);
        if (current != RbpJournalSchema.CurrentVersion - 1)
        {
            return;
        }

        string backupPath = databasePath + ".v6.rollback";
        if (File.Exists(backupPath))
        {
            VerifyRollbackBackup(backupPath, expectedVersion: current, seam.RequiresProtectedAcl);
            return;
        }
        string temporaryPath = backupPath + ".tmp-" + Guid.NewGuid().ToString("N");
        try
        {
            // Create and ACL the empty file before SQLite can copy a byte into
            // it. The service is LocalSystem, so service and LocalSystem are
            // the one permitted SID; no administrator/users ACE is granted.
            seam.CreateTemporary(temporaryPath);
            seam.ProtectTemporary(temporaryPath);
            seam.CopyConsistently(connection, temporaryPath);
            VerifyRollbackBackup(temporaryPath, expectedVersion: current, seam.RequiresProtectedAcl);
            try
            {
                seam.PublishNoOverwrite(temporaryPath, backupPath);
            }
            catch (IOException) when (File.Exists(backupPath))
            {
                // A concurrent opener won the single publish. Verify it
                // instead of overwriting its offline rollback image.
                VerifyRollbackBackup(backupPath, expectedVersion: current, seam.RequiresProtectedAcl);
            }
        }
        finally
        {
            seam.CleanupTemporary(temporaryPath);
        }
    }

    [SupportedOSPlatform("windows")]
    internal static void ProtectRollbackBackup(string path)
    {
        if (!OperatingSystem.IsWindows())
        {
            return;
        }
        SecurityIdentifier localSystem = new(
            WellKnownSidType.LocalSystemSid, domainSid: null);
        new FileInfo(path).SetAccessControl(BuildRollbackBackupSecurity(localSystem));
    }

    [SupportedOSPlatform("windows")]
    internal static FileSecurity BuildRollbackBackupSecurity(
        SecurityIdentifier localSystem)
    {
        ArgumentNullException.ThrowIfNull(localSystem);
        var security = new FileSecurity();
        security.SetOwner(localSystem);
        security.SetAccessRuleProtection(isProtected: true, preserveInheritance: false);
        security.AddAccessRule(new FileSystemAccessRule(
            localSystem,
            FileSystemRights.FullControl,
            InheritanceFlags.None,
            PropagationFlags.None,
            AccessControlType.Allow));
        return security;
    }

    private static void VerifyRollbackBackup(string path, int expectedVersion, bool requireProtectedAcl)
    {
        if (requireProtectedAcl && OperatingSystem.IsWindows())
        {
            VerifyRollbackBackupAcl(path);
        }
        var builder = new SqliteConnectionStringBuilder
        {
            DataSource = path,
            Mode = SqliteOpenMode.ReadOnly,
            Cache = SqliteCacheMode.Private,
            Pooling = false,
        };
        using var backup = new SqliteConnection(builder.ToString());
        backup.Open();
        (_, int version) = ReadJournalMeta(backup);
        if (version != expectedVersion)
        {
            throw new RbpJournalException(
                RbpJournalErrorCode.UnsupportedSchema,
                "The pre-v7 rollback backup does not have the expected schema.");
        }
    }

    [SupportedOSPlatform("windows")]
    private static void VerifyRollbackBackupAcl(string path)
    {
        var file = new FileInfo(path);
        FileSecurity security = file.GetAccessControl(AccessControlSections.Access | AccessControlSections.Owner);
        SecurityIdentifier localSystem = new(WellKnownSidType.LocalSystemSid, domainSid: null);
        FileSystemAccessRule[] rules = security.GetAccessRules(
                includeExplicit: true,
                includeInherited: true,
                typeof(SecurityIdentifier))
            .Cast<FileSystemAccessRule>()
            .ToArray();
        if (!security.AreAccessRulesProtected ||
            !Equals(security.GetOwner(typeof(SecurityIdentifier)), localSystem) ||
            rules.Length != 1 ||
            rules[0].AccessControlType != AccessControlType.Allow ||
            !Equals(rules[0].IdentityReference, localSystem) ||
            (rules[0].FileSystemRights & FileSystemRights.FullControl) != FileSystemRights.FullControl)
        {
            throw new RbpJournalException(
                RbpJournalErrorCode.UnsupportedSchema,
                "The pre-v7 rollback backup ACL is not protected.");
        }
    }

    internal async Task<T> ExecuteImmediateAsync<T>(
        Func<RbpJournalWriteContext, T> operation,
        CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(operation);
        EnsureOpen();
        await _gate.WaitAsync(cancellationToken).ConfigureAwait(false);
        try
        {
            EnsureOpen();
            using SqliteTransaction transaction =
                _connection.BeginTransaction(deferred: false);
            var context = new RbpJournalWriteContext(
                _connection,
                transaction,
                _commandTimeoutSeconds);
            T result;
            try
            {
                result = operation(context);
                RejectEscapedAsynchronousResult(result);
                _faultInjector?.Hit(RbpJournalFaultPoint.BeforeCommit);
            }
            catch
            {
                TryRollback(transaction);
                throw;
            }

            try
            {
                transaction.Commit();
            }
            catch (Exception exception)
            {
                TryRollback(transaction);
                throw new RbpJournalException(
                    RbpJournalErrorCode.PostCommitFailure,
                    "The RBP journal commit outcome could not be proven. " +
                    "The caller must re-read exact durable state before " +
                    "taking a transport or dispatch action.",
                    exception);
            }

            if (context.SensitiveCompactionPerformed)
            {
                try
                {
                    RunTruncateCheckpoint(_connection);
                }
                catch (Exception exception)
                {
                    _sensitiveCompactionUnproven = true;
                    throw new RbpJournalException(
                        RbpJournalErrorCode.PostCommitFailure,
                        "The inbound invocation handoff committed, but " +
                        "sensitive WAL compaction could not be proven. The " +
                        "journal is blocked until restart recovery.",
                        exception,
                        durableStateObserved: true);
                }
            }

            try
            {
                _faultInjector?.Hit(
                    RbpJournalFaultPoint.AfterCommitBeforeReturn);
            }
            catch (Exception exception)
            {
                throw new RbpJournalException(
                    RbpJournalErrorCode.PostCommitFailure,
                    "The RBP journal committed, but the write result was not " +
                    "returned. The caller must re-read exact durable state " +
                    "before taking a transport or dispatch action.",
                    exception);
            }

            return result;
        }
        finally
        {
            _gate.Release();
        }
    }

    internal async Task<T> ReadAsync<T>(
        Func<SqliteConnection, T> operation,
        CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(operation);
        EnsureOpen();
        await _gate.WaitAsync(cancellationToken).ConfigureAwait(false);
        try
        {
            EnsureOpen();
            return operation(_connection);
        }
        finally
        {
            _gate.Release();
        }
    }

    public async ValueTask DisposeAsync()
    {
        await _gate.WaitAsync().ConfigureAwait(false);
        try
        {
            if (_closed)
            {
                return;
            }

            _closed = true;
            try
            {
                RunTruncateCheckpoint(_connection);
            }
            finally
            {
                _connection.Dispose();
                _writerLease.Dispose();
            }
        }
        finally
        {
            _gate.Release();
        }
    }

    private static bool InitializeSqlite()
    {
        SQLitePCL.Batteries_V2.Init();
        return true;
    }

    private static void ValidateOpenOptions(RbpJournalOpenOptions options)
    {
        if (options.BusyTimeoutMilliseconds is < 1 or > 60_000)
        {
            throw new ArgumentOutOfRangeException(
                nameof(options),
                "RBP journal busy timeout must be between 1 and 60000 ms.");
        }

        long now = options.NowMilliseconds?.Invoke() ??
            DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        if (now < 0)
        {
            throw new ArgumentOutOfRangeException(
                nameof(options),
                "RBP journal clock must not precede the Unix epoch.");
        }
    }

    private static RbpJournalDurabilityProfile ApplyAndVerifyDurability(
        SqliteConnection connection,
        int busyTimeoutMilliseconds)
    {
        ExecuteNonQuery(connection, "PRAGMA foreign_keys=ON;");
        ExecuteNonQuery(connection, "PRAGMA trusted_schema=OFF;");
        ExecuteNonQuery(connection, "PRAGMA secure_delete=ON;");
        ExecuteNonQuery(
            connection,
            "PRAGMA busy_timeout=" +
            busyTimeoutMilliseconds.ToString(CultureInfo.InvariantCulture) +
            ";");
        string journalMode =
            Convert.ToString(
                ExecuteScalar(connection, "PRAGMA journal_mode=WAL;"),
                CultureInfo.InvariantCulture) ??
            string.Empty;
        ExecuteNonQuery(connection, "PRAGMA synchronous=FULL;");
        ExecuteNonQuery(
            connection,
            "PRAGMA wal_autocheckpoint=" +
            WalAutoCheckpointPages.ToString(CultureInfo.InvariantCulture) +
            ";");

        int synchronous = ScalarInt32(connection, "PRAGMA synchronous;");
        bool foreignKeys =
            ScalarInt32(connection, "PRAGMA foreign_keys;") == 1;
        bool trustedSchema =
            ScalarInt32(connection, "PRAGMA trusted_schema;") == 1;
        bool secureDelete =
            ScalarInt32(connection, "PRAGMA secure_delete;") == 1;
        int observedBusyTimeout =
            ScalarInt32(connection, "PRAGMA busy_timeout;");
        int observedAutoCheckpoint =
            ScalarInt32(connection, "PRAGMA wal_autocheckpoint;");
        var profile = new RbpJournalDurabilityProfile(
            journalMode,
            synchronous,
            foreignKeys,
            trustedSchema,
            secureDelete,
            observedBusyTimeout,
            observedAutoCheckpoint);
        if (!string.Equals(
                profile.JournalMode,
                "wal",
                StringComparison.OrdinalIgnoreCase) ||
            profile.Synchronous != 2 ||
            !profile.ForeignKeys ||
            profile.TrustedSchema ||
            !profile.SecureDelete ||
            profile.BusyTimeoutMilliseconds != busyTimeoutMilliseconds ||
            profile.WalAutoCheckpointPages != WalAutoCheckpointPages)
        {
            throw new RbpJournalException(
                RbpJournalErrorCode.InvalidDurabilityProfile,
                "SQLite did not accept the required WAL/FULL, foreign-key, " +
                "trusted-schema, secure-delete, busy-timeout, and checkpoint " +
                "profile.");
        }

        return profile;
    }

    private static void RunQuickCheck(SqliteConnection connection)
    {
        using SqliteCommand command =
            CreateCommand(connection, "PRAGMA quick_check;");
        using SqliteDataReader reader = command.ExecuteReader();
        int rowCount = 0;
        while (reader.Read())
        {
            rowCount++;
            string result = reader.GetString(0);
            if (!string.Equals(result, "ok", StringComparison.Ordinal))
            {
                throw new RbpJournalException(
                    RbpJournalErrorCode.IntegrityCheckFailed,
                    "SQLite quick_check rejected the RBP journal: " +
                    result);
            }
        }

        if (rowCount != 1)
        {
            throw new RbpJournalException(
                RbpJournalErrorCode.IntegrityCheckFailed,
                "SQLite quick_check did not return one authoritative result.");
        }
    }

    private static void ValidateInboundReceiptIntegrity(
        SqliteConnection connection)
    {
        using SqliteCommand command = CreateCommand(
            connection,
            """
            WITH receipt_summary AS (
              SELECT rsid,
                     COUNT(*) AS receipt_count,
                     MIN(seq) AS minimum_sequence,
                     MAX(seq) AS maximum_sequence,
                     COALESCE(
                       MIN(CASE
                         WHEN handoff_state='pending' THEN seq
                       END)-1,
                       MAX(seq),
                       0
                     ) AS contiguous_journaled_sequence,
                     SUM(
                       CASE
                         WHEN length(immutable_digest)=71
                          AND substr(immutable_digest,1,7)='sha256:'
                          AND substr(immutable_digest,8)
                            NOT GLOB '*[^0-9a-f]*'
                         THEN 0
                         ELSE 1
                       END
                     ) AS invalid_digest_count
              FROM rbp_inbound_receipts
              GROUP BY rsid
            ),
            invalid_authority AS (
              SELECT authority.rsid
              FROM rbp_session_sequence AS authority
              LEFT JOIN receipt_summary AS receipts
                ON receipts.rsid=authority.rsid
              WHERE COALESCE(receipts.receipt_count,0) <>
                      authority.last_rx_seq
                 OR (
                      authority.last_rx_seq > 0
                      AND (
                        receipts.minimum_sequence <> 1
                        OR receipts.maximum_sequence <>
                           authority.last_rx_seq
                      )
                    )
                 OR COALESCE(
                      receipts.contiguous_journaled_sequence,
                      0
                    ) <> authority.last_journaled_rx_seq
                 OR COALESCE(receipts.invalid_digest_count,0) <> 0
            ),
            orphan_receipts AS (
              SELECT receipts.rsid
              FROM receipt_summary AS receipts
              LEFT JOIN rbp_session_sequence AS authority
                ON authority.rsid=receipts.rsid
              WHERE authority.rsid IS NULL
            )
            SELECT rsid FROM invalid_authority
            UNION ALL
            SELECT rsid FROM orphan_receipts
            LIMIT 1;
            """);
        object? invalidRsid = command.ExecuteScalar();
        if (invalidRsid is not null and not DBNull)
        {
            throw new RbpJournalException(
                RbpJournalErrorCode.IntegrityCheckFailed,
                "The inbound receipt history is not contiguous or " +
                "disagrees with its durable receive frontiers.");
        }
    }

    private static void RunTruncateCheckpoint(SqliteConnection connection)
    {
        using SqliteCommand command = CreateCommand(
            connection,
            "PRAGMA wal_checkpoint(TRUNCATE);");
        using SqliteDataReader reader = command.ExecuteReader();
        if (!reader.Read())
        {
            throw new RbpJournalException(
                RbpJournalErrorCode.PostCommitFailure,
                "SQLite returned no WAL checkpoint result.");
        }

        int busy = reader.GetInt32(0);
        int remainingFrames = reader.GetInt32(1);
        _ = reader.GetInt32(2);
        if (reader.Read() || busy != 0 || remainingFrames != 0)
        {
            throw new RbpJournalException(
                RbpJournalErrorCode.PostCommitFailure,
                "SQLite could not truncate every WAL frame.");
        }
    }

    private static int EnsureSchema(
        SqliteConnection connection,
        IReadOnlyList<RbpJournalMigration> migrations,
        long nowMilliseconds)
    {
        bool hasUserTable = ScalarInt32(
            connection,
            """
            SELECT CASE WHEN EXISTS(
              SELECT 1 FROM sqlite_master
              WHERE type='table' AND name NOT LIKE 'sqlite_%'
            ) THEN 1 ELSE 0 END;
            """) == 1;
        if (!hasUserTable)
        {
            using SqliteTransaction transaction =
                connection.BeginTransaction(deferred: false);
            try
            {
                ExecuteNonQuery(
                    connection,
                    """
                    CREATE TABLE journal_meta(
                      singleton INTEGER PRIMARY KEY CHECK(singleton=1),
                      store_format TEXT NOT NULL,
                      schema_version INTEGER NOT NULL
                        CHECK(schema_version >= 0),
                      created_at_ms INTEGER NOT NULL
                        CHECK(created_at_ms >= 0),
                      updated_at_ms INTEGER NOT NULL
                        CHECK(updated_at_ms >= created_at_ms)
                    ) STRICT;

                    CREATE TABLE schema_migrations(
                      version INTEGER PRIMARY KEY CHECK(version >= 1),
                      owner TEXT NOT NULL,
                      name TEXT NOT NULL UNIQUE,
                      sql_sha256 TEXT NOT NULL,
                      applied_at_ms INTEGER NOT NULL
                        CHECK(applied_at_ms >= 0),
                      CHECK(length(owner) BETWEEN 1 AND 64),
                      CHECK(length(name) BETWEEN 1 AND 128),
                      CHECK(length(sql_sha256)=71)
                    ) STRICT;
                    """,
                    transaction);
                using (SqliteCommand insertMeta = CreateCommand(
                           connection,
                           """
                           INSERT INTO journal_meta(
                             singleton,store_format,schema_version,
                             created_at_ms,updated_at_ms
                           ) VALUES(1,$format,0,$now,$now);
                           """,
                           transaction))
                {
                    insertMeta.Parameters.AddWithValue(
                        "$format",
                        RbpJournalSchema.StoreFormat);
                    insertMeta.Parameters.AddWithValue("$now", nowMilliseconds);
                    _ = insertMeta.ExecuteNonQuery();
                }

                ApplyMigrations(
                    connection,
                    transaction,
                    migrations,
                    firstMigrationIndex: 0,
                    nowMilliseconds);
                transaction.Commit();
            }
            catch
            {
                TryRollback(transaction);
                throw;
            }

            return migrations.Count;
        }

        if (!TableExists(connection, "journal_meta") ||
            !TableExists(connection, "schema_migrations"))
        {
            throw new RbpJournalException(
                RbpJournalErrorCode.UnsupportedSchema,
                "The existing database is not a revAgent RBP journal.");
        }

        (string storeFormat, int metaVersion) = ReadJournalMeta(connection);
        if (!string.Equals(
                storeFormat,
                RbpJournalSchema.StoreFormat,
                StringComparison.Ordinal))
        {
            throw new RbpJournalException(
                RbpJournalErrorCode.UnsupportedSchema,
                "The existing database uses an unsupported journal format.");
        }

        IReadOnlyList<AppliedMigration> applied =
            ReadAppliedMigrations(connection);
        int userVersion = ScalarInt32(connection, "PRAGMA user_version;");
        if (metaVersion != applied.Count || userVersion != metaVersion)
        {
            throw new RbpJournalException(
                RbpJournalErrorCode.MigrationMismatch,
                "RBP journal schema authorities disagree.");
        }

        if (applied.Count > migrations.Count)
        {
            throw new RbpJournalException(
                RbpJournalErrorCode.UnsupportedSchema,
                "The RBP journal was created by a newer migration chain.");
        }

        for (int index = 0; index < applied.Count; index++)
        {
            AppliedMigration observed = applied[index];
            RbpJournalMigration expected = migrations[index];
            if (observed.Version != expected.Version ||
                !string.Equals(
                    observed.Owner,
                    expected.Owner,
                    StringComparison.Ordinal) ||
                !string.Equals(
                    observed.Name,
                    expected.Name,
                    StringComparison.Ordinal) ||
                !string.Equals(
                    observed.Digest,
                    RbpJournalSchema.Digest(expected),
                    StringComparison.Ordinal))
            {
                throw new RbpJournalException(
                    RbpJournalErrorCode.MigrationMismatch,
                    "The applied RBP journal migration chain does not match " +
                    "the executable.");
            }
        }

        if (applied.Count == migrations.Count)
        {
            return metaVersion;
        }

        nowMilliseconds = ClampMigrationTimestamp(
            connection,
            nowMilliseconds);
        using (SqliteTransaction transaction =
               connection.BeginTransaction(deferred: false))
        {
            try
            {
                ApplyMigrations(
                    connection,
                    transaction,
                    migrations,
                    applied.Count,
                    nowMilliseconds);
                transaction.Commit();
            }
            catch
            {
                TryRollback(transaction);
                throw;
            }
        }

        return migrations.Count;
    }

    private static long ClampMigrationTimestamp(
        SqliteConnection connection,
        long candidate)
    {
        using SqliteCommand command = CreateCommand(
            connection,
            """
            SELECT MAX(value)
            FROM (
              SELECT updated_at_ms AS value FROM journal_meta
              UNION ALL
              SELECT applied_at_ms AS value FROM schema_migrations
            );
            """);
        object? scalar = command.ExecuteScalar();
        long durableFloor =
            scalar is null || scalar is DBNull
                ? 0
                : Convert.ToInt64(
                    scalar,
                    CultureInfo.InvariantCulture);
        return Math.Max(candidate, durableFloor);
    }

    private static void ApplyMigrations(
        SqliteConnection connection,
        SqliteTransaction transaction,
        IReadOnlyList<RbpJournalMigration> migrations,
        int firstMigrationIndex,
        long nowMilliseconds)
    {
        for (int index = firstMigrationIndex;
             index < migrations.Count;
             index++)
        {
            RbpJournalMigration migration = migrations[index];
            ExecuteNonQuery(connection, migration.Sql, transaction);
            using SqliteCommand insert = CreateCommand(
                connection,
                """
                INSERT INTO schema_migrations(
                  version,owner,name,sql_sha256,applied_at_ms
                ) VALUES($version,$owner,$name,$digest,$applied_at_ms);
                """,
                transaction);
            insert.Parameters.AddWithValue("$version", migration.Version);
            insert.Parameters.AddWithValue("$owner", migration.Owner);
            insert.Parameters.AddWithValue("$name", migration.Name);
            insert.Parameters.AddWithValue(
                "$digest",
                RbpJournalSchema.Digest(migration));
            insert.Parameters.AddWithValue(
                "$applied_at_ms",
                nowMilliseconds);
            _ = insert.ExecuteNonQuery();
        }

        int targetVersion = migrations.Count;
        using (SqliteCommand updateMeta = CreateCommand(
                   connection,
                   """
                   UPDATE journal_meta
                   SET schema_version=$version,
                       updated_at_ms=MAX(updated_at_ms,$now)
                   WHERE singleton=1;
                   """,
                   transaction))
        {
            updateMeta.Parameters.AddWithValue("$version", targetVersion);
            updateMeta.Parameters.AddWithValue("$now", nowMilliseconds);
            if (updateMeta.ExecuteNonQuery() != 1)
            {
                throw new RbpJournalException(
                    RbpJournalErrorCode.MigrationMismatch,
                    "The RBP journal metadata row is missing.");
            }
        }

        ExecuteNonQuery(
            connection,
            "PRAGMA user_version=" +
            targetVersion.ToString(CultureInfo.InvariantCulture) +
            ";",
            transaction);
    }

    private static (string StoreFormat, int SchemaVersion) ReadJournalMeta(
        SqliteConnection connection)
    {
        using SqliteCommand command = CreateCommand(
            connection,
            """
            SELECT store_format,schema_version
            FROM journal_meta
            WHERE singleton=1;
            """);
        using SqliteDataReader reader = command.ExecuteReader();
        if (!reader.Read())
        {
            throw new RbpJournalException(
                RbpJournalErrorCode.MigrationMismatch,
                "The RBP journal metadata row is missing.");
        }

        string storeFormat = reader.GetString(0);
        int schemaVersion = reader.GetInt32(1);
        if (reader.Read())
        {
            throw new RbpJournalException(
                RbpJournalErrorCode.MigrationMismatch,
                "The RBP journal has multiple metadata rows.");
        }

        return (storeFormat, schemaVersion);
    }

    private static IReadOnlyList<AppliedMigration> ReadAppliedMigrations(
        SqliteConnection connection)
    {
        using SqliteCommand command = CreateCommand(
            connection,
            """
            SELECT version,owner,name,sql_sha256
            FROM schema_migrations
            ORDER BY version;
            """);
        using SqliteDataReader reader = command.ExecuteReader();
        var values = new List<AppliedMigration>();
        while (reader.Read())
        {
            values.Add(
                new AppliedMigration(
                    reader.GetInt32(0),
                    reader.GetString(1),
                    reader.GetString(2),
                    reader.GetString(3)));
        }

        for (int index = 0; index < values.Count; index++)
        {
            if (values[index].Version != index + 1)
            {
                throw new RbpJournalException(
                    RbpJournalErrorCode.MigrationMismatch,
                    "The applied RBP journal migrations are not contiguous.");
            }
        }

        return values.AsReadOnly();
    }

    private static bool TableExists(
        SqliteConnection connection,
        string tableName)
    {
        using SqliteCommand command = CreateCommand(
            connection,
            """
            SELECT COUNT(*)
            FROM sqlite_master
            WHERE type='table' AND name=$name;
            """);
        command.Parameters.AddWithValue("$name", tableName);
        return Convert.ToInt32(
                   command.ExecuteScalar(),
                   CultureInfo.InvariantCulture) == 1;
    }

    private static SqliteCommand CreateCommand(
        SqliteConnection connection,
        string commandText,
        SqliteTransaction? transaction = null)
    {
        SqliteCommand command = connection.CreateCommand();
        command.CommandText = commandText;
        command.Transaction = transaction;
        return command;
    }

    private static void ExecuteNonQuery(
        SqliteConnection connection,
        string commandText,
        SqliteTransaction? transaction = null)
    {
        using SqliteCommand command =
            CreateCommand(connection, commandText, transaction);
        _ = command.ExecuteNonQuery();
    }

    private static object? ExecuteScalar(
        SqliteConnection connection,
        string commandText)
    {
        using SqliteCommand command = CreateCommand(connection, commandText);
        return command.ExecuteScalar();
    }

    private static int ScalarInt32(
        SqliteConnection connection,
        string commandText)
    {
        return Convert.ToInt32(
            ExecuteScalar(connection, commandText),
            CultureInfo.InvariantCulture);
    }

    private static void TryRollback(SqliteTransaction transaction)
    {
        try
        {
            transaction.Rollback();
        }
        catch (InvalidOperationException)
        {
            // The transaction was already completed.
        }
        catch (SqliteException)
        {
            // Preserve the primary failure. Reopen recovery still quick-checks.
        }
    }

    private void EnsureOpen()
    {
        if (_closed)
        {
            throw new RbpJournalException(
                RbpJournalErrorCode.StoreClosed,
                "The RBP journal store is closed.");
        }

        if (_sensitiveCompactionUnproven)
        {
            throw new RbpJournalException(
                RbpJournalErrorCode.PostCommitFailure,
                "The RBP journal is blocked until restart because sensitive " +
                "WAL compaction could not be proven.",
                durableStateObserved: true);
        }
    }

    private static void RejectEscapedAsynchronousResult<T>(T result)
    {
        Type resultType = result is null
            ? typeof(T)
            : result.GetType();
        bool asynchronous =
            typeof(Task).IsAssignableFrom(resultType) ||
            resultType == typeof(ValueTask) ||
            (resultType.IsGenericType &&
             resultType.GetGenericTypeDefinition() ==
             typeof(ValueTask<>));
        if (asynchronous)
        {
            throw new InvalidOperationException(
                "RBP journal transaction callbacks must finish " +
                "synchronously and must not return Task or ValueTask.");
        }
    }

    private long NowMilliseconds()
    {
        long value = _nowMilliseconds();
        if (value < 0)
        {
            throw new RbpJournalException(
                RbpJournalErrorCode.IntegrityCheckFailed,
                "The RBP journal clock moved before the Unix epoch.");
        }

        return value;
    }

    private sealed record AppliedMigration(
        int Version,
        string Owner,
        string Name,
        string Digest);
}

internal interface IRbpJournalRollbackBackupSeam
{
    bool RequiresProtectedAcl { get; }
    void CreateTemporary(string path);
    void ProtectTemporary(string path);
    void CopyConsistently(SqliteConnection source, string temporaryPath);
    void PublishNoOverwrite(string temporaryPath, string backupPath);
    void CleanupTemporary(string temporaryPath);
}

internal sealed class SystemRbpJournalRollbackBackupSeam : IRbpJournalRollbackBackupSeam
{
    internal static readonly SystemRbpJournalRollbackBackupSeam Instance = new();
    public bool RequiresProtectedAcl => OperatingSystem.IsWindows();
    public void CreateTemporary(string path)
    {
        using FileStream _ = new(path, FileMode.CreateNew, FileAccess.ReadWrite, FileShare.None);
    }
    public void ProtectTemporary(string path)
    {
        if (OperatingSystem.IsWindows()) RbpJournalStore.ProtectRollbackBackup(path);
    }
    public void CopyConsistently(SqliteConnection source, string temporaryPath)
    {
        using var target = new SqliteConnection(new SqliteConnectionStringBuilder
        {
            DataSource = temporaryPath, Mode = SqliteOpenMode.ReadWriteCreate,
            Cache = SqliteCacheMode.Private, Pooling = false,
        }.ToString());
        target.Open();
        source.BackupDatabase(target);
    }
    public void PublishNoOverwrite(string temporaryPath, string backupPath) =>
        File.Move(temporaryPath, backupPath, overwrite: false);
    public void CleanupTemporary(string temporaryPath)
    {
        if (File.Exists(temporaryPath)) File.Delete(temporaryPath);
    }
}
