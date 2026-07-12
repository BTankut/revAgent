using Autodesk.Revit.DB;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;
using RevAgentCommandSet.Extensions;
using RevAgentPlugin.Core;
using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Security.Cryptography;
using System.Text;

namespace RevAgentCommandSet.Commands.Spatial
{
    internal static class SpatialSnapshotHelpers
    {
        internal const double FeetToMillimetres = 304.8;
        internal const string SchemaVersion = "0.3";
        internal const string ExtractorVersion = "phase1b-native/0.3";
        internal const string CoordinateFrame = "host_internal_mm";
        internal const string CursorVersion = "0.2";
        internal const string WorkCursorVersion = "0.2-work";
        internal const string CaptureConsistency = "document_change_sequence_bound";
        internal const string Phase1aCaveat = "SpatialSnapshot v0.3 native transport pages are read-only, document-change-sequence-bound staging inputs. Only the runtime spatial store may publish an atomically committed current snapshot after validating the complete page chain. Connector topology comes only from Revit Connector.AllRefs; unresolved references remain explicit coverage gaps. Continuation cursors retain the v0.2 wire format, are HMAC-bound to this add-in process session, and are intentionally invalid after restart.";
        internal const string FingerprintVersion = "phase1b-spatial-fingerprint/1.0";
        private const string CursorPrefix = "spatial-cursor-v0.2.";
        private const string WorkCursorPrefix = "spatial-work-cursor-v0.2.";
        private const int MaxCursorJsonBytes = 8192;
        private const int MaxCursorEncodedChars = 12000;

        private static readonly DateTimeOffset AddinSessionStartedAtUtc = DateTimeOffset.UtcNow;
        private static readonly byte[] CursorHmacKey = CreateRandomSecret(32);

        internal static readonly IList<BuiltInCategory> HostMepCategories = new List<BuiltInCategory>
        {
            BuiltInCategory.OST_DuctCurves,
            BuiltInCategory.OST_FlexDuctCurves,
            BuiltInCategory.OST_DuctFitting,
            BuiltInCategory.OST_DuctAccessory,
            BuiltInCategory.OST_DuctTerminal,
            BuiltInCategory.OST_MechanicalEquipment,
            BuiltInCategory.OST_PipeCurves,
            BuiltInCategory.OST_FlexPipeCurves,
            BuiltInCategory.OST_PipeFitting,
            BuiltInCategory.OST_PipeAccessory,
            BuiltInCategory.OST_PlumbingFixtures,
            BuiltInCategory.OST_Sprinklers
        };

        internal static readonly IList<BuiltInCategory> SpatialCategories = new List<BuiltInCategory>
        {
            BuiltInCategory.OST_Rooms,
            BuiltInCategory.OST_MEPSpaces
        };

        internal static readonly IList<BuiltInCategory> LinkedObstructionCategories = new List<BuiltInCategory>
        {
            BuiltInCategory.OST_Walls,
            BuiltInCategory.OST_Floors,
            BuiltInCategory.OST_Roofs,
            BuiltInCategory.OST_Ceilings,
            BuiltInCategory.OST_StructuralColumns,
            BuiltInCategory.OST_StructuralFraming,
            BuiltInCategory.OST_StructuralFoundation,
            BuiltInCategory.OST_Stairs,
            BuiltInCategory.OST_Ramps
        };

        internal static string Sha256(string value)
        {
            return "sha256:" + Sha256Hex(value);
        }

        private static string Sha256Hex(string value)
        {
            using (SHA256 sha = SHA256.Create())
            {
                byte[] digest = sha.ComputeHash(Encoding.UTF8.GetBytes(value ?? ""));
                StringBuilder text = new StringBuilder(digest.Length * 2);
                foreach (byte item in digest) text.Append(item.ToString("x2", CultureInfo.InvariantCulture));
                return text.ToString();
            }
        }

        internal static string EncodeCursor(CursorEnvelope envelope)
        {
            JObject json = new JObject
            {
                ["cursorVersion"] = envelope.CursorVersion,
                ["captureId"] = envelope.CaptureId,
                ["pageOrdinal"] = envelope.PageOrdinal,
                ["sortPosition"] = envelope.SortPosition == null ? null : new JObject
                {
                    ["documentKey"] = envelope.SortPosition.DocumentKey,
                    ["linkPlacementKey"] = envelope.SortPosition.LinkPlacementKey,
                    ["nodeKind"] = envelope.SortPosition.NodeKind,
                    ["stableSourceIdentity"] = envelope.SortPosition.StableSourceIdentity
                },
                ["priorPageHash"] = envelope.PriorPageHash,
                ["revisionFingerprint"] = envelope.RevisionFingerprint,
                ["scopeFingerprint"] = envelope.ScopeFingerprint,
                ["capturedAt"] = envelope.CapturedAt
            };
            byte[] payload = Encoding.UTF8.GetBytes(CanonicalJson(json));
            byte[] signature;
            using (HMACSHA256 hmac = new HMACSHA256(CursorHmacKey))
            {
                signature = hmac.ComputeHash(payload);
            }
            return CursorPrefix + ToBase64Url(payload) + "." + ToBase64Url(signature);
        }

        internal static bool IsWorkCursor(string value)
        {
            return !string.IsNullOrWhiteSpace(value) && value.StartsWith(WorkCursorPrefix, StringComparison.Ordinal);
        }

        internal static string EncodeWorkCursor(WorkCursorEnvelope envelope)
        {
            JObject json = new JObject
            {
                ["cursorVersion"] = envelope.CursorVersion,
                ["cursorKind"] = envelope.CursorKind,
                ["captureId"] = envelope.CaptureId,
                ["workPhase"] = envelope.WorkPhase,
                ["stepOrdinal"] = envelope.StepOrdinal,
                ["scopeFingerprint"] = envelope.ScopeFingerprint,
                ["sourceBindingFingerprint"] = envelope.SourceBindingFingerprint,
                ["capturedAt"] = envelope.CapturedAt
            };
            byte[] payload = Encoding.UTF8.GetBytes(CanonicalJson(json));
            byte[] signature;
            using (HMACSHA256 hmac = new HMACSHA256(CursorHmacKey))
            {
                signature = hmac.ComputeHash(payload);
            }
            return WorkCursorPrefix + ToBase64Url(payload) + "." + ToBase64Url(signature);
        }

        internal static bool TryDecodeWorkCursor(string value, out WorkCursorEnvelope envelope, out string error)
        {
            envelope = null;
            error = null;
            if (string.IsNullOrWhiteSpace(value)) return true;
            try
            {
                if (!value.StartsWith(WorkCursorPrefix, StringComparison.Ordinal)) throw new FormatException("Work cursor prefix is missing or unsupported.");
                string encoded = value.Substring(WorkCursorPrefix.Length);
                int separator = encoded.IndexOf('.');
                if (separator <= 0 || separator != encoded.LastIndexOf('.')) throw new FormatException("Work cursor must contain one payload/signature separator.");
                string payloadText = encoded.Substring(0, separator);
                string signatureText = encoded.Substring(separator + 1);
                if (payloadText.Length > MaxCursorEncodedChars || signatureText.Length != 43) throw new FormatException("Work cursor size is outside the supported bounds.");
                byte[] payload = FromBase64Url(payloadText, MaxCursorJsonBytes);
                byte[] suppliedSignature = FromBase64Url(signatureText, 32);
                byte[] expectedSignature;
                using (HMACSHA256 hmac = new HMACSHA256(CursorHmacKey))
                {
                    expectedSignature = hmac.ComputeHash(payload);
                }
                if (!FixedTimeEquals(expectedSignature, suppliedSignature)) throw new FormatException("Work cursor authentication failed; it may be altered or from a prior add-in session.");

                string jsonText = new UTF8Encoding(false, true).GetString(payload);
                JObject json;
                using (StringReader stringReader = new StringReader(jsonText))
                using (JsonTextReader jsonReader = new JsonTextReader(stringReader))
                {
                    jsonReader.DateParseHandling = DateParseHandling.None;
                    jsonReader.FloatParseHandling = FloatParseHandling.Double;
                    json = JObject.Load(jsonReader);
                }
                HashSet<string> expectedFields = new HashSet<string>(new[]
                {
                    "cursorVersion", "cursorKind", "captureId", "workPhase", "stepOrdinal",
                    "scopeFingerprint", "sourceBindingFingerprint", "capturedAt"
                }, StringComparer.Ordinal);
                if (json.Properties().Any(property => !expectedFields.Contains(property.Name)) || json.Properties().Count() != expectedFields.Count)
                {
                    throw new FormatException("Work cursor envelope fields do not match version 0.2-work.");
                }
                if (!string.Equals(jsonText, CanonicalJson(json), StringComparison.Ordinal)) throw new FormatException("Work cursor payload is not canonical JSON.");
                if (json.Properties().Where(property => property.Name != "stepOrdinal").Any(property => !IsStringToken(property.Value)) ||
                    json["stepOrdinal"] == null || json["stepOrdinal"].Type != JTokenType.Integer)
                {
                    throw new FormatException("Work cursor envelope value types do not match version 0.2-work.");
                }

                envelope = new WorkCursorEnvelope
                {
                    CursorVersion = ReadCursorString(json, "cursorVersion"),
                    CursorKind = ReadCursorString(json, "cursorKind"),
                    CaptureId = ReadCursorString(json, "captureId"),
                    WorkPhase = ReadCursorString(json, "workPhase"),
                    StepOrdinal = json["stepOrdinal"].Value<int>(),
                    ScopeFingerprint = ReadCursorString(json, "scopeFingerprint"),
                    SourceBindingFingerprint = ReadCursorString(json, "sourceBindingFingerprint"),
                    CapturedAt = ReadCursorString(json, "capturedAt")
                };
                DateTimeOffset capturedAt;
                if (!string.Equals(envelope.CursorVersion, WorkCursorVersion, StringComparison.Ordinal) ||
                    !string.Equals(envelope.CursorKind, "work", StringComparison.Ordinal) ||
                    !IsBoundedNonEmpty(envelope.CaptureId, 256) || envelope.StepOrdinal < 1 || envelope.StepOrdinal > 1000000 ||
                    !IsWorkPhase(envelope.WorkPhase) || !IsSha256(envelope.ScopeFingerprint) || !IsSha256(envelope.SourceBindingFingerprint) ||
                    !DateTimeOffset.TryParseExact(envelope.CapturedAt, "o", CultureInfo.InvariantCulture, DateTimeStyles.RoundtripKind, out capturedAt) ||
                    capturedAt.Offset != TimeSpan.Zero || capturedAt > DateTimeOffset.UtcNow.AddMinutes(5) || capturedAt < AddinSessionStartedAtUtc.AddMinutes(-5))
                {
                    throw new FormatException("Work cursor envelope is incomplete or uses an unsupported version.");
                }
                return true;
            }
            catch (Exception ex)
            {
                error = ex.Message;
                return false;
            }
        }

        internal static bool TryDecodeCursor(string value, out CursorEnvelope envelope, out string error)
        {
            envelope = null;
            error = null;
            if (string.IsNullOrWhiteSpace(value)) return true;
            try
            {
                if (!value.StartsWith(CursorPrefix, StringComparison.Ordinal)) throw new FormatException("Cursor prefix is missing or unsupported.");
                string encoded = value.Substring(CursorPrefix.Length);
                int separator = encoded.IndexOf('.');
                if (separator <= 0 || separator != encoded.LastIndexOf('.')) throw new FormatException("Cursor must contain one payload/signature separator.");
                string payloadText = encoded.Substring(0, separator);
                string signatureText = encoded.Substring(separator + 1);
                if (payloadText.Length > MaxCursorEncodedChars || signatureText.Length != 43) throw new FormatException("Cursor size is outside the supported bounds.");
                byte[] payload = FromBase64Url(payloadText, MaxCursorJsonBytes);
                byte[] suppliedSignature = FromBase64Url(signatureText, 32);
                byte[] expectedSignature;
                using (HMACSHA256 hmac = new HMACSHA256(CursorHmacKey))
                {
                    expectedSignature = hmac.ComputeHash(payload);
                }
                if (!FixedTimeEquals(expectedSignature, suppliedSignature)) throw new FormatException("Cursor authentication failed; it may be altered or from a prior add-in session.");

                string jsonText = new UTF8Encoding(false, true).GetString(payload);
                JObject json;
                using (StringReader stringReader = new StringReader(jsonText))
                using (JsonTextReader jsonReader = new JsonTextReader(stringReader))
                {
                    jsonReader.DateParseHandling = DateParseHandling.None;
                    jsonReader.FloatParseHandling = FloatParseHandling.Double;
                    json = JObject.Load(jsonReader);
                }
                HashSet<string> expectedFields = new HashSet<string>(new[]
                {
                    "cursorVersion", "captureId", "pageOrdinal", "sortPosition", "priorPageHash",
                    "revisionFingerprint", "scopeFingerprint", "capturedAt"
                }, StringComparer.Ordinal);
                if (json.Properties().Any(property => !expectedFields.Contains(property.Name)) || json.Properties().Count() != expectedFields.Count)
                {
                    throw new FormatException("Cursor envelope fields do not match version 0.2.");
                }
                if (!string.Equals(jsonText, CanonicalJson(json), StringComparison.Ordinal)) throw new FormatException("Cursor payload is not canonical JSON.");
                JObject sortObject = json["sortPosition"] as JObject;
                HashSet<string> expectedSortFields = new HashSet<string>(new[]
                {
                    "documentKey", "linkPlacementKey", "nodeKind", "stableSourceIdentity"
                }, StringComparer.Ordinal);
                if (!IsStringToken(json["cursorVersion"]) || !IsStringToken(json["captureId"]) ||
                    json["pageOrdinal"] == null || json["pageOrdinal"].Type != JTokenType.Integer ||
                    !IsStringToken(json["priorPageHash"]) || !IsStringToken(json["revisionFingerprint"]) ||
                    !IsStringToken(json["scopeFingerprint"]) || !IsStringToken(json["capturedAt"]) ||
                    sortObject == null || sortObject.Properties().Any(property => !expectedSortFields.Contains(property.Name)) ||
                    sortObject.Properties().Count() != expectedSortFields.Count || sortObject.Properties().Any(property => !IsStringToken(property.Value)))
                {
                    throw new FormatException("Cursor envelope value types do not match version 0.2.");
                }
                envelope = new CursorEnvelope
                {
                    CursorVersion = ReadCursorString(json, "cursorVersion"),
                    CaptureId = ReadCursorString(json, "captureId"),
                    PageOrdinal = json["pageOrdinal"] != null ? json["pageOrdinal"].Value<int>() : -1,
                    SortPosition = ReadSortPosition(json["sortPosition"] as JObject),
                    PriorPageHash = ReadCursorString(json, "priorPageHash"),
                    RevisionFingerprint = ReadCursorString(json, "revisionFingerprint"),
                    ScopeFingerprint = ReadCursorString(json, "scopeFingerprint"),
                    CapturedAt = ReadCursorString(json, "capturedAt")
                };
                DateTimeOffset capturedAt;
                if (!string.Equals(envelope.CursorVersion, CursorVersion, StringComparison.Ordinal) ||
                    !IsBoundedNonEmpty(envelope.CaptureId, 256) || envelope.PageOrdinal < 1 || envelope.PageOrdinal > 1000000 ||
                    envelope.SortPosition == null || string.IsNullOrWhiteSpace(envelope.SortPosition.DocumentKey) ||
                    string.IsNullOrWhiteSpace(envelope.SortPosition.LinkPlacementKey) || string.IsNullOrWhiteSpace(envelope.SortPosition.NodeKind) ||
                    string.IsNullOrWhiteSpace(envelope.SortPosition.StableSourceIdentity) || string.IsNullOrWhiteSpace(envelope.PriorPageHash) ||
                    !IsBoundedNonEmpty(envelope.SortPosition.DocumentKey, 512) || !IsBoundedNonEmpty(envelope.SortPosition.LinkPlacementKey, 512) ||
                    !IsBoundedNonEmpty(envelope.SortPosition.StableSourceIdentity, 512) || !IsCursorNodeKind(envelope.SortPosition.NodeKind) ||
                    !IsSha256(envelope.PriorPageHash) || !IsSha256(envelope.RevisionFingerprint) || !IsSha256(envelope.ScopeFingerprint) ||
                    !DateTimeOffset.TryParseExact(envelope.CapturedAt, "o", CultureInfo.InvariantCulture, DateTimeStyles.RoundtripKind, out capturedAt) ||
                    capturedAt.Offset != TimeSpan.Zero || capturedAt > DateTimeOffset.UtcNow.AddMinutes(5) || capturedAt < AddinSessionStartedAtUtc.AddMinutes(-5))
                {
                    throw new FormatException("Cursor envelope is incomplete or uses an unsupported version.");
                }
                return true;
            }
            catch (Exception ex)
            {
                error = ex.Message;
                return false;
            }
        }

