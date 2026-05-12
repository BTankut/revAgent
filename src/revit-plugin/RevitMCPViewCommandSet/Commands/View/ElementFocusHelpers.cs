using Autodesk.Revit.DB;
using Autodesk.Revit.UI;
using RevitMCPViewCommandSet.Extensions;
using System;
using System.Collections.Generic;
using System.Linq;

namespace RevitMCPViewCommandSet.Commands.View
{
    public class ElementSummary
    {
        public int Id { get; set; }
        public string UniqueId { get; set; }
        public string Name { get; set; }
        public string Category { get; set; }
        public string ClassName { get; set; }
        public bool HasBoundingBox { get; set; }
    }

    public class BoundingBoxSummary
    {
        public double MinX { get; set; }
        public double MinY { get; set; }
        public double MinZ { get; set; }
        public double MaxX { get; set; }
        public double MaxY { get; set; }
        public double MaxZ { get; set; }
        public double PaddingMm { get; set; }
    }

    public class ElementFocusResult
    {
        public bool Success { get; set; }
        public string Action { get; set; }
        public string Message { get; set; }
        public string Error { get; set; }
        public bool Requested { get; set; }
        public bool Deferred { get; set; }
        public bool Changed { get; set; }
        public bool Selected { get; set; }
        public bool Zoomed { get; set; }
        public string ZoomMethod { get; set; }
        public string FocusNote { get; set; }
        public bool FocusBlocked { get; set; }
        public string FocusBlockReason { get; set; }
        public string FocusSuggestion { get; set; }
        public ViewSummary SuggestedView { get; set; }
        public bool FitToScreen { get; set; }
        public string FitToScreenMethod { get; set; }
        public string FitToScreenWarning { get; set; }
        public bool SectionBoxApplied { get; set; }
        public bool SectionBoxBoundaryShown { get; set; }
        public string SectionBoxBoundaryWarning { get; set; }
        public bool CreatedView { get; set; }
        public bool ReusedView { get; set; }
        public bool SectionBoxCleared { get; set; }
        public bool SectionBoxConfirmedOff { get; set; }
        public string SectionBoxState { get; set; }
        public string SectionBoxNote { get; set; }
        public double? PaddingMm { get; set; }
        public string BoundingBoxSource { get; set; }
        public string BoundingBoxNote { get; set; }
        public string RequestedViewName { get; set; }
        public string ActualViewName { get; set; }
        public bool ViewNameChanged { get; set; }
        public string ViewNameResolution { get; set; }
        public ViewSummary ActiveViewBefore { get; set; }
        public bool ActiveViewChanged { get; set; }
        public string PlanMode { get; set; }
        public string PlanOpenMode { get; set; }
        public string PlanOpenNote { get; set; }
        public bool ActivePlanMatchesElementLevel { get; set; }
        public int? ActivePlanLevelId { get; set; }
        public string ActivePlanLevelName { get; set; }
        public string PlanVisibilityWarning { get; set; }
        public string CameraOrientation { get; set; }
        public bool CameraApplied { get; set; }
        public string CameraWarning { get; set; }
        public double? FramingPaddingMm { get; set; }
        public ViewSummary TargetView { get; set; }
        public ViewSummary ActiveView { get; set; }
        public ViewSummary SelectedPlan { get; set; }
        public int? LevelId { get; set; }
        public string LevelName { get; set; }
        public string PlanSelectionReason { get; set; }
        public List<ViewSummary> OpenViews { get; set; }
        public List<ViewSummary> Candidates { get; set; }
        public List<PlanCandidateSummary> PlanCandidates { get; set; }
        public List<ElementSummary> Elements { get; set; }
        public List<int> MissingElementIds { get; set; }
        public List<int> NoBoundingBoxElementIds { get; set; }
        public BoundingBoxSummary BoundingBox { get; set; }
    }

    internal static class ElementFocusHelpers
    {
        public static bool TryResolveElements(
            Document document,
            IEnumerable<int> requestedIds,
            bool allowPartial,
            out List<ElementId> elementIds,
            out List<ElementSummary> elements,
            out List<int> missingElementIds,
            out string error)
        {
            elementIds = new List<ElementId>();
            elements = new List<ElementSummary>();
            missingElementIds = new List<int>();
            error = "";

            if (requestedIds == null)
            {
                error = "Pass at least one element id.";
                return false;
            }

            List<int> ids = requestedIds.Where(id => id > 0).Distinct().ToList();
            if (ids.Count == 0)
            {
                error = "Pass at least one positive element id.";
                return false;
            }

            foreach (int id in ids)
            {
                Element element = document.GetElement(new ElementId(id));
                if (element == null)
                {
                    missingElementIds.Add(id);
                    continue;
                }

                elementIds.Add(element.Id);
                elements.Add(BuildElementSummary(element, HasModelBoundingBox(element)));
            }

            if (elementIds.Count == 0)
            {
                error = "None of the supplied element ids exist in the active Revit document.";
                return false;
            }

            if (missingElementIds.Count > 0 && !allowPartial)
            {
                error = "Some supplied element ids were not found. Set allowPartial=true to continue with the existing elements.";
                return false;
            }

            return true;
        }

