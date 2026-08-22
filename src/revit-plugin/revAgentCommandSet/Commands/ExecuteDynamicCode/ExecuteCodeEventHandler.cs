using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Text.RegularExpressions;
using System.Threading;
using Autodesk.Revit.DB;
using Autodesk.Revit.UI;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;
using RevitMCPSDK.API.Interfaces;

namespace RevAgentCommandSet.Commands.ExecuteDynamicCode
{
    public class ExecuteCodeEventHandler : IExternalEventHandler, IWaitableExternalEventHandler
    {
        public const string TransactionModeAuto = "auto";
        public const string TransactionModeNone = "none";
        public const string OutcomeEvidenceSchema = "revagent.mutation-outcome/v1";

        private string _generatedCode;
        private object[] _executionParameters = Array.Empty<object>();
        private string _transactionMode = TransactionModeAuto;
        private string _nativeOutcomeEvidenceConformance = string.Empty;

        public ExecutionResultInfo ResultInfo { get; private set; }
        public bool TaskCompleted { get; private set; }

        private readonly ManualResetEvent _resetEvent = new ManualResetEvent(false);

        public void SetExecutionParameters(
            string code,
            object[] parameters = null,
            string transactionMode = TransactionModeAuto,
            string nativeOutcomeEvidenceConformance = null)
        {
            _generatedCode = code;
            _executionParameters = parameters ?? Array.Empty<object>();
            _transactionMode = string.Equals(transactionMode, TransactionModeNone, StringComparison.OrdinalIgnoreCase)
                ? TransactionModeNone
                : TransactionModeAuto;
            _nativeOutcomeEvidenceConformance = nativeOutcomeEvidenceConformance ?? string.Empty;
            TaskCompleted = false;
            _resetEvent.Reset();
        }

        public bool WaitForCompletion(int timeoutMilliseconds = 10000)
        {
            return _resetEvent.WaitOne(timeoutMilliseconds);
        }

        public void Execute(UIApplication app)
        {
            Transaction transaction = null;
            try
            {
                ResultInfo = new ExecutionResultInfo
                {
                    OutcomeEvidence = CreateOutcomeEvidence(
                        "not_started",
                        _transactionMode,
                        "not_started")
                };
                var doc = app.ActiveUIDocument.Document;

                if (_transactionMode == TransactionModeAuto && ContainsManualTransaction(_generatedCode))
                {
                    SetGuardedResult(
                        "manual_transaction_requires_transactionMode_none",
                        "Manual Revit Transaction usage was blocked because transactionMode is auto. Use transactionMode none only for explicitly confirmed snippets that manage their own transaction.");
                    return;
                }

                if (_transactionMode == TransactionModeNone &&
                    ContainsManualTransaction(_generatedCode) &&
                    !string.Equals(
                        _nativeOutcomeEvidenceConformance,
                        OutcomeEvidenceSchema,
                        StringComparison.Ordinal))
                {
                    SetGuardedResult(
                        "native_outcome_evidence_conformance_required",
                        "transactionMode none with manual Revit transaction code requires the exact revagent.mutation-outcome/v1 conformance declaration before execution.");
                    return;
                }

                object result;
                if (_transactionMode == TransactionModeNone)
                {
                    result = CompileAndExecuteCode(
                        code: _generatedCode,
                        doc: doc,
                        parameters: _executionParameters
                    );

                    if (string.Equals(
                            _nativeOutcomeEvidenceConformance,
                            OutcomeEvidenceSchema,
                            StringComparison.Ordinal))
                    {
                        if (!TryReadNativeOutcomeEvidence(
                                result,
                                out ExecutionOutcomeEvidence nativeEvidence))
                        {
                            ResultInfo.Success = false;
                            ResultInfo.ErrorMessage =
                                "Execution completed without exact native outcome evidence.";
                            ResultInfo.OutcomeEvidence = CreateOutcomeEvidence(
                                "unknown",
                                TransactionModeNone,
                                "unknown");
                            return;
                        }

                        ResultInfo.OutcomeEvidence = nativeEvidence;
                    }
                    else
                    {
                        ResultInfo.OutcomeEvidence = CreateOutcomeEvidence(
                            "read_only",
                            TransactionModeNone,
                            "read_only");
                    }
                }
                else
                {
                    transaction = new Transaction(doc, "Execute AI code");
                    TransactionStatus startStatus = transaction.Start();
                    if (startStatus != TransactionStatus.Started)
                    {
                        throw new InvalidOperationException(
                            "The wrapper transaction did not enter Started state.");
                    }

                    result = CompileAndExecuteCode(
                        code: _generatedCode,
                        doc: doc,
                        parameters: _executionParameters
                    );

                    TransactionStatus commitStatus = transaction.Commit();
                    if (commitStatus != TransactionStatus.Committed)
                    {
                        throw new InvalidOperationException(
                            "The wrapper transaction did not report Committed state.");
                    }

                    ResultInfo.OutcomeEvidence = CreateOutcomeEvidence(
                        "committed",
                        TransactionModeAuto,
                        "committed");
                }

                ResultInfo.Success = true;
                ResultInfo.Result = CreateSafeResultToken(result);
            }
            catch (Exception ex)
            {
                string effectState = ResolveFailureEffect(transaction);
                ResultInfo.Success = false;
                ResultInfo.ErrorMessage = $"Execution failed: {ex.Message}";
                ResultInfo.OutcomeEvidence = CreateOutcomeEvidence(
                    effectState,
                    _transactionMode,
                    effectState);
            }
            finally
            {
                transaction?.Dispose();
                TaskCompleted = true;
                _resetEvent.Set();
            }
        }

