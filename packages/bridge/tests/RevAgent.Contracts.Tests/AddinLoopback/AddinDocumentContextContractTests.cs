using System;
using System.Collections.Generic;
using System.Linq;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;
using Newtonsoft.Json.Serialization;
using RevAgent.Contracts.AddinLoopback;
using RevAgent.Contracts.Rbp;
using Xunit;

namespace RevAgent.Contracts.Tests.AddinLoopback
{
    /// <summary>
    /// Appendix A.3 contract tests for the add-in document-context cache:
    /// the cacheState/revision state machine, the event-driven aggregator,
    /// the exact response envelope, and the A.2 doc_context_cached_v1
    /// capability descriptor. Every produced envelope is round-tripped
    /// through the frozen bridge-side <see cref="AddinDocumentContextParser"/>
    /// so both ends of the wire agree.
    /// </summary>
    public sealed class AddinDocumentContextContractTests
    {
        private static readonly DateTimeOffset BaseTime =
            new DateTimeOffset(2026, 7, 31, 10, 0, 0, TimeSpan.Zero);

        private static Func<DateTimeOffset> FixedClock()
        {
            return () => BaseTime;
        }

        private static AddinDocumentContextDocumentState Document(
            string documentId,
            string title = "Sample Model",
            string? pathDigest = null,
            bool isWorkshared = false)
        {
            return new AddinDocumentContextDocumentState(documentId, title, pathDigest, isWorkshared);
        }

        private static AddinDocumentContextViewState View(
            string id = "1001",
            string name = "Level 1 Plan",
            string type = "FloorPlan",
            string? level = "Level 1")
        {
            return new AddinDocumentContextViewState(id, name, type, level);
        }

        private static AddinDocumentContextDocumentSource Source(
            string stableKey,
            string title = "Sample Model",
            string? pathDigest = null,
            bool isWorkshared = false)
        {
            return new AddinDocumentContextDocumentSource(stableKey, title, pathDigest, isWorkshared);
        }

        private static RevAgent.Contracts.Rbp.AddinDocumentContextSnapshot ParseWithFrozenBridgeParser(
            AddinDocumentContextCacheSnapshot snapshot)
        {
            return AddinDocumentContextParser.ParseResult(snapshot.ToResultObject());
        }

        // ---------------------------------------------------------------
        // A.2: doc_context_cached_v1 capability descriptor
        // ---------------------------------------------------------------

        [Fact]
        public void CapabilityDescriptorHasTheExactFrozenShape()
        {
            AddinDocumentContextCapability capability = AddinDocumentContextContract.CreateCapability();

            Assert.Equal(1, capability.ContractVersion);
            Assert.Equal("get_document_context", capability.Method);
            Assert.Equal("application_events_cache", capability.Source);
            Assert.Equal(15000, capability.PollIntervalMs);
            Assert.False(capability.UiThreadRoundTrip);
        }

        [Fact]
        public void CapabilityDescriptorSerializesToTheExactWireKeys()
        {
            JsonSerializer camelCase = JsonSerializer.Create(new JsonSerializerSettings
            {
                ContractResolver = new DefaultContractResolver
                {
                    NamingStrategy = new CamelCaseNamingStrategy
                    {
                        ProcessDictionaryKeys = false,
                        OverrideSpecifiedNames = false,
                    },
                },
            });

            JObject wire = JObject.FromObject(
                AddinDocumentContextContract.CreateCapability(),
                camelCase);

            Assert.Equal(
                new[] { "contractVersion", "method", "source", "pollIntervalMs", "uiThreadRoundTrip" },
                wire.Properties().Select(property => property.Name).ToArray());
            Assert.Equal(1, wire["contractVersion"]!.Value<int>());
            Assert.Equal("get_document_context", wire["method"]!.Value<string>());
            Assert.Equal("application_events_cache", wire["source"]!.Value<string>());
            Assert.Equal(15000, wire["pollIntervalMs"]!.Value<int>());
            Assert.False(wire["uiThreadRoundTrip"]!.Value<bool>());
        }

        // ---------------------------------------------------------------
        // A.3: request params are the empty object
        // ---------------------------------------------------------------