        private static byte[] CreateRandomSecret(int length)
        {
            byte[] secret = new byte[length];
            using (RandomNumberGenerator random = RandomNumberGenerator.Create()) random.GetBytes(secret);
            return secret;
        }

        private static string ToBase64Url(byte[] value)
        {
            return Convert.ToBase64String(value).TrimEnd('=').Replace('+', '-').Replace('/', '_');
        }

        private static byte[] FromBase64Url(string value, int maxDecodedBytes)
        {
            if (string.IsNullOrWhiteSpace(value) || value.IndexOf('=') >= 0 || value.Any(character =>
                !(character >= 'A' && character <= 'Z') && !(character >= 'a' && character <= 'z') &&
                !(character >= '0' && character <= '9') && character != '-' && character != '_'))
            {
                throw new FormatException("Cursor contains invalid base64url characters.");
            }
            string base64 = value.Replace('-', '+').Replace('_', '/');
            switch (base64.Length % 4)
            {
                case 2: base64 += "=="; break;
                case 3: base64 += "="; break;
                case 1: throw new FormatException("Invalid base64url length.");
            }
            byte[] decoded = Convert.FromBase64String(base64);
            if (decoded.Length > maxDecodedBytes) throw new FormatException("Decoded cursor exceeds the supported size.");
            return decoded;
        }

        private static bool FixedTimeEquals(byte[] left, byte[] right)
        {
            if (left == null || right == null) return false;
            int difference = left.Length ^ right.Length;
            int length = Math.Min(left.Length, right.Length);
            for (int index = 0; index < length; index++) difference |= left[index] ^ right[index];
            return difference == 0;
        }

        private static bool IsBoundedNonEmpty(string value, int maxLength)
        {
            return !string.IsNullOrWhiteSpace(value) && value.Length <= maxLength && !value.Any(char.IsControl);
        }

        private static bool IsStringToken(JToken token)
        {
            return token != null && token.Type == JTokenType.String;
        }

        private static bool IsCursorNodeKind(string value)
        {
            return value == "revit_element" || value == "connector" || value == "derived" ||
                value == "revit_element_omission" || value == "connector_omission" ||
                value == "source_omission";
        }

        private static bool IsSha256(string value)
        {
            if (string.IsNullOrEmpty(value) || value.Length != 71 || !value.StartsWith("sha256:", StringComparison.Ordinal)) return false;
            for (int index = 7; index < value.Length; index++)
            {
                char character = value[index];
                if (!((character >= '0' && character <= '9') || (character >= 'a' && character <= 'f'))) return false;
            }
            return true;
        }

        private static string ReadCursorString(JObject json, string name)
        {
            JToken token = json != null ? json[name] : null;
            return token == null || token.Type == JTokenType.Null ? "" : token.ToString();
        }

        private static CursorSortPosition ReadSortPosition(JObject json)
        {
            if (json == null) return null;
            return new CursorSortPosition
            {
                DocumentKey = ReadCursorString(json, "documentKey"),
                LinkPlacementKey = ReadCursorString(json, "linkPlacementKey"),
                NodeKind = ReadCursorString(json, "nodeKind"),
                StableSourceIdentity = ReadCursorString(json, "stableSourceIdentity")
            };
        }

        internal static DocumentIdentity ResolveDocumentIdentity(Document document, bool isLinkedSource = false, bool observeExternalSource = true)
        {
            SpatialDocumentChangeSnapshot changeBinding = SpatialChangeTracker.Instance.GetCurrentBinding(document);
            string sessionId = changeBinding.DocumentSessionId;
            string path = NormalizePath(SafeGet(delegate { return document.PathName; }));
            string projectInfoIdentity = SafeGet(delegate
            {
                ProjectInfo info = document.ProjectInformation;
                return info != null ? info.UniqueId : "";
            });

            string documentKey;
            string resolutionBasis;
            string fallbackReason = null;
            bool crossSessionStable;
            string cloudIdentity = TryGetCloudIdentity(document);
            string centralIdentity = string.IsNullOrWhiteSpace(cloudIdentity) ? TryGetCentralIdentity(document) : "";
            if (!string.IsNullOrWhiteSpace(cloudIdentity))
            {
                documentKey = "cloud:" + Sha256(cloudIdentity);
                resolutionBasis = "cloud_project_model_identity";
                crossSessionStable = true;
            }
            else if (!string.IsNullOrWhiteSpace(centralIdentity))
            {
                documentKey = "central:" + Sha256(centralIdentity);
                resolutionBasis = "workshared_central_identity";
                crossSessionStable = true;
            }
            else if (!string.IsNullOrWhiteSpace(path))
            {
                documentKey = "standalone:" + Sha256((projectInfoIdentity ?? "") + "|" + path);
                resolutionBasis = "project_information_plus_normalized_path";
                fallbackReason = string.IsNullOrWhiteSpace(projectInfoIdentity) ? "project_information_identity_unavailable" : null;
                crossSessionStable = !string.IsNullOrWhiteSpace(projectInfoIdentity);
            }
            else
            {
                documentKey = "session-only:" + sessionId;
                resolutionBasis = "unsaved_session_only";
                fallbackReason = "document_has_no_stable_saved_or_workshared_identity";
                crossSessionStable = false;
            }

            LoadedVersionObservation version = ResolveLoadedVersion(document, path, isLinkedSource, observeExternalSource, sessionId);
            return new DocumentIdentity
            {
                DocumentKey = documentKey,
                DocumentSessionId = sessionId,
                ResolutionBasis = resolutionBasis,
                FallbackReason = fallbackReason,
                CrossSessionStable = crossSessionStable,
                LoadedVersion = version.LoadedVersion,
                LoadedVersionBasis = version.LoadedVersionBasis,
                LoadedVersionAvailable = version.LoadedVersionAvailable,
                ExternalSourceVersion = version.ExternalSourceVersion,
                ExternalLinkUpdateAvailable = version.ExternalLinkUpdateAvailable,
                ExternalObservationBasis = version.ExternalObservationBasis,
                TrackerSessionId = changeBinding.TrackerSessionId,
                TrackerSubscribed = changeBinding.TrackerSubscribed,
                ChangeSequence = changeBinding.CurrentSequence,
                OldestRetainedSequence = changeBinding.OldestRetainedSequence,
                JournalEntryCount = changeBinding.JournalEntryCount,
                JournalCapacity = changeBinding.JournalCapacity,
                JournalTruncated = changeBinding.JournalTruncated
            };
        }

        private static bool IsWorkPhase(string value)
        {
            return value == "discover" || value == "filter" || value == "extract" || value == "finalize";
        }

        private static string TryGetCloudIdentity(Document document)
        {
            try
            {
                MethodInfo method = document.GetType().GetMethod("GetCloudModelPath", BindingFlags.Instance | BindingFlags.Public, null, Type.EmptyTypes, null);
                object modelPath = method != null ? method.Invoke(document, null) : null;
                if (modelPath == null) return "";
                Type type = modelPath.GetType();
                PropertyInfo projectProperty = type.GetProperty("ProjectGUID", BindingFlags.Instance | BindingFlags.Public);
                PropertyInfo modelProperty = type.GetProperty("ModelGUID", BindingFlags.Instance | BindingFlags.Public);
                object project = projectProperty != null ? projectProperty.GetValue(modelPath, null) : InvokeNoArg(type, modelPath, "GetProjectGUID");
                object model = modelProperty != null ? modelProperty.GetValue(modelPath, null) : InvokeNoArg(type, modelPath, "GetModelGUID");
                if (project != null || model != null) return (project ?? "") + "|" + (model ?? "");
                return "";
            }
            catch
            {
                return "";
            }
        }

        private static object InvokeNoArg(Type type, object instance, string methodName)
        {
            try
            {
                MethodInfo method = type.GetMethod(methodName, BindingFlags.Instance | BindingFlags.Public, null, Type.EmptyTypes, null);
                return method != null ? method.Invoke(instance, null) : null;
            }
            catch
            {
                return null;
            }
        }

        private static string TryGetCentralIdentity(Document document)
        {
            try
            {
                if (!document.IsWorkshared) return "";
                MethodInfo centralGuidMethod = typeof(WorksharingUtils).GetMethod("GetCentralGUID", BindingFlags.Public | BindingFlags.Static, null, new[] { typeof(Document) }, null);
                object guid = centralGuidMethod != null ? centralGuidMethod.Invoke(null, new object[] { document }) : null;
                if (guid != null && !string.Equals(guid.ToString(), Guid.Empty.ToString(), StringComparison.OrdinalIgnoreCase)) return guid.ToString();
            }
            catch
            {
            }

            try
            {
                ModelPath central = document.GetWorksharingCentralModelPath();
                return central != null ? NormalizePath(ModelPathUtils.ConvertModelPathToUserVisiblePath(central)) : "";
            }
            catch
            {
                return "";
            }
        }

        private static LoadedVersionObservation ResolveLoadedVersion(Document document, string normalizedPath, bool isLinkedSource, bool observeExternalSource, string documentSessionId)
        {
            string loadedToken = TryReadVersionToken(document);
            LoadedVersionObservation result = new LoadedVersionObservation
            {
                LoadedVersionAvailable = !string.IsNullOrWhiteSpace(loadedToken),
                LoadedVersionBasis = !string.IsNullOrWhiteSpace(loadedToken) ? "revit_in_memory_document_version" : "unavailable_session_bound",
                LoadedVersion = !string.IsNullOrWhiteSpace(loadedToken)
                    ? Sha256(loadedToken)
                    : Sha256("loaded-version-unavailable|" + (documentSessionId ?? "")),
                ExternalLinkUpdateAvailable = false,
                ExternalObservationBasis = isLinkedSource ? "external_version_unavailable" : "not_linked_source"
            };
            if (!isLinkedSource || !observeExternalSource || string.IsNullOrWhiteSpace(normalizedPath) || !File.Exists(normalizedPath)) return result;

            object basicFileInfo = null;
            try
            {
                MethodInfo extract = typeof(BasicFileInfo).GetMethod("Extract", BindingFlags.Public | BindingFlags.Static, null, new[] { typeof(string) }, null);
                basicFileInfo = extract != null ? extract.Invoke(null, new object[] { normalizedPath }) : null;
                string externalToken = TryReadVersionToken(basicFileInfo);
                if (!string.IsNullOrWhiteSpace(externalToken))
                {
                    result.ExternalSourceVersion = Sha256(externalToken);
                    result.ExternalObservationBasis = "revit_basic_file_document_version";
                    result.ExternalLinkUpdateAvailable = result.LoadedVersionAvailable &&
                        !string.Equals(result.ExternalSourceVersion, result.LoadedVersion, StringComparison.Ordinal);
                    return result;
                }

                FileInfo file = new FileInfo(normalizedPath);
                result.ExternalSourceVersion = Sha256(
                    "length=" + file.Length.ToString(CultureInfo.InvariantCulture) +
                    "|lastWriteUtc=" + file.LastWriteTimeUtc.Ticks.ToString(CultureInfo.InvariantCulture));
                result.ExternalObservationBasis = "file_metadata_uncompared";
            }
            catch
            {
                result.ExternalObservationBasis = "external_version_read_failed";
            }
            finally
            {
                IDisposable disposable = basicFileInfo as IDisposable;
                if (disposable != null) disposable.Dispose();
            }
            return result;
        }

        private static string TryReadVersionToken(object source)
        {
            if (source == null) return "";
            try
            {
                object version = source;
                MethodInfo method = source.GetType().GetMethod("GetDocumentVersion", BindingFlags.Instance | BindingFlags.Public, null, Type.EmptyTypes, null);
                if (method != null) version = method.Invoke(source, null);
                else
                {
                    PropertyInfo property = source.GetType().GetProperty("DocumentVersion", BindingFlags.Instance | BindingFlags.Public);
                    if (property != null) version = property.GetValue(source, null);
                }
                if (version == null) return "";
                Type type = version.GetType();
                List<string> parts = new List<string>();
                foreach (string propertyName in new[] { "VersionGUID", "NumberOfSaves" })
                {
                    PropertyInfo property = type.GetProperty(propertyName, BindingFlags.Instance | BindingFlags.Public);
                    object value = property != null ? property.GetValue(version, null) : null;
                    if (value != null) parts.Add(propertyName + "=" + Convert.ToString(value, CultureInfo.InvariantCulture));
                }
                return parts.Count > 0 ? string.Join("|", parts) : "";
            }
            catch
            {
                return "";
            }
        }

        private sealed class LoadedVersionObservation
        {
            public string LoadedVersion;
            public string LoadedVersionBasis;
            public bool LoadedVersionAvailable;
            public string ExternalSourceVersion;
            public bool ExternalLinkUpdateAvailable;
            public string ExternalObservationBasis;
        }

        private static string NormalizePath(string path)
        {
            if (string.IsNullOrWhiteSpace(path)) return "";
            try { return Path.GetFullPath(path).Trim().Replace('/', '\\').ToLowerInvariant(); }
            catch { return path.Trim().Replace('/', '\\').ToLowerInvariant(); }
        }

        private static string SafeGet(Func<string> getter)
        {
            try { return getter() ?? ""; }
            catch { return ""; }
        }

        internal static List<LevelBand> ResolveLevelBands(Document hostDocument, SpatialSnapshotRequest request, List<string> warnings)
        {
            Dictionary<int, Level> byId = new Dictionary<int, Level>();
            List<Level> allLevels;
            using (FilteredElementCollector collector = new FilteredElementCollector(hostDocument))
            {
                allLevels = collector.OfClass(typeof(Level)).Cast<Level>().ToList();
            }

            foreach (Level level in allLevels) byId[level.Id.GetIdValue()] = level;
            List<Level> selected = new List<Level>();
            HashSet<int> selectedIds = new HashSet<int>();
            foreach (int levelId in request.LevelIds)
            {
                Level level;
                if (byId.TryGetValue(levelId, out level) && selectedIds.Add(levelId)) selected.Add(level);
                else warnings.Add("Requested host level id was not found: " + levelId.ToString(CultureInfo.InvariantCulture) + ".");
            }
            foreach (string name in request.LevelNames)
            {
                List<Level> matches = allLevels.Where(level => string.Equals(level.Name, name, StringComparison.OrdinalIgnoreCase)).OrderBy(GetProjectElevationFeet).ThenBy(level => level.Id.GetIdValue()).ToList();
                if (matches.Count == 0)
                {
                    warnings.Add("Requested host level name was not found: " + name + ".");
                    continue;
                }
                foreach (Level level in matches)
                {
                    if (selectedIds.Add(level.Id.GetIdValue())) selected.Add(level);
                }
            }

            return selected.OrderBy(GetProjectElevationFeet).ThenBy(level => level.Id.GetIdValue()).Select(level => new LevelBand
            {
                Id = level.Id.GetIdValue(),
                UniqueId = SafeGet(delegate { return level.UniqueId; }),
                Name = level.Name,
                ElevationFeet = GetProjectElevationFeet(level),
                MinHostZFeet = GetProjectElevationFeet(level) - request.BelowLevelMm / FeetToMillimetres,
                MaxHostZFeet = GetProjectElevationFeet(level) + request.AboveLevelMm / FeetToMillimetres
            }).ToList();
        }

