#nullable enable

using System;
using System.Linq;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;
using RevAgent.Contracts.Rbp;
using Xunit;

namespace RevAgent.Contracts.Tests.Rbp
{
    public sealed class DocumentContextTests
    {
        private const string PositiveResponseJson =
            @"{
                ""jsonrpc"": ""2.0"",
                ""id"": ""context-probe-1"",
                ""result"": {
                    ""resultContractVersion"": 2,
                    ""documentContextContractVersion"": 1,
                    ""capturedAtUtc"": ""2026-07-22T12:00:00.000Z"",
                    ""revision"": 7,
                    ""cacheState"": ""ready"",
                    ""unavailableReason"": null,
                    ""documents"": [
                        {
                            ""documentId"": ""doc-session-1"",
                            ""title"": ""Project A"",
                            ""pathDigest"": ""sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"",
                            ""isWorkshared"": true,
                            ""isActive"": true
                        },
                        {
                            ""documentId"": ""doc-session-2"",
                            ""title"": ""Project B"",
                            ""pathDigest"": null,
                            ""isWorkshared"": false,
                            ""isActive"": false
                        }
                    ],
                    ""activeDocumentId"": ""doc-session-1"",
                    ""activeView"": {
                        ""documentId"": ""doc-session-1"",
                        ""id"": ""123"",
                        ""name"": ""Level 2 HVAC"",
                        ""type"": ""FloorPlan"",
                        ""level"": ""Level 2""
                    },
                    ""disciplineHint"": ""mech""
                }
            }";

        [Fact]
        public void ParsesAndMapsPositiveResponseToExactFrozenPayload()
        {
            var response = AddinDocumentContextParser.ParseResponse(PositiveResponseJson);

            Assert.Equal("context-probe-1", response.RequestId);
            Assert.Equal(2, response.Context.ResultContractVersion);
            Assert.Equal(1, response.Context.DocumentContextContractVersion);
            Assert.Equal(7, response.Context.Revision);
            Assert.Equal(DocumentContextCacheState.Ready, response.Context.CacheState);
            Assert.Equal(2, response.Context.Documents.Count);
            Assert.Null(response.Context.Documents[1].PathDigest);

            var normalized = JObject.Parse(DocumentContextMapper.NormalizeForComparison(response.Context));
            var expected = JObject.Parse(
                @"{
                    ""documents"": [
                        {
                            ""document_id"": ""doc-session-1"",
                            ""title"": ""Project A"",
                            ""path_digest"": ""sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"",
                            ""is_workshared"": true,
                            ""is_active"": true
                        },
                        {
                            ""document_id"": ""doc-session-2"",
                            ""title"": ""Project B"",
                            ""path_digest"": null,
                            ""is_workshared"": false,
                            ""is_active"": false
                        }
                    ],
                    ""active_document"": ""doc-session-1"",
                    ""active_view"": {
                        ""id"": ""123"",
                        ""name"": ""Level 2 HVAC"",
                        ""type"": ""FloorPlan"",
                        ""level"": ""Level 2""
                    },
                    ""discipline_hint"": ""mech""
                }");

            Assert.True(JToken.DeepEquals(expected, normalized));
            Assert.Null(normalized.SelectToken("active_view.documentId"));
            Assert.Null(normalized["capturedAtUtc"]);
            Assert.Null(normalized["revision"]);
            Assert.Null(normalized["cacheState"]);
            Assert.Null(normalized["unavailableReason"]);
        }

        [Fact]
        public void ReadyNullVariantPreservesNullsAndOmitsNullDiscipline()
        {
            var root = PositiveRoot();
            var result = (JObject)root["result"]!;
            result["documents"] = new JArray
            {
                new JObject
                {
                    ["documentId"] = "doc-session-2",
                    ["title"] = "Unsaved Project",
                    ["pathDigest"] = JValue.CreateNull(),
                    ["isWorkshared"] = false,
                    ["isActive"] = false,
                },
            };
            result["activeDocumentId"] = JValue.CreateNull();
            result["activeView"] = JValue.CreateNull();
            result["disciplineHint"] = JValue.CreateNull();

            var response = AddinDocumentContextParser.ParseResponse(root.ToString(Formatting.None));
            var mapped = DocumentContextMapper.ToNormalizedJObject(response.Context);

            Assert.Equal(JTokenType.Null, mapped["active_document"]?.Type);
            Assert.Equal(JTokenType.Null, mapped["active_view"]?.Type);
            Assert.Equal(JTokenType.Null, mapped.SelectToken("documents[0].path_digest")?.Type);
            Assert.Null(mapped["discipline_hint"]);
            Assert.Equal(
                "{\"documents\":[{\"document_id\":\"doc-session-2\",\"title\":\"Unsaved Project\",\"path_digest\":null,\"is_workshared\":false,\"is_active\":false}],\"active_document\":null,\"active_view\":null}",
                mapped.ToString(Formatting.None));
        }