        [Fact]
        public void EmptyOrMissingRequestParametersAreAccepted()
        {
            AddinDocumentContextContract.ValidateRequestParameters(null);
            AddinDocumentContextContract.ValidateRequestParameters(new JObject());
        }

        [Fact]
        public void NonEmptyRequestParametersAreRejectedWithInvalidParams()
        {
            AddinDocumentContextRequestException rejection =
                Assert.Throws<AddinDocumentContextRequestException>(() =>
                    AddinDocumentContextContract.ValidateRequestParameters(
                        new JObject { ["anything"] = true }));

            Assert.Equal(-32602, rejection.JsonRpcErrorCode);
        }

        // ---------------------------------------------------------------
        // A.3 state machine: warming -> ready -> unavailable -> ready
        // ---------------------------------------------------------------

        [Fact]
        public void CacheStartsWarmingAtRevisionZeroWithABoundedReason()
        {
            AddinDocumentContextCacheSnapshot snapshot =
                new AddinDocumentContextCache(FixedClock()).Read();

            Assert.Equal(0, snapshot.Revision);
            Assert.Equal("warming", snapshot.CacheState);
            Assert.False(string.IsNullOrEmpty(snapshot.UnavailableReason));
            Assert.True(snapshot.UnavailableReason!.Length <= 256);
            Assert.Empty(snapshot.Documents);
            Assert.Null(snapshot.ActiveDocumentId);
            Assert.Null(snapshot.ActiveView);
            Assert.Null(snapshot.DisciplineHint);

            RevAgent.Contracts.Rbp.AddinDocumentContextSnapshot parsed =
                ParseWithFrozenBridgeParser(snapshot);
            Assert.Equal(DocumentContextCacheState.Warming, parsed.CacheState);
        }

        [Fact]
        public void FirstPublishMovesWarmingToReadyAtRevisionOne()
        {
            AddinDocumentContextCache cache = new AddinDocumentContextCache(FixedClock());

            AddinDocumentContextCacheSnapshot snapshot = cache.PublishContext(
                new[] { Document("doc-1") },
                "doc-1",
                View(),
                "mechanical");

            Assert.Equal(1, snapshot.Revision);
            Assert.Equal("ready", snapshot.CacheState);
            Assert.Null(snapshot.UnavailableReason);
            Assert.Equal("doc-1", snapshot.ActiveDocumentId);
            Assert.Equal("mechanical", snapshot.DisciplineHint);
            Assert.Equal(DocumentContextCacheState.Ready, ParseWithFrozenBridgeParser(snapshot).CacheState);
        }

        [Fact]
        public void UnchangedPublishKeepsRevisionAndCapturedAtStable()
        {
            DateTimeOffset now = BaseTime;
            AddinDocumentContextCache cache = new AddinDocumentContextCache(() => now);
            cache.PublishContext(new[] { Document("doc-1") }, "doc-1", View(), "mechanical");

            now = BaseTime.AddMinutes(5);
            AddinDocumentContextCacheSnapshot unchanged = cache.PublishContext(
                new[] { Document("doc-1") },
                "doc-1",
                View(),
                "mechanical");

            Assert.Equal(1, unchanged.Revision);
            Assert.Equal(BaseTime, unchanged.CapturedAtUtc);
            Assert.Equal(1, cache.Read().Revision);
        }

        [Fact]
        public void EachNormalizedChangeIncrementsRevisionByExactlyOne()
        {
            AddinDocumentContextCache cache = new AddinDocumentContextCache(FixedClock());

            Assert.Equal(1, cache.PublishContext(
                new[] { Document("doc-1") }, null, null, null).Revision);
            Assert.Equal(2, cache.PublishContext(
                new[] { Document("doc-1") }, "doc-1", null, null).Revision);
            Assert.Equal(3, cache.PublishContext(
                new[] { Document("doc-1") }, "doc-1", View(), null).Revision);
            Assert.Equal(4, cache.PublishContext(
                new[] { Document("doc-1") }, "doc-1", View(level: null), null).Revision);
            Assert.Equal(5, cache.PublishContext(
                new[] { Document("doc-1", isWorkshared: true) }, "doc-1", View(level: null), null).Revision);
            Assert.Equal(6, cache.MarkUnavailable("capture failed").Revision);
            Assert.Equal(7, cache.PublishContext(
                new[] { Document("doc-1", isWorkshared: true) }, "doc-1", View(level: null), null).Revision);
        }