        internal static double GetProjectElevationFeet(Level level)
        {
            if (level == null) return 0.0;
            try { return level.ProjectElevation; }
            catch { return level.Elevation; }
        }

        internal static List<BuiltInCategory> GetCategoriesForSource(SpatialSource source, SpatialSnapshotRequest request)
        {
            HashSet<BuiltInCategory> categories = new HashSet<BuiltInCategory>();
            if (source.IsHost && request.IncludeHostMep)
            {
                foreach (BuiltInCategory category in HostMepCategories) categories.Add(category);
            }
            if (request.IncludeRoomsSpaces)
            {
                foreach (BuiltInCategory category in SpatialCategories) categories.Add(category);
            }
            if (!source.IsHost && request.IncludeLinkedObstructions)
            {
                foreach (BuiltInCategory category in LinkedObstructionCategories) categories.Add(category);
            }
            return categories.OrderBy(category => (int)category).ToList();
        }

        internal static string GetCategoryRole(SpatialSource source, BuiltInCategory category)
        {
            if (SpatialCategories.Contains(category)) return "spatial";
            if (source.IsHost && HostMepCategories.Contains(category)) return "host_mep";
            if (!source.IsHost && LinkedObstructionCategories.Contains(category)) return "linked_obstruction";
            return "unsupported";
        }

        internal static Level ResolveSourceLevel(Element element, Document sourceDocument)
        {
            if (element == null || sourceDocument == null) return null;

            try
            {
                ElementId directLevelId = element.LevelId;
                if (directLevelId != null && directLevelId != ElementId.InvalidElementId)
                {
                    Level directLevel = sourceDocument.GetElement(directLevelId) as Level;
                    if (directLevel != null) return directLevel;
                }
            }
            catch
            {
            }

            try
            {
                MEPCurve mepCurve = element as MEPCurve;
                if (mepCurve != null && mepCurve.ReferenceLevel != null)
                {
                    return mepCurve.ReferenceLevel;
                }
            }
            catch
            {
            }

            foreach (BuiltInParameter builtInParameter in new[]
            {
                BuiltInParameter.INSTANCE_SCHEDULE_ONLY_LEVEL_PARAM,
                BuiltInParameter.FAMILY_LEVEL_PARAM,
                BuiltInParameter.INSTANCE_REFERENCE_LEVEL_PARAM,
                BuiltInParameter.RBS_START_LEVEL_PARAM
            })
            {
                try
                {
                    Parameter parameter = element.get_Parameter(builtInParameter);
                    if (parameter == null || parameter.StorageType != StorageType.ElementId) continue;

                    ElementId parameterLevelId = parameter.AsElementId();
                    if (parameterLevelId == null || parameterLevelId == ElementId.InvalidElementId) continue;

                    Level parameterLevel = sourceDocument.GetElement(parameterLevelId) as Level;
                    if (parameterLevel != null) return parameterLevel;
                }
                catch
                {
                }
            }

            return null;
        }

        internal static string ClassifyLevelScope(Element element, SpatialSource source, IList<LevelBand> bands, out string resolvedLevelName, out int? resolvedLevelId, out string resolvedLevelUniqueId)
        {
            resolvedLevelName = null;
            resolvedLevelId = null;
            resolvedLevelUniqueId = null;
            double? sourceLevelHostZFeet = null;
            try
            {
                Level sourceLevel = ResolveSourceLevel(element, source.Document);
                if (sourceLevel != null)
                {
                    resolvedLevelName = sourceLevel.Name;
                    resolvedLevelId = sourceLevel.Id.GetIdValue();
                    resolvedLevelUniqueId = StableUniqueId(sourceLevel);
                    XYZ hostPoint = source.SourceToHost.OfPoint(new XYZ(0, 0, GetProjectElevationFeet(sourceLevel)));
                    sourceLevelHostZFeet = hostPoint.Z;
                }
            }
            catch
            {
            }

            BoundingBoxXYZ box = null;
            try { box = element.get_BoundingBox(null); }
            catch { }
            if (box != null)
            {
                List<XYZ> corners = GetHostBoundingCorners(box, source.SourceToHost);
                if (corners.Count > 0)
                {
                    double minZ = corners.Min(point => point.Z);
                    double maxZ = corners.Max(point => point.Z);
                    return bands.Any(band => maxZ >= band.MinHostZFeet && minZ <= band.MaxHostZFeet) ? "eligible" : "out_of_scope";
                }
            }

            // Source Level identity is useful for deterministic filtering and
            // diagnostics, but it is not proof that element geometry overlaps a
            // host-Z band. When bounds are unavailable, use the transformed Level
            // point only to reject clearly different bands; a matching band remains
            // an explicit omission rather than a false-positive spatial node.
            if (sourceLevelHostZFeet.HasValue)
            {
                return bands.Any(band => sourceLevelHostZFeet.Value >= band.MinHostZFeet && sourceLevelHostZFeet.Value <= band.MaxHostZFeet)
                    ? "scope_unresolved"
                    : "out_of_scope";
            }
            return "scope_unresolved";
        }

        internal static bool TryBuildGeometry(
            Element element,
            SpatialSource source,
            DateTime deadlineUtc,
            int maxPoints,
            int maxSegments,
            out Dictionary<string, object> geometry,
            out string omissionClassification,
            out string omissionDetail)
        {
            geometry = null;
            omissionClassification = null;
            omissionDetail = null;
            try
            {
                int pointCount = 0;
                int segmentCount = 0;
                EnsureGeometryBudget(deadlineUtc, pointCount, segmentCount, maxPoints, maxSegments);
                List<XYZ> hostAabbPoints = new List<XYZ>();
                BoundingBoxXYZ box = null;
                try { box = element.get_BoundingBox(null); }
                catch (Exception ex) { omissionDetail = "Bounding box read failed: " + ex.Message; }
                if (box != null)
                {
                    List<XYZ> corners = GetHostBoundingCorners(box, source.SourceToHost);
                    pointCount += corners.Count;
                    EnsureGeometryBudget(deadlineUtc, pointCount, segmentCount, maxPoints, maxSegments);
                    hostAabbPoints.AddRange(corners);
                }

                Dictionary<string, object> centerline = BuildCenterline(element, source.SourceToHost, hostAabbPoints, deadlineUtc, maxPoints, maxSegments, ref pointCount, ref segmentCount);
                List<object> boundaryLoops = new List<object>();
                SpatialElement spatial = element as SpatialElement;
                if (spatial != null)
                {
                    string boundaryFailure;
                    boundaryLoops = BuildBoundaryLoops(spatial, source.SourceToHost, hostAabbPoints, deadlineUtc, maxPoints, maxSegments, ref pointCount, ref segmentCount, out boundaryFailure);
                    if (boundaryLoops.Count == 0)
                    {
                        omissionClassification = "spatial_boundary_unavailable";
                        omissionDetail = boundaryFailure ?? "Room/Space has no readable boundary loops (unplaced, unenclosed, or unsupported phase state).";
                        return false;
                    }
                }

                Dictionary<string, object> pointLocation = BuildPointLocation(element, source.SourceToHost, hostAabbPoints, deadlineUtc, maxPoints, maxSegments, ref pointCount, ref segmentCount);
                if (hostAabbPoints.Count == 0)
                {
                    omissionClassification = "geometry_unavailable";
                    omissionDetail = omissionDetail ?? "No bounding box, centerline, point, or spatial boundary geometry was available.";
                    return false;
                }

                double minX = hostAabbPoints.Min(point => point.X) * FeetToMillimetres;
                double minY = hostAabbPoints.Min(point => point.Y) * FeetToMillimetres;
                double minZ = hostAabbPoints.Min(point => point.Z) * FeetToMillimetres;
                double maxX = hostAabbPoints.Max(point => point.X) * FeetToMillimetres;
                double maxY = hostAabbPoints.Max(point => point.Y) * FeetToMillimetres;
                double maxZ = hostAabbPoints.Max(point => point.Z) * FeetToMillimetres;

                geometry = new Dictionary<string, object>
                {
                    { "coordinateFrame", CoordinateFrame },
                    { "lengthUnit", "mm" },
                    { "aabb", new Dictionary<string, object>
                        {
                            { "min", MillimetrePoint(minX, minY, minZ) },
                            { "max", MillimetrePoint(maxX, maxY, maxZ) }
                        }
                    },
                    { "centerline", centerline },
                    { "pointLocation", pointLocation },
                    { "boundaryLoops", boundaryLoops },
                    { "basis", spatial != null ? "revit_spatial_boundary_and_aabb" : centerline != null ? "revit_location_curve_and_aabb" : "revit_element_aabb" },
                    { "precisionClass", spatial != null ? "boundary_curve_tessellation" : centerline != null ? "centerline_tessellation" : "aabb_only" },
                    { "verdictCapability", "context_only" }
                };
                geometry["geometryFingerprint"] = Sha256(CanonicalGeometryText(geometry));
                return true;
            }
            catch (GeometryBudgetException ex)
            {
                omissionClassification = ex.Classification;
                omissionDetail = ex.Message;
                return false;
            }
            catch (Exception ex)
            {
                omissionClassification = "geometry_read_failed";
                omissionDetail = ex.Message;
                return false;
            }
        }

        private static Dictionary<string, object> BuildCenterline(
            Element element,
            Transform sourceToHost,
            List<XYZ> envelopePoints,
            DateTime deadlineUtc,
            int maxPoints,
            int maxSegments,
            ref int pointCount,
            ref int segmentCount)
        {
            LocationCurve location = element.Location as LocationCurve;
            if (location == null || location.Curve == null) return null;
            segmentCount++;
            EnsureGeometryBudget(deadlineUtc, pointCount, segmentCount, maxPoints, maxSegments);
            IList<XYZ> points;
            try { points = location.Curve.Tessellate(); }
            catch { points = new List<XYZ> { location.Curve.GetEndPoint(0), location.Curve.GetEndPoint(1) }; }
            pointCount += points.Count;
            EnsureGeometryBudget(deadlineUtc, pointCount, segmentCount, maxPoints, maxSegments);
            List<object> converted = new List<object>();
            for (int index = 0; index < points.Count; index++)
            {
                if ((index & 63) == 0) EnsureGeometryBudget(deadlineUtc, pointCount, segmentCount, maxPoints, maxSegments);
                XYZ sourcePoint = points[index];
                XYZ hostPoint = sourceToHost.OfPoint(sourcePoint);
                envelopePoints.Add(hostPoint);
                converted.Add(MillimetrePoint(hostPoint));
            }
            return new Dictionary<string, object>
            {
                { "curveType", location.Curve.GetType().Name },
                { "points", converted }
            };
        }

        private static Dictionary<string, object> BuildPointLocation(
            Element element,
            Transform sourceToHost,
            List<XYZ> envelopePoints,
            DateTime deadlineUtc,
            int maxPoints,
            int maxSegments,
            ref int pointCount,
            ref int segmentCount)
        {
            LocationPoint location = element.Location as LocationPoint;
            if (location == null || location.Point == null) return null;
            pointCount++;
            EnsureGeometryBudget(deadlineUtc, pointCount, segmentCount, maxPoints, maxSegments);
            XYZ point = sourceToHost.OfPoint(location.Point);
            envelopePoints.Add(point);
            object rotationRadians = null;
            try
            {
                double sourceRotation = location.Rotation;
                XYZ sourceDirection = new XYZ(Math.Cos(sourceRotation), Math.Sin(sourceRotation), 0.0);
                XYZ hostDirection = sourceToHost.OfVector(sourceDirection);
                rotationRadians = Math.Atan2(hostDirection.Y, hostDirection.X);
            }
            catch { }
            return new Dictionary<string, object>
            {
                { "point", MillimetrePoint(point) },
                { "rotationRadians", rotationRadians }
            };
        }

        private static List<object> BuildBoundaryLoops(
            SpatialElement spatial,
            Transform sourceToHost,
            List<XYZ> envelopePoints,
            DateTime deadlineUtc,
            int maxPoints,
            int maxSegments,
            ref int pointCount,
            ref int segmentCount,
            out string failure)
        {
            failure = null;
            List<object> result = new List<object>();
            try
            {
                SpatialElementBoundaryOptions options = new SpatialElementBoundaryOptions
                {
                    SpatialElementBoundaryLocation = SpatialElementBoundaryLocation.Finish
                };
                IList<IList<BoundarySegment>> loops = spatial.GetBoundarySegments(options);
                if (loops == null) return result;
                foreach (IList<BoundarySegment> loop in loops)
                {
                    List<object> points = new List<object>();
                    foreach (BoundarySegment segment in loop)
                    {
                        segmentCount++;
                        EnsureGeometryBudget(deadlineUtc, pointCount, segmentCount, maxPoints, maxSegments);
                        Curve curve = segment.GetCurve();
                        if (curve == null) continue;
                        IList<XYZ> tessellated;
                        try { tessellated = curve.Tessellate(); }
                        catch { tessellated = new List<XYZ> { curve.GetEndPoint(0), curve.GetEndPoint(1) }; }
                        pointCount += tessellated.Count;
                        EnsureGeometryBudget(deadlineUtc, pointCount, segmentCount, maxPoints, maxSegments);
                        for (int index = 0; index < tessellated.Count; index++)
                        {
                            if ((index & 63) == 0) EnsureGeometryBudget(deadlineUtc, pointCount, segmentCount, maxPoints, maxSegments);
                            XYZ sourcePoint = tessellated[index];
                            XYZ hostPoint = sourceToHost.OfPoint(sourcePoint);
                            if (points.Count == 0 || !SamePoint((IList<double>)points[points.Count - 1], hostPoint))
                            {
                                points.Add(MillimetrePoint(hostPoint));
                                envelopePoints.Add(hostPoint);
                            }
                        }
                    }
                    if (points.Count >= 2 && SameMillimetrePoint(
                        (IList<double>)points[0],
                        (IList<double>)points[points.Count - 1]))
                    {
                        points.RemoveAt(points.Count - 1);
                    }
                    if (points.Count >= 3) result.Add(points);
                }
            }
            catch (GeometryBudgetException)
            {
                throw;
            }
            catch (Exception ex)
            {
                failure = ex.Message;
            }
            return result;
        }

        private static void EnsureGeometryBudget(DateTime deadlineUtc, int pointCount, int segmentCount, int maxPoints, int maxSegments)
        {
            if (DateTime.UtcNow >= deadlineUtc)
            {
                throw new GeometryBudgetException("geometry_deadline_exceeded", "Per-element geometry traversal reached the extraction deadline.");
            }
            if (pointCount > maxPoints)
            {
                throw new GeometryBudgetException("geometry_point_budget_exceeded", "Per-element geometry exceeded maxGeometryPointsPerElement=" + maxPoints.ToString(CultureInfo.InvariantCulture) + ".");
            }
            if (segmentCount > maxSegments)
            {
                throw new GeometryBudgetException("geometry_segment_budget_exceeded", "Per-element geometry exceeded maxBoundarySegmentsPerElement=" + maxSegments.ToString(CultureInfo.InvariantCulture) + ".");
            }
        }

        private sealed class GeometryBudgetException : Exception
        {
            public string Classification { get; private set; }

            public GeometryBudgetException(string classification, string message)
                : base(message)
            {
                Classification = classification;
            }
        }

        private static bool SamePoint(IList<double> priorMm, XYZ pointFeet)
        {
            if (priorMm == null || priorMm.Count < 3) return false;
            return Math.Abs(priorMm[0] - pointFeet.X * FeetToMillimetres) < 0.01 &&
                   Math.Abs(priorMm[1] - pointFeet.Y * FeetToMillimetres) < 0.01 &&
                   Math.Abs(priorMm[2] - pointFeet.Z * FeetToMillimetres) < 0.01;
        }

        private static bool SameMillimetrePoint(IList<double> left, IList<double> right)
        {
            return left != null && right != null && left.Count >= 3 && right.Count >= 3 &&
                   Math.Abs(left[0] - right[0]) < 0.01 &&
                   Math.Abs(left[1] - right[1]) < 0.01 &&
                   Math.Abs(left[2] - right[2]) < 0.01;
        }

