using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using RevAgent.Bridge.Gateway.Dispatch;
using RevAgent.Bridge.Gateway.Protocol;
using RevAgent.Bridge.Gateway.Storage;
using RevAgent.Bridge.Tests.Gateway.Dispatch;

namespace RevAgent.Bridge.Tests.Gateway.Storage;

/// <summary>
/// Frozen O1 Section 6.2.1 conformance for the mutation-recovery hold
/// correlation id (spec ~469-480):
/// <code>
/// hold_material = {"mutation_scope":&lt;scope&gt;,"origin_idempotency_keys":[&lt;ordered keys&gt;],"rsid":&lt;rsid&gt;}
/// verification_hold_id = "vh:" + lowercase_hex(SHA-256(UTF-8-without-BOM(RFC8785-JCS(hold_material))))
/// </code>
/// </summary>
/// <remarks>
/// Every expectation here is derived independently of the production code:
/// the material is assembled as a literal string in this file and hashed with
/// <see cref="SHA256"/> directly. The literal is already the RFC 8785 form —
/// object members appear in ascending code-point order
/// (<c>document_id</c> &lt; <c>kind</c>, <c>mutation_scope</c> &lt;
/// <c>origin_idempotency_keys</c> &lt; <c>rsid</c>), there is no insignificant
/// whitespace, and every string is unescaped ASCII — so no canonicalizer is
/// needed to reproduce it. The store is never asserted against its own output.
/// </remarks>
public sealed class RbpVerificationHoldDerivationTests
{
    private const string Rsid = "rs-test";
    private const string WriteMethod = "create_wall";
    private const string DocumentOneScope =
        """{"document_id":"doc-1","kind":"document"}""";
    private const string DocumentTwoScope =
        """{"document_id":"doc-2","kind":"document"}""";
    private const string SessionScope = """{"kind":"session"}""";

    private const string OriginInvocationId =
        "0197a3c2-0000-7000-8000-0000000000b2";
    private const string SecondInvocationId =
        "0197a3c2-0000-7000-8000-0000000000f4";

    private const string BatchId = "0197a3c2-0000-7000-8000-0000000000c0";
    private const string StepA = "0197a3c2-0000-7000-8000-0000000000c1";
    private const string StepB = "0197a3c2-0000-7000-8000-0000000000c2";
    private const string StepC = "0197a3c2-0000-7000-8000-0000000000c3";
    private const string StepD = "0197a3c2-0000-7000-8000-0000000000c4";

    /// <summary>
    /// The golden vector for one uncertain document-scoped invocation, over
    /// the material printed in <c>MaterialIsTheFrozenHoldMaterialShape</c>.
    /// </summary>
    private const string SingleDocumentGoldenVector =
        "vh:91f227b8577246f5b5461d6f94d2d0346073a73fb1ea25994b48016be754721a";

    private const string SingleSessionGoldenVector =
        "vh:99546edf0457f1f52afcb8b38a34adad11721064a9e8d9b69e78610c3ede024f";

    private const string BatchDocumentOneGoldenVector =
        "vh:d557266d47237abe7331260e7d455f80e2952bbe864863889c5dad489a6783a1";

    private const string BatchDocumentTwoGoldenVector =
        "vh:2d447e89f6dbfd4f3c60b1ede54433e9d4f74c06463199737c72d29e8c98e0ad";

    private const string BatchSessionGoldenVector =
        "vh:db677390508c1efcc4ca1adbafcbbdbf44d941bfda6a3448c32b553ef63ce0c3";

    private const string VerificationId =
        "0197a3c2-0000-7000-8000-0000000000e1";
    private const string ResolutionId =
        "0197a3c2-0000-7000-8000-000000000101";
    private const string AuditId =
        "0197a3c2-0000-7000-8000-000000000102";