        [Fact]
        public void MarkUnavailableClearsDocumentsAndActiveContext()
        {
            AddinDocumentContextCache cache = new AddinDocumentContextCache(FixedClock());
            cache.PublishContext(new[] { Document("doc-1") }, "doc-1", View(), "mechanical");

            AddinDocumentContextCacheSnapshot snapshot = cache.MarkUnavailable("event capture failed");

            Assert.Equal(2, snapshot.Revision);
            Assert.Equal("unavailable", snapshot.CacheState);
            Assert.Equal("event capture failed", snapshot.UnavailableReason);
            Assert.Empty(snapshot.Documents);
            Assert.Null(snapshot.ActiveDocumentId);
            Assert.Null(snapshot.ActiveView);
            Assert.Null(snapshot.DisciplineHint);
            Assert.Equal(
                DocumentContextCacheState.Unavailable,
                ParseWithFrozenBridgeParser(snapshot).CacheState);
        }

        [Fact]
        public void RepeatedIdenticalUnavailableReasonIsANoOp()
        {
            AddinDocumentContextCache cache = new AddinDocumentContextCache(FixedClock());
            cache.MarkUnavailable("same reason");

            Assert.Equal(1, cache.MarkUnavailable("same reason").Revision);
            Assert.Equal(2, cache.MarkUnavailable("different reason").Revision);
        }

        [Fact]
        public void UnavailableReasonIsNormalizedToTheBoundedNonEmptyShape()
        {
            AddinDocumentContextCache cache = new AddinDocumentContextCache(FixedClock());

            AddinDocumentContextCacheSnapshot defaulted = cache.MarkUnavailable("   ");
            Assert.False(string.IsNullOrWhiteSpace(defaulted.UnavailableReason));

            string overlong = new string('x', 300) + "\U0001F600";
            AddinDocumentContextCacheSnapshot truncated = cache.MarkUnavailable(overlong);
            Assert.Equal(new string('x', 256), truncated.UnavailableReason);
            ParseWithFrozenBridgeParser(truncated);
        }

        [Fact]
        public void SurrogatePairReasonTruncationCountsCodePoints()
        {
            string emoji = string.Concat(Enumerable.Repeat("\U0001F600", 300));
            AddinDocumentContextCacheSnapshot snapshot =
                new AddinDocumentContextCache(FixedClock()).MarkUnavailable(emoji);

            Assert.Equal(512, snapshot.UnavailableReason!.Length);
            Assert.Equal(string.Concat(Enumerable.Repeat("\U0001F600", 256)), snapshot.UnavailableReason);
            ParseWithFrozenBridgeParser(snapshot);
        }

        [Fact]
        public void ReadNeverMutatesRevisionOrState()
        {
            AddinDocumentContextCache cache = new AddinDocumentContextCache(FixedClock());
            cache.PublishContext(new[] { Document("doc-1") }, null, null, null);

            for (int index = 0; index < 5; index++)
            {
                Assert.Equal(1, cache.Read().Revision);
                Assert.Equal("ready", cache.Read().CacheState);
            }
        }

        [Fact]
        public void RevisionStopsAtTheJsonSafeCeiling()
        {
            AddinDocumentContextCache cache = new AddinDocumentContextCache(
                FixedClock(),
                AddinDocumentContextContract.MaxRevision - 1);

            AddinDocumentContextCacheSnapshot last = cache.PublishContext(
                new[] { Document("doc-1") },
                null,
                null,
                null);
            Assert.Equal(AddinDocumentContextContract.MaxRevision, last.Revision);
            ParseWithFrozenBridgeParser(last);

            Assert.Throws<InvalidOperationException>(() => cache.MarkUnavailable("over the ceiling"));
            Assert.Equal(AddinDocumentContextContract.MaxRevision, cache.Read().Revision);
        }

        // ---------------------------------------------------------------
        // A.3 publish validation: invalid observations never corrupt state
        // ---------------------------------------------------------------