        [Fact]
        public void NonReadyVariantRequiresEmptyContextAndMapsToEmptyPayload()
        {
            var root = PositiveRoot();
            var result = (JObject)root["result"]!;
            result["cacheState"] = "warming";
            result["unavailableReason"] = "application events have not produced a snapshot";
            result["documents"] = new JArray();
            result["activeDocumentId"] = JValue.CreateNull();
            result["activeView"] = JValue.CreateNull();
            result["disciplineHint"] = JValue.CreateNull();

            var response = AddinDocumentContextParser.ParseResponse(root.ToString(Formatting.None));
            var mapped = DocumentContextMapper.ToNormalizedJObject(response.Context);

            Assert.Equal(DocumentContextCacheState.Warming, response.Context.CacheState);
            Assert.Equal(
                "{\"documents\":[],\"active_document\":null,\"active_view\":null}",
                mapped.ToString(Formatting.None));
        }

        [Fact]
        public void NormalizationIgnoresCacheMetadataButPreservesDocumentOrder()
        {
            var firstRoot = PositiveRoot();
            var secondRoot = PositiveRoot();
            var secondResult = (JObject)secondRoot["result"]!;
            secondResult["capturedAtUtc"] = "2026-07-22T12:00:15Z";
            secondResult["revision"] = 8;

            var first = AddinDocumentContextParser.ParseResponse(firstRoot.ToString(Formatting.None)).Context;
            var second = AddinDocumentContextParser.ParseResponse(secondRoot.ToString(Formatting.None)).Context;
            Assert.Equal(
                DocumentContextMapper.NormalizeForComparison(first),
                DocumentContextMapper.NormalizeForComparison(second));

            var documents = (JArray)secondResult["documents"]!;
            var moved = documents[1];
            moved.Remove();
            documents.Insert(0, moved);
            var reordered = AddinDocumentContextParser.ParseResponse(secondRoot.ToString(Formatting.None)).Context;
            Assert.NotEqual(
                DocumentContextMapper.NormalizeForComparison(first),
                DocumentContextMapper.NormalizeForComparison(reordered));
        }

        [Fact]
        public void RejectsWrongContractVersionsAndUnknownState()
        {
            AssertInvalid(
                root => ((JObject)root["result"]!)["resultContractVersion"] = 3,
                "resultContractVersion");
            AssertInvalid(
                root => ((JObject)root["result"]!)["documentContextContractVersion"] = 2,
                "documentContextContractVersion");
            AssertInvalid(
                root => ((JObject)root["result"]!)["cacheState"] = "stale",
                "cacheState");
        }

        [Theory]
        [InlineData("2.0", "1.0", "7.0")]
        [InlineData("2e0", "1e0", "7e0")]
        public void AcceptsMathematicallyIntegralSchemaIntegers(
            string resultContractVersion,
            string documentContextContractVersion,
            string revision)
        {
            string json = PositiveResponseJson
                .Replace(
                    "\"resultContractVersion\": 2",
                    "\"resultContractVersion\": " + resultContractVersion)
                .Replace(
                    "\"documentContextContractVersion\": 1",
                    "\"documentContextContractVersion\": " + documentContextContractVersion)
                .Replace(
                    "\"revision\": 7",
                    "\"revision\": " + revision);

            AddinDocumentContextResponse response =
                AddinDocumentContextParser.ParseResponse(json);

            Assert.Equal(2, response.Context.ResultContractVersion);
            Assert.Equal(1, response.Context.DocumentContextContractVersion);
            Assert.Equal(7, response.Context.Revision);
        }

        [Theory]
        [InlineData("\"resultContractVersion\": 2", "\"resultContractVersion\": 2.1", "resultContractVersion")]
        [InlineData("\"revision\": 7", "\"revision\": 7.1", "revision")]
        public void RejectsFractionalSchemaIntegers(
            string original,
            string replacement,
            string messageFragment)
        {
            RbpContractException error = Assert.Throws<RbpContractException>(
                () => AddinDocumentContextParser.ParseResponse(
                    PositiveResponseJson.Replace(original, replacement)));

            Assert.Contains(messageFragment, error.Message, StringComparison.Ordinal);
            Assert.Contains("must be an integer", error.Message, StringComparison.Ordinal);
        }