    [Fact]
    public void MaterialIsTheFrozenHoldMaterialShape()
    {
        // Guards the literal the rest of this suite hashes: it must be the
        // exact frozen material, not merely something that hashes stably.
        Assert.Equal(
            """
            {"mutation_scope":{"document_id":"doc-1","kind":"document"},"origin_idempotency_keys":["rs-test/0197a3c2-0000-7000-8000-0000000000b2"],"rsid":"rs-test"}
            """,
            Material(DocumentOneScope, Key(OriginInvocationId)));
        Assert.Equal(
            SingleDocumentGoldenVector,
            Derive(Material(DocumentOneScope, Key(OriginInvocationId))));
    }

    [Fact]
    public async Task SingleInvocationHoldIdIsDerivedFromItsOwnMaterial()
    {
        using var directory = new RbpJournalTestDirectory();
        await using RbpJournalStore store = await OpenAsync(directory);
        RbpInvocationIdentity origin = WriteIdentity();

        string holdId = await InstallIndeterminateHoldAsync(store, origin);

        // Spec ~477: "For one invocation the origin list has one key."
        Assert.Equal(
            Derive(Material(DocumentOneScope, origin.IdempotencyKey)),
            holdId);
        Assert.Equal(SingleDocumentGoldenVector, holdId);

        RbpVerificationHold? hold = await store.GetHoldAsync(Rsid, holdId);
        Assert.NotNull(hold);
        Assert.Equal(
            new[] { origin.IdempotencyKey },
            hold!.OrderedOriginIdempotencyKeys);
        Assert.Equal("document", hold.ScopeKind);
    }

    [Fact]
    public async Task SessionScopeAndDocumentScopeDeriveDifferentHoldIds()
    {
        using var directory = new RbpJournalTestDirectory();
        await using RbpJournalStore store = await OpenAsync(directory);

        RbpInvocationIdentity documentOrigin = WriteIdentity();
        RbpInvocationIdentity sessionOrigin = WriteIdentity(
            scopeJcs: SessionScope,
            invocationId: SecondInvocationId);

        // A document hold subsumes a later session mutation. The separate
        // scope material remains independently derivable, but the safety
        // barrier correctly denies that later session origin before it can
        // acquire dispatch ownership.
        await StartPossiblyDispatchedMutationAsync(store, documentOrigin);
        string documentHold =
            await RefuseRedeliveryAsync(store, documentOrigin);
        RbpInvocationAdmissionResult denied =
            await store.AdmitInvocationAsync(sessionOrigin);

        Assert.Equal(
            Derive(Material(DocumentOneScope, Key(OriginInvocationId))),
            documentHold);
        Assert.Equal(SingleDocumentGoldenVector, documentHold);
        Assert.Equal(
            Derive(Material(SessionScope, Key(SecondInvocationId))),
            "vh:" + Sha256Hex(
                """
                {"mutation_scope":{"kind":"session"},"origin_idempotency_keys":["rs-test/0197a3c2-0000-7000-8000-0000000000f4"],"rsid":"rs-test"}
                """));
        Assert.Equal(
            RbpInvocationAdmission.BlockedByConflictingHold,
            denied.Admission);
        Assert.Equal(documentHold, denied.VerificationHoldId);
        Assert.Null(await store.GetInvocationAsync(sessionOrigin.IdempotencyKey));

        // The scope is part of the material, so the same rsid under two
        // scopes never collides.
        Assert.NotEqual(
            documentHold,
            Derive(Material(SessionScope, Key(SecondInvocationId))));
    }

    [Fact]
    public async Task SameInvocationUnderTwoSessionsDerivesTwoHoldIds()
    {
        using var directory = new RbpJournalTestDirectory();
        await using RbpJournalStore store = await OpenAsync(directory);
        _ = await store.PersistRegisteredSessionAsync(
            RbpJournalTestData.Registration(
                "rs-other",
                localSessionKey: "port:8081:pid:1235"));

        string first = await InstallIndeterminateHoldAsync(
            store,
            WriteIdentity());
        string second = await InstallIndeterminateHoldAsync(
            store,
            WriteIdentity() with { Rsid = "rs-other" });

        Assert.NotEqual(first, second);
        Assert.Equal(
            "vh:" + Sha256Hex(
                """
                {"mutation_scope":{"document_id":"doc-1","kind":"document"},"origin_idempotency_keys":["rs-other/0197a3c2-0000-7000-8000-0000000000b2"],"rsid":"rs-other"}
                """),
            second);
    }