        [Fact]
        public void PublishRejectsMoreThanThirtyTwoDocuments()
        {
            AddinDocumentContextCache cache = new AddinDocumentContextCache(FixedClock());
            AddinDocumentContextDocumentState[] documents = Enumerable.Range(1, 33)
                .Select(ordinal => Document("doc-" + ordinal))
                .ToArray();

            Assert.Throws<ArgumentException>(() => cache.PublishContext(documents, null, null, null));
            Assert.Equal(0, cache.Read().Revision);
            Assert.Equal("warming", cache.Read().CacheState);
        }

        [Fact]
        public void PublishRejectsDuplicateDocumentIds()
        {
            AddinDocumentContextCache cache = new AddinDocumentContextCache(FixedClock());

            Assert.Throws<ArgumentException>(() => cache.PublishContext(
                new[] { Document("doc-1"), Document("doc-1", "Other Title") },
                null,
                null,
                null));
        }

        [Fact]
        public void PublishRejectsAnActiveDocumentOutsideTheList()
        {
            AddinDocumentContextCache cache = new AddinDocumentContextCache(FixedClock());

            Assert.Throws<ArgumentException>(() => cache.PublishContext(
                new[] { Document("doc-1") },
                "doc-2",
                null,
                null));
        }

        [Fact]
        public void PublishRejectsAnActiveViewWithoutAnActiveDocument()
        {
            AddinDocumentContextCache cache = new AddinDocumentContextCache(FixedClock());

            Assert.Throws<ArgumentException>(() => cache.PublishContext(
                new[] { Document("doc-1") },
                null,
                View(),
                null));
        }

        [Fact]
        public void PublishRejectsAMalformedDisciplineHint()
        {
            AddinDocumentContextCache cache = new AddinDocumentContextCache(FixedClock());

            Assert.Throws<ArgumentException>(() => cache.PublishContext(
                new[] { Document("doc-1") },
                "doc-1",
                null,
                "Not A Token"));
        }

        [Theory]
        [InlineData("")]
        [InlineData("sha256:ABC")]
        [InlineData("md5:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef")]
        public void DocumentStateRejectsAMalformedPathDigest(string digest)
        {
            Assert.Throws<ArgumentException>(() => Document("doc-1", pathDigest: digest));
        }

        [Fact]
        public void DocumentStateRejectsOversizedIdentityFields()
        {
            Assert.Throws<ArgumentException>(() => Document(new string('d', 129)));
            Assert.Throws<ArgumentException>(() => Document("doc-1", new string('t', 513)));
            Assert.Throws<ArgumentException>(() => Document("doc-1", string.Empty));
            Assert.Throws<ArgumentException>(() => View(id: new string('v', 65)));
            Assert.Throws<ArgumentException>(() => View(name: new string('n', 513)));
            Assert.Throws<ArgumentException>(() => View(type: new string('t', 129)));
            Assert.Throws<ArgumentException>(() => View(level: new string('l', 513)));
        }

        [Fact]
        public void BoundedFieldsCountUnicodeCodePointsNotUtf16Units()
        {
            string maxTitle = string.Concat(Enumerable.Repeat("\U0001F600", 512));
            AddinDocumentContextDocumentState document = Document("doc-1", maxTitle);
            Assert.Equal(maxTitle, document.Title);

            Assert.Throws<ArgumentException>(() =>
                Document("doc-1", maxTitle + "\U0001F600"));
        }

        // ---------------------------------------------------------------
        // A.3 envelope: exact key set and cross-field derivation
        // ---------------------------------------------------------------