        internal static List<XYZ> GetHostBoundingCorners(BoundingBoxXYZ box, Transform sourceToHost)
        {
            List<XYZ> result = new List<XYZ>();
            if (box == null || box.Min == null || box.Max == null) return result;
            Transform boxTransform = box.Transform ?? Transform.Identity;
            for (int xi = 0; xi < 2; xi++)
            {
                for (int yi = 0; yi < 2; yi++)
                {
                    for (int zi = 0; zi < 2; zi++)
                    {
                        XYZ local = new XYZ(xi == 0 ? box.Min.X : box.Max.X, yi == 0 ? box.Min.Y : box.Max.Y, zi == 0 ? box.Min.Z : box.Max.Z);
                        result.Add(sourceToHost.OfPoint(boxTransform.OfPoint(local)));
                    }
                }
            }
            return result;
        }

        internal static IList<double> MillimetrePoint(XYZ point)
        {
            return MillimetrePoint(point.X * FeetToMillimetres, point.Y * FeetToMillimetres, point.Z * FeetToMillimetres);
        }

        private static IList<double> MillimetrePoint(double x, double y, double z)
        {
            return new[] { RoundMm(x), RoundMm(y), RoundMm(z) };
        }

        private static double RoundMm(double value)
        {
            return Math.Round(value, 6, MidpointRounding.AwayFromZero);
        }

        private static string CanonicalGeometryText(Dictionary<string, object> geometry)
        {
            return CanonicalJson(geometry);
        }

        internal static Dictionary<string, object> BuildElementSpatialProperties(Document document, Element element)
        {
            string systemName = ReadParameterText(element, new[]
            {
                "RBS_SYSTEM_NAME_PARAM"
            });
            string systemClassification = ReadParameterText(element, new[]
            {
                "RBS_SYSTEM_CLASSIFICATION_PARAM"
            });
            Element systemElement = ResolveSystemElement(document, element);
            if (systemElement != null)
            {
                if (string.IsNullOrWhiteSpace(systemName)) systemName = GetElementName(systemElement);
                if (string.IsNullOrWhiteSpace(systemClassification))
                {
                    systemClassification = ReadPropertyText(systemElement, "SystemClassification");
                }
            }

            return new Dictionary<string, object>
            {
                { "systemKey", systemElement != null ? "system:" + StableUniqueId(systemElement) : null },
                { "systemName", string.IsNullOrWhiteSpace(systemName) ? null : systemName },
                { "systemClassification", string.IsNullOrWhiteSpace(systemClassification) ? null : systemClassification }
            };
        }

        internal static Dictionary<string, object> BuildElementProfile(Element element)
        {
            BuiltInCategory category = GetBuiltInCategory(element);
            bool isPipeCurve = category == BuiltInCategory.OST_PipeCurves ||
                category == BuiltInCategory.OST_FlexPipeCurves;
            double? diameterMm = ReadLengthParameterMm(element, isPipeCurve
                ? new[] { "RBS_PIPE_OUTER_DIAMETER" }
                : new[] { "RBS_DUCT_DIAMETER_PARAM", "RBS_CURVE_DIAMETER_PARAM" });
            double? widthMm = ReadLengthParameterMm(element, new[]
            {
                "RBS_CURVE_WIDTH_PARAM",
                "RBS_DUCT_WIDTH_PARAM"
            });
            double? heightMm = ReadLengthParameterMm(element, new[]
            {
                "RBS_CURVE_HEIGHT_PARAM",
                "RBS_DUCT_HEIGHT_PARAM"
            });
            double? insulationThicknessMm = ReadNonNegativeLengthParameterMm(element, new[]
            {
                "RBS_REFERENCE_INSULATION_THICKNESS",
                "RBS_INSULATION_THICKNESS"
            });
            string shape = diameterMm.HasValue && diameterMm.Value > 0
                ? "round"
                : widthMm.HasValue && widthMm.Value > 0 && heightMm.HasValue && heightMm.Value > 0
                    ? "rectangular"
                    : "unknown";
            string rawShape = ReadParameterText(element, new[] { "RBS_CURVE_PROFILE_PARAM", "RBS_DUCT_SHAPE_PARAM" });
            if (!string.IsNullOrWhiteSpace(rawShape) && rawShape.IndexOf("oval", StringComparison.OrdinalIgnoreCase) >= 0)
            {
                shape = "oval";
            }

            return new Dictionary<string, object>
            {
                { "shape", shape },
                { "diameterMm", diameterMm },
                { "widthMm", widthMm },
                { "heightMm", heightMm },
                { "insulationThicknessMm", insulationThicknessMm }
            };
        }

        internal static void ApplyAnalyticProfileEnvelopeToGeometry(
            Dictionary<string, object> geometry,
            Dictionary<string, object> profile)
        {
            if (geometry == null || profile == null) return;
            JObject geometryJson = JObject.FromObject(geometry);
            JObject profileJson = JObject.FromObject(profile);
            string shape = Convert.ToString(profileJson["shape"], CultureInfo.InvariantCulture);
            double? diameterMm = profileJson["diameterMm"] != null && profileJson["diameterMm"].Type != JTokenType.Null
                ? (double?)profileJson["diameterMm"].Value<double>()
                : null;
            double? insulationThicknessMm = profileJson["insulationThicknessMm"] != null && profileJson["insulationThicknessMm"].Type != JTokenType.Null
                ? (double?)profileJson["insulationThicknessMm"].Value<double>()
                : null;
            JObject centerline = geometryJson["centerline"] as JObject;
            JArray points = centerline != null ? centerline["points"] as JArray : null;
            string curveType = centerline != null
                ? Convert.ToString(centerline["curveType"], CultureInfo.InvariantCulture)
                : null;
            if (!string.Equals(shape, "round", StringComparison.OrdinalIgnoreCase)
                || !diameterMm.HasValue || diameterMm.Value < 0
                || !insulationThicknessMm.HasValue || insulationThicknessMm.Value < 0
                || !string.Equals(curveType, "Line", StringComparison.OrdinalIgnoreCase)
                || points == null || points.Count != 2
                || points.Any(point => !(point is JArray) || ((JArray)point).Count != 3))
            {
                return;
            }

            double outerRadiusMm = diameterMm.Value / 2.0 + insulationThicknessMm.Value;
            JObject aabb = geometryJson["aabb"] as JObject;
            JArray currentMin = aabb != null ? aabb["min"] as JArray : null;
            JArray currentMax = aabb != null ? aabb["max"] as JArray : null;
            if (currentMin == null || currentMax == null || currentMin.Count != 3 || currentMax.Count != 3) return;

            double[] minimum = Enumerable.Range(0, 3).Select(axis => currentMin[axis].Value<double>()).ToArray();
            double[] maximum = Enumerable.Range(0, 3).Select(axis => currentMax[axis].Value<double>()).ToArray();
            foreach (JArray point in points.OfType<JArray>())
            {
                for (int axis = 0; axis < 3; axis++)
                {
                    double coordinate = point[axis].Value<double>();
                    minimum[axis] = Math.Min(minimum[axis], coordinate - outerRadiusMm);
                    maximum[axis] = Math.Max(maximum[axis], coordinate + outerRadiusMm);
                }
            }

            geometry["aabb"] = new Dictionary<string, object>
            {
                { "min", MillimetrePoint(minimum[0], minimum[1], minimum[2]) },
                { "max", MillimetrePoint(maximum[0], maximum[1], maximum[2]) }
            };
            geometry.Remove("geometryFingerprint");
            geometry["geometryFingerprint"] = Sha256(CanonicalGeometryText(geometry));
        }

        internal static Dictionary<string, object> BuildElementFingerprints(
            Dictionary<string, object> geometry,
            Dictionary<string, object> spatialProperties,
            Dictionary<string, object> profile,
            object propertyBasis)
        {
            Dictionary<string, object> topologyBasis = new Dictionary<string, object>
            {
                { "ownedConnectorNodeIds", new List<string>() },
                { "connectorTopologyFingerprints", new List<string>() }
            };
            return new Dictionary<string, object>
            {
                { "version", FingerprintVersion },
                { "placement", Sha256(CanonicalJson(BuildPlacementFingerprintBasis(geometry))) },
                { "shape", Sha256(CanonicalJson(BuildShapeFingerprintBasis(geometry, profile))) },
                { "property", Sha256(CanonicalJson(new Dictionary<string, object>
                    {
                        { "spatialProperties", spatialProperties },
                        { "element", propertyBasis }
                    }))
                },
                { "topology", Sha256(CanonicalJson(topologyBasis)) }
            };
        }

        internal static void ApplyElementTopologyFingerprint(SpatialRow elementRow, IEnumerable<SpatialRow> connectorRows)
        {
            if (elementRow == null || elementRow.Payload == null) return;
            List<SpatialRow> rows = (connectorRows ?? Enumerable.Empty<SpatialRow>())
                .Where(row => row != null && row.IsNode && row.Payload != null)
                .OrderBy(row => Convert.ToString(row.Payload.ContainsKey("nodeId") ? row.Payload["nodeId"] : null, CultureInfo.InvariantCulture), StringComparer.Ordinal)
                .ToList();
            List<string> connectorNodeIds = rows
                .Select(row => Convert.ToString(row.Payload.ContainsKey("nodeId") ? row.Payload["nodeId"] : null, CultureInfo.InvariantCulture))
                .Where(value => !string.IsNullOrWhiteSpace(value))
                .ToList();
            List<string> connectorTopologyFingerprints = rows
                .Select(row => row.Payload.ContainsKey("fingerprints") ? row.Payload["fingerprints"] as Dictionary<string, object> : null)
                .Where(value => value != null && value.ContainsKey("topology"))
                .Select(value => Convert.ToString(value["topology"], CultureInfo.InvariantCulture))
                .Where(value => !string.IsNullOrWhiteSpace(value))
                .OrderBy(value => value, StringComparer.Ordinal)
                .ToList();
            Dictionary<string, object> fingerprints = elementRow.Payload.ContainsKey("fingerprints")
                ? elementRow.Payload["fingerprints"] as Dictionary<string, object>
                : null;
            if (fingerprints == null) return;
            fingerprints["topology"] = Sha256(CanonicalJson(new Dictionary<string, object>
            {
                { "ownedConnectorNodeIds", connectorNodeIds },
                { "connectorTopologyFingerprints", connectorTopologyFingerprints }
            }));
            elementRow.PayloadFingerprint = Sha256(SerializePayload(elementRow.Payload));
            elementRow.CanonicalByteCount = 0;
        }

        private static Dictionary<string, object> BuildShapeFingerprintBasis(
            Dictionary<string, object> geometry,
            Dictionary<string, object> profile)
        {
            JObject source = geometry != null ? JObject.FromObject(geometry) : new JObject();
            JObject basis = new JObject
            {
                ["basis"] = source["basis"],
                ["precisionClass"] = source["precisionClass"],
                ["profile"] = profile != null ? JObject.FromObject(profile) : JValue.CreateNull()
            };
            JObject centerline = source["centerline"] as JObject;
            JArray centerlinePoints = centerline != null ? centerline["points"] as JArray : null;
            bool hasLinearCenterline = centerlinePoints != null && centerlinePoints.Count >= 2;
            basis["centerlineShape"] = JObject.FromObject(PolylineShapeInvariants(centerlinePoints, false));
            JArray boundaryLoops = source["boundaryLoops"] as JArray;
            JArray normalizedLoops = new JArray();
            if (boundaryLoops != null)
            {
                List<JObject> loopInvariants = boundaryLoops.OfType<JArray>()
                    .Select(loop => JObject.FromObject(PolylineShapeInvariants(loop, true)))
                    .OrderBy(loop => CanonicalJson(loop), StringComparer.Ordinal)
                    .ToList();
                foreach (JObject loopInvariant in loopInvariants) normalizedLoops.Add(loopInvariant);
            }
            basis["boundaryLoopShape"] = normalizedLoops;
            if (!hasLinearCenterline && normalizedLoops.Count == 0)
            {
                // A host-axis-aligned AABB changes dimensions under a rigid
                // rotation. Excluding it from the shape fingerprint avoids
                // falsely classifying placement rotation as physical resize.
                // The runtime reports this class as capability-limited.
                basis["shapeSupport"] = "aabb_only_not_rotation_invariant";
            }
            return basis.ToObject<Dictionary<string, object>>();
        }

        private static Dictionary<string, object> BuildPlacementFingerprintBasis(Dictionary<string, object> geometry)
        {
            JObject source = geometry != null ? JObject.FromObject(geometry) : new JObject();
            JObject centerline = source["centerline"] as JObject;
            JArray centerlinePoints = centerline != null ? centerline["points"] as JArray : null;
            JToken pointLocation = source["pointLocation"];
            JArray boundaryLoops = source["boundaryLoops"] as JArray;
            JObject basis = new JObject();
            if (centerlinePoints != null && centerlinePoints.Count >= 2)
            {
                basis["centerlinePoints"] = CanonicalPointSequence(centerlinePoints, false);
            }
            else if (pointLocation != null && pointLocation.Type != JTokenType.Null)
            {
                basis["pointLocation"] = pointLocation.DeepClone();
            }
            else if (boundaryLoops != null && boundaryLoops.Count > 0)
            {
                JArray canonicalLoops = new JArray();
                List<JArray> orderedLoops = boundaryLoops.OfType<JArray>()
                    .Select(loop => CanonicalPointSequence(loop, true))
                    .OrderBy(loop => CanonicalJson(loop), StringComparer.Ordinal)
                    .ToList();
                foreach (JArray loop in orderedLoops) canonicalLoops.Add(loop);
                basis["boundaryLoops"] = canonicalLoops;
            }
            else
            {
                JObject aabb = source["aabb"] as JObject;
                JArray min = aabb != null ? aabb["min"] as JArray : null;
                JArray max = aabb != null ? aabb["max"] as JArray : null;
                if (min != null && max != null && min.Count == 3 && max.Count == 3)
                {
                    basis["aabbCenterMm"] = new JArray(
                        RoundMm((max[0].Value<double>() + min[0].Value<double>()) / 2.0),
                        RoundMm((max[1].Value<double>() + min[1].Value<double>()) / 2.0),
                        RoundMm((max[2].Value<double>() + min[2].Value<double>()) / 2.0));
                }
            }
            return basis.ToObject<Dictionary<string, object>>();
        }

        private static JArray CanonicalPointSequence(JArray points, bool closed)
        {
            List<JToken> source = points != null
                ? points.Where(point => point is JArray).Select(point => point.DeepClone()).ToList()
                : new List<JToken>();
            if (source.Count == 0) return new JArray();
            List<List<JToken>> orientations = new List<List<JToken>>
            {
                source,
                source.AsEnumerable().Reverse().Select(point => point.DeepClone()).ToList()
            };
            string bestCanonical = null;
            JArray best = null;
            foreach (List<JToken> orientation in orientations)
            {
                int candidateCount = closed ? orientation.Count : 1;
                for (int offset = 0; offset < candidateCount; offset++)
                {
                    JArray candidate = new JArray(Enumerable.Range(0, orientation.Count)
                        .Select(index => orientation[(index + offset) % orientation.Count].DeepClone()));
                    string canonical = CanonicalJson(candidate);
                    if (bestCanonical == null || string.CompareOrdinal(canonical, bestCanonical) < 0)
                    {
                        bestCanonical = canonical;
                        best = candidate;
                    }
                }
            }
            return best ?? new JArray();
        }

