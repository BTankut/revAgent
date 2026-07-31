using Newtonsoft.Json.Linq;
using RevAgent.Contracts.AddinLoopback;
using RevAgentPlugin.Core;
using RevitMCPSDK.API.Interfaces;

namespace RevAgentCommandSet.Commands.Context
{
    /// <summary>
    /// Add-in loopback v1 <c>get_document_context</c> (O1 Appendix A.3): the
    /// registered command returns the application-event-maintained cached
    /// snapshot. It never raises a Revit ExternalEvent, performs no Revit API
    /// reads at request time, and is never composed from
    /// <c>get_current_view_info</c> plus <c>list_open_views</c>. The socket
    /// service serves this method outside the data-plane intake gate through
    /// the identical tracker read.
    /// </summary>
    public class GetDocumentContextCommand : IRevitCommand
    {
        public string CommandName => AddinDocumentContextContract.Method;

        public object Execute(JObject parameters, string requestId)
        {
            // Appendix A.3: the request params are the empty object. A
            // violation throws a JSON-RPC-mappable -32602 before the cache
            // snapshot is read.
            AddinDocumentContextContract.ValidateRequestParameters(parameters);
            return DocumentContextTracker.Instance.ReadResultObject();
        }
    }
}
