using Autodesk.Revit.DB;
using Autodesk.Revit.UI;
using Newtonsoft.Json.Linq;
using RevAgent.Contracts.AddinLoopback;
using RevitMCPSDK.API.Interfaces;
using System;
using System.Threading;

namespace RevAgentCommandSet.Commands.Batch
{
    /// <summary>
    /// Runs one validated <c>execute_batch</c> request on the Revit API thread:
    /// it opens exactly one TransactionGroup, executes the advertised command
    /// seams directly in input order without raising any nested ExternalEvent,
    /// assimilates only an all-success envelope, and rolls the whole group back
    /// on the first non-success step so no partial mutation survives.
    /// </summary>
    public class ExecuteBatchEventHandler : IExternalEventHandler, IWaitableExternalEventHandler
    {
        private readonly ManualResetEvent _resetEvent = new ManualResetEvent(false);
        private AddinBatchRequest _request;

        /// <summary>The Appendix A.4 batch result envelope.</summary>
        public JObject ResultInfo { get; private set; }

        /// <summary>
        /// Non-null when execution failed before the TransactionGroup opened;
        /// the command surfaces it as a JSON-RPC error with zero executed steps.
        /// </summary>
        public string PreGroupError { get; private set; }

        public bool TaskCompleted { get; private set; }

        public void SetRequest(AddinBatchRequest request)
        {
            _request = request;
            ResultInfo = null;
            PreGroupError = null;
            TaskCompleted = false;
            _resetEvent.Reset();
        }

        public bool WaitForCompletion(int timeoutMilliseconds = 10000)
        {
            return _resetEvent.WaitOne(timeoutMilliseconds);
        }

        public void Execute(UIApplication app)
        {
            try
            {
                AddinBatchRequest request = _request;
                if (request == null)
                {
                    Complete(null, "execute_batch was raised without a validated batch request.");
                    return;
                }

                Document document = app != null && app.ActiveUIDocument != null
                    ? app.ActiveUIDocument.Document
                    : null;
                if (document == null)
                {
                    Complete(null, "No active Revit document is available for execute_batch.");
                    return;
                }

                using (RevitBatchTransactionGroup group = new RevitBatchTransactionGroup(document))
                {
                    JObject envelope = AddinBatchExecutor.Execute(
                        request,
                        group,
                        step => BatchStepSeamRunner.Run(app, step));
                    Complete(envelope, null);
                }
            }
            catch (Exception ex)
            {
                // Reaching this catch means the group could not be opened (or
                // was already terminally disposed); no step outcome exists.
                Complete(null, ex.Message);
            }
        }

        private void Complete(JObject envelope, string preGroupError)
        {
            ResultInfo = envelope;
            PreGroupError = preGroupError;
            TaskCompleted = true;
            _resetEvent.Set();
        }

        public string GetName()
        {
            return "Execute revAgent atomic command batch";
        }

        /// <summary>
        /// One Revit TransactionGroup as the Appendix A.2 advertised
        /// <c>revit_transaction_group</c> boundary. Dispose rolls back a group
        /// that is still open so no partial mutation can outlive a failure.
        /// </summary>
        private sealed class RevitBatchTransactionGroup : IAddinBatchTransactionGroup, IDisposable
        {
            private readonly TransactionGroup _group;

            public RevitBatchTransactionGroup(Document document)
            {
                _group = new TransactionGroup(document, "revAgent execute_batch");
            }

            public void Start()
            {
                TransactionStatus status = _group.Start();
                if (status != TransactionStatus.Started)
                {
                    throw new InvalidOperationException(
                        "The execute_batch TransactionGroup could not start: " + status);
                }
            }

            public void Assimilate()
            {
                TransactionStatus status = _group.Assimilate();
                if (status != TransactionStatus.Committed)
                {
                    throw new InvalidOperationException(
                        "The execute_batch TransactionGroup could not assimilate: " + status);
                }
            }

            public void RollBack()
            {
                TransactionStatus status = _group.RollBack();
                if (status != TransactionStatus.RolledBack)
                {
                    throw new InvalidOperationException(
                        "The execute_batch TransactionGroup could not roll back: " + status);
                }
            }

            public void Dispose()
            {
                if (_group.HasStarted() && !_group.HasEnded())
                {
                    try
                    {
                        _group.RollBack();
                    }
                    catch
                    {
                        // Disposal containment only; the executor has already
                        // reported the terminal batch state.
                    }
                }

                _group.Dispose();
            }
        }
    }
}