        private static Dictionary<string, object> PolylineShapeInvariants(JArray points, bool closeLoop)
        {
            List<double[]> vectors = new List<double[]>();
            if (points != null)
            {
                for (int index = 1; index < points.Count; index++)
                {
                    JArray previous = points[index - 1] as JArray;
                    JArray current = points[index] as JArray;
                    if (previous == null || current == null || previous.Count != 3 || current.Count != 3) continue;
                    vectors.Add(new[]
                    {
                        current[0].Value<double>() - previous[0].Value<double>(),
                        current[1].Value<double>() - previous[1].Value<double>(),
                        current[2].Value<double>() - previous[2].Value<double>()
                    });
                }
                if (closeLoop && points.Count >= 3)
                {
                    JArray last = points[points.Count - 1] as JArray;
                    JArray first = points[0] as JArray;
                    if (last != null && first != null && last.Count == 3 && first.Count == 3)
                    {
                        vectors.Add(new[]
                        {
                            first[0].Value<double>() - last[0].Value<double>(),
                            first[1].Value<double>() - last[1].Value<double>(),
                            first[2].Value<double>() - last[2].Value<double>()
                        });
                    }
                }
            }
            if (closeLoop) return CanonicalClosedPolylineInvariants(vectors);
            List<double> lengths = vectors.Select(vector => RoundMm(Math.Sqrt(vector[0] * vector[0] + vector[1] * vector[1] + vector[2] * vector[2]))).ToList();
            List<double> turnCosines = new List<double>();
            for (int index = 1; index < vectors.Count; index++)
            {
                double leftLength = lengths[index - 1];
                double rightLength = lengths[index];
                double cosine = leftLength > 1e-9 && rightLength > 1e-9
                    ? (vectors[index - 1][0] * vectors[index][0] + vectors[index - 1][1] * vectors[index][1] + vectors[index - 1][2] * vectors[index][2]) / (leftLength * rightLength)
                    : 1.0;
                turnCosines.Add(Math.Round(Math.Max(-1.0, Math.Min(1.0, cosine)), 12, MidpointRounding.AwayFromZero));
            }
            return new Dictionary<string, object>
            {
                { "segmentLengthsMm", lengths },
                { "turnCosines", turnCosines }
            };
        }

        private static Dictionary<string, object> CanonicalClosedPolylineInvariants(IList<double[]> vectors)
        {
            if (vectors == null || vectors.Count == 0)
            {
                return new Dictionary<string, object>
                {
                    { "segmentLengthsMm", new List<double>() },
                    { "turnCosines", new List<double>() }
                };
            }

            List<IList<double[]>> orientations = new List<IList<double[]>>
            {
                vectors.ToList(),
                vectors.Reverse().Select(vector => new[] { -vector[0], -vector[1], -vector[2] }).ToList()
            };
            string bestCanonical = null;
            Dictionary<string, object> best = null;
            foreach (IList<double[]> orientation in orientations)
            {
                List<double> lengths = orientation.Select(VectorLengthMm).ToList();
                List<double> turns = new List<double>();
                for (int index = 0; index < orientation.Count; index++)
                {
                    turns.Add(VectorTurnCosine(
                        orientation[index],
                        orientation[(index + 1) % orientation.Count],
                        lengths[index],
                        lengths[(index + 1) % orientation.Count]));
                }
                for (int offset = 0; offset < orientation.Count; offset++)
                {
                    List<double> rotatedLengths = Enumerable.Range(0, orientation.Count)
                        .Select(index => lengths[(index + offset) % orientation.Count])
                        .ToList();
                    List<double> rotatedTurns = Enumerable.Range(0, orientation.Count)
                        .Select(index => turns[(index + offset) % orientation.Count])
                        .ToList();
                    Dictionary<string, object> candidate = new Dictionary<string, object>
                    {
                        { "segmentLengthsMm", rotatedLengths },
                        { "turnCosines", rotatedTurns }
                    };
                    string canonical = CanonicalJson(candidate);
                    if (bestCanonical == null || string.CompareOrdinal(canonical, bestCanonical) < 0)
                    {
                        bestCanonical = canonical;
                        best = candidate;
                    }
                }
            }
            return best;
        }

        private static double VectorLengthMm(double[] vector)
        {
            return RoundMm(Math.Sqrt(vector[0] * vector[0] + vector[1] * vector[1] + vector[2] * vector[2]));
        }

        private static double VectorTurnCosine(double[] left, double[] right, double leftLength, double rightLength)
        {
            double cosine = leftLength > 1e-9 && rightLength > 1e-9
                ? (left[0] * right[0] + left[1] * right[1] + left[2] * right[2]) / (leftLength * rightLength)
                : 1.0;
            return Math.Round(Math.Max(-1.0, Math.Min(1.0, cosine)), 12, MidpointRounding.AwayFromZero);
        }

        private static Element ResolveSystemElement(Document document, Element element)
        {
            if (document == null || element == null) return null;
            try
            {
                PropertyInfo property = element.GetType().GetProperty("MEPSystem", BindingFlags.Instance | BindingFlags.Public);
                Element system = property != null ? property.GetValue(element, null) as Element : null;
                if (system != null) return system;
            }
            catch { }
            foreach (string parameterName in new[] { "RBS_DUCT_SYSTEM_TYPE_PARAM", "RBS_PIPING_SYSTEM_TYPE_PARAM" })
            {
                Parameter parameter = GetBuiltInParameter(element, parameterName);
                try
                {
                    ElementId id = parameter != null && parameter.StorageType == StorageType.ElementId ? parameter.AsElementId() : ElementId.InvalidElementId;
                    Element value = id != null && id != ElementId.InvalidElementId ? document.GetElement(id) : null;
                    if (value != null) return value;
                }
                catch { }
            }
            return null;
        }

        private static string ReadPropertyText(object value, string propertyName)
        {
            try
            {
                PropertyInfo property = value != null ? value.GetType().GetProperty(propertyName, BindingFlags.Instance | BindingFlags.Public) : null;
                object result = property != null ? property.GetValue(value, null) : null;
                return result != null ? Convert.ToString(result, CultureInfo.InvariantCulture) : null;
            }
            catch { return null; }
        }

        private static Parameter GetBuiltInParameter(Element element, string name)
        {
            if (element == null || string.IsNullOrWhiteSpace(name)) return null;
            try
            {
                BuiltInParameter parameterId;
                if (!Enum.TryParse(name, true, out parameterId)) return null;
                return element.get_Parameter(parameterId);
            }
            catch { return null; }
        }

        private static string ReadParameterText(Element element, IEnumerable<string> parameterNames)
        {
            foreach (string name in parameterNames ?? Enumerable.Empty<string>())
            {
                Parameter parameter = GetBuiltInParameter(element, name);
                if (parameter == null) continue;
                try
                {
                    string text = parameter.StorageType == StorageType.String ? parameter.AsString() : parameter.AsValueString();
                    if (!string.IsNullOrWhiteSpace(text)) return text.Trim();
                }
                catch { }
            }
            return null;
        }

        private static double? ReadLengthParameterMm(Element element, IEnumerable<string> parameterNames)
        {
            foreach (string name in parameterNames ?? Enumerable.Empty<string>())
            {
                Parameter parameter = GetBuiltInParameter(element, name);
                if (parameter == null) continue;
                try
                {
                    double value = parameter.AsDouble() * FeetToMillimetres;
                    if (!double.IsNaN(value) && !double.IsInfinity(value) && value > 0) return RoundMm(value);
                }
                catch { }
            }
            return null;
        }

        private static double? ReadNonNegativeLengthParameterMm(Element element, IEnumerable<string> parameterNames)
        {
            foreach (string name in parameterNames ?? Enumerable.Empty<string>())
            {
                Parameter parameter = GetBuiltInParameter(element, name);
                if (parameter == null || !parameter.HasValue) continue;
                try
                {
                    double value = parameter.AsDouble() * FeetToMillimetres;
                    if (!double.IsNaN(value) && !double.IsInfinity(value) && value >= 0) return RoundMm(value);
                }
                catch { }
            }
            return null;
        }

        internal static Dictionary<string, object> BuildTransformRecord(Transform transform, out double roundTripErrorMm, out bool valid)
        {
            roundTripErrorMm = double.PositiveInfinity;
            valid = false;
            Transform value = transform ?? Transform.Identity;
            try
            {
                Transform inverse = value.Inverse;
                XYZ[] samples = { XYZ.Zero, new XYZ(1.25, -2.5, 3.75), new XYZ(-4.0, 0.5, 7.0) };
                roundTripErrorMm = samples.Max(sample => inverse.OfPoint(value.OfPoint(sample)).DistanceTo(sample) * FeetToMillimetres);
                valid = !double.IsNaN(roundTripErrorMm) && !double.IsInfinity(roundTripErrorMm) && roundTripErrorMm <= 0.5;
            }
            catch
            {
            }

            Dictionary<string, object> record = new Dictionary<string, object>
            {
                { "representation", "affine_4x4_row_major" },
                { "fromFrame", "source_internal" },
                { "toFrame", CoordinateFrame },
                { "lengthUnit", "mm" },
                { "matrix", new[]
                    {
                        RoundMm(value.BasisX.X), RoundMm(value.BasisY.X), RoundMm(value.BasisZ.X), RoundMm(value.Origin.X * FeetToMillimetres),
                        RoundMm(value.BasisX.Y), RoundMm(value.BasisY.Y), RoundMm(value.BasisZ.Y), RoundMm(value.Origin.Y * FeetToMillimetres),
                        RoundMm(value.BasisX.Z), RoundMm(value.BasisY.Z), RoundMm(value.BasisZ.Z), RoundMm(value.Origin.Z * FeetToMillimetres),
                        0.0, 0.0, 0.0, 1.0
                    }
                }
            };
            return record;
        }

        internal static string BuildSortKey(string documentKey, string placementKey, string nodeKind, string stableSourceIdentity)
        {
            return (documentKey ?? "") + "\u001f" + (placementKey ?? "") + "\u001f" + (nodeKind ?? "") + "\u001f" + (stableSourceIdentity ?? "");
        }

        internal static string StableUniqueId(Element element)
        {
            try
            {
                string value = element.UniqueId;
                if (!string.IsNullOrWhiteSpace(value)) return value;
            }
            catch
            {
            }
            return "element-id:" + element.Id.GetIdValue().ToString(CultureInfo.InvariantCulture);
        }

        internal static string BuildNodeId(SpatialSource source, string elementUniqueId)
        {
            string placement = source.IsHost ? "host" : source.PlacementKey;
            return "node:" + Sha256("revit_element|" + source.Identity.DocumentKey + "|" + placement + "|" + elementUniqueId);
        }

        internal static Dictionary<string, object> BuildElementRef(SpatialSource source, Element element, string uniqueId)
        {
            Dictionary<string, object> result = new Dictionary<string, object>
            {
                { "documentKey", source.Identity.DocumentKey },
                { "documentSessionId", source.Identity.DocumentSessionId },
                { "elementUniqueId", uniqueId },
                { "elementId", element.Id.GetIdValue() },
                { "sourceKind", source.IsHost ? "host" : "link" }
            };
            if (!source.IsHost)
            {
                result["linkInstanceUniqueId"] = source.PlacementKey;
            }
            return result;
        }

        internal static string BuildDerivedNodeId(string derivedKind, string derivationRuleVersion, string scopeAnchor, IEnumerable<string> derivedFrom)
        {
            List<string> sources = (derivedFrom ?? Enumerable.Empty<string>())
                .Where(value => !string.IsNullOrWhiteSpace(value))
                .Distinct(StringComparer.Ordinal)
                .OrderBy(value => value, StringComparer.Ordinal)
                .ToList();
            string basis = (derivedKind ?? "") + "\u001f" + (derivationRuleVersion ?? "") + "\u001f" +
                (scopeAnchor ?? "") + "\u001f" + string.Join("\u001f", sources);
            return "derived:" + Sha256(basis);
        }

        internal static string BuildConnectorNodeId(string ownerNodeId, string connectorKey)
        {
            if (string.IsNullOrWhiteSpace(ownerNodeId)) throw new ArgumentException("Connector identity requires an owner node id.", "ownerNodeId");
            if (string.IsNullOrWhiteSpace(connectorKey)) throw new ArgumentException("Connector identity requires a connector key.", "connectorKey");
            return "connector:" + ownerNodeId + ":" + connectorKey;
        }

        internal static string BuildConnectorSignatureKey(string canonicalOwnerLocalSignature, int collisionOrdinal)
        {
            if (string.IsNullOrWhiteSpace(canonicalOwnerLocalSignature)) throw new ArgumentException("Connector signature cannot be empty.", "canonicalOwnerLocalSignature");
            if (collisionOrdinal < 0) throw new ArgumentOutOfRangeException("collisionOrdinal");
            return "signature:" + Sha256(canonicalOwnerLocalSignature) + ":" + collisionOrdinal.ToString(CultureInfo.InvariantCulture);
        }

        internal static Dictionary<string, object> BuildDerivedNodeRef(
            string derivedKind,
            string derivationRuleVersion,
            string scopeAnchor,
            IEnumerable<string> derivedFrom,
            IEnumerable<Dictionary<string, object>> sourceRefs)
        {
            List<string> sources = (derivedFrom ?? Enumerable.Empty<string>())
                .Where(value => !string.IsNullOrWhiteSpace(value))
                .Distinct(StringComparer.Ordinal)
                .OrderBy(value => value, StringComparer.Ordinal)
                .ToList();
            return new Dictionary<string, object>
            {
                { "nodeId", BuildDerivedNodeId(derivedKind, derivationRuleVersion, scopeAnchor, sources) },
                { "nodeKind", "derived" },
                { "derivedRef", new Dictionary<string, object>
                    {
                        { "derivedKind", derivedKind },
                        { "derivationRuleVersion", derivationRuleVersion },
                        { "scopeAnchor", scopeAnchor },
                        { "derivedFrom", sources }
                    }
                },
                { "sourceRefs", (sourceRefs ?? Enumerable.Empty<Dictionary<string, object>>()).Cast<object>().ToList() }
            };
        }