        public static ElementSummary BuildElementSummary(Element element, bool hasBoundingBox)
        {
            if (element == null)
            {
                return null;
            }

            return new ElementSummary
            {
                Id = element.Id.GetIdValue(),
                UniqueId = element.UniqueId,
                Name = element.Name,
                Category = element.Category != null ? element.Category.Name : "",
                ClassName = element.GetType().Name,
                HasBoundingBox = hasBoundingBox
            };
        }

        public static bool HasModelBoundingBox(Element element)
        {
            if (element == null)
            {
                return false;
            }

            try
            {
                return element.get_BoundingBox(null) != null;
            }
            catch
            {
                return false;
            }
        }

        public static List<int> GetNoBoundingBoxElementIds(IEnumerable<ElementSummary> elements)
        {
            if (elements == null)
            {
                return new List<int>();
            }

            return elements
                .Where(e => e != null && !e.HasBoundingBox)
                .Select(e => e.Id)
                .ToList();
        }

        public static string BuildFocusNote(bool zoom, string zoomMethod, IEnumerable<ElementSummary> elements)
        {
            if (!zoom)
            {
                return "";
            }

            List<int> noBoundingBoxIds = GetNoBoundingBoxElementIds(elements);
            if (string.Equals(zoomMethod, "ShowElements", StringComparison.OrdinalIgnoreCase) && noBoundingBoxIds.Count > 0)
            {
                return "One or more elements did not expose a model bounding box; Revit ShowElements fallback was used for UI focus.";
            }

            return "";
        }

        public static string BuildBoundingBoxNote(string source)
        {
            if (string.Equals(source, "sectionBox", StringComparison.OrdinalIgnoreCase))
            {
                return "BoundingBox is the aggregate model-space box used for the 3D section box.";
            }
            if (string.Equals(source, "cameraFrame", StringComparison.OrdinalIgnoreCase))
            {
                return "BoundingBox is the aggregate model-space box used to set the 3D camera orientation/framing; no section box was applied from it.";
            }

            return "Element HasBoundingBox describes per-element model boxes; this operation did not compute an aggregate BoundingBox and used Revit UI focus instead.";
        }

        public static string SelectAndZoom(UIDocument uiDocument, IList<ElementId> elementIds, bool select, bool zoom)
        {
            bool fitToScreenApplied;
            string fitToScreenMethod;
            string fitToScreenWarning;
            return SelectAndZoom(uiDocument, elementIds, select, zoom, false, out fitToScreenApplied, out fitToScreenMethod, out fitToScreenWarning);
        }

        public static string SelectAndZoom(
            UIDocument uiDocument,
            IList<ElementId> elementIds,
            bool select,
            bool zoom,
            bool fitToScreen,
            out bool fitToScreenApplied,
            out string fitToScreenMethod,
            out string fitToScreenWarning)
        {
            fitToScreenApplied = false;
            fitToScreenMethod = "";
            fitToScreenWarning = "";
            string zoomMethod = "";

            if (select)
            {
                uiDocument.Selection.SetElementIds(elementIds);
            }

            if (zoom)
            {
                uiDocument.ShowElements(elementIds);
                zoomMethod = "ShowElements";
            }

            if (fitToScreen)
            {
                fitToScreenApplied = TryZoomToFitActiveView(uiDocument, out fitToScreenMethod, out fitToScreenWarning);
                if (fitToScreenApplied)
                {
                    zoomMethod = string.IsNullOrWhiteSpace(zoomMethod)
                        ? "ZoomToFit"
                        : zoomMethod + "+ZoomToFit";
                }
            }

            return zoomMethod;
        }

