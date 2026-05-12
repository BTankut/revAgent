using Autodesk.Revit.DB;
using Autodesk.Revit.UI;
using RevitMCPViewCommandSet.Extensions;
using System;
using System.Collections.Generic;
using System.Linq;

namespace RevitMCPViewCommandSet.Commands.View
{
    public class PlanCandidateSummary
    {
        public int Id { get; set; }
        public string UniqueId { get; set; }
        public string Name { get; set; }
        public string ViewType { get; set; }
        public int Scale { get; set; }
        public bool IsOpen { get; set; }
        public bool IsActive { get; set; }
        public int Score { get; set; }
        public string Reason { get; set; }
    }

    public class ElementSearchItem
    {
        public int Id { get; set; }
        public string UniqueId { get; set; }
        public string Name { get; set; }
        public string Category { get; set; }
        public string ClassName { get; set; }
        public string FamilyName { get; set; }
        public string TypeName { get; set; }
        public int? LevelId { get; set; }
        public string LevelName { get; set; }
        public string Mark { get; set; }
        public string Comments { get; set; }
        public bool HasBoundingBox { get; set; }
        public List<PlanCandidateSummary> PlanCandidates { get; set; }
    }

    internal static class ElementDiscoveryHelpers
    {
        private static readonly string[] PreferredMechanicalPlanTokens =
        {
            "hvac",
            "mechanical",
            "mep",
            "mechanic",
            "mekanik",
            "tesisat"
        };

        public static ElementSearchItem BuildElementSearchItem(
            Document document,
            UIDocument uiDocument,
            Element element,
            bool includePlanCandidates,
            string planNameContains)
        {
            if (element == null)
            {
                return null;
            }

            ElementId levelId;
            string levelName;
            ResolveElementLevel(document, element, out levelId, out levelName);

            List<PlanCandidateSummary> planCandidates = null;
            if (includePlanCandidates && levelId != null && levelId != ElementId.InvalidElementId)
            {
                planCandidates = FindPlanCandidates(document, uiDocument, levelId, planNameContains, true);
            }

            return new ElementSearchItem
            {
                Id = element.Id.GetIdValue(),
                UniqueId = element.UniqueId,
                Name = element.Name,
                Category = element.Category != null ? element.Category.Name : "",
                ClassName = element.GetType().Name,
                FamilyName = GetFamilyName(document, element),
                TypeName = GetTypeName(document, element),
                LevelId = levelId != null && levelId != ElementId.InvalidElementId ? (int?)levelId.GetIdValue() : null,
                LevelName = levelName,
                Mark = GetParameterString(element, "Mark"),
                Comments = GetParameterString(element, "Comments"),
                HasBoundingBox = ElementFocusHelpers.HasModelBoundingBox(element),
                PlanCandidates = planCandidates
            };
        }

        public static bool MatchesSearch(
            Document document,
            Element element,
            string query,
            IList<string> categoryNames)
        {
            if (element == null)
            {
                return false;
            }

            if (categoryNames != null && categoryNames.Count > 0)
            {
                string category = element.Category != null ? element.Category.Name : "";
                bool categoryMatched = false;
                foreach (string categoryName in categoryNames)
                {
                    if (!string.IsNullOrWhiteSpace(categoryName) &&
                        category.IndexOf(categoryName, StringComparison.OrdinalIgnoreCase) >= 0)
                    {
                        categoryMatched = true;
                        break;
                    }
                }

                if (!categoryMatched)
                {
                    return false;
                }
            }

            if (string.IsNullOrWhiteSpace(query))
            {
                return true;
            }

            string text = string.Join(" ", new[]
            {
                element.Id.GetIdValue().ToString(),
                element.UniqueId,
                element.Name,
                element.Category != null ? element.Category.Name : "",
                GetFamilyName(document, element),
                GetTypeName(document, element),
                GetParameterString(element, "Mark"),
                GetParameterString(element, "Comments")
            });

            return text.IndexOf(query, StringComparison.OrdinalIgnoreCase) >= 0;
        }

        public static void ResolveElementLevel(
            Document document,
            Element element,
            out ElementId levelId,
            out string levelName)
        {
            levelId = ElementId.InvalidElementId;
            levelName = "";

            if (element == null)
            {
                return;
            }

            try
            {
                if (element.LevelId != null && element.LevelId != ElementId.InvalidElementId)
                {
                    levelId = element.LevelId;
                }
            }
            catch
            {
            }

            if (levelId == ElementId.InvalidElementId)
            {
                foreach (BuiltInParameter builtInParameter in new[]
                {
                    BuiltInParameter.INSTANCE_SCHEDULE_ONLY_LEVEL_PARAM,
                    BuiltInParameter.FAMILY_LEVEL_PARAM,
                    BuiltInParameter.INSTANCE_REFERENCE_LEVEL_PARAM,
                    BuiltInParameter.RBS_START_LEVEL_PARAM
                })
                {
                    try
                    {
                        Parameter parameter = element.get_Parameter(builtInParameter);
                        if (parameter != null && parameter.StorageType == StorageType.ElementId)
                        {
                            ElementId candidate = parameter.AsElementId();
                            if (candidate != null && candidate != ElementId.InvalidElementId)
                            {
                                levelId = candidate;
                                break;
                            }
                        }
                    }
                    catch
                    {
                    }
                }
            }

            if (levelId != null && levelId != ElementId.InvalidElementId)
            {
                Element level = document.GetElement(levelId);
                if (level != null)
                {
                    levelName = level.Name;
                }
            }
        }