        internal static List<SpatialRow> BuildConnectorRows(
            SpatialSource source,
            Element owner,
            string ownerNodeId,
            DateTime deadlineUtc,
            List<string> warnings,
            out bool readFailed,
            out bool deadlineExceeded)
        {
            List<ConnectorDescriptor> descriptors = ReadConnectorDescriptors(owner, source, deadlineUtc, warnings, out readFailed, out deadlineExceeded);
            if (descriptors.Count == 0) return new List<SpatialRow>();
            if (DateTime.UtcNow >= deadlineUtc)
            {
                deadlineExceeded = true;
                return new List<SpatialRow>();
            }

            HashSet<ConnectorDescriptor> ambiguousDescriptors;
            Dictionary<ConnectorDescriptor, string> keys = BuildConnectorKeyMap(owner, descriptors, deadlineUtc, warnings, out ambiguousDescriptors, out deadlineExceeded);
            if (deadlineExceeded) return new List<SpatialRow>();

            Dictionary<string, object> sourceRef = new Dictionary<string, object>
            {
                { "documentKey", source.Identity.DocumentKey },
                { "documentSessionId", source.Identity.DocumentSessionId }
            };
            if (!source.IsHost) sourceRef["linkInstanceUniqueId"] = source.PlacementKey;
            List<SpatialRow> rows = new List<SpatialRow>();
            Dictionary<string, object> ownerSpatialProperties = BuildElementSpatialProperties(source.Document, owner);
            Dictionary<string, object> ownerProfile = BuildElementProfile(owner);
            Dictionary<string, ConnectorResolutionSet> peerResolutionCache = new Dictionary<string, ConnectorResolutionSet>(StringComparer.Ordinal);
            peerResolutionCache[ownerNodeId] = new ConnectorResolutionSet
            {
                Owner = owner,
                OwnerNodeId = ownerNodeId,
                Descriptors = descriptors,
                Keys = keys,
                AmbiguousDescriptors = ambiguousDescriptors
            };
            foreach (ConnectorDescriptor descriptor in descriptors.OrderBy(item => keys[item], StringComparer.Ordinal))
            {
                if (DateTime.UtcNow >= deadlineUtc)
                {
                    deadlineExceeded = true;
                    return new List<SpatialRow>();
                }
                string connectorKey = keys[descriptor];
                string nodeId = BuildConnectorNodeId(ownerNodeId, connectorKey);
                Dictionary<string, object> connectorRef = new Dictionary<string, object>
                {
                    { "ownerNodeId", ownerNodeId },
                    { "connectorKey", connectorKey },
                    { "providerVersion", "phase1a-connector-key/1.0" }
                };
                List<object> sourceRefs = new List<object> { new Dictionary<string, object>(sourceRef) };
                Dictionary<string, object> nodeRef = new Dictionary<string, object>
                {
                    { "nodeId", nodeId },
                    { "nodeKind", "connector" },
                    { "connectorRef", connectorRef },
                    { "sourceRefs", sourceRefs }
                };
                Dictionary<string, object> geometry = new Dictionary<string, object>
                {
                    { "coordinateFrame", CoordinateFrame },
                    { "lengthUnit", "mm" },
                    { "aabb", new Dictionary<string, object> { { "min", descriptor.HostPointMm }, { "max", descriptor.HostPointMm } } },
                    { "centerline", null },
                    { "pointLocation", new Dictionary<string, object> { { "point", descriptor.HostPointMm }, { "rotationRadians", null } } },
                    { "boundaryLoops", new List<object>() },
                    { "basis", "revit_connector_origin" },
                    { "precisionClass", "connector_origin" },
                    { "verdictCapability", "context_only" }
                };
                if (descriptor.HostDirectionMm != null) geometry["direction"] = descriptor.HostDirectionMm;
                geometry["geometryFingerprint"] = Sha256(CanonicalGeometryText(geometry));
                ConnectorTopologyEvidence topology = BuildConnectorTopologyEvidence(
                    source,
                    owner,
                    nodeId,
                    descriptor,
                    peerResolutionCache,
                    deadlineUtc,
                    warnings,
                    ambiguousDescriptors.Contains(descriptor),
                    out deadlineExceeded);
                if (deadlineExceeded) return new List<SpatialRow>();
                Dictionary<string, object> profile = BuildConnectorProfile(descriptor, ownerProfile);
                Dictionary<string, object> spatialProperties = BuildConnectorSpatialProperties(descriptor, ownerSpatialProperties);
                Dictionary<string, object> fingerprints = new Dictionary<string, object>
                {
                    { "version", FingerprintVersion },
                    { "placement", Sha256(CanonicalJson(new Dictionary<string, object>
                        {
                            { "originMm", descriptor.HostPointMm },
                            { "direction", descriptor.HostDirectionMm }
                        }))
                    },
                    { "shape", Sha256(CanonicalJson(new Dictionary<string, object>
                        {
                            { "profile", profile }
                        }))
                    },
                    { "property", Sha256(CanonicalJson(new Dictionary<string, object>
                        {
                            { "spatialProperties", spatialProperties },
                            { "domain", descriptor.Domain },
                            { "connectorType", descriptor.ConnectorType }
                        }))
                    },
                    { "topology", Sha256(CanonicalJson(new Dictionary<string, object>
                        {
                            { "isConnected", descriptor.IsConnected },
                            { "connectedToNodeIds", topology.ConnectedToNodeIds },
                            { "connectedOwnerNodeIds", topology.ConnectedOwnerNodeIds },
                            { "connectionRefs", topology.ConnectionRefs },
                            { "topologyCoverage", topology.Coverage }
                        }))
                    }
                };
                Dictionary<string, object> payload = new Dictionary<string, object>
                {
                    { "nodeId", nodeId },
                    { "nodeKind", "connector" },
                    { "nodeRef", nodeRef },
                    { "connectorRef", connectorRef },
                    { "sourceRefs", sourceRefs },
                    { "ownerNodeId", ownerNodeId },
                    { "connectorKey", connectorKey },
                    { "domain", descriptor.Domain },
                    { "connectorType", descriptor.ConnectorType },
                    { "shape", descriptor.Shape },
                    { "isConnected", descriptor.IsConnected },
                    { "spatialProperties", spatialProperties },
                    { "profile", profile },
                    { "connectedToNodeIds", topology.ConnectedToNodeIds },
                    { "connectedOwnerNodeIds", topology.ConnectedOwnerNodeIds },
                    { "connectionRefs", topology.ConnectionRefs },
                    { "topologyCoverage", topology.Coverage },
                    { "fingerprints", fingerprints },
                    { "geometry", geometry }
                };
                rows.Add(new SpatialRow
                {
                    SortKey = BuildSortKey(source.Identity.DocumentKey, source.PlacementKey, "connector", ownerNodeId + "|" + connectorKey),
                    DocumentKey = source.Identity.DocumentKey,
                    PlacementKey = source.PlacementKey,
                    NodeKind = "connector",
                    StableSourceIdentity = ownerNodeId + "|" + connectorKey,
                    ElementId = owner.Id.GetIdValue(),
                    IsNode = true,
                    Payload = payload,
                    PayloadFingerprint = Sha256(SerializePayload(payload))
                });
            }
            return rows;
        }

        private static Dictionary<ConnectorDescriptor, string> BuildConnectorKeyMap(
            Element owner,
            IList<ConnectorDescriptor> descriptors,
            DateTime deadlineUtc,
            IList<string> warnings,
            out HashSet<ConnectorDescriptor> ambiguousDescriptors,
            out bool deadlineExceeded)
        {
            deadlineExceeded = false;
            ambiguousDescriptors = new HashSet<ConnectorDescriptor>();
            List<ConnectorDescriptor> endConnectors = descriptors
                .Where(item => string.Equals(item.ConnectorType, "End", StringComparison.OrdinalIgnoreCase))
                .OrderBy(item => item.EndpointOrder)
                .ThenBy(item => item.Signature, StringComparer.Ordinal)
                .ToList();
            Dictionary<ConnectorDescriptor, string> keys = new Dictionary<ConnectorDescriptor, string>();
            if (owner is MEPCurve)
            {
                for (int index = 0; index < endConnectors.Count; index++)
                {
                    keys[endConnectors[index]] = "mepcurve-end:" + index.ToString(CultureInfo.InvariantCulture);
                }
            }

            HashSet<string> uniqueApiIds = new HashSet<string>(StringComparer.Ordinal);
            HashSet<string> duplicateApiIds = new HashSet<string>(StringComparer.Ordinal);
            foreach (ConnectorDescriptor descriptor in descriptors.Where(item => !string.IsNullOrWhiteSpace(item.ApiId)))
            {
                if (!uniqueApiIds.Add(descriptor.ApiId)) duplicateApiIds.Add(descriptor.ApiId);
            }

            foreach (IGrouping<string, ConnectorDescriptor> group in descriptors
                .Where(item => !keys.ContainsKey(item))
                .GroupBy(item => item.Signature, StringComparer.Ordinal)
                .OrderBy(item => item.Key, StringComparer.Ordinal))
            {
                if (DateTime.UtcNow >= deadlineUtc)
                {
                    deadlineExceeded = true;
                    return new Dictionary<ConnectorDescriptor, string>();
                }
                bool ambiguousGroup = group.Count() > 1 && group
                    .Select(item => (item.ApiId ?? "") + "|" + item.HostPointKey)
                    .Distinct(StringComparer.Ordinal)
                    .Count() < group.Count();
                if (ambiguousGroup)
                {
                    foreach (ConnectorDescriptor ambiguous in group) ambiguousDescriptors.Add(ambiguous);
                    if (warnings != null)
                    {
                        warnings.Add("Ambiguous connector signature collision on owner " + StableUniqueId(owner) + "; collision ordinals are session-deterministic and future remapping must be treated as remove/add.");
                    }
                }
                int collisionOrdinal = 0;
                foreach (ConnectorDescriptor descriptor in group
                    .OrderBy(item => item.HostPointKey, StringComparer.Ordinal)
                    .ThenBy(item => item.ApiId ?? "", StringComparer.Ordinal))
                {
                    if (!string.IsNullOrWhiteSpace(descriptor.ApiId) && !duplicateApiIds.Contains(descriptor.ApiId))
                    {
                        keys[descriptor] = "api-id:" + descriptor.ApiId;
                    }
                    else
                    {
                        keys[descriptor] = BuildConnectorSignatureKey(group.Key, collisionOrdinal);
                        collisionOrdinal++;
                    }
                }
            }
            return keys;
        }

        private static Dictionary<string, object> BuildConnectorProfile(
            ConnectorDescriptor descriptor,
            Dictionary<string, object> ownerProfile)
        {
            object insulation;
            return new Dictionary<string, object>
            {
                { "shape", NormalizeProfileShape(descriptor.Shape, descriptor.DiameterMm, descriptor.WidthMm, descriptor.HeightMm) },
                { "diameterMm", descriptor.DiameterMm },
                { "widthMm", descriptor.WidthMm },
                { "heightMm", descriptor.HeightMm },
                { "insulationThicknessMm", ownerProfile != null && ownerProfile.TryGetValue("insulationThicknessMm", out insulation) ? insulation : null }
            };
        }

        private static Dictionary<string, object> BuildConnectorSpatialProperties(
            ConnectorDescriptor descriptor,
            Dictionary<string, object> ownerSpatialProperties)
        {
            object ownerSystemKey;
            object ownerSystemName;
            object ownerClassification;
            return new Dictionary<string, object>
            {
                { "systemKey", !string.IsNullOrWhiteSpace(descriptor.SystemKey)
                    ? descriptor.SystemKey
                    : ownerSpatialProperties != null && ownerSpatialProperties.TryGetValue("systemKey", out ownerSystemKey) ? ownerSystemKey : null },
                { "systemName", !string.IsNullOrWhiteSpace(descriptor.SystemName)
                    ? descriptor.SystemName
                    : ownerSpatialProperties != null && ownerSpatialProperties.TryGetValue("systemName", out ownerSystemName) ? ownerSystemName : null },
                { "systemClassification", !string.IsNullOrWhiteSpace(descriptor.SystemClassification)
                    ? descriptor.SystemClassification
                    : ownerSpatialProperties != null && ownerSpatialProperties.TryGetValue("systemClassification", out ownerClassification) ? ownerClassification : null }
            };
        }

        private static ConnectorTopologyEvidence BuildConnectorTopologyEvidence(
            SpatialSource source,
            Element owner,
            string currentNodeId,
            ConnectorDescriptor descriptor,
            Dictionary<string, ConnectorResolutionSet> resolutionCache,
            DateTime deadlineUtc,
            IList<string> warnings,
            bool currentConnectorIdentityAmbiguous,
            out bool deadlineExceeded)
        {
            deadlineExceeded = false;
            ConnectorTopologyEvidence result = new ConnectorTopologyEvidence();
            List<string> reasons = new List<string>();
            if (currentConnectorIdentityAmbiguous) reasons.Add("connector_identity_ambiguous");
            if (!descriptor.IsConnectedRead) reasons.Add("is_connected_read_failed");

            ConnectorSet references = null;
            try
            {
                references = descriptor.Connector != null ? descriptor.Connector.AllRefs : null;
                result.AllRefsRead = references != null;
                if (references == null) reasons.Add("all_refs_unavailable");
            }
            catch (Exception ex)
            {
                reasons.Add("all_refs_read_failed");
                if (warnings != null) warnings.Add("Connector.AllRefs read failed on owner " + StableUniqueId(owner) + ": " + ex.GetType().Name + ".");
            }

            try
            {
                if (references != null)
                {
                    foreach (Connector peer in references)
                    {
                    if (DateTime.UtcNow >= deadlineUtc)
                    {
                        deadlineExceeded = true;
                        return result;
                    }
                    result.ReferencedConnectorCount++;
                    if (peer == null)
                    {
                        reasons.Add("peer_connector_unavailable");
                        result.UnresolvedConnectorCount++;
                        continue;
                    }
                    Element peerOwner = null;
                    try { peerOwner = peer.Owner; }
                    catch { }
                    if (peerOwner == null)
                    {
                        reasons.Add("peer_owner_unavailable");
                        result.UnresolvedConnectorCount++;
                        continue;
                    }
                    string peerConnectorType = SafeConnectorText(delegate { return peer.ConnectorType.ToString(); });
                    if (string.Equals(peerConnectorType, "Reference", StringComparison.OrdinalIgnoreCase) ||
                        (string.Equals(peerConnectorType, "Logical", StringComparison.OrdinalIgnoreCase) && peerOwner is MEPSystem))
                    {
                        // Connector.AllRefs also exposes insulation/reference
                        // bindings and the owning MEPSystem container. Those
                        // are not element-to-element topology edges: system
                        // membership is already captured in spatialProperties.
                        result.ReferencedConnectorCount--;
                        continue;
                    }
                    string peerUniqueId = StableUniqueId(peerOwner);
                    if (peerUniqueId.StartsWith("element-id:", StringComparison.Ordinal))
                    {
                        reasons.Add("peer_stable_identity_unavailable");
                        result.UnresolvedConnectorCount++;
                        continue;
                    }
                    string peerOwnerNodeId = BuildNodeId(source, peerUniqueId);
                    string peerConnectorNodeId;
                    string unresolvedReason;
                    bool resolved = TryResolvePeerConnectorNodeId(
                        source,
                        peerOwner,
                        peerOwnerNodeId,
                        peer,
                        resolutionCache,
                        deadlineUtc,
                        warnings,
                        out peerConnectorNodeId,
                        out unresolvedReason,
                        out deadlineExceeded);
                    if (deadlineExceeded) return result;
                    if (resolved && string.Equals(peerConnectorNodeId, currentNodeId, StringComparison.Ordinal))
                    {
                        result.ReferencedConnectorCount--;
                        continue;
                    }

                    string relationKind = ResolveConnectionKind(descriptor.ConnectorType, peerConnectorType);
                    Dictionary<string, object> connectionRef = new Dictionary<string, object>
                    {
                        { "targetOwnerNodeId", peerOwnerNodeId },
                        { "targetConnectorNodeId", resolved ? peerConnectorNodeId : null },
                        { "relationKind", relationKind },
                        { "basis", "revit_connector_all_refs" },
                        { "resolved", resolved }
                    };
                    string identity = peerOwnerNodeId + "|" + (resolved ? peerConnectorNodeId : "unresolved:" + (unresolvedReason ?? "unknown")) + "|" + relationKind;
                    if (!result.ConnectionIdentityKeys.Add(identity)) continue;
                    result.ConnectionRefs.Add(connectionRef);
                    result.ConnectedOwnerNodeIds.Add(peerOwnerNodeId);
                    if (resolved)
                    {
                        result.ConnectedToNodeIds.Add(peerConnectorNodeId);
                    }
                    else
                    {
                        result.UnresolvedConnectorCount++;
                        reasons.Add(unresolvedReason ?? "peer_connector_identity_unresolved");
                    }
                    }
                }
            }
            catch (Exception ex)
            {
                result.AllRefsRead = false;
                reasons.Add("all_refs_enumeration_failed");
                if (warnings != null) warnings.Add("Connector.AllRefs enumeration failed on owner " + StableUniqueId(owner) + ": " + ex.GetType().Name + ".");
            }

            result.ConnectedToNodeIds = result.ConnectedToNodeIds.Distinct(StringComparer.Ordinal).OrderBy(value => value, StringComparer.Ordinal).ToList();
            result.ConnectedOwnerNodeIds = result.ConnectedOwnerNodeIds.Distinct(StringComparer.Ordinal).OrderBy(value => value, StringComparer.Ordinal).ToList();
            result.ConnectionRefs = result.ConnectionRefs
                .OrderBy(value => Convert.ToString(value["targetOwnerNodeId"], CultureInfo.InvariantCulture), StringComparer.Ordinal)
                .ThenBy(value => Convert.ToString(value["targetConnectorNodeId"], CultureInfo.InvariantCulture), StringComparer.Ordinal)
                .ThenBy(value => Convert.ToString(value["relationKind"], CultureInfo.InvariantCulture), StringComparer.Ordinal)
                .ToList();
            if (descriptor.IsConnected && result.ConnectionRefs.Count == 0)
            {
                reasons.Add("connected_without_all_refs");
            }
            List<string> distinctReasons = reasons.Distinct(StringComparer.Ordinal).OrderBy(value => value, StringComparer.Ordinal).ToList();
            bool complete = !currentConnectorIdentityAmbiguous && descriptor.IsConnectedRead && result.AllRefsRead && result.UnresolvedConnectorCount == 0 &&
                (!descriptor.IsConnected || result.ConnectionRefs.Count > 0);
            result.Coverage = new Dictionary<string, object>
            {
                { "basis", "revit_connector_all_refs" },
                { "complete", complete },
                { "targetMembershipValidated", false },
                { "isConnectedRead", descriptor.IsConnectedRead },
                { "allRefsRead", result.AllRefsRead },
                { "referencedConnectorCount", result.ReferencedConnectorCount },
                { "resolvedConnectorNodeCount", result.ConnectedToNodeIds.Count },
                { "unresolvedConnectorCount", result.UnresolvedConnectorCount },
                { "reasons", distinctReasons }
            };
            return result;
        }

