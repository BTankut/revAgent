using Autodesk.Revit.Attributes;
using Autodesk.Revit.DB;
using Autodesk.Revit.UI;
using System;

namespace revit_mcp_plugin.Core
{
    [Transaction(TransactionMode.Manual)]
    public class MCPServiceConnection : IExternalCommand
    {
        public Result Execute(ExternalCommandData commandData, ref string message, ElementSet elements)
        {
            try
            {
                // Obtain socket service.
                SocketService service = SocketService.Instance;

                if (service.IsRunning)
                {
                    service.Stop();
                    TaskDialog.Show("revAgent", "revAgent bridge stopped");
                }
                else
                {
                    service.Initialize(commandData.Application);
                    service.Start();
                    TaskDialog.Show("revAgent", "revAgent bridge started");
                }

                return Result.Succeeded;
            }
            catch (Exception ex)
            {
                message = ex.Message;
                return Result.Failed;
            }
        }
    }
}
