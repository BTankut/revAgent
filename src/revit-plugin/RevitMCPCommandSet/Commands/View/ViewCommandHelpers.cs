using Autodesk.Revit.DB;
using Autodesk.Revit.UI;
using Newtonsoft.Json.Linq;
using RevitMCPCommandSet.Extensions;
using System;
using System.Collections.Generic;
using System.Linq;

namespace RevitMCPCommandSet.Commands.View
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
        public int? ViewTemplateId { get; set; }
        public bool? CropBoxActive { get; set; }
        public bool? IsSectionBoxActive { get; set; }
        public bool? SectionBoxBoundaryVisible { get; set; }
    }

    public class ViewOperationResult
    {
        public bool Success { get; set; }
        public string Action { get; set; }
        public string Message { get; set; }
        public string Error { get; set; }
        public bool Guarded { get; set; }
        public string State { get; set; }
        public string Reason { get; set; }
        public bool Requested { get; set; }
        public bool Deferred { get; set; }
        public bool Changed { get; set; }
        public bool Closed { get; set; }
        public bool DryRun { get; set; }
        public bool Deleted { get; set; }
        public bool ConfirmDelete { get; set; }
        public bool TargetIsReviewView { get; set; }
        public List<string> ReviewSignals { get; set; }
        public List<string> Warnings { get; set; }
        public List<string> SuggestedNextScopes { get; set; }
        public int DeletedElementCount { get; set; }
        public ViewSummary ActiveViewBefore { get; set; }
        public ViewSummary BeforeView { get; set; }
        public ViewSummary AfterView { get; set; }
        public bool ActiveViewChanged { get; set; }
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

            int? viewTemplateId = null;
            bool? cropBoxActive = null;
            bool? isSectionBoxActive = null;
            bool? sectionBoxBoundaryVisible = null;

            try
            {
                if (view.ViewTemplateId != null && view.ViewTemplateId != ElementId.InvalidElementId)
                {
                    viewTemplateId = view.ViewTemplateId.GetIdValue();
                }
            }
            catch
            {
            }

            try
            {
                cropBoxActive = view.CropBoxActive;
            }
            catch
            {
            }

            View3D view3D = view as View3D;
            if (view3D != null)
            {
                try
                {
                    isSectionBoxActive = view3D.IsSectionBoxActive;
                }
                catch
                {
                }

                if (isSectionBoxActive == true)
                {
                    try
                    {
                        Category category = document.Settings.Categories.get_Item(BuiltInCategory.OST_SectionBox);
                        if (category != null)
                        {
                            sectionBoxBoundaryVisible = !view3D.GetCategoryHidden(category.Id);
                        }
                    }
                    catch
                    {
                    }
                }
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
                IsOpen = isOpen,
                ViewTemplateId = viewTemplateId,
                CropBoxActive = cropBoxActive,
                IsSectionBoxActive = isSectionBoxActive,
                SectionBoxBoundaryVisible = sectionBoxBoundaryVisible
            };
        }

        public static bool DidActiveViewChange(ViewSummary beforeView, ViewSummary afterView)
        {
            if (beforeView == null || afterView == null)
            {
                return false;
            }

            return beforeView.Id != afterView.Id;
        }

        public static List<string> GetReviewViewSignals(Autodesk.Revit.DB.View view)
        {
            List<string> signals = new List<string>();
            if (view == null || view.IsTemplate || !(view is View3D))
            {
                return signals;
            }

            string name = view.Name ?? "";
            string normalizedName = NormalizeReviewViewName(name);
            if (name.StartsWith("3D - Focus ", StringComparison.OrdinalIgnoreCase))
            {
                signals.Add("default_focus_view_name");
            }
            if (name.StartsWith("Revit MCP 3D Focus", StringComparison.OrdinalIgnoreCase))
            {
                signals.Add("revit_mcp_focus_view_name");
            }
            if (name.StartsWith("DPE Visual QA - Coordination Export", StringComparison.OrdinalIgnoreCase))
            {
                signals.Add("coordination_export_view_name");
            }
            if (name.IndexOf("Coordination Export", StringComparison.OrdinalIgnoreCase) >= 0 &&
                name.IndexOf("QA", StringComparison.OrdinalIgnoreCase) >= 0)
            {
                signals.Add("qa_coordination_view_name");
            }
            if (StartsWithReviewBrand(normalizedName) &&
                (ContainsReviewToken(normalizedName, "review") ||
                 ContainsReviewToken(normalizedName, "focus") ||
                 ContainsReviewToken(normalizedName, "qa")))
            {
                signals.Add("revagent_review_view_name");
            }

            return signals.Distinct(StringComparer.OrdinalIgnoreCase).ToList();
        }

        private static string NormalizeReviewViewName(string name)
        {
            if (string.IsNullOrWhiteSpace(name))
            {
                return "";
            }

            char[] chars = name.ToLowerInvariant().ToCharArray();
            for (int i = 0; i < chars.Length; i++)
            {
                if (!char.IsLetterOrDigit(chars[i]))
                {
                    chars[i] = ' ';
                }
            }

            return " " + string.Join(" ", new string(chars).Split(new[] { ' ' }, StringSplitOptions.RemoveEmptyEntries)) + " ";
        }

        private static bool StartsWithReviewBrand(string normalizedName)
        {
            return normalizedName.StartsWith(" revagent ", StringComparison.OrdinalIgnoreCase) ||
                normalizedName.StartsWith(" revit mcp ", StringComparison.OrdinalIgnoreCase);
        }

        private static bool ContainsReviewToken(string normalizedName, string token)
        {
            if (string.IsNullOrWhiteSpace(normalizedName) || string.IsNullOrWhiteSpace(token))
            {
                return false;
            }

            return normalizedName.IndexOf(" " + token.ToLowerInvariant() + " ", StringComparison.OrdinalIgnoreCase) >= 0;
        }

        public static void PopulateViewTransition(ViewOperationResult result, ViewSummary beforeView, ViewSummary afterView)
        {
            if (result == null)
            {
                return;
            }

            result.ActiveViewBefore = beforeView;
            result.BeforeView = beforeView;
            result.AfterView = afterView;
            result.ActiveView = afterView;
            result.ActiveViewChanged = DidActiveViewChange(beforeView, afterView);
        }

        public static void PopulateViewTransition(ElementFocusResult result, ViewSummary beforeView, ViewSummary afterView)
        {
            if (result == null)
            {
                return;
            }

            result.ActiveViewBefore = beforeView;
            result.BeforeView = beforeView;
            result.AfterView = afterView;
            result.ActiveView = afterView;
            result.ActiveViewChanged = DidActiveViewChange(beforeView, afterView);
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

            List<Autodesk.Revit.DB.View> viewElements;
            using (FilteredElementCollector viewCollector = new FilteredElementCollector(document))
            {
                viewElements = viewCollector
                    .WhereElementIsNotElementType()
                    .ToElements()
                    .OfType<Autodesk.Revit.DB.View>()
                    .ToList();
            }
            IEnumerable<Autodesk.Revit.DB.View> views = viewElements;

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

        public static List<int> ParseElementIds(JObject parameters)
        {
            List<int> elementIds = new List<int>();
            JArray rawIds = parameters != null ? parameters["elementIds"] as JArray : null;
            if (rawIds == null)
            {
                return elementIds;
            }

            foreach (JToken token in rawIds)
            {
                int value;
                if (token.Type == JTokenType.String)
                {
                    if (int.TryParse(token.Value<string>(), out value))
                    {
                        elementIds.Add(value);
                    }
                    continue;
                }

                value = token.Value<int>();
                elementIds.Add(value);
            }

            return elementIds;
        }

        public static string MakeUniqueViewName(Document document, string requestedName)
        {
            string baseName = string.IsNullOrWhiteSpace(requestedName)
                ? "Revit MCP 3D Focus"
                : requestedName.Trim();

            List<string> existingViewNames;
            using (FilteredElementCollector viewCollector = new FilteredElementCollector(document))
            {
                existingViewNames = viewCollector
                    .WhereElementIsNotElementType()
                    .ToElements()
                    .OfType<Autodesk.Revit.DB.View>()
                    .Select(v => v.Name)
                    .ToList();
            }
            HashSet<string> names = new HashSet<string>(existingViewNames, StringComparer.OrdinalIgnoreCase);

            if (!names.Contains(baseName))
            {
                return baseName;
            }

            for (int index = 2; index < 1000; index++)
            {
                string candidate = baseName + " " + index;
                if (!names.Contains(candidate))
                {
                    return candidate;
                }
            }

            return baseName + " " + Guid.NewGuid().ToString("N").Substring(0, 8);
        }
    }
}