        private static bool TryResolvePeerConnectorNodeId(
            SpatialSource source,
            Element peerOwner,
            string peerOwnerNodeId,
            Connector peer,
            Dictionary<string, ConnectorResolutionSet> resolutionCache,
            DateTime deadlineUtc,
            IList<string> warnings,
            out string peerConnectorNodeId,
            out string unresolvedReason,
            out bool deadlineExceeded)
        {
            peerConnectorNodeId = null;
            unresolvedReason = null;
            deadlineExceeded = false;
            ConnectorResolutionSet set;
            if (!resolutionCache.TryGetValue(peerOwnerNodeId, out set))
            {
                bool readFailed;
                List<ConnectorDescriptor> peerDescriptors = ReadConnectorDescriptors(peerOwner, source, deadlineUtc, warnings, out readFailed, out deadlineExceeded);
                if (deadlineExceeded) return false;
                if (readFailed)
                {
                    unresolvedReason = "peer_connector_read_failed";
                    return false;
                }
                HashSet<ConnectorDescriptor> peerAmbiguousDescriptors;
                Dictionary<ConnectorDescriptor, string> peerKeys = BuildConnectorKeyMap(peerOwner, peerDescriptors, deadlineUtc, warnings, out peerAmbiguousDescriptors, out deadlineExceeded);
                if (deadlineExceeded) return false;
                set = new ConnectorResolutionSet
                {
                    Owner = peerOwner,
                    OwnerNodeId = peerOwnerNodeId,
                    Descriptors = peerDescriptors,
                    Keys = peerKeys,
                    AmbiguousDescriptors = peerAmbiguousDescriptors
                };
                resolutionCache[peerOwnerNodeId] = set;
            }

            ConnectorDescriptor match = set.Descriptors.FirstOrDefault(value => object.ReferenceEquals(value.Connector, peer));
            string apiId = TryGetConnectorApiId(peer);
            if (match == null && !string.IsNullOrWhiteSpace(apiId))
            {
                List<ConnectorDescriptor> apiMatches = set.Descriptors.Where(value => string.Equals(value.ApiId, apiId, StringComparison.Ordinal)).ToList();
                if (apiMatches.Count == 1) match = apiMatches[0];
            }
            if (match == null)
            {
                XYZ localPoint = null;
                string signature = null;
                string hostPointKey = null;
                try
                {
                    XYZ sourcePoint = peer.Origin;
                    localPoint = ToOwnerLocalPoint(peerOwner, sourcePoint);
                    signature = BuildConnectorSignature(peerOwner, peer, localPoint);
                    hostPointKey = string.Join(",", MillimetrePoint(source.SourceToHost.OfPoint(sourcePoint)).Select(value => value.ToString("R", CultureInfo.InvariantCulture)));
                }
                catch { }
                List<ConnectorDescriptor> signatureMatches = set.Descriptors
                    .Where(value => string.Equals(value.Signature, signature, StringComparison.Ordinal) && string.Equals(value.HostPointKey, hostPointKey, StringComparison.Ordinal))
                    .ToList();
                if (signatureMatches.Count == 1) match = signatureMatches[0];
            }
            string key;
            if (match == null || !set.Keys.TryGetValue(match, out key))
            {
                unresolvedReason = "peer_connector_identity_unresolved";
                return false;
            }
            if (set.AmbiguousDescriptors != null && set.AmbiguousDescriptors.Contains(match))
            {
                unresolvedReason = "peer_connector_identity_ambiguous";
                return false;
            }
            peerConnectorNodeId = BuildConnectorNodeId(peerOwnerNodeId, key);
            return true;
        }

        private static string ResolveConnectionKind(string leftConnectorType, string rightConnectorType)
        {
            if (string.Equals(leftConnectorType, "Logical", StringComparison.OrdinalIgnoreCase) ||
                string.Equals(rightConnectorType, "Logical", StringComparison.OrdinalIgnoreCase)) return "logical";
            if (string.Equals(leftConnectorType, "unknown", StringComparison.OrdinalIgnoreCase) ||
                string.Equals(rightConnectorType, "unknown", StringComparison.OrdinalIgnoreCase)) return "unknown";
            return "physical";
        }

        private static string NormalizeProfileShape(string rawShape, double? diameterMm, double? widthMm, double? heightMm)
        {
            if (!string.IsNullOrWhiteSpace(rawShape))
            {
                if (rawShape.IndexOf("round", StringComparison.OrdinalIgnoreCase) >= 0) return "round";
                if (rawShape.IndexOf("rect", StringComparison.OrdinalIgnoreCase) >= 0) return "rectangular";
                if (rawShape.IndexOf("oval", StringComparison.OrdinalIgnoreCase) >= 0) return "oval";
            }
            if (diameterMm.HasValue && diameterMm.Value > 0) return "round";
            if (widthMm.HasValue && widthMm.Value > 0 && heightMm.HasValue && heightMm.Value > 0) return "rectangular";
            return "unknown";
        }

        private static List<ConnectorDescriptor> ReadConnectorDescriptors(
            Element owner,
            SpatialSource source,
            DateTime deadlineUtc,
            IList<string> warnings,
            out bool readFailed,
            out bool deadlineExceeded)
        {
            readFailed = false;
            deadlineExceeded = false;
            ConnectorManager manager = null;
            try
            {
                MEPCurve curve = owner as MEPCurve;
                if (curve != null) manager = curve.ConnectorManager;
                FamilyInstance instance = owner as FamilyInstance;
                if (manager == null && instance != null && instance.MEPModel != null) manager = instance.MEPModel.ConnectorManager;
            }
            catch (Exception ex)
            {
                if (warnings != null) warnings.Add("Connector manager read failed for " + StableUniqueId(owner) + ": " + ex.GetType().Name + ".");
                readFailed = true;
                return new List<ConnectorDescriptor>();
            }
            if (manager == null) return new List<ConnectorDescriptor>();

            List<ConnectorDescriptor> result = new List<ConnectorDescriptor>();
            XYZ firstEndpoint = null;
            try
            {
                LocationCurve location = owner.Location as LocationCurve;
                if (location != null && location.Curve != null) firstEndpoint = location.Curve.GetEndPoint(0);
            }
            catch { }
            try
            {
                foreach (Connector connector in manager.Connectors)
                {
                    if (DateTime.UtcNow >= deadlineUtc)
                    {
                        deadlineExceeded = true;
                        return new List<ConnectorDescriptor>();
                    }
                    XYZ sourcePoint = connector.Origin;
                    XYZ hostPoint = source.SourceToHost.OfPoint(sourcePoint);
                    XYZ hostDirection = null;
                    try
                    {
                        Transform coordinateSystem = connector.CoordinateSystem;
                        if (coordinateSystem != null && coordinateSystem.BasisZ != null)
                        {
                            hostDirection = source.SourceToHost.OfVector(coordinateSystem.BasisZ);
                        }
                    }
                    catch { }
                    XYZ localPoint = ToOwnerLocalPoint(owner, sourcePoint);
                    string signature = BuildConnectorSignature(owner, connector, localPoint);
                    bool isConnected;
                    bool isConnectedRead = TryReadConnectorBool(connector, "IsConnected", out isConnected);
                    double? diameterMm = TryReadConnectorLengthMm(connector, "Radius", 2.0);
                    double? widthMm = TryReadConnectorLengthMm(connector, "Width", 1.0);
                    double? heightMm = TryReadConnectorLengthMm(connector, "Height", 1.0);
                    Element connectorSystem = ResolveConnectorSystemElement(connector);
                    result.Add(new ConnectorDescriptor
                    {
                        Connector = connector,
                        ApiId = TryGetConnectorApiId(connector),
                        Signature = signature,
                        HostPointMm = MillimetrePoint(hostPoint),
                        HostPointKey = string.Join(",", MillimetrePoint(hostPoint).Select(value => value.ToString("R", CultureInfo.InvariantCulture))),
                        HostDirectionMm = hostDirection != null ? MillimetreVector(hostDirection) : null,
                        EndpointOrder = firstEndpoint != null ? sourcePoint.DistanceTo(firstEndpoint) : double.MaxValue,
                        Domain = SafeConnectorText(delegate { return connector.Domain.ToString(); }),
                        ConnectorType = SafeConnectorText(delegate { return connector.ConnectorType.ToString(); }),
                        Shape = SafeConnectorText(delegate { return connector.Shape.ToString(); }),
                        IsConnected = isConnected,
                        IsConnectedRead = isConnectedRead,
                        DiameterMm = diameterMm,
                        WidthMm = widthMm,
                        HeightMm = heightMm,
                        SystemKey = connectorSystem != null ? "system:" + StableUniqueId(connectorSystem) : null,
                        SystemName = connectorSystem != null ? GetElementName(connectorSystem) : null,
                        SystemClassification = connectorSystem != null ? ReadPropertyText(connectorSystem, "SystemClassification") : null
                    });
                }
            }
            catch (Exception ex)
            {
                if (warnings != null) warnings.Add("Connector enumeration failed for " + StableUniqueId(owner) + ": " + ex.GetType().Name + ".");
                readFailed = true;
                return new List<ConnectorDescriptor>();
            }
            return result;
        }

        private static XYZ ToOwnerLocalPoint(Element owner, XYZ sourcePoint)
        {
            try
            {
                FamilyInstance instance = owner as FamilyInstance;
                if (instance != null) return instance.GetTransform().Inverse.OfPoint(sourcePoint);
                LocationPoint point = owner.Location as LocationPoint;
                if (point != null && point.Point != null) return sourcePoint - point.Point;
            }
            catch { }
            return sourcePoint;
        }

        private static string BuildConnectorSignature(Element owner, Connector connector, XYZ localPoint)
        {
            List<string> parts = new List<string>
            {
                "domain=" + SafeConnectorText(delegate { return connector.Domain.ToString(); }),
                "type=" + SafeConnectorText(delegate { return connector.ConnectorType.ToString(); }),
                "shape=" + SafeConnectorText(delegate { return connector.Shape.ToString(); }),
                "point=" + string.Join(",", MillimetrePoint(localPoint).Select(value => value.ToString("R", CultureInfo.InvariantCulture)))
            };
            try
            {
                Transform coordinateSystem = connector.CoordinateSystem;
                if (coordinateSystem != null && coordinateSystem.BasisZ != null)
                {
                    XYZ localDirection = ToOwnerLocalVector(owner, coordinateSystem.BasisZ);
                    parts.Add("direction=" + string.Join(",", MillimetreVector(localDirection).Select(value => value.ToString("R", CultureInfo.InvariantCulture))));
                }
            }
            catch { }
            return string.Join("|", parts);
        }

        private static XYZ ToOwnerLocalVector(Element owner, XYZ sourceVector)
        {
            try
            {
                FamilyInstance instance = owner as FamilyInstance;
                if (instance != null) return instance.GetTransform().Inverse.OfVector(sourceVector);
            }
            catch { }
            return sourceVector;
        }

        private static string TryGetConnectorApiId(Connector connector)
        {
            try
            {
                PropertyInfo property = connector.GetType().GetProperty("Id", BindingFlags.Instance | BindingFlags.Public);
                object value = property != null ? property.GetValue(connector, null) : null;
                return value != null ? Convert.ToString(value, CultureInfo.InvariantCulture) : null;
            }
            catch { return null; }
        }

        private static IList<double> MillimetreVector(XYZ vector)
        {
            if (vector == null) return null;
            double length = vector.GetLength();
            XYZ normalized = length > 1e-12 ? vector / length : vector;
            return new[] { RoundMm(normalized.X), RoundMm(normalized.Y), RoundMm(normalized.Z) };
        }

        private static string SafeConnectorText(Func<string> reader)
        {
            try { return reader() ?? "unknown"; }
            catch { return "unknown"; }
        }

        private static bool SafeConnectorBool(Func<bool> reader)
        {
            try { return reader(); }
            catch { return false; }
        }

        private static bool TryReadConnectorBool(Connector connector, string propertyName, out bool value)
        {
            value = false;
            try
            {
                PropertyInfo property = connector != null ? connector.GetType().GetProperty(propertyName, BindingFlags.Instance | BindingFlags.Public) : null;
                object raw = property != null ? property.GetValue(connector, null) : null;
                if (!(raw is bool)) return false;
                value = (bool)raw;
                return true;
            }
            catch { return false; }
        }

        private static double? TryReadConnectorLengthMm(Connector connector, string propertyName, double multiplier)
        {
            try
            {
                PropertyInfo property = connector != null ? connector.GetType().GetProperty(propertyName, BindingFlags.Instance | BindingFlags.Public) : null;
                object raw = property != null ? property.GetValue(connector, null) : null;
                if (raw == null) return null;
                double value = Convert.ToDouble(raw, CultureInfo.InvariantCulture) * multiplier * FeetToMillimetres;
                return !double.IsNaN(value) && !double.IsInfinity(value) && value > 0 ? (double?)RoundMm(value) : null;
            }
            catch { return null; }
        }

        private static Element ResolveConnectorSystemElement(Connector connector)
        {
            try
            {
                PropertyInfo property = connector != null ? connector.GetType().GetProperty("MEPSystem", BindingFlags.Instance | BindingFlags.Public) : null;
                return property != null ? property.GetValue(connector, null) as Element : null;
            }
            catch { return null; }
        }

        private sealed class ConnectorDescriptor
        {
            public Connector Connector;
            public string ApiId;
            public string Signature;
            public IList<double> HostPointMm;
            public string HostPointKey;
            public IList<double> HostDirectionMm;
            public double EndpointOrder;
            public string Domain;
            public string ConnectorType;
            public string Shape;
            public bool IsConnected;
            public bool IsConnectedRead;
            public double? DiameterMm;
            public double? WidthMm;
            public double? HeightMm;
            public string SystemKey;
            public string SystemName;
            public string SystemClassification;
        }

        private sealed class ConnectorResolutionSet
        {
            public Element Owner;
            public string OwnerNodeId;
            public IList<ConnectorDescriptor> Descriptors;
            public Dictionary<ConnectorDescriptor, string> Keys;
            public HashSet<ConnectorDescriptor> AmbiguousDescriptors;
        }

        private sealed class ConnectorTopologyEvidence
        {
            public bool AllRefsRead;
            public int ReferencedConnectorCount;
            public int UnresolvedConnectorCount;
            public List<string> ConnectedToNodeIds = new List<string>();
            public List<string> ConnectedOwnerNodeIds = new List<string>();
            public List<Dictionary<string, object>> ConnectionRefs = new List<Dictionary<string, object>>();
            public HashSet<string> ConnectionIdentityKeys = new HashSet<string>(StringComparer.Ordinal);
            public Dictionary<string, object> Coverage = new Dictionary<string, object>
            {
                { "basis", "revit_connector_all_refs" },
                { "complete", false },
                { "targetMembershipValidated", false },
                { "isConnectedRead", false },
                { "allRefsRead", false },
                { "referencedConnectorCount", 0 },
                { "resolvedConnectorNodeCount", 0 },
                { "unresolvedConnectorCount", 0 },
                { "reasons", new List<string> { "topology_not_evaluated" } }
            };
        }

        internal static string GetElementName(Element element)
        {
            try { return element.Name ?? ""; }
            catch { return ""; }
        }

        internal static string GetFamilyName(Document document, Element element)
        {
            try
            {
                FamilyInstance instance = element as FamilyInstance;
                if (instance != null && instance.Symbol != null && instance.Symbol.Family != null) return instance.Symbol.Family.Name;
                ElementType type = document.GetElement(element.GetTypeId()) as ElementType;
                if (type != null)
                {
                    FamilySymbol symbol = type as FamilySymbol;
                    if (symbol != null && symbol.Family != null) return symbol.Family.Name;
                    Parameter family = type.get_Parameter(BuiltInParameter.SYMBOL_FAMILY_NAME_PARAM);
                    if (family != null) return family.AsString() ?? "";
                }
            }
            catch
            {
            }
            return "";
        }