        [Fact]
        public void ReadyEnvelopeCarriesExactlyTheFrozenKeySet()
        {
            AddinDocumentContextCache cache = new AddinDocumentContextCache(FixedClock());
            string digest = AddinDocumentContextContract.ComputePathDigest("C:\\Models\\Sample.rvt")!;
            AddinDocumentContextCacheSnapshot snapshot = cache.PublishContext(
                new[]
                {
                    Document("doc-1", "Sample Model", digest, isWorkshared: true),
                    Document("doc-2", "Second Model"),
                },
                "doc-1",
                View(),
                "mechanical");

            JObject result = snapshot.ToResultObject();
            Assert.Equal(
                new[]
                {
                    "resultContractVersion",
                    "documentContextContractVersion",
                    "capturedAtUtc",
                    "revision",
                    "cacheState",
                    "unavailableReason",
                    "documents",
                    "activeDocumentId",
                    "activeView",
                    "disciplineHint",
                },
                result.Properties().Select(property => property.Name).ToArray());
            Assert.Equal(2, result["resultContractVersion"]!.Value<int>());
            Assert.Equal(1, result["documentContextContractVersion"]!.Value<int>());
            Assert.Equal(JTokenType.Null, result["unavailableReason"]!.Type);

            JObject firstDocument = (JObject)result["documents"]![0]!;
            Assert.Equal(
                new[] { "documentId", "title", "pathDigest", "isWorkshared", "isActive" },
                firstDocument.Properties().Select(property => property.Name).ToArray());
            Assert.True(firstDocument["isActive"]!.Value<bool>());
            Assert.Equal(digest, firstDocument["pathDigest"]!.Value<string>());
            Assert.False(((JObject)result["documents"]![1]!)["isActive"]!.Value<bool>());

            JObject activeView = (JObject)result["activeView"]!;
            Assert.Equal(
                new[] { "documentId", "id", "name", "type", "level" },
                activeView.Properties().Select(property => property.Name).ToArray());
            Assert.Equal("doc-1", activeView["documentId"]!.Value<string>());
            Assert.Equal("Level 1", activeView["level"]!.Value<string>());

            RevAgent.Contracts.Rbp.AddinDocumentContextSnapshot parsed =
                ParseWithFrozenBridgeParser(snapshot);
            Assert.Equal(2, parsed.Documents.Count);
            Assert.Equal("doc-1", parsed.ActiveDocumentId);
        }

        [Fact]
        public void ActiveViewDocumentIdAlwaysEqualsActiveDocumentIdByConstruction()
        {
            AddinDocumentContextCache cache = new AddinDocumentContextCache(FixedClock());
            AddinDocumentContextCacheSnapshot snapshot = cache.PublishContext(
                new[] { Document("doc-7") },
                "doc-7",
                View(),
                null);

            JObject result = snapshot.ToResultObject();
            Assert.Equal(
                result["activeDocumentId"]!.Value<string>(),
                ((JObject)result["activeView"]!)["documentId"]!.Value<string>());
        }

        [Fact]
        public void ReadyEnvelopeWithoutActiveDocumentHasNullActiveView()
        {
            AddinDocumentContextCacheSnapshot snapshot =
                new AddinDocumentContextCache(FixedClock()).PublishContext(
                    new[] { Document("doc-1") },
                    null,
                    null,
                    null);

            JObject result = snapshot.ToResultObject();
            Assert.Equal(JTokenType.Null, result["activeDocumentId"]!.Type);
            Assert.Equal(JTokenType.Null, result["activeView"]!.Type);
            Assert.False(((JObject)result["documents"]![0]!)["isActive"]!.Value<bool>());
            ParseWithFrozenBridgeParser(snapshot);
        }

        [Fact]
        public void WarmingAndUnavailableEnvelopesCarryNoDocumentsOrActiveContext()
        {
            AddinDocumentContextCache cache = new AddinDocumentContextCache(FixedClock());
            foreach (AddinDocumentContextCacheSnapshot snapshot in new[]
                     {
                         cache.Read(),
                         cache.MarkUnavailable("invalidated by a failed event capture"),
                     })
            {
                JObject result = snapshot.ToResultObject();
                Assert.Empty((JArray)result["documents"]!);
                Assert.Equal(JTokenType.Null, result["activeDocumentId"]!.Type);
                Assert.Equal(JTokenType.Null, result["activeView"]!.Type);
                Assert.Equal(JTokenType.Null, result["disciplineHint"]!.Type);
                Assert.Equal(JTokenType.String, result["unavailableReason"]!.Type);
                ParseWithFrozenBridgeParser(snapshot);
            }
        }

