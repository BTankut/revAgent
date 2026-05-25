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
using RevitMCPSDK.API.Interfaces;

namespace RevitMCPCommandSet.Commands.ExecuteDynamicCode
{
    public class ExecuteCodeEventHandler : IExternalEventHandler, IWaitableExternalEventHandler
    {
        public const string TransactionModeAuto = "auto";
        public const string TransactionModeNone = "none";

        private string _generatedCode;
        private object[] _executionParameters = Array.Empty<object>();
        private string _transactionMode = TransactionModeAuto;

        public ExecutionResultInfo ResultInfo { get; private set; }
        public bool TaskCompleted { get; private set; }

        private readonly ManualResetEvent _resetEvent = new ManualResetEvent(false);

        public void SetExecutionParameters(string code, object[] parameters = null, string transactionMode = TransactionModeAuto)
        {
            _generatedCode = code;
            _executionParameters = parameters ?? Array.Empty<object>();
            _transactionMode = string.Equals(transactionMode, TransactionModeNone, StringComparison.OrdinalIgnoreCase)
                ? TransactionModeNone
                : TransactionModeAuto;
            TaskCompleted = false;
            _resetEvent.Reset();
        }

        public bool WaitForCompletion(int timeoutMilliseconds = 10000)
        {
            _resetEvent.Reset();
            return _resetEvent.WaitOne(timeoutMilliseconds);
        }

        public void Execute(UIApplication app)
        {
            try
            {
                var doc = app.ActiveUIDocument.Document;
                ResultInfo = new ExecutionResultInfo();

                if (_transactionMode == TransactionModeAuto && ContainsManualTransaction(_generatedCode))
                {
                    SetGuardedResult(
                        "manual_transaction_requires_transactionMode_none",
                        "Manual Revit Transaction usage was blocked because transactionMode is auto. Use transactionMode none only for explicitly confirmed snippets that manage their own transaction.");
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
                }
                else
                {
                    using (var transaction = new Transaction(doc, "Execute AI code"))
                    {
                        transaction.Start();

                        result = CompileAndExecuteCode(
                            code: _generatedCode,
                            doc: doc,
                            parameters: _executionParameters
                        );

                        transaction.Commit();
                    }
                }

                ResultInfo.Success = true;
                ResultInfo.Result = JsonConvert.SerializeObject(result);
            }
            catch (Exception ex)
            {
                ResultInfo.Success = false;
                ResultInfo.ErrorMessage = $"Execution failed: {ex.Message}";
            }
            finally
            {
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
            foreach (Assembly assembly in AppDomain.CurrentDomain.GetAssemblies())
            {
                if (assembly.IsDynamic || string.IsNullOrEmpty(assembly.Location))
                {
                    continue;
                }

                AssemblyName name = assembly.GetName();
                if (string.IsNullOrWhiteSpace(name.Name))
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
        public string Result { get; set; }

        [JsonProperty("errorMessage")]
        public string ErrorMessage { get; set; } = string.Empty;
    }
}