        public static List<PlanCandidateSummary> FindPlanCandidates(
            Document document,
            UIDocument uiDocument,
            ElementId levelId,
            string nameContains,
            bool preferMechanical)
        {
            HashSet<int> openViewIds = GetOpenViewIds(uiDocument);
            int activeViewId = document.ActiveView != null
                ? document.ActiveView.Id.GetIdValue()
                : -1;

            List<PlanCandidateSummary> candidates = new List<PlanCandidateSummary>();
            if (levelId == null || levelId == ElementId.InvalidElementId)
            {
                return candidates;
            }

            IEnumerable<ViewPlan> plans =
                new FilteredElementCollector(document)
                    .WhereElementIsNotElementType()
                    .OfClass(typeof(ViewPlan))
                    .Cast<ViewPlan>()
                    .Where(v => !v.IsTemplate && v.GenLevel != null && v.GenLevel.Id.GetIdValue() == levelId.GetIdValue());

            foreach (ViewPlan plan in plans)
            {
                PlanCandidateSummary candidate = BuildPlanCandidate(plan, openViewIds, activeViewId, nameContains, preferMechanical);
                candidates.Add(candidate);
            }

            return candidates
                .OrderByDescending(c => c.Score)
                .ThenBy(c => c.Name, StringComparer.OrdinalIgnoreCase)
                .ToList();
        }

        public static string GetFamilyName(Document document, Element element)
        {
            FamilyInstance familyInstance = element as FamilyInstance;
            if (familyInstance != null && familyInstance.Symbol != null && familyInstance.Symbol.Family != null)
            {
                return familyInstance.Symbol.Family.Name;
            }

            Element type = GetElementType(document, element);
            ElementType elementType = type as ElementType;
            if (elementType != null && !string.IsNullOrWhiteSpace(elementType.FamilyName))
            {
                return elementType.FamilyName;
            }

            return "";
        }

        public static string GetTypeName(Document document, Element element)
        {
            Element type = GetElementType(document, element);
            return type != null ? type.Name : "";
        }

        public static string GetParameterString(Element element, string parameterName)
        {
            try
            {
                Parameter parameter = element.LookupParameter(parameterName);
                if (parameter == null)
                {
                    return "";
                }

                string display = parameter.AsValueString();
                if (!string.IsNullOrWhiteSpace(display))
                {
                    return display;
                }

                return parameter.AsString() ?? "";
            }
            catch
            {
                return "";
            }
        }

        private static Element GetElementType(Document document, Element element)
        {
            try
            {
                ElementId typeId = element.GetTypeId();
                if (typeId != null && typeId != ElementId.InvalidElementId)
                {
                    return document.GetElement(typeId);
                }
            }
            catch
            {
            }

            return null;
        }

        private static HashSet<int> GetOpenViewIds(UIDocument uiDocument)
        {
            HashSet<int> openViewIds = new HashSet<int>();
            if (uiDocument == null)
            {
                return openViewIds;
            }

            foreach (UIView uiView in uiDocument.GetOpenUIViews())
            {
                openViewIds.Add(uiView.ViewId.GetIdValue());
            }

            return openViewIds;
        }

        private static PlanCandidateSummary BuildPlanCandidate(
            ViewPlan plan,
            HashSet<int> openViewIds,
            int activeViewId,
            string nameContains,
            bool preferMechanical)
        {
            int score = 0;
            List<string> reasons = new List<string>();
            string name = plan.Name ?? "";

            if (!string.IsNullOrWhiteSpace(nameContains) &&
                name.IndexOf(nameContains, StringComparison.OrdinalIgnoreCase) >= 0)
            {
                score += 200;
                reasons.Add("name match");
            }

            if (preferMechanical)
            {
                foreach (string token in PreferredMechanicalPlanTokens)
                {
                    if (name.IndexOf(token, StringComparison.OrdinalIgnoreCase) >= 0)
                    {
                        score += 100;
                        reasons.Add("mechanical/HVAC name");
                        break;
                    }
                }
            }

            if (string.Equals(plan.ViewType.ToString(), "FloorPlan", StringComparison.OrdinalIgnoreCase))
            {
                score += 20;
                reasons.Add("floor plan");
            }
            else if (string.Equals(plan.ViewType.ToString(), "CeilingPlan", StringComparison.OrdinalIgnoreCase))
            {
                score += 10;
                reasons.Add("ceiling plan");
            }

            if (openViewIds.Contains(plan.Id.GetIdValue()))
            {
                score += 5;
                reasons.Add("already open");
            }

            return new PlanCandidateSummary
            {
                Id = plan.Id.GetIdValue(),
                UniqueId = plan.UniqueId,
                Name = plan.Name,
                ViewType = plan.ViewType.ToString(),
                Scale = plan.Scale,
                IsOpen = openViewIds.Contains(plan.Id.GetIdValue()),
                IsActive = activeViewId == plan.Id.GetIdValue(),
                Score = score,
                Reason = reasons.Count > 0 ? string.Join(", ", reasons) : "same level plan"
            };
        }
    }
}