        public static bool TryZoomToFitActiveView(UIDocument uiDocument, out string method, out string warning)
        {
            method = "";
            warning = "";
            try
            {
                Document document = uiDocument.Document;
                if (document == null || document.ActiveView == null)
                {
                    warning = "No active Revit view was available for ZoomToFit.";
                    return false;
                }

                UIView uiView = ViewCommandHelpers.FindOpenUIView(uiDocument, document.ActiveView.Id);
                if (uiView == null)
                {
                    warning = "The active Revit view was not found among open UI views.";
                    return false;
                }

                uiView.ZoomToFit();
                method = "UIView.ZoomToFit";
                return true;
            }
            catch (Exception ex)
            {
                warning = ex.Message;
                return false;
            }
        }

        public static string BuildSectionBoxNote(bool sectionBoxRequested, bool sectionBoxActive, bool sectionBoxCleared)
        {
            if (sectionBoxRequested)
            {
                return sectionBoxActive
                    ? "Section box is active and was applied around the supplied elements."
                    : "Section box was requested but could not be confirmed active.";
            }

            if (sectionBoxCleared)
            {
                return "An existing section box was cleared and is now confirmed inactive.";
            }

            return sectionBoxActive
                ? "Section box is still active."
                : "Section box is confirmed inactive; no clearing was needed.";
        }

        public static bool TryBuildSectionBox(
            Document document,
            IList<ElementId> elementIds,
            double paddingMm,
            out BoundingBoxXYZ sectionBox,
            out BoundingBoxSummary summary,
            out List<ElementSummary> elements,
            out List<int> noBoundingBoxElementIds,
            out string error)
        {
            sectionBox = null;
            summary = null;
            elements = new List<ElementSummary>();
            noBoundingBoxElementIds = new List<int>();
            error = "";

            double minX = double.PositiveInfinity;
            double minY = double.PositiveInfinity;
            double minZ = double.PositiveInfinity;
            double maxX = double.NegativeInfinity;
            double maxY = double.NegativeInfinity;
            double maxZ = double.NegativeInfinity;
            bool foundAnyBox = false;

            foreach (ElementId elementId in elementIds)
            {
                Element element = document.GetElement(elementId);
                if (element == null)
                {
                    continue;
                }

                BoundingBoxXYZ box = element.get_BoundingBox(null);
                bool hasBoundingBox = box != null;
                elements.Add(BuildElementSummary(element, hasBoundingBox));

                if (!hasBoundingBox)
                {
                    noBoundingBoxElementIds.Add(element.Id.GetIdValue());
                    continue;
                }

                foundAnyBox = true;
                foreach (XYZ point in GetBoundingBoxCorners(box))
                {
                    minX = Math.Min(minX, point.X);
                    minY = Math.Min(minY, point.Y);
                    minZ = Math.Min(minZ, point.Z);
                    maxX = Math.Max(maxX, point.X);
                    maxY = Math.Max(maxY, point.Y);
                    maxZ = Math.Max(maxZ, point.Z);
                }
            }

            if (!foundAnyBox)
            {
                error = "None of the supplied elements have a model bounding box.";
                return false;
            }

            double paddingFeet = Math.Max(0, paddingMm) / 304.8;
            sectionBox = new BoundingBoxXYZ
            {
                Transform = Transform.Identity,
                Min = new XYZ(minX - paddingFeet, minY - paddingFeet, minZ - paddingFeet),
                Max = new XYZ(maxX + paddingFeet, maxY + paddingFeet, maxZ + paddingFeet)
            };

            summary = new BoundingBoxSummary
            {
                MinX = sectionBox.Min.X,
                MinY = sectionBox.Min.Y,
                MinZ = sectionBox.Min.Z,
                MaxX = sectionBox.Max.X,
                MaxY = sectionBox.Max.Y,
                MaxZ = sectionBox.Max.Z,
                PaddingMm = Math.Max(0, paddingMm)
            };

            return true;
        }

        private static IEnumerable<XYZ> GetBoundingBoxCorners(BoundingBoxXYZ box)
        {
            Transform transform = box.Transform ?? Transform.Identity;
            XYZ min = box.Min;
            XYZ max = box.Max;

            yield return transform.OfPoint(new XYZ(min.X, min.Y, min.Z));
            yield return transform.OfPoint(new XYZ(min.X, min.Y, max.Z));
            yield return transform.OfPoint(new XYZ(min.X, max.Y, min.Z));
            yield return transform.OfPoint(new XYZ(min.X, max.Y, max.Z));
            yield return transform.OfPoint(new XYZ(max.X, min.Y, min.Z));
            yield return transform.OfPoint(new XYZ(max.X, min.Y, max.Z));
            yield return transform.OfPoint(new XYZ(max.X, max.Y, min.Z));
            yield return transform.OfPoint(new XYZ(max.X, max.Y, max.Z));
        }
    }
}
