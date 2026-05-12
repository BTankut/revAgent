using Autodesk.Revit.UI;
using Newtonsoft.Json.Linq;
using RevitMCPSDK.API.Base;
using System;
using System.Collections.Generic;

namespace RevitMCPViewCommandSet.Commands.View
{
    public class Create3DViewForElementsCommand : ExternalEventCommandBase
    {
        private Create3DViewForElementsEventHandler _handler
        {
            get { return (Create3DViewForElementsEventHandler)Handler; }
        }

        public override string CommandName
        {
            get { return "create_3d_view_for_elements"; }
        }

        public Create3DViewForElementsCommand(UIApplication uiApp)
            : base(new Create3DViewForElementsEventHandler(), uiApp)
        {
        }

        public override object Execute(JObject parameters, string requestId)
        {
            List<int> elementIds = ViewCommandHelpers.ParseElementIds(parameters);
            string viewName = parameters != null && parameters["viewName"] != null
                ? parameters["viewName"].Value<string>()
                : null;
            bool reuseExisting = parameters == null || parameters["reuseExisting"] == null || parameters["reuseExisting"].Value<bool>();
            bool createIfMissing = parameters == null || parameters["createIfMissing"] == null || parameters["createIfMissing"].Value<bool>();
            bool sectionBox = parameters != null && parameters["sectionBox"] != null && parameters["sectionBox"].Value<bool>();
            bool activate = parameters == null || parameters["activate"] == null || parameters["activate"].Value<bool>();
            bool select = parameters == null || parameters["select"] == null || parameters["select"].Value<bool>();
            bool zoom = parameters == null || parameters["zoom"] == null || parameters["zoom"].Value<bool>();
            bool allowPartial = parameters != null && parameters["allowPartial"] != null && parameters["allowPartial"].Value<bool>();
            double paddingMm = parameters != null && parameters["paddingMm"] != null ? parameters["paddingMm"].Value<double>() : 500.0;
            int timeoutMs = parameters != null && parameters["timeoutMs"] != null ? parameters["timeoutMs"].Value<int>() : 20000;
            if (timeoutMs < 1000) timeoutMs = 1000;
            if (timeoutMs > 120000) timeoutMs = 120000;

            _handler.SetRequest(
                elementIds,
                viewName,
                reuseExisting,
                createIfMissing,
                sectionBox,
                activate,
                select,
                zoom,
                allowPartial,
                paddingMm);

            if (RaiseAndWaitForCompletion(timeoutMs))
            {
                return _handler.ResultInfo;
            }

            throw new TimeoutException("Timed out while creating or focusing a Revit 3D view.");
        }
    }
}