        private void SetGuardedResult(string reason, string message)
        {
            ResultInfo.Success = false;
            ResultInfo.Guarded = true;
            ResultInfo.GuardReason = reason;
            ResultInfo.ErrorMessage = message;
            ResultInfo.OutcomeEvidence = CreateOutcomeEvidence(
                "not_started",
                _transactionMode,
                "not_started");
        }

        private static string ResolveFailureEffect(Transaction transaction)
        {
            if (transaction == null)
            {
                return ExecutionOutcomeDecision.ResolveFailure(null, null);
            }

            try
            {
                TransactionStatus status = transaction.GetStatus();
                TransactionStatus? rollbackStatus = null;
                if (status == TransactionStatus.Started)
                {
                    rollbackStatus = transaction.RollBack();
                }

                return ExecutionOutcomeDecision.ResolveFailure(
                    status.ToString(),
                    rollbackStatus?.ToString());
            }
            catch
            {
                // The only safe statement when transaction status cannot be
                // read or rollback cannot be proven is unknown.
            }

            return ExecutionOutcomeDecision.ResolveFailure(null, null);
        }

        private static ExecutionOutcomeEvidence CreateOutcomeEvidence(
            string effectState,
            string transactionMode,
            string transactionStatus)
        {
            return new ExecutionOutcomeEvidence
            {
                Schema = OutcomeEvidenceSchema,
                EffectState = effectState,
                TransactionMode = transactionMode,
                Evidence = new ExecutionOutcomeWitness
                {
                    Source = "execute_dynamic_code",
                    TransactionStatus = transactionStatus
                }
            };
        }

        private static bool TryReadNativeOutcomeEvidence(
            object result,
            out ExecutionOutcomeEvidence evidence)
        {
            evidence = null;
            JToken token;
            try
            {
                token = result as JToken ?? JToken.FromObject(result);
            }
            catch
            {
                return false;
            }

            JObject owner = token as JObject;
            JObject candidate = owner?["outcomeEvidence"] as JObject;
            if (candidate == null ||
                !HasExactProperties(
                    candidate,
                    "schema",
                    "effectState",
                    "transactionMode",
                    "evidence") ||
                !string.Equals(
                    candidate["schema"]?.Value<string>(),
                    OutcomeEvidenceSchema,
                    StringComparison.Ordinal) ||
                !string.Equals(
                    candidate["transactionMode"]?.Value<string>(),
                    TransactionModeNone,
                    StringComparison.Ordinal) ||
                candidate["evidence"] is not JObject witness ||
                !HasExactProperties(
                    witness,
                    "source",
                    "transactionStatus"))
            {
                return false;
            }

            string effectState = candidate["effectState"]?.Value<string>();
            string source = witness["source"]?.Value<string>();
            string transactionStatus =
                witness["transactionStatus"]?.Value<string>();
            if (!IsEffectState(effectState) ||
                !IsBoundedCode(source) ||
                !string.Equals(
                    effectState,
                    transactionStatus,
                    StringComparison.Ordinal))
            {
                return false;
            }

            string serialized = candidate.ToString(Formatting.None);
            if (System.Text.Encoding.UTF8.GetByteCount(serialized) > 2048)
            {
                return false;
            }

            evidence = new ExecutionOutcomeEvidence
            {
                Schema = OutcomeEvidenceSchema,
                EffectState = effectState,
                TransactionMode = TransactionModeNone,
                Evidence = new ExecutionOutcomeWitness
                {
                    Source = source,
                    TransactionStatus = transactionStatus
                }
            };
            return true;
        }

