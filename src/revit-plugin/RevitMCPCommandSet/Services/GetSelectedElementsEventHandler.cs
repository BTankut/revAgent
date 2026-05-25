using Autodesk.Revit.UI;
using RevitMCPCommandSet.Models.Common;
using RevitMCPSDK.API.Interfaces;
using System;
using System.Collections.Generic;
using System.Linq;
using System.Text;
using System.Threading.Tasks;

namespace RevitMCPCommandSet.Services
{
    public class GetSelectedElementsEventHandler : IExternalEventHandler, IWaitableExternalEventHandler
    {
        // Execution result.
        public List<Models.Common.ElementInfo> ResultElements { get; private set; }

        // Status synchronization state.
        public bool TaskCompleted { get; private set; }
        private readonly ManualResetEvent _resetEvent = new ManualResetEvent(false);

        // Optional result limit.
        public int? Limit { get; set; }

        // IWaitableExternalEventHandler implementation.
        public bool WaitForCompletion(int timeoutMilliseconds = 10000)
        {
            _resetEvent.Reset();
            return _resetEvent.WaitOne(timeoutMilliseconds);
        }

        public void Execute(UIApplication app)
        {
            try
            {
                var uiDoc = app.ActiveUIDocument;
                var doc = uiDoc.Document;

                // Read the current selection.
                var selectedIds = uiDoc.Selection.GetElementIds();
                var selectedElements = selectedIds.Select(id => doc.GetElement(id)).ToList();

                // Apply the result limit.
                if (Limit.HasValue && Limit.Value > 0)
                {
                    selectedElements = selectedElements.Take(Limit.Value).ToList();
                }

                // Convert selected Revit elements to serializable element records.
                ResultElements = selectedElements.Select(element => new ElementInfo
                {
#if REVIT2024_OR_GREATER
                    Id = element.Id.Value,
#else
                    Id = element.Id.IntegerValue,
#endif
                    UniqueId = element.UniqueId,
                    Name = element.Name,
                    Category = element.Category?.Name
                }).ToList();
            }
            catch (Exception ex)
            {
                TaskDialog.Show("revAgent", "Failed to read selected elements: " + ex.Message);
                ResultElements = new List<Models.Common.ElementInfo>();
            }
            finally
            {
                TaskCompleted = true;
                _resetEvent.Set();
            }
        }

        public string GetName()
        {
            return "Get selected elements";
        }
    }
}
