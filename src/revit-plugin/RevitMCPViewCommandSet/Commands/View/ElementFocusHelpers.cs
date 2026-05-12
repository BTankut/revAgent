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
        public bool SectionBoxApplied { get; set; }
        public bool SectionBoxBoundaryShown { get; set; }
        public string SectionBoxBoundaryWarning { get; set; }
        public double PaddingMm { get; set; }
        public ViewSummary TargetView { get; set; }
        public ViewSummary ActiveView { get; set; }
        public List<ViewSummary> OpenViews { get; set; }
        public List<ViewSummary> Candidates { get; set; }
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
                elements.Add(BuildElementSummary(element, false));
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

        public static void SelectAndZoom(UIDocument uiDocument, IList<ElementId> elementIds, bool select, bool zoom)
        {
            if (select)
            {
                uiDocument.Selection.SetElementIds(elementIds);
            }

            if (zoom)
            {
                uiDocument.ShowElements(elementIds);
            }
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