        private static bool HasExactProperties(
            JObject value,
            params string[] expected)
        {
            var actual = new HashSet<string>(
                value.Properties().Select(property => property.Name),
                StringComparer.Ordinal);
            return actual.Count == expected.Length &&
                expected.All(actual.Contains);
        }

        private static bool IsEffectState(string value)
        {
            return value == "not_started" ||
                value == "read_only" ||
                value == "rolled_back" ||
                value == "committed" ||
                value == "unknown";
        }

        private static bool IsBoundedCode(string value)
        {
            if (string.IsNullOrEmpty(value) ||
                value.Length > 64 ||
                value[0] < 'a' ||
                value[0] > 'z')
            {
                return false;
            }

            return value.All(character =>
                (character >= 'a' && character <= 'z') ||
                (character >= '0' && character <= '9') ||
                character == '_');
        }

        private static JToken CreateSafeResultToken(object result)
        {
            if (result == null)
            {
                return JValue.CreateNull();
            }

            try
            {
                JToken token = result as JToken;
                return token != null ? token.DeepClone() : JToken.FromObject(result);
            }
            catch
            {
                try
                {
                    return new JValue(Convert.ToString(result));
                }
                catch
                {
                    return new JValue(result.GetType().FullName);
                }
            }
        }

        private static bool ContainsManualTransaction(string code)
        {
            if (string.IsNullOrWhiteSpace(code))
            {
                return false;
            }

            return Regex.IsMatch(
                code,
                @"new\s+(?:Autodesk\.Revit\.DB\.)?(?:Transaction|SubTransaction|TransactionGroup)\s*\(",
                RegexOptions.IgnoreCase);
        }

        private object CompileAndExecuteCode(string code, Document doc, object[] parameters)
        {
            var wrappedCode = $@"
using System;
using System.Linq;
using Autodesk.Revit.DB;
using Autodesk.Revit.UI;
using System.Collections.Generic;

namespace AIGeneratedCode
{{
    public static class CodeExecutor
    {{
        public static object Execute(Document document, object[] parameters)
        {{
            {code}
        }}
    }}
}}";

            var syntaxTree = CSharpSyntaxTree.ParseText(wrappedCode);

            var references = GetMetadataReferences();

            var compilation = CSharpCompilation.Create(
                "AIGeneratedCode",
                syntaxTrees: new[] { syntaxTree },
                references: references,
                options: new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary)
            );

            using (var ms = new MemoryStream())
            {
                var result = compilation.Emit(ms);

                if (!result.Success)
                {
                    var errors = string.Join("\n", result.Diagnostics
                        .Where(d => d.Severity == DiagnosticSeverity.Error)
                        .Select(d => $"Line {d.Location.GetLineSpan().StartLinePosition.Line}: {d.GetMessage()}"));
                    throw new Exception($"Code compilation error:\n{errors}");
                }

                ms.Seek(0, SeekOrigin.Begin);
                var assembly = Assembly.Load(ms.ToArray());
                var executorType = assembly.GetType("AIGeneratedCode.CodeExecutor");
                var executeMethod = executorType.GetMethod("Execute");

                try
                {
                    return executeMethod.Invoke(null, new object[] { doc, parameters });
                }
                catch (TargetInvocationException ex)
                {
                    if (ex.InnerException != null)
                    {
                        throw ex.InnerException;
                    }

                    throw;
                }
            }
        }