    [Fact]
    public async Task AtomicBatchDerivesOneHoldPerDocumentFromOrderedOrigins()
    {
        using var directory = new RbpJournalTestDirectory();
        await using RbpJournalStore store = await OpenAsync(directory);
        RbpBatchIdentity batch = RbpBatchTestData.Batch(
            atomic: true,
            BatchId,
            new[]
            {
                RbpBatchTestData.WriteStep(StepA),
                RbpBatchTestData.ReadStep(StepB),
                RbpBatchTestData.WriteStep(
                    StepC,
                    method: "set_element_parameter"),
                RbpBatchTestData.WriteStep(StepD, DocumentTwoScope),
            });
        _ = await store.AdmitBatchAsync(
            batch,
            Array.Empty<RbpRecoveryClearance>());
        await store.MarkBatchDispatchedAsync(batch.BatchKey);

        RbpBatchAdmissionResult arbitrated =
            (await store.AdmitBatchAsync(
                batch,
                Array.Empty<RbpRecoveryClearance>())).Admission!;

        // Spec ~477-478: each scope's list contains, in input order, every
        // possibly executed mutating step key in that scope.
        string documentOne = Derive(
            Material(DocumentOneScope, Key(StepA), Key(StepC)));
        string documentTwo = Derive(Material(DocumentTwoScope, Key(StepD)));
        Assert.Equal(BatchDocumentOneGoldenVector, documentOne);
        Assert.Equal(BatchDocumentTwoGoldenVector, documentTwo);
        Assert.Equal(documentOne, arbitrated.Steps[0].VerificationHoldId);
        Assert.Equal(documentOne, arbitrated.Steps[2].VerificationHoldId);
        Assert.Equal(documentTwo, arbitrated.Steps[3].VerificationHoldId);

        // Array order is significant: a permuted origin list is a different
        // hold, so the store may not answer with it.
        string permuted = Derive(
            Material(DocumentOneScope, Key(StepC), Key(StepA)));
        Assert.NotEqual(permuted, documentOne);
        Assert.Null(await store.GetHoldAsync(Rsid, permuted));

        RbpVerificationHold? hold =
            await store.GetHoldAsync(Rsid, documentOne);
        Assert.Equal(
            new[] { Key(StepA), Key(StepC) },
            hold!.OrderedOriginIdempotencyKeys);
    }

    [Fact]
    public async Task AnUncertainSessionStepSubsumesThatBatchsDocumentHolds()
    {
        using var directory = new RbpJournalTestDirectory();
        await using RbpJournalStore store = await OpenAsync(directory);
        RbpBatchIdentity batch = RbpBatchTestData.Batch(
            atomic: true,
            BatchId,
            new[]
            {
                RbpBatchTestData.WriteStep(StepA),
                RbpBatchTestData.WriteStep(
                    StepB,
                    SessionScope,
                    method: "set_element_parameter"),
                RbpBatchTestData.WriteStep(StepC, DocumentTwoScope),
            });
        _ = await store.AdmitBatchAsync(
            batch,
            Array.Empty<RbpRecoveryClearance>());
        await store.MarkBatchDispatchedAsync(batch.BatchKey);

        RbpBatchAdmissionResult arbitrated =
            (await store.AdmitBatchAsync(
                batch,
                Array.Empty<RbpRecoveryClearance>())).Admission!;

        // Spec ~478-480: "If any uncertain step uses session scope, one
        // session hold contains all possibly executed mutating origin keys
        // and subsumes document holds for that batch."
        string sessionHold = Derive(
            Material(SessionScope, Key(StepA), Key(StepB), Key(StepC)));
        Assert.Equal(BatchSessionGoldenVector, sessionHold);
        Assert.All(
            arbitrated.Steps,
            step => Assert.Equal(sessionHold, step.VerificationHoldId));

        RbpVerificationHold? hold = await store.GetHoldAsync(Rsid, sessionHold);
        Assert.NotNull(hold);
        Assert.Equal("session", hold!.ScopeKind);
        Assert.Equal(
            new[] { Key(StepA), Key(StepB), Key(StepC) },
            hold.OrderedOriginIdempotencyKeys);

        // The subsumed document holds are not installed at all.
        Assert.Null(
            await store.GetHoldAsync(
                Rsid,
                Derive(Material(DocumentOneScope, Key(StepA)))));
        Assert.Null(
            await store.GetHoldAsync(
                Rsid,
                Derive(Material(DocumentTwoScope, Key(StepC)))));

        RbpStoredBatch stored = (await store.GetBatchAsync(batch.BatchKey))!;
        Assert.Contains(
            $"\"verification_hold_ids\":[\"{sessionHold}\"]",
            stored.TerminalOutcomeJson,
            StringComparison.Ordinal);
    }

