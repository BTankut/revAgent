using Autodesk.Revit.UI;
using Newtonsoft.Json.Linq;
using RevAgent.Contracts.AddinLoopback;
using RevitMCPSDK.API.Base;
using System;

namespace RevAgentCommandSet.Commands.Batch
{
    /// <summary>
    /// Add-in loopback v1 <c>execute_batch</c> (O1 Appendix A.4). The complete
    /// request is validated before Revit execution; a validation failure is a
    /// JSON-RPC error with zero executed steps. A valid request raises exactly
    /// one ExternalEvent whose handler runs every step inside one Revit
    /// TransactionGroup.
    /// </summary>
    public class ExecuteBatchCommand : ExternalEventCommandBase
    {
        private const int BatchWaitTimeoutMs = 120000;

        private ExecuteBatchEventHandler _handler => (ExecuteBatchEventHandler)Handler;

        public override string CommandName => AddinBatchContract.Method;

        public ExecuteBatchCommand(UIApplication uiApp)
            : base(new ExecuteBatchEventHandler(), uiApp)
        {
        }

        public override object Execute(JObject parameters, string requestId)
        {
            // Throws AddinBatchRequestException before any Revit dispatch on a
            // malformed, non-batchable, or budget/id-violating request.
            AddinBatchRequest request = AddinBatchRequestParser.Parse(requestId, parameters);

            _handler.SetRequest(request);
            if (RaiseAndWaitForCompletion(BatchWaitTimeoutMs))
            {
                if (_handler.PreGroupError != null)
                {
                    // The TransactionGroup never opened; zero steps executed.
                    throw new InvalidOperationException(_handler.PreGroupError);
                }

                return _handler.ResultInfo;
            }

            throw new TimeoutException("Timed out while executing the atomic Revit command batch.");
        }
    }
}