        internal static string GetTypeName(Document document, Element element)
        {
            try
            {
                ElementType type = document.GetElement(element.GetTypeId()) as ElementType;
                return type != null ? type.Name : "";
            }
            catch { return ""; }
        }

        internal static string GetCategoryName(Element element)
        {
            try { return element.Category != null ? element.Category.Name : "<none>"; }
            catch { return "<none>"; }
        }

        internal static BuiltInCategory GetBuiltInCategory(Element element)
        {
            try { return (BuiltInCategory)element.Category.Id.GetIdValue(); }
            catch { return (BuiltInCategory)0; }
        }

        internal static Dictionary<string, object> BuildScope(SpatialSnapshotRequest request, IList<LevelBand> bands, Document hostDocument, DocumentIdentity hostIdentity)
        {
            List<string> categories = new List<string>();
            if (request.IncludeHostMep) categories.AddRange(HostMepCategories.Select(category => category.ToString()));
            if (request.IncludeRoomsSpaces) categories.AddRange(SpatialCategories.Select(category => category.ToString()));
            if (request.IncludeLinkedObstructions) categories.AddRange(LinkedObstructionCategories.Select(category => category.ToString()));
            categories = categories.Distinct(StringComparer.Ordinal).OrderBy(value => value, StringComparer.Ordinal).ToList();
            if (categories.Count == 0) categories.Add("phase0_no_categories_selected");
            string activePhase = "phase_context_unresolved_phase0";
            try
            {
                Autodesk.Revit.DB.View activeView = hostDocument != null ? hostDocument.ActiveView : null;
                Parameter phaseParameter = activeView != null ? activeView.get_Parameter(BuiltInParameter.VIEW_PHASE) : null;
                ElementId phaseId = phaseParameter != null ? phaseParameter.AsElementId() : ElementId.InvalidElementId;
                Phase phase = phaseId != null && phaseId != ElementId.InvalidElementId ? hostDocument.GetElement(phaseId) as Phase : null;
                if (phase != null && !string.IsNullOrWhiteSpace(phase.Name)) activePhase = phase.Name;
            }
            catch
            {
            }
            return new Dictionary<string, object>
            {
                { "hostDocumentKey", hostIdentity.DocumentKey },
                { "requestedLevelUniqueIds", bands.Select(band => !string.IsNullOrWhiteSpace(band.UniqueId) ? band.UniqueId : "level-id:" + band.Id.ToString(CultureInfo.InvariantCulture)).Distinct(StringComparer.Ordinal).ToList() },
                { "effectiveVerticalBands", bands.OrderBy(band => band.ElevationFeet).ThenBy(band => band.Id).Select(band => new Dictionary<string, object>
                    {
                        { "levelId", band.Id },
                        { "levelUniqueId", !string.IsNullOrWhiteSpace(band.UniqueId) ? band.UniqueId : "level-id:" + band.Id.ToString(CultureInfo.InvariantCulture) },
                        { "levelName", band.Name },
                        { "elevationMm", RoundMm(band.ElevationFeet * FeetToMillimetres) },
                        { "minHostZMm", RoundMm(band.MinHostZFeet * FeetToMillimetres) },
                        { "maxHostZMm", RoundMm(band.MaxHostZFeet * FeetToMillimetres) }
                    }).ToList()
                },
                { "levelScopeSemantics", "host_vertical_band" },
                { "verticalBandIsExactLevelMembership", false },
                { "linkedSourceLevelFilterMode", request.LinkedSourceLevels.Count > 0 || request.LinkedSourceLevelNames.Count > 0 ? "exact" : "none" },
                { "linkedSourceLevelFilterAppliesTo", new List<string> { "linked_room_space" } },
                { "requestedLinkedSourceLevels", BuildLinkedSourceLevelSelectorRecords(request.LinkedSourceLevels) },
                { "requestedLinkedSourceLevelNames", request.LinkedSourceLevelNames.OrderBy(value => value, StringComparer.OrdinalIgnoreCase).ToList() },
                { "categories", categories },
                { "linkInclusionPolicy", string.Equals(request.SourceScope, "hostOnly", StringComparison.OrdinalIgnoreCase) ? "host_only" : "loaded_links" },
                { "sourceDocumentPolicy", string.Equals(request.SourceScope, "hostOnly", StringComparison.OrdinalIgnoreCase)
                    ? "host_only"
                    : string.Equals(request.SourceScope, "linkedOnly", StringComparison.OrdinalIgnoreCase)
                        ? "linked_only"
                        : "host_and_loaded_links" },
                { "activePhase", activePhase },
                { "phaseSelectionPolicy", "collector_unfiltered_phase0" },
                { "designOptionsInEffect", new List<string> { "collector_default_phase0" } },
                { "worksetVisibilityPolicy", "collector_unfiltered_phase0" },
                { "categoryRuleSetSelection", new List<string> { "phase0-spatial-extraction" } },
                { "coordinateFrame", CoordinateFrame }
            };
        }

        internal static string BuildScopeFingerprint(SpatialSnapshotRequest request, IList<LevelBand> bands, Dictionary<string, object> scope)
        {
            Dictionary<string, object> fingerprintBasis = new Dictionary<string, object>
            {
                { "schemaMajor", 0 },
                { "hostDocumentKey", scope != null && scope.ContainsKey("hostDocumentKey") ? scope["hostDocumentKey"] : null },
                { "requestedLevelUniqueIds", bands.Select(band => !string.IsNullOrWhiteSpace(band.UniqueId) ? band.UniqueId : "level-id:" + band.Id.ToString(CultureInfo.InvariantCulture)).Distinct(StringComparer.Ordinal).OrderBy(value => value, StringComparer.Ordinal).ToList() },
                { "levelScopeSemantics", "host_vertical_band" },
                { "sourceScope", request.SourceScope },
                { "requestedLinkInstanceIds", request.LinkInstanceIds.OrderBy(value => value).ToList() },
                { "requestedLinkInstanceUniqueIds", request.LinkInstanceUniqueIds.OrderBy(value => value, StringComparer.Ordinal).ToList() },
                { "requestedLinkedSourceLevels", BuildLinkedSourceLevelSelectorRecords(request.LinkedSourceLevels) },
                { "requestedLinkedSourceLevelNames", request.LinkedSourceLevelNames.OrderBy(value => value, StringComparer.OrdinalIgnoreCase).ToList() },
                { "includeHostMep", request.IncludeHostMep },
                { "includeRoomsSpaces", request.IncludeRoomsSpaces },
                { "includeLinkedObstructions", request.IncludeLinkedObstructions },
                { "belowLevelMm", request.BelowLevelMm },
                { "aboveLevelMm", request.AboveLevelMm },
                { "activePhase", scope != null && scope.ContainsKey("activePhase") ? scope["activePhase"] : null },
                { "phaseSelectionPolicy", scope != null && scope.ContainsKey("phaseSelectionPolicy") ? scope["phaseSelectionPolicy"] : null },
                { "designOptionsInEffect", scope != null && scope.ContainsKey("designOptionsInEffect") ? scope["designOptionsInEffect"] : null },
                { "worksetVisibilityPolicy", scope != null && scope.ContainsKey("worksetVisibilityPolicy") ? scope["worksetVisibilityPolicy"] : null },
                { "categoryRuleSetSelection", scope != null && scope.ContainsKey("categoryRuleSetSelection") ? scope["categoryRuleSetSelection"] : null },
                { "coordinateFrame", CoordinateFrame }
            };
            return Sha256(CanonicalJson(fingerprintBasis));
        }

        internal static List<Dictionary<string, object>> BuildLinkedSourceLevelSelectorRecords(IEnumerable<LinkedSourceLevelSelector> selectors)
        {
            return (selectors ?? Enumerable.Empty<LinkedSourceLevelSelector>())
                .OrderBy(value => value.LinkInstanceUniqueId, StringComparer.Ordinal)
                .ThenBy(value => value.LevelId ?? int.MaxValue)
                .ThenBy(value => value.LevelUniqueId, StringComparer.Ordinal)
                .ThenBy(value => value.LevelName, StringComparer.OrdinalIgnoreCase)
                .Select(value => new Dictionary<string, object>
                {
                    { "linkInstanceUniqueId", value.LinkInstanceUniqueId },
                    { "levelId", value.LevelId },
                    { "levelUniqueId", string.IsNullOrWhiteSpace(value.LevelUniqueId) ? null : value.LevelUniqueId },
                    { "levelName", string.IsNullOrWhiteSpace(value.LevelName) ? null : value.LevelName }
                }).ToList();
        }

        internal static string SerializePayload(Dictionary<string, object> payload)
        {
            return CanonicalJson(payload);
        }

        internal static string CanonicalJson(object value)
        {
            JToken token = value as JToken ?? JToken.FromObject(value ?? JValue.CreateNull(), JsonSerializer.Create(new JsonSerializerSettings
            {
                Culture = CultureInfo.InvariantCulture,
                NullValueHandling = NullValueHandling.Include
            }));
            return CanonicalToken(token);
        }

        internal static string SemanticCanonicalJson(object value)
        {
            JToken token = value as JToken ?? JToken.FromObject(value ?? JValue.CreateNull(), JsonSerializer.Create(new JsonSerializerSettings
            {
                Culture = CultureInfo.InvariantCulture,
                NullValueHandling = NullValueHandling.Include
            }));
            return SemanticCanonicalToken(token);
        }

        private static string SemanticCanonicalToken(JToken token)
        {
            if (token == null || token.Type == JTokenType.Null || token.Type == JTokenType.Undefined) return "null";
            JObject objectValue = token as JObject;
            if (objectValue != null)
            {
                return "{" + string.Join(",", objectValue.Properties()
                    .OrderBy(property => property.Name, StringComparer.Ordinal)
                    .Select(property => JsonConvert.SerializeObject(property.Name) + ":" + SemanticCanonicalToken(property.Value))) + "}";
            }
            JArray arrayValue = token as JArray;
            if (arrayValue != null)
            {
                return "[" + string.Join(",", arrayValue.Select(SemanticCanonicalToken)) + "]";
            }
            if (token.Type == JTokenType.Integer || token.Type == JTokenType.Float)
            {
                double numeric = Convert.ToDouble(((JValue)token).Value, CultureInfo.InvariantCulture);
                if (double.IsNaN(numeric) || double.IsInfinity(numeric)) throw new InvalidOperationException("Semantic spatial JSON cannot contain NaN or Infinity.");
                if (numeric == 0.0) numeric = 0.0;
                ulong bits = unchecked((ulong)BitConverter.DoubleToInt64Bits(numeric));
                return JsonConvert.SerializeObject("n:" + bits.ToString("x16", CultureInfo.InvariantCulture));
            }
            if (token.Type == JTokenType.String)
            {
                return JsonConvert.SerializeObject("s:" + Convert.ToString(((JValue)token).Value, CultureInfo.InvariantCulture));
            }
            return token.ToString(Formatting.None, new JsonConverter[0]);
        }

        private static string CanonicalToken(JToken token)
        {
            if (token == null || token.Type == JTokenType.Null || token.Type == JTokenType.Undefined) return "null";
            JObject objectValue = token as JObject;
            if (objectValue != null)
            {
                return "{" + string.Join(",", objectValue.Properties()
                    .OrderBy(property => property.Name, StringComparer.Ordinal)
                    .Select(property => JsonConvert.SerializeObject(property.Name) + ":" + CanonicalToken(property.Value))) + "}";
            }
            JArray arrayValue = token as JArray;
            if (arrayValue != null)
            {
                return "[" + string.Join(",", arrayValue.Select(CanonicalToken)) + "]";
            }
            if (token.Type == JTokenType.Integer)
            {
                return Convert.ToInt64(((JValue)token).Value, CultureInfo.InvariantCulture).ToString(CultureInfo.InvariantCulture);
            }
            if (token.Type == JTokenType.Float)
            {
                return JavaScriptNumber(Convert.ToDouble(((JValue)token).Value, CultureInfo.InvariantCulture));
            }
            return token.ToString(Formatting.None, new JsonConverter[0]);
        }

        private static string JavaScriptNumber(double value)
        {
            if (double.IsNaN(value) || double.IsInfinity(value)) throw new InvalidOperationException("Canonical spatial JSON cannot contain NaN or Infinity.");
            if (value == 0.0) return "0";

            bool negative = value < 0.0;
            double absolute = Math.Abs(value);
            if (absolute < 1e21 && Math.Truncate(absolute) == absolute)
            {
                string integer = absolute.ToString("0", CultureInfo.InvariantCulture);
                return negative ? "-" + integer : integer;
            }
            string roundTrip = ShortestRoundTrip(absolute);
            int exponentIndex = roundTrip.IndexOfAny(new[] { 'E', 'e' });
            string mantissa = exponentIndex >= 0 ? roundTrip.Substring(0, exponentIndex) : roundTrip;
            int exponent = exponentIndex >= 0
                ? int.Parse(roundTrip.Substring(exponentIndex + 1), NumberStyles.Integer, CultureInfo.InvariantCulture)
                : 0;
            int decimalIndex = mantissa.IndexOf('.');
            int integerDigits = decimalIndex >= 0 ? decimalIndex : mantissa.Length;
            string digits = mantissa.Replace(".", "");
            int decimalPosition = integerDigits + exponent;

            string rendered;
            if (absolute >= 0.000001 && absolute < 1e21)
            {
                if (decimalPosition <= 0)
                {
                    rendered = "0." + new string('0', -decimalPosition) + digits;
                }
                else if (decimalPosition >= digits.Length)
                {
                    rendered = digits + new string('0', decimalPosition - digits.Length);
                }
                else
                {
                    rendered = digits.Substring(0, decimalPosition) + "." + digits.Substring(decimalPosition);
                }
                if (rendered.IndexOf('.') >= 0)
                {
                    rendered = rendered.TrimEnd('0').TrimEnd('.');
                }
            }
            else
            {
                int firstNonZero = 0;
                while (firstNonZero < digits.Length && digits[firstNonZero] == '0') firstNonZero++;
                if (firstNonZero >= digits.Length) return "0";
                int normalizedExponent = decimalPosition - firstNonZero - 1;
                string significant = digits.Substring(firstNonZero).TrimEnd('0');
                rendered = significant.Length == 1 ? significant : significant.Substring(0, 1) + "." + significant.Substring(1);
                rendered += "e" + (normalizedExponent >= 0 ? "+" : "") + normalizedExponent.ToString(CultureInfo.InvariantCulture);
            }
            return negative ? "-" + rendered : rendered;
        }

        private static string ShortestRoundTrip(double value)
        {
            long expectedBits = BitConverter.DoubleToInt64Bits(value);
            string candidate = value.ToString("G15", CultureInfo.InvariantCulture);
            double parsed;
            if (double.TryParse(candidate, NumberStyles.Float, CultureInfo.InvariantCulture, out parsed) &&
                BitConverter.DoubleToInt64Bits(parsed) == expectedBits)
            {
                string best = candidate;
                for (int precision = 14; precision >= 1; precision--)
                {
                    candidate = value.ToString("G" + precision.ToString(CultureInfo.InvariantCulture), CultureInfo.InvariantCulture);
                    if (!double.TryParse(candidate, NumberStyles.Float, CultureInfo.InvariantCulture, out parsed) ||
                        BitConverter.DoubleToInt64Bits(parsed) != expectedBits)
                    {
                        break;
                    }
                    best = candidate;
                }
                return best;
            }
            for (int precision = 16; precision <= 17; precision++)
            {
                candidate = value.ToString("G" + precision.ToString(CultureInfo.InvariantCulture), CultureInfo.InvariantCulture);
                if (double.TryParse(candidate, NumberStyles.Float, CultureInfo.InvariantCulture, out parsed) &&
                    BitConverter.DoubleToInt64Bits(parsed) == expectedBits) return candidate;
            }
            return value.ToString("R", CultureInfo.InvariantCulture);
        }
    }
}
