using Autodesk.Revit.DB;
using Autodesk.Revit.UI;
using RevitMCPViewCommandSet.Extensions;
using System;
using System.Collections.Generic;
using System.Linq;

namespace RevitMCPViewCommandSet.Commands.View
{
    public class ViewSummary
    {
        public int Id { get; set; }
        public string UniqueId { get; set; }
        public string Name { get; set; }
        public string ViewType { get; set; }
        public int Scale { get; set; }
        public bool IsTemplate { get; set; }
        public bool IsActive { get; set; }
        public bool IsOpen { get; set; }
    }

    public class ViewOperationResult
    {
        public bool Success { get; set; }
        public string Action { get; set; }
        public string Message { get; set; }
        public string Error { get; set; }
        public bool Requested { get; set; }
        public bool Deferred { get; set; }
        public bool Changed { get; set; }
        public bool Closed { get; set; }
        public ViewSummary TargetView { get; set; }
        public ViewSummary ActiveView { get; set; }
        public List<ViewSummary> OpenViews { get; set; }
        public List<ViewSummary> Candidates { get; set; }
    }

    internal static class ViewCommandHelpers
    {
        private static readonly HashSet<string> NonActivatableViewTypes =
            new HashSet<string>(StringComparer.OrdinalIgnoreCase)
            {
                "Internal",
                "ProjectBrowser",
                "SystemBrowser",
                "Undefined"
            };

        public static ViewSummary BuildViewSummary(Document document, Autodesk.Revit.DB.View view, bool isActive, bool isOpen)
        {
            if (view == null)
            {
                return null;
            }

            return new ViewSummary
            {
                Id = view.Id.GetIdValue(),
                UniqueId = view.UniqueId,
                Name = view.Name,
                ViewType = view.ViewType.ToString(),
                Scale = view.Scale,
                IsTemplate = view.IsTemplate,
                IsActive = isActive,
                IsOpen = isOpen
            };
        }

        public static List<ViewSummary> GetOpenViewSummaries(UIDocument uiDocument)
        {
            Document document = uiDocument.Document;
            ElementId activeViewId = document.ActiveView != null ? document.ActiveView.Id : ElementId.InvalidElementId;
            HashSet<int> openViewIds = new HashSet<int>();
            foreach (UIView uiView in uiDocument.GetOpenUIViews())
            {
                openViewIds.Add(uiView.ViewId.GetIdValue());
            }

            List<ViewSummary> result = new List<ViewSummary>();
            foreach (int id in openViewIds)
            {
                Autodesk.Revit.DB.View view = document.GetElement(new ElementId(id)) as Autodesk.Revit.DB.View;
                if (view == null)
                {
                    continue;
                }
                result.Add(BuildViewSummary(
                    document,
                    view,
                    activeViewId != null && view.Id.GetIdValue() == activeViewId.GetIdValue(),
                    true));
            }

            return result.OrderBy(v => v.Name, StringComparer.OrdinalIgnoreCase).ToList();
        }

        public static bool TryResolveView(
            Document document,
            int? viewId,
            string viewName,
            string viewType,
            bool exactName,
            out Autodesk.Revit.DB.View resolvedView,
            out List<ViewSummary> candidates,
            out string error)
        {
            resolvedView = null;
            candidates = new List<ViewSummary>();
            error = "";

            if (viewId.HasValue)
            {
                Element element = document.GetElement(new ElementId(viewId.Value));
                resolvedView = element as Autodesk.Revit.DB.View;
                if (resolvedView == null)
                {
                    error = "No Revit view was found for viewId " + viewId.Value + ".";
                    return false;
                }
                return true;
            }

            if (string.IsNullOrWhiteSpace(viewName))
            {
                error = "Pass either viewId or viewName.";
                return false;
            }

            IEnumerable<Autodesk.Revit.DB.View> views =
                new FilteredElementCollector(document)
                    .WhereElementIsNotElementType()
                    .ToElements()
                    .OfType<Autodesk.Revit.DB.View>();

            if (!string.IsNullOrWhiteSpace(viewType))
            {
                views = views.Where(v => string.Equals(v.ViewType.ToString(), viewType, StringComparison.OrdinalIgnoreCase));
            }

            if (exactName)
            {
                views = views.Where(v => string.Equals(v.Name, viewName, StringComparison.OrdinalIgnoreCase));
            }
            else
            {
                views = views.Where(v => v.Name != null && v.Name.IndexOf(viewName, StringComparison.OrdinalIgnoreCase) >= 0);
            }

            List<Autodesk.Revit.DB.View> matches = views.OrderBy(v => v.Name, StringComparer.OrdinalIgnoreCase).ToList();
            candidates = matches.Select(v => BuildViewSummary(document, v, false, false)).ToList();
            if (matches.Count == 0)
            {
                error = "No Revit view matched the supplied name.";
                return false;
            }
            if (matches.Count > 1)
            {
                error = "Multiple Revit views matched the supplied name. Pass viewId or viewType to disambiguate.";
                return false;
            }

            resolvedView = matches[0];
            return true;
        }

        public static bool CanActivateView(Autodesk.Revit.DB.View view, out string reason)
        {
            reason = "";
            if (view == null)
            {
                reason = "View was not found.";
                return false;
            }
            if (view.IsTemplate)
            {
                reason = "View templates cannot be activated.";
                return false;
            }
            string viewType = view.ViewType.ToString();
            if (NonActivatableViewTypes.Contains(viewType))
            {
                reason = "View type cannot be activated: " + viewType + ".";
                return false;
            }

            return true;
        }

        public static UIView FindOpenUIView(UIDocument uiDocument, ElementId viewId)
        {
            foreach (UIView uiView in uiDocument.GetOpenUIViews())
            {
                if (uiView.ViewId.GetIdValue() == viewId.GetIdValue())
                {
                    return uiView;
                }
            }

            return null;
        }

        public static List<UIView> GetOpenUIViewsForDocument(UIDocument uiDocument)
        {
            return uiDocument.GetOpenUIViews().ToList();
        }
    }
}
