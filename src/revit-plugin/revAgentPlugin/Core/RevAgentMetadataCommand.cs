using Autodesk.Revit.Attributes;
using Autodesk.Revit.DB;
using Autodesk.Revit.UI;

namespace RevAgentPlugin.Core
{
    [Transaction(TransactionMode.Manual)]
    public class RevAgentMetadataCommand : IExternalCommand
    {
        public Result Execute(ExternalCommandData commandData, ref string message, ElementSet elements)
        {
            McpVersionInfo version = McpVersionInfo.Read();

            TaskDialog dialog = new TaskDialog("revAgent")
            {
                MainInstruction = "revAgent",
                MainContent = version.FormatMetadataDetails(),
                FooterText = McpVersionInfo.ProductWebsiteUrl,
                CommonButtons = TaskDialogCommonButtons.Ok
            };
            dialog.Show();

            return Result.Succeeded;
        }
    }
}