        [Fact]
        public void CapturedAtUtcIsRfc3339UtcFromTheInjectedClock()
        {
            AddinDocumentContextCacheSnapshot snapshot =
                new AddinDocumentContextCache(FixedClock()).Read();

            Assert.Equal("2026-07-31T10:00:00.000Z", snapshot.CapturedAtUtcText);
            Assert.Equal(
                BaseTime,
                ParseWithFrozenBridgeParser(snapshot).CapturedAtUtc);
        }

        // ---------------------------------------------------------------
        // Path digests never expose a raw model path
        // ---------------------------------------------------------------

        [Fact]
        public void PathDigestUsesLowercasePrefixedSha256OfTheExactPath()
        {
            Assert.Null(AddinDocumentContextContract.ComputePathDigest(null));
            Assert.Null(AddinDocumentContextContract.ComputePathDigest(string.Empty));
            Assert.Equal(
                "sha256:ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
                AddinDocumentContextContract.ComputePathDigest("abc"));
        }

        [Fact]
        public void PathDigestNeverEchoesTheRawPath()
        {
            const string path = "C:\\Confidential\\Tower.rvt";
            string digest = AddinDocumentContextContract.ComputePathDigest(path)!;
            AddinDocumentContextCacheSnapshot snapshot =
                new AddinDocumentContextCache(FixedClock()).PublishContext(
                    new[] { Document("doc-1", "Tower", digest) },
                    null,
                    null,
                    null);

            string wire = snapshot.ToResultObject().ToString(Formatting.None);
            Assert.DoesNotContain("Confidential", wire, StringComparison.OrdinalIgnoreCase);
            Assert.Contains(digest, wire, StringComparison.Ordinal);
        }

        // ---------------------------------------------------------------
        // Discipline hint normalization
        // ---------------------------------------------------------------

        [Theory]
        [InlineData("Mechanical", "mechanical")]
        [InlineData("  Coordination  ", "coordination")]
        [InlineData("ARCHITECTURAL", "architectural")]
        [InlineData(null, null)]
        [InlineData("", null)]
        [InlineData("Not A Token", null)]
        [InlineData("1starts-with-digit", null)]
        public void DisciplineHintsNormalizeToTheFrozenTokenOrNull(string? hint, string? expected)
        {
            Assert.Equal(expected, AddinDocumentContextContract.NormalizeDisciplineHint(hint));
        }

        // ---------------------------------------------------------------
        // RES-3 aggregator: one method per Revit application event kind
        // ---------------------------------------------------------------

        [Fact]
        public void StartupBaselinePublishesATruthfulEmptyReadySnapshot()
        {
            AddinDocumentContextAggregator aggregator =
                new AddinDocumentContextAggregator(FixedClock());

            AddinDocumentContextCacheSnapshot snapshot = aggregator.RecordStartupBaseline();

            Assert.Equal(1, snapshot.Revision);
            Assert.Equal("ready", snapshot.CacheState);
            Assert.Empty(snapshot.Documents);
            Assert.Null(snapshot.ActiveDocumentId);
            ParseWithFrozenBridgeParser(snapshot);
        }

        [Fact]
        public void DocumentOpenedEventAddsTheDocumentWithASessionLocalId()
        {
            AddinDocumentContextAggregator aggregator =
                new AddinDocumentContextAggregator(FixedClock());
            aggregator.RecordStartupBaseline();

            AddinDocumentContextCacheSnapshot snapshot = aggregator.RecordDocumentsChanged(
                new[] { Source("path|C:\\Models\\A.rvt", "A") });

            Assert.Equal(2, snapshot.Revision);
            Assert.Single(snapshot.Documents);
            Assert.Equal("doc-1", snapshot.Documents[0].DocumentId);
            Assert.Null(snapshot.ActiveDocumentId);
            ParseWithFrozenBridgeParser(snapshot);
        }

