using Autodesk.Revit.UI;
using Newtonsoft.Json.Linq;
using RevitMCPSDK.API.Base;

namespace RevAgentCommandSet.Commands.ExecuteDynamicCode
{
    /// <summary>
    /// Command wrapper for dynamic C# execution in Revit.
    /// </summary>
    public class ExecuteCodeCommand : ExternalEventCommandBase
    {
        private ExecuteCodeEventHandler _handler => (ExecuteCodeEventHandler)Handler;

        public override string CommandName => "send_code_to_revit";

        public ExecuteCodeCommand(UIApplication uiApp)
            : base(new ExecuteCodeEventHandler(), uiApp)
        {
        }

        public override object Execute(JObject parameters, string requestId)
        {
            try
            {
                // Validate parameters.
                if (!parameters.ContainsKey("code"))
                {
                    throw new ArgumentException("Missing required parameter: 'code'");
                }

                // Parse code, arguments, and transaction behavior.
                string code = parameters["code"].Value<string>();
                JArray parametersArray = parameters["parameters"] as JArray;
                object[] executionParameters = parametersArray?.ToObject<object[]>() ?? Array.Empty<object>();
                string transactionMode = parameters["transactionMode"]?.Value<string>() ?? ExecuteCodeEventHandler.TransactionModeAuto;
                if (!string.Equals(
                        transactionMode,
                        ExecuteCodeEventHandler.TransactionModeAuto,
                        StringComparison.Ordinal) &&
                    !string.Equals(
                        transactionMode,
                        ExecuteCodeEventHandler.TransactionModeNone,
                        StringComparison.Ordinal))
                {
                    throw new ArgumentException(
                        "transactionMode must be exactly auto or none.");
                }
                string nativeOutcomeEvidenceConformance =
                    parameters["nativeOutcomeEvidenceConformance"]?.Value<string>();

                // Pass execution parameters to the Revit external event handler.
                _handler.SetExecutionParameters(
                    code,
                    executionParameters,
                    transactionMode,
                    nativeOutcomeEvidenceConformance);

                // Raise the external event and wait for completion.
                if (RaiseAndWaitForCompletion(60000))
                {
                    return _handler.ResultInfo;
                }
                else
                {
                    throw new TimeoutException("Code execution timed out.");
                }
            }
            catch (Exception ex)
            {
                throw new Exception($"Code execution failed: {ex.Message}", ex);
            }
        }
    }
}