    [Fact]
    public async Task ALaterOriginOnAHeldScopeKeepsTheOriginalStableId()
    {
        using var directory = new RbpJournalTestDirectory();
        await using RbpJournalStore store = await OpenAsync(directory);
        RbpInvocationIdentity first = WriteIdentity();
        RbpInvocationIdentity second =
            WriteIdentity(invocationId: SecondInvocationId);

        // The first mutation is left `executing`, which is exactly the state
        // a crash between Section 12.1 steps 2 and 3 produces.
        _ = await store.AdmitInvocationAsync(first);
        await store.MarkInvocationExecutingAsync(first.IdempotencyKey);

        string installed =
            (await store.AdmitInvocationAsync(first)).VerificationHoldId!;
        RbpInvocationAdmissionResult later =
            await store.AdmitInvocationAsync(second);

        // Spec ~470 makes the id a *stable* correlation value while the hold
        // is indexed by (rsid, mutation_scope), spec ~477-480 defines the
        // origin list only for one invocation or one uncertain atomic batch,
        // and spec ~482-485 answers a later conflicting mutation with "the
        // original hold's journal_indeterminate error". The origin list is
        // therefore fixed at install and the id never moves.
        Assert.Equal(
            RbpInvocationAdmission.BlockedByConflictingHold,
            later.Admission);
        Assert.Equal(installed, later.VerificationHoldId);
        Assert.Equal(
            Derive(Material(DocumentOneScope, first.IdempotencyKey)),
            installed);

        RbpVerificationHold? hold = await store.GetHoldAsync(Rsid, installed);
        Assert.Equal(
            new[] { first.IdempotencyKey },
            hold!.OrderedOriginIdempotencyKeys);
        Assert.Null(await store.GetInvocationAsync(second.IdempotencyKey));

        // The extended material is never the answer, in either direction.
        Assert.NotEqual(
            Derive(
                Material(
                    DocumentOneScope,
                    first.IdempotencyKey,
                    second.IdempotencyKey)),
            installed);
        Assert.Null(
            await store.GetHoldAsync(
                Rsid,
                Derive(
                    Material(
                        DocumentOneScope,
                        first.IdempotencyKey,
                        second.IdempotencyKey))));
    }

    [Fact]
    public async Task AClearanceOnTheDerivedHoldIsAccepted()
    {
        using var directory = new RbpJournalTestDirectory();
        var fixture = new RbpApplicationErrorSafetyTests.RoutedFixture("{}", -32603);
        await using RbpJournalStore store = await OpenAsync(directory, fixture);
        string holdId =
            await InstallIndeterminateHoldAsync(store, WriteIdentity());
        Assert.Equal(
            Derive(Material(DocumentOneScope, Key(OriginInvocationId))),
            holdId);
        string evidenceDigest = await ProduceCorrelatedVerificationEvidenceAsync(
            store,
            fixture,
            holdId);

        RbpRecoveryClearance clearance = Clearance(holdId, evidenceDigest);
        RbpInvocationIdentity recovery = WriteIdentity(
            invocationId: SecondInvocationId) with
        {
            RecoveryClearancesJcs = RbpBatchTestData.ClearanceArrayJcs(clearance),
        };
        RbpClearanceGatedAdmission admitted =
            await store.AdmitInvocationWithClearancesAsync(
                recovery,
                new[] { clearance });

        Assert.Null(admitted.BlockingHold);
        Assert.Equal(
            RbpInvocationAdmission.Accepted,
            admitted.Admission?.Admission);
        Assert.Equal(
            RbpHoldState.Cleared,
            (await store.GetHoldAsync(Rsid, holdId))!.State);
    }