        [Fact]
        public void ViewActivatedEventPublishesActiveDocumentViewAndDiscipline()
        {
            AddinDocumentContextAggregator aggregator =
                new AddinDocumentContextAggregator(FixedClock());
            aggregator.RecordStartupBaseline();

            AddinDocumentContextCacheSnapshot snapshot = aggregator.RecordViewActivated(
                new[] { Source("path|C:\\Models\\A.rvt", "A"), Source("untitled|Project1", "Project1") },
                "path|C:\\Models\\A.rvt",
                View(),
                "Mechanical");

            Assert.Equal("ready", snapshot.CacheState);
            Assert.Equal(2, snapshot.Documents.Count);
            Assert.Equal("doc-1", snapshot.ActiveDocumentId);
            Assert.NotNull(snapshot.ActiveView);
            Assert.Equal("mechanical", snapshot.DisciplineHint);
            RevAgent.Contracts.Rbp.AddinDocumentContextSnapshot parsed =
                ParseWithFrozenBridgeParser(snapshot);
            Assert.True(parsed.Documents[0].IsActive);
            Assert.False(parsed.Documents[1].IsActive);
        }

        [Fact]
        public void RepeatedIdenticalViewActivationIsANoOp()
        {
            AddinDocumentContextAggregator aggregator =
                new AddinDocumentContextAggregator(FixedClock());
            aggregator.RecordViewActivated(
                new[] { Source("path|A", "A") }, "path|A", View(), "mechanical");

            AddinDocumentContextCacheSnapshot repeat = aggregator.RecordViewActivated(
                new[] { Source("path|A", "A") }, "path|A", View(), "mechanical");

            Assert.Equal(1, repeat.Revision);
        }

        [Fact]
        public void ViewActivatedRejectsAnActiveKeyOutsideTheEnumeratedDocuments()
        {
            AddinDocumentContextAggregator aggregator =
                new AddinDocumentContextAggregator(FixedClock());

            Assert.Throws<ArgumentException>(() => aggregator.RecordViewActivated(
                new[] { Source("path|A", "A") },
                "path|B",
                View(),
                null));
        }

        [Fact]
        public void DocumentIdsStayStablePerStableKeyAcrossEventKinds()
        {
            AddinDocumentContextAggregator aggregator =
                new AddinDocumentContextAggregator(FixedClock());
            aggregator.RecordDocumentsChanged(new[] { Source("path|A", "A") });
            aggregator.RecordViewActivated(
                new[] { Source("path|A", "A"), Source("path|B", "B") }, "path|B", View(), null);

            AddinDocumentContextCacheSnapshot snapshot = aggregator.RecordDocumentsChanged(
                new[] { Source("path|B", "B"), Source("path|A", "A") });

            Assert.Equal(
                new[] { "doc-2", "doc-1" },
                snapshot.Documents.Select(document => document.DocumentId).ToArray());
            Assert.Equal("doc-2", snapshot.ActiveDocumentId);
        }

        [Fact]
        public void SaveAsAssignsANewSessionIdForTheNewStableKey()
        {
            AddinDocumentContextAggregator aggregator =
                new AddinDocumentContextAggregator(FixedClock());
            aggregator.RecordDocumentsChanged(new[] { Source("untitled|Project1", "Project1") });

            AddinDocumentContextCacheSnapshot snapshot = aggregator.RecordDocumentsChanged(
                new[] { Source("path|C:\\Models\\Project1.rvt", "Project1") });

            Assert.Single(snapshot.Documents);
            Assert.Equal("doc-2", snapshot.Documents[0].DocumentId);
        }

        [Fact]
        public void DocumentsChangedClearsAnActiveContextWhoseDocumentDisappeared()
        {
            AddinDocumentContextAggregator aggregator =
                new AddinDocumentContextAggregator(FixedClock());
            aggregator.RecordViewActivated(
                new[] { Source("path|A", "A"), Source("path|B", "B") }, "path|A", View(), "mechanical");

            AddinDocumentContextCacheSnapshot snapshot = aggregator.RecordDocumentsChanged(
                new[] { Source("path|B", "B") });

            Assert.Null(snapshot.ActiveDocumentId);
            Assert.Null(snapshot.ActiveView);
            Assert.Null(snapshot.DisciplineHint);
            ParseWithFrozenBridgeParser(snapshot);
        }

        [Fact]
        public void DocumentClosingAloneChangesNothing()
        {
            AddinDocumentContextAggregator aggregator =
                new AddinDocumentContextAggregator(FixedClock());
            aggregator.RecordViewActivated(new[] { Source("path|A", "A") }, "path|A", View(), null);

            AddinDocumentContextCacheSnapshot snapshot = aggregator.RecordDocumentClosing(42, "path|A");

            Assert.Equal(1, snapshot.Revision);
            Assert.Single(snapshot.Documents);
        }

