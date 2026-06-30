using Autodesk.Revit.DB;
using Autodesk.Revit.UI;
using RevAgentCommandSet.Extensions;
using System;
using System.Collections.Generic;
using System.Linq;

namespace RevAgentCommandSet.Commands.View
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
        public bool? ElementVisibleInView { get; set; }
        public string ElementVisibilityReason { get; set; }
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
        public string SourceDocumentTitle { get; set; }
        public string SourceDocumentKind { get; set; }
        public int? LinkInstanceId { get; set; }
        public string LinkInstanceName { get; set; }
        public int MatchScore { get; set; }
        public string MatchConfidence { get; set; }
        public string MatchReason { get; set; }
        public List<string> MatchFields { get; set; }
        public string PlanCandidateMode { get; set; }
        public List<PlanCandidateSummary> PlanCandidates { get; set; }
        public int? PlanCandidatesTotal { get; set; }
        public bool PlanCandidatesTruncated { get; set; }
    }

    public class SearchMatchSummary
    {
        public bool Matches { get; set; }
        public int Score { get; set; }
        public string Confidence { get; set; }
        public string Reason { get; set; }
        public List<string> Fields { get; set; }
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

        private static readonly Dictionary<string, BuiltInCategory> CategoryAliases =
            new Dictionary<string, BuiltInCategory>(StringComparer.OrdinalIgnoreCase)
            {
                { "Mechanical Equipment", BuiltInCategory.OST_MechanicalEquipment },
                { "Ducts", BuiltInCategory.OST_DuctCurves },
                { "duct", BuiltInCategory.OST_DuctCurves },
                { "Duct Fittings", BuiltInCategory.OST_DuctFitting },
                { "Duct Accessories", BuiltInCategory.OST_DuctAccessory },
                { "Air Terminals", BuiltInCategory.OST_DuctTerminal },
                { "diffuser", BuiltInCategory.OST_DuctTerminal },
                { "Pipes", BuiltInCategory.OST_PipeCurves },
                { "pipe", BuiltInCategory.OST_PipeCurves },
                { "Pipe Fittings", BuiltInCategory.OST_PipeFitting },
                { "Pipe Accessories", BuiltInCategory.OST_PipeAccessory },
                { "Plumbing Fixtures", BuiltInCategory.OST_PlumbingFixtures },
                { "Sprinklers", BuiltInCategory.OST_Sprinklers },
                { "Flex Ducts", BuiltInCategory.OST_FlexDuctCurves },
                { "Flex Pipes", BuiltInCategory.OST_FlexPipeCurves }
            };

        public static List<BuiltInCategory> ResolveBuiltInCategories(IList<string> categoryNames)
        {
            List<BuiltInCategory> categories = new List<BuiltInCategory>();
            if (categoryNames == null)
            {
                return categories;
            }

            foreach (string categoryName in categoryNames)
            {
                if (string.IsNullOrWhiteSpace(categoryName)) continue;
                BuiltInCategory exact;
                if (CategoryAliases.TryGetValue(categoryName.Trim(), out exact))
                {
                    if (!categories.Contains(exact)) categories.Add(exact);
                    continue;
                }

                foreach (KeyValuePair<string, BuiltInCategory> alias in CategoryAliases)
                {
                    if (alias.Key.IndexOf(categoryName, StringComparison.OrdinalIgnoreCase) >= 0 ||
                        categoryName.IndexOf(alias.Key, StringComparison.OrdinalIgnoreCase) >= 0)
                    {
                        if (!categories.Contains(alias.Value)) categories.Add(alias.Value);
                    }
                }
            }

            return categories;
        }

        public static ElementSearchItem BuildElementSearchItem(
            Document document,
            UIDocument uiDocument,
            Element element,
            bool includePlanCandidates,
            string planNameContains,
            string planCandidateMode,
            SearchMatchSummary matchSummary = null)
        {
            bool planCandidateBudgetStopped;
            string planCandidateStoppedReason;
            return BuildElementSearchItem(
                document,
                uiDocument,
                element,
                includePlanCandidates,
                planNameContains,
                planCandidateMode,
                matchSummary,
                null,
                out planCandidateBudgetStopped,
                out planCandidateStoppedReason);
        }

        public static ElementSearchItem BuildElementSearchItem(
            Document document,
            UIDocument uiDocument,
            Element element,
            bool includePlanCandidates,
            string planNameContains,
            string planCandidateMode,
            SearchMatchSummary matchSummary,
            DateTime? deadlineUtc,
            out bool planCandidateBudgetStopped,
            out string planCandidateStoppedReason)
        {
            planCandidateBudgetStopped = false;
            planCandidateStoppedReason = "";

            if (document == null || element == null)
            {
                return null;
            }

            ElementId levelId;
            string levelName;
            ResolveElementLevel(document, element, out levelId, out levelName);

            List<PlanCandidateSummary> planCandidates = null;
            if (includePlanCandidates && levelId != null && levelId != ElementId.InvalidElementId)
            {
                bool verifyVisibility = string.Equals(planCandidateMode, "verified", StringComparison.OrdinalIgnoreCase);
                planCandidates = FindPlanCandidates(
                    document,
                    uiDocument,
                    levelId,
                    planNameContains,
                    true,
                    verifyVisibility ? element : null,
                    deadlineUtc,
                    out planCandidateBudgetStopped,
                    out planCandidateStoppedReason);
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
                MatchScore = matchSummary != null ? matchSummary.Score : 0,
                MatchConfidence = matchSummary != null ? matchSummary.Confidence : "",
                MatchReason = matchSummary != null ? matchSummary.Reason : "",
                MatchFields = matchSummary != null ? matchSummary.Fields : new List<string>(),
                PlanCandidateMode = includePlanCandidates ? planCandidateMode : "none",
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

            return BuildSearchMatch(document, element, query, categoryNames).Matches;
        }

        public static SearchMatchSummary BuildSearchMatch(
            Document document,
            Element element,
            string query,
            IList<string> categoryNames)
        {
            SearchMatchSummary result = new SearchMatchSummary
            {
                Matches = false,
                Score = 0,
                Confidence = "none",
                Reason = "",
                Fields = new List<string>()
            };

            if (element == null)
            {
                result.Reason = "element was null";
                return result;
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
                    result.Reason = "category did not match";
                    return result;
                }

                result.Score += 100;
                result.Fields.Add("categoryFilter");
            }

            if (string.IsNullOrWhiteSpace(query))
            {
                result.Matches = true;
                result.Confidence = BuildMatchConfidence(result.Score);
                result.Reason = result.Fields.Count > 0 ? "category filter matched" : "no text query supplied";
                return result;
            }

            string trimmedQuery = query.Trim();
            AddFieldMatch(result, "id", element.Id.GetIdValue().ToString(), trimmedQuery, 1000, 500);
            AddFieldMatch(result, "uniqueId", element.UniqueId, trimmedQuery, 900, 450);
            AddFieldMatch(result, "category", element.Category != null ? element.Category.Name : "", trimmedQuery, 500, 180);
            AddFieldMatch(result, "mark", GetParameterString(element, "Mark"), trimmedQuery, 800, 360);
            AddFieldMatch(result, "name", element.Name, trimmedQuery, 650, 280);
            AddFieldMatch(result, "family", GetFamilyName(document, element), trimmedQuery, 620, 260);
            AddFieldMatch(result, "type", GetTypeName(document, element), trimmedQuery, 600, 240);
            AddFieldMatch(result, "comments", GetParameterString(element, "Comments"), trimmedQuery, 250, 120);
            AddTokenMatches(document, element, result, trimmedQuery);
            AddValveAccessorySignal(element, result, trimmedQuery);

            result.Matches = result.Fields.Count > 0 && result.Fields.Any(f => !string.Equals(f, "categoryFilter", StringComparison.OrdinalIgnoreCase));
            result.Confidence = BuildMatchConfidence(result.Score);
            result.Reason = result.Matches
                ? "matched " + string.Join(", ", result.Fields)
                : "text query did not match";
            return result;
        }

        public static void ResolveElementLevel(
            Document document,
            Element element,
            out ElementId levelId,
            out string levelName)
        {
            levelId = ElementId.InvalidElementId;
            levelName = "";

            if (document == null || element == null)
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
            bool preferMechanical,
            Element targetElement = null)
        {
            bool budgetStopped;
            string stoppedReason;
            return FindPlanCandidates(
                document,
                uiDocument,
                levelId,
                nameContains,
                preferMechanical,
                targetElement,
                null,
                out budgetStopped,
                out stoppedReason);
        }

        public static List<PlanCandidateSummary> FindPlanCandidates(
            Document document,
            UIDocument uiDocument,
            ElementId levelId,
            string nameContains,
            bool preferMechanical,
            Element targetElement,
            DateTime? deadlineUtc,
            out bool budgetStopped,
            out string stoppedReason)
        {
            budgetStopped = false;
            stoppedReason = "";

            if (document == null)
            {
                return new List<PlanCandidateSummary>();
            }

            HashSet<int> openViewIds = GetOpenViewIds(uiDocument);
            int activeViewId = document.ActiveView != null
                ? document.ActiveView.Id.GetIdValue()
                : -1;

            List<PlanCandidateSummary> candidates = new List<PlanCandidateSummary>();
            if (levelId == null || levelId == ElementId.InvalidElementId)
            {
                return candidates;
            }

            List<ViewPlan> plans;
            using (FilteredElementCollector planCollector = new FilteredElementCollector(document))
            {
                plans = planCollector
                    .WhereElementIsNotElementType()
                    .OfClass(typeof(ViewPlan))
                    .Cast<ViewPlan>()
                    .Where(v => !v.IsTemplate && v.GenLevel != null && v.GenLevel.Id.GetIdValue() == levelId.GetIdValue())
                    .ToList();
            }

            foreach (ViewPlan plan in plans)
            {
                if (deadlineUtc.HasValue && DateTime.UtcNow >= deadlineUtc.Value)
                {
                    budgetStopped = true;
                    stoppedReason = "max_elapsed";
                    break;
                }

                PlanCandidateSummary candidate = BuildPlanCandidate(document, plan, openViewIds, activeViewId, nameContains, preferMechanical, targetElement);
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

        public static PlanCandidateSummary BuildPlanCandidate(
            Document document,
            ViewPlan plan,
            HashSet<int> openViewIds,
            int activeViewId,
            string nameContains,
            bool preferMechanical,
            Element targetElement = null)
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

            bool? elementVisibleInView = null;
            string elementVisibilityReason = "";
            if (targetElement != null)
            {
                string visibilityReason;
                elementVisibleInView = ElementFocusHelpers.IsElementVisibleInView(document, targetElement, plan, out visibilityReason);
                elementVisibilityReason = visibilityReason;
                if (elementVisibleInView == true)
                {
                    score += 500;
                    reasons.Add("element visible in view");
                }
                else
                {
                    score -= 1000;
                    reasons.Add("element not visible in view: " + visibilityReason);
                }
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
                Reason = reasons.Count > 0 ? string.Join(", ", reasons) : "same level plan",
                ElementVisibleInView = elementVisibleInView,
                ElementVisibilityReason = elementVisibilityReason
            };
        }

        public static PlanCandidateSummary BuildActivePlanCandidate(ViewPlan plan, Document document = null, Element targetElement = null)
        {
            if (plan == null)
            {
                return null;
            }

            bool? elementVisibleInView = null;
            string elementVisibilityReason = "";
            if (document != null && targetElement != null)
            {
                string visibilityReason;
                elementVisibleInView = ElementFocusHelpers.IsElementVisibleInView(document, targetElement, plan, out visibilityReason);
                elementVisibilityReason = visibilityReason;
            }

            return new PlanCandidateSummary
            {
                Id = plan.Id.GetIdValue(),
                UniqueId = plan.UniqueId,
                Name = plan.Name,
                ViewType = plan.ViewType.ToString(),
                Scale = plan.Scale,
                IsOpen = true,
                IsActive = true,
                Score = 1000,
                Reason = "active plan requested",
                ElementVisibleInView = elementVisibleInView,
                ElementVisibilityReason = elementVisibilityReason
            };
        }

        private static void AddFieldMatch(
            SearchMatchSummary result,
            string fieldName,
            string value,
            string query,
            int exactScore,
            int containsScore)
        {
            if (string.IsNullOrWhiteSpace(value) || string.IsNullOrWhiteSpace(query))
            {
                return;
            }

            if (string.Equals(value.Trim(), query, StringComparison.OrdinalIgnoreCase))
            {
                result.Score += exactScore;
                result.Fields.Add(fieldName + ":exact");
                return;
            }

            if (value.IndexOf(query, StringComparison.OrdinalIgnoreCase) >= 0)
            {
                result.Score += containsScore;
                result.Fields.Add(fieldName + ":contains");
            }
        }

        private static void AddValveAccessorySignal(Element element, SearchMatchSummary result, string query)
        {
            if (!IsValveSearch(query) || element == null || result == null)
            {
                return;
            }

            string category = element.Category != null ? element.Category.Name : "";
            if (category.IndexOf("Pipe Accessories", StringComparison.OrdinalIgnoreCase) >= 0)
            {
                result.Score += 430;
                if (!result.Fields.Contains("mepValveAccessoryCategory"))
                {
                    result.Fields.Add("mepValveAccessoryCategory");
                }
            }
        }

        private static bool IsValveSearch(string query)
        {
            string normalized = NormalizeSearchText(query);
            string padded = " " + normalized + " ";
            return normalized == "valve" ||
                normalized == "vana" ||
                padded.Contains(" valve ") ||
                padded.Contains(" vana ");
        }

        private static string NormalizeSearchText(string value)
        {
            string normalized = (value ?? "").Trim().ToLowerInvariant();
            normalized = normalized.Replace("\u0131", "i").Replace("\u0130", "i");
            return normalized;
        }

        private static void AddTokenMatches(Document document, Element element, SearchMatchSummary result, string query)
        {
            string[] tokens = SplitSearchTokens(query);
            if (tokens.Length <= 1)
            {
                return;
            }

            Dictionary<string, string> fields = new Dictionary<string, string>
            {
                { "id", element.Id.GetIdValue().ToString() },
                { "uniqueId", element.UniqueId ?? "" },
                { "category", element.Category != null ? element.Category.Name : "" },
                { "mark", GetParameterString(element, "Mark") },
                { "name", element.Name ?? "" },
                { "family", GetFamilyName(document, element) },
                { "type", GetTypeName(document, element) },
                { "comments", GetParameterString(element, "Comments") }
            };

            List<string> matchedFields = new List<string>();
            int score = 0;
            foreach (string token in tokens)
            {
                bool tokenMatched = false;
                foreach (KeyValuePair<string, string> field in fields)
                {
                    if (string.IsNullOrWhiteSpace(field.Value)) continue;
                    if (string.Equals(field.Value.Trim(), token, StringComparison.OrdinalIgnoreCase))
                    {
                        matchedFields.Add(field.Key + ":tokenExact");
                        score += TokenScore(field.Key, true);
                        tokenMatched = true;
                        break;
                    }
                    if (field.Value.IndexOf(token, StringComparison.OrdinalIgnoreCase) >= 0)
                    {
                        matchedFields.Add(field.Key + ":tokenContains");
                        score += TokenScore(field.Key, false);
                        tokenMatched = true;
                        break;
                    }
                }
                if (!tokenMatched)
                {
                    return;
                }
            }

            result.Score += score;
            result.Fields.Add("queryTokens:all");
            foreach (string field in matchedFields)
            {
                if (!result.Fields.Contains(field))
                {
                    result.Fields.Add(field);
                }
            }
        }

        private static string[] SplitSearchTokens(string query)
        {
            return (query ?? "")
                .Split(new[] { ' ', '\t', '\r', '\n', '-', '_', '/', '\\' }, StringSplitOptions.RemoveEmptyEntries)
                .Select(t => t.Trim())
                .Where(t => t.Length >= 2)
                .Distinct(StringComparer.OrdinalIgnoreCase)
                .ToArray();
        }

        private static int TokenScore(string fieldName, bool exact)
        {
            int baseScore;
            switch (fieldName)
            {
                case "id":
                    baseScore = 180;
                    break;
                case "uniqueId":
                    baseScore = 160;
                    break;
                case "mark":
                    baseScore = 150;
                    break;
                case "family":
                    baseScore = 130;
                    break;
                case "type":
                    baseScore = 125;
                    break;
                case "name":
                    baseScore = 110;
                    break;
                case "category":
                    baseScore = 80;
                    break;
                default:
                    baseScore = 50;
                    break;
            }
            return exact ? baseScore * 2 : baseScore;
        }

        private static string BuildMatchConfidence(int score)
        {
            if (score >= 800)
            {
                return "high";
            }
            if (score >= 350)
            {
                return "medium";
            }
            if (score > 0)
            {
                return "low";
            }

            return "none";
        }
    }
}