    [Fact]
    public async Task ANonDerivableClearanceHoldIdFailsClosed()
    {
        using var directory = new RbpJournalTestDirectory();
        var fixture = new RbpApplicationErrorSafetyTests.RoutedFixture("{}", -32603);
        await using RbpJournalStore store = await OpenAsync(directory, fixture);
        string holdId =
            await InstallIndeterminateHoldAsync(store, WriteIdentity());
        string evidenceDigest = await ProduceCorrelatedVerificationEvidenceAsync(
            store,
            fixture,
            holdId);

        // Correctly shaped ("vh:" plus 64 lowercase hex) but not derivable
        // from any durable hold material: it clears nothing and admits
        // nothing.
        string undecidable = "vh:" + new string('a', 64);
        Assert.NotEqual(holdId, undecidable);
        RbpRecoveryClearance clearance = Clearance(undecidable, evidenceDigest);
        RbpInvocationIdentity recovery = WriteIdentity(
            invocationId: SecondInvocationId) with
        {
            RecoveryClearancesJcs = RbpBatchTestData.ClearanceArrayJcs(clearance),
        };
        RbpJournalException fault =
            await Assert.ThrowsAsync<RbpJournalException>(
                () => store.AdmitInvocationWithClearancesAsync(
                    recovery,
                    new[] { clearance }));

        Assert.Equal(RbpJournalErrorCode.ProtocolConflict, fault.ErrorCode);
        Assert.Equal(
            RbpHoldState.EvidenceRecorded,
            (await store.GetHoldAsync(Rsid, holdId))!.State);
        Assert.Null(
            await store.GetInvocationAsync(Key(SecondInvocationId)));
    }

    /// <summary>
    /// The independent derivation: SHA-256 over the UTF-8 bytes of the
    /// canonical material, with no BOM and no production helper involved.
    /// </summary>
    private static string Derive(string materialJson) =>
        "vh:" + Sha256Hex(materialJson);

    private static string Sha256Hex(string canonicalJson) =>
        Convert.ToHexString(
                SHA256.HashData(
                    new UTF8Encoding(
                            encoderShouldEmitUTF8Identifier: false,
                            throwOnInvalidBytes: true)
                        .GetBytes(canonicalJson)))
            .ToLowerInvariant();

    private static string Material(
        string scopeJcs,
        params string[] orderedOriginKeys)
    {
        var builder = new StringBuilder();
        builder.Append("{\"mutation_scope\":").Append(scopeJcs);
        builder.Append(",\"origin_idempotency_keys\":[");
        for (int index = 0; index < orderedOriginKeys.Length; index++)
        {
            if (index > 0)
            {
                builder.Append(',');
            }

            builder.Append('"').Append(orderedOriginKeys[index]).Append('"');
        }

        builder.Append("],\"rsid\":\"").Append(Rsid).Append("\"}");
        return builder.ToString();
    }

    private static string Key(string invocationId) =>
        Rsid + "/" + invocationId;

    private static async Task<string> InstallIndeterminateHoldAsync(
        RbpJournalStore store,
        RbpInvocationIdentity origin)
    {
        await StartPossiblyDispatchedMutationAsync(store, origin);
        return await RefuseRedeliveryAsync(store, origin);
    }