        [Fact]
        public void SuccessfulCloseRemovesTheDocumentAndClearsItsActiveContext()
        {
            AddinDocumentContextAggregator aggregator =
                new AddinDocumentContextAggregator(FixedClock());
            aggregator.RecordViewActivated(new[] { Source("path|A", "A") }, "path|A", View(), "mechanical");
            aggregator.RecordDocumentClosing(42, "path|A");

            AddinDocumentContextCacheSnapshot snapshot = aggregator.RecordDocumentClosed(42, succeeded: true);

            Assert.Equal(2, snapshot.Revision);
            Assert.Empty(snapshot.Documents);
            Assert.Null(snapshot.ActiveDocumentId);
            Assert.Null(snapshot.ActiveView);
            ParseWithFrozenBridgeParser(snapshot);
        }

        [Fact]
        public void CancelledCloseKeepsTheDocumentOpen()
        {
            AddinDocumentContextAggregator aggregator =
                new AddinDocumentContextAggregator(FixedClock());
            aggregator.RecordViewActivated(new[] { Source("path|A", "A") }, "path|A", View(), null);
            aggregator.RecordDocumentClosing(42, "path|A");

            AddinDocumentContextCacheSnapshot snapshot = aggregator.RecordDocumentClosed(42, succeeded: false);

            Assert.Equal(1, snapshot.Revision);
            Assert.Single(snapshot.Documents);
        }

        [Fact]
        public void UnpairedCloseIsIgnored()
        {
            AddinDocumentContextAggregator aggregator =
                new AddinDocumentContextAggregator(FixedClock());
            aggregator.RecordViewActivated(new[] { Source("path|A", "A") }, "path|A", View(), null);

            AddinDocumentContextCacheSnapshot snapshot = aggregator.RecordDocumentClosed(999, succeeded: true);

            Assert.Equal(1, snapshot.Revision);
            Assert.Single(snapshot.Documents);
        }

        [Fact]
        public void ReopeningAClosedStableKeyAssignsAFreshSessionId()
        {
            AddinDocumentContextAggregator aggregator =
                new AddinDocumentContextAggregator(FixedClock());
            aggregator.RecordDocumentsChanged(new[] { Source("path|A", "A") });
            aggregator.RecordDocumentClosing(1, "path|A");
            aggregator.RecordDocumentClosed(1, succeeded: true);

            AddinDocumentContextCacheSnapshot snapshot = aggregator.RecordDocumentsChanged(
                new[] { Source("path|A", "A") });

            Assert.Equal("doc-2", snapshot.Documents[0].DocumentId);
        }

        [Fact]
        public void FailedCaptureMarksUnavailableAndTheNextEventSelfHeals()
        {
            AddinDocumentContextAggregator aggregator =
                new AddinDocumentContextAggregator(FixedClock());
            aggregator.RecordViewActivated(new[] { Source("path|A", "A") }, "path|A", View(), "mechanical");

            AddinDocumentContextCacheSnapshot invalidated =
                aggregator.MarkUnavailable("Revit read threw during DocumentOpened");
            Assert.Equal("unavailable", invalidated.CacheState);
            Assert.Equal(2, invalidated.Revision);

            AddinDocumentContextCacheSnapshot healed = aggregator.RecordViewActivated(
                new[] { Source("path|A", "A") }, "path|A", View(), "mechanical");
            Assert.Equal("ready", healed.CacheState);
            Assert.Equal(3, healed.Revision);
            Assert.Equal("doc-1", healed.ActiveDocumentId);
            ParseWithFrozenBridgeParser(healed);
        }

        [Fact]
        public void AggregatorRejectsDuplicateStableKeysBeforeAnyStateChange()
        {
            AddinDocumentContextAggregator aggregator =
                new AddinDocumentContextAggregator(FixedClock());
            aggregator.RecordStartupBaseline();

            Assert.Throws<ArgumentException>(() => aggregator.RecordDocumentsChanged(
                new[] { Source("path|A", "A"), Source("path|A", "A copy") }));
            Assert.Equal(1, aggregator.Read().Revision);
        }
    }
}