        private static List<MetadataReference> GetMetadataReferences()
        {
            Dictionary<string, Assembly> chosen = new Dictionary<string, Assembly>(StringComparer.OrdinalIgnoreCase);
            List<Assembly> assemblies = AppDomain.CurrentDomain.GetAssemblies()
                .Where(assembly => !assembly.IsDynamic && !string.IsNullOrEmpty(assembly.Location))
                .ToList();
            bool hasOfficialNewtonsoftJson = assemblies.Any(assembly =>
                string.Equals(assembly.GetName().Name, "Newtonsoft.Json", StringComparison.OrdinalIgnoreCase));

            foreach (Assembly assembly in assemblies)
            {
                AssemblyName name = assembly.GetName();
                if (string.IsNullOrWhiteSpace(name.Name))
                {
                    continue;
                }

                if (hasOfficialNewtonsoftJson && IsShadowNewtonsoftJsonProvider(assembly))
                {
                    continue;
                }

                if (!chosen.TryGetValue(name.Name, out Assembly existing) ||
                    CompareAssemblyReference(assembly, existing) > 0)
                {
                    chosen[name.Name] = assembly;
                }
            }

            return chosen.Values
                .OrderBy(a => a.GetName().Name, StringComparer.OrdinalIgnoreCase)
                .Select(a => MetadataReference.CreateFromFile(a.Location))
                .Cast<MetadataReference>()
                .ToList();
        }

        private static bool IsShadowNewtonsoftJsonProvider(Assembly assembly)
        {
            string assemblyName = assembly.GetName().Name;
            if (string.Equals(assemblyName, "Newtonsoft.Json", StringComparison.OrdinalIgnoreCase))
            {
                return false;
            }

            return assembly.GetType("Newtonsoft.Json.JsonConvert", false) != null ||
                assembly.GetType("Newtonsoft.Json.Linq.JObject", false) != null;
        }

        private static int CompareAssemblyReference(Assembly candidate, Assembly existing)
        {
            int versionCompare = CompareVersion(candidate.GetName().Version, existing.GetName().Version);
            if (versionCompare != 0)
            {
                return versionCompare;
            }

            return string.Compare(candidate.Location, existing.Location, StringComparison.OrdinalIgnoreCase);
        }

        private static int CompareVersion(Version candidate, Version existing)
        {
            if (candidate == null && existing == null)
            {
                return 0;
            }

            if (candidate == null)
            {
                return -1;
            }

            if (existing == null)
            {
                return 1;
            }

            return candidate.CompareTo(existing);
        }

        public string GetName()
        {
            return "Execute AI code";
        }
    }

    public class ExecutionResultInfo
    {
        [JsonProperty("success")]
        public bool Success { get; set; }

        [JsonProperty("guarded")]
        public bool Guarded { get; set; }

        [JsonProperty("guardReason")]
        public string GuardReason { get; set; } = string.Empty;

        [JsonProperty("result")]
        public JToken Result { get; set; }

        [JsonProperty("errorMessage")]
        public string ErrorMessage { get; set; } = string.Empty;

        [JsonProperty("outcomeEvidence")]
        public ExecutionOutcomeEvidence OutcomeEvidence { get; set; }
    }

    public class ExecutionOutcomeEvidence
    {
        [JsonProperty("schema")]
        public string Schema { get; set; } = ExecuteCodeEventHandler.OutcomeEvidenceSchema;

        [JsonProperty("effectState")]
        public string EffectState { get; set; } = "unknown";

        [JsonProperty("transactionMode")]
        public string TransactionMode { get; set; } = "not_applicable";

        [JsonProperty("evidence")]
        public ExecutionOutcomeWitness Evidence { get; set; } = new ExecutionOutcomeWitness();
    }

    public class ExecutionOutcomeWitness
    {
        [JsonProperty("source")]
        public string Source { get; set; } = "execute_dynamic_code";

        [JsonProperty("transactionStatus")]
        public string TransactionStatus { get; set; } = "unknown";
    }
}