    /// <summary>
    /// Leaves one mutation in <c>executing</c> — the state a crash between
    /// Section 12.1 steps 2 and 3 produces — without installing a hold yet.
    /// </summary>
    private static async Task StartPossiblyDispatchedMutationAsync(
        RbpJournalStore store,
        RbpInvocationIdentity origin)
    {
        _ = await store.AdmitInvocationAsync(origin);
        await store.MarkInvocationExecutingAsync(origin.IdempotencyKey);
    }

    /// <summary>
    /// Redelivers an origin key, which Section 12.2 rule 4 refuses and which
    /// spec ~484 exempts from the Section 6.2.1 conflict block, so the hold
    /// installs even when another scope is already held.
    /// </summary>
    private static async Task<string> RefuseRedeliveryAsync(
        RbpJournalStore store,
        RbpInvocationIdentity origin)
    {
        RbpInvocationAdmissionResult refused =
            await store.AdmitInvocationAsync(origin);
        Assert.Equal(
            RbpInvocationAdmission.RefuseIndeterminate,
            refused.Admission);
        return refused.VerificationHoldId!;
    }

    private static RbpRecoveryClearance Clearance(
        string holdId,
        string evidenceDigest) =>
        new(
            holdId,
            DocumentOneScope,
            ResolutionId,
            RbpClearanceBasis.VerificationRead,
            VerificationId,
            evidenceDigest,
            RbpClearanceDecision.PostconditionVerified,
            AuditId);

    private static RbpInvocationIdentity WriteIdentity(
        string scopeJcs = DocumentOneScope,
        string invocationId = OriginInvocationId) =>
        new(
            Rsid,
            invocationId,
            WriteMethod,
            Mutating: true,
            MutationScopeJcs: scopeJcs,
            ParamsDigest: "sha256:" + new string('a', 64),
            PolicyJcs: """{"decision":"allow"}""",
            RecoveryClearancesJcs: "[]");

    private static async Task<RbpJournalStore> OpenAsync(
        RbpJournalTestDirectory directory,
        RbpApplicationErrorSafetyTests.RoutedFixture? fixture = null)
    {
        RbpJournalStore store = RbpJournalStore.Open(
            directory.JournalPath,
            new TestResumeTokenProtector(),
            RbpJournalTestData.Options());
        _ = await store.PersistRegisteredSessionAsync(
            RbpJournalTestData.Registration(
                localSessionKey: fixture is null
                    ? "port:8080:pid:1234"
                    : fixture.Route.Handle!.LocalSessionKey));
        return store;
    }

    private static async Task<string> ProduceCorrelatedVerificationEvidenceAsync(
        RbpJournalStore store,
        RbpApplicationErrorSafetyTests.RoutedFixture fixture,
        string holdId)
    {
        fixture.Transport.SetResponse("""{"success":true}""", null);
        var dispatcher = new RbpInvocationDispatcher(
            store,
            fixture.Channel,
            new RbpInFlightGate());
        RbpInvocationAnswer verification = await dispatcher.DispatchAsync(
            VerificationReadRequest(holdId),
            CancellationToken.None);

        Assert.Equal("result", verification.Type);
        RbpVerificationHold hold =
            (await store.GetHoldAsync(Rsid, holdId))!;
        Assert.Equal(RbpHoldState.EvidenceRecorded, hold.State);
        Assert.Equal(VerificationId, hold.VerificationInvocationId);
        return hold.EvidenceDigest!;
    }

    private static RbpInvokeRequest VerificationReadRequest(string holdId)
    {
        string payload =
            $$"""
            {
              "invocation_id": "{{VerificationId}}",
              "method": "get_element_parameter",
              "params": {"element_id": 42},
              "timeout_ms": 30000,
              "mutating": false,
              "mutation_scope": null,
              "policy": {"class":"read","decision":"allow"},
              "verification": {
                "hold_id": "{{holdId}}",
                "mutation_scope": {"document_id":"doc-1","kind":"document"},
                "purpose": "resolve_indeterminate"
              },
              "recovery_clearances": []
            }
            """;
        using JsonDocument document = JsonDocument.Parse(payload);
        return RbpInvokeRequest.Parse(Rsid, document.RootElement.Clone());
    }
}