        [Fact]
        public void RejectsMoreThanThirtyTwoDocumentsAndDuplicateIds()
        {
            AssertInvalid(
                root =>
                {
                    var documents = (JArray)((JObject)root["result"]!)["documents"]!;
                    var template = (JObject)documents[1]!;
                    documents.Clear();
                    for (var index = 0; index < 33; index++)
                    {
                        var document = (JObject)template.DeepClone();
                        document["documentId"] = "doc-" + index;
                        documents.Add(document);
                    }

                    ((JObject)root["result"]!)["activeDocumentId"] = JValue.CreateNull();
                    ((JObject)root["result"]!)["activeView"] = JValue.CreateNull();
                },
                "32-document");

            AssertInvalid(
                root =>
                {
                    var documents = (JArray)((JObject)root["result"]!)["documents"]!;
                    ((JObject)documents[1]!)["documentId"] = "doc-session-1";
                },
                "duplicate documentId");
        }

        [Fact]
        public void StringMaxLengthCountsUnicodeCodePoints()
        {
            var acceptedRoot = PositiveRoot();
            var acceptedDocument =
                (JObject)((JArray)((JObject)acceptedRoot["result"]!)["documents"]!)[0]!;
            string acceptedTitle = string.Concat(
                Enumerable.Repeat("\U0001F600", 512));
            acceptedDocument["title"] = acceptedTitle;

            var accepted = AddinDocumentContextParser.ParseResponse(
                acceptedRoot.ToString(Formatting.None));
            Assert.Equal(acceptedTitle, accepted.Context.Documents[0].Title);

            AssertInvalid(
                root =>
                {
                    var document =
                        (JObject)((JArray)((JObject)root["result"]!)["documents"]!)[0]!;
                    document["title"] = string.Concat(
                        Enumerable.Repeat("\U0001F600", 513));
                },
                "maximum length");
        }

        [Fact]
        public void RejectsActiveDocumentAndViewOwnershipContradictions()
        {
            AssertInvalid(
                root => ((JObject)root["result"]!)["activeDocumentId"] = "doc-session-2",
                "sole isActive");
            AssertInvalid(
                root => ((JObject)((JObject)root["result"]!)["activeView"]!)["documentId"] = "doc-session-2",
                "activeView.documentId");
            AssertInvalid(
                root => ((JObject)root["result"]!)["activeDocumentId"] = JValue.CreateNull(),
                "active document row");
        }

        [Fact]
        public void RejectsInvalidDigestRawPathAndUnknownClosedFields()
        {
            AssertInvalid(
                root =>
                {
                    var document = (JObject)((JArray)((JObject)root["result"]!)["documents"]!)[0]!;
                    document["pathDigest"] =
                        "sha256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
                },
                "pathDigest");
            AssertInvalid(
                root =>
                {
                    var document = (JObject)((JArray)((JObject)root["result"]!)["documents"]!)[0]!;
                    document["path"] = @"C:\Projects\Project-A.rvt";
                },
                "unexpected property \"path\"");
            AssertInvalid(
                root => ((JObject)root["result"]!)["futureField"] = true,
                "unexpected property \"futureField\"");
        }

        [Fact]
        public void RejectsStateInvariantViolations()
        {
            AssertInvalid(
                root => ((JObject)root["result"]!)["unavailableReason"] = "not ready",
                "ready result.unavailableReason");
            AssertInvalid(
                root =>
                {
                    var result = (JObject)root["result"]!;
                    result["cacheState"] = "unavailable";
                    result["unavailableReason"] = "Revit shutting down";
                },
                "must not carry documents");
        }

        [Fact]
        public void RejectsDuplicatePropertiesCommentsBomAndTrailingJson()
        {
            Assert.Throws<RbpContractException>(
                () => AddinDocumentContextParser.ParseResponse(
                    PositiveResponseJson.Replace(
                        "\"jsonrpc\": \"2.0\",",
                        "\"jsonrpc\": \"2.0\", \"jsonrpc\": \"2.0\",")));
            Assert.Throws<RbpContractException>(
                () => AddinDocumentContextParser.ParseResponse(
                    PositiveResponseJson.Replace("\"id\": \"context-probe-1\",", "/*comment*/ \"id\": \"context-probe-1\",")));
            Assert.Throws<RbpContractException>(
                () => AddinDocumentContextParser.ParseResponse("\uFEFF" + PositiveResponseJson));
            Assert.Throws<RbpContractException>(
                () => AddinDocumentContextParser.ParseResponse(PositiveResponseJson + "{}"));
        }

        private static JObject PositiveRoot() => JObject.Parse(PositiveResponseJson);

        private static void AssertInvalid(Action<JObject> mutate, string messageFragment)
        {
            var root = PositiveRoot();
            mutate(root);

            var error = Assert.Throws<RbpContractException>(
                () => AddinDocumentContextParser.ParseResponse(root.ToString(Formatting.None)));
            Assert.Contains(messageFragment, error.Message, StringComparison.Ordinal);
        }
    }
}
