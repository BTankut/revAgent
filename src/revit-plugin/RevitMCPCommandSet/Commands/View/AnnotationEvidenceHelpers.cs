using Autodesk.Revit.DB;
using RevitMCPCommandSet.Extensions;
using System;
using System.Collections;
using System.Collections.Generic;
using System.Globalization;
using System.Text;

namespace RevitMCPCommandSet.Commands.View
{
    internal enum AnnotationEvidenceByteEstimateKind
    {
        SheetText,
        Schedule
    }

    internal static class AnnotationEvidenceHelpers
    {
        public static List<string> BuildSheetTextSuggestedNextScopes()
        {
            return new List<string>
            {
                "sheetQuery",
                "sheetIds",
                "viewNameQuery",
                "maxSheets",
                "allowExpensiveSearch",
                "searchBudget=deep"
            };
        }

        public static List<string> BuildScheduleSuggestedNextScopes()
        {
            return new List<string>
            {
                "nameQuery",
                "scheduleIds",
                "sections",
                "startRow",
                "startColumn",
                "maxRowsPerSection",
                "maxColumnsPerSection",
                "maxCells",
                "maxResponseBytes",
                "maxElapsedMs",
                "allowExpensiveSearch"
            };
        }

        public static Dictionary<string, object> BuildTextNoteRecord(
            string kind,
            ViewSheet sheet,
            Viewport viewport,
            Autodesk.Revit.DB.View view,
            TextNote textNote,
            string text,
            int maxTextChars)
        {
            Dictionary<string, object> record = new Dictionary<string, object>();
            record["kind"] = kind;
            record["id"] = textNote.Id.GetIdValue();
            record["elementId"] = textNote.Id.GetIdValue();
            record["uniqueId"] = textNote.UniqueId;
            record["sheetId"] = sheet.Id.GetIdValue();
            record["sheetNumber"] = sheet.SheetNumber;
            record["sheetName"] = sheet.Name;
            if (viewport != null)
            {
                record["viewportId"] = viewport.Id.GetIdValue();
            }
            if (view != null)
            {
                record["viewId"] = view.Id.GetIdValue();
                record["viewName"] = view.Name;
                record["viewType"] = view.ViewType.ToString();
            }
            record["text"] = TrimText(text, maxTextChars);
            record["textNormalized"] = NormalizeForSearch(text);
            record["point"] = PointInfo(textNote.Coord);
            record["box"] = BoxInfo(SafeBoundingBox(textNote, view ?? sheet));
            return record;
        }

        public static Dictionary<string, object> BuildScheduleInstanceRecord(
            ViewSheet sheet,
            ScheduleSheetInstance instance,
            ViewSchedule schedule,
            Dictionary<string, object> cellScan)
        {
            Dictionary<string, object> record = new Dictionary<string, object>();
            record["kind"] = "scheduleInstance";
            record["sheetId"] = sheet.Id.GetIdValue();
            record["sheetNumber"] = sheet.SheetNumber;
            record["sheetName"] = sheet.Name;
            record["instanceId"] = instance.Id.GetIdValue();
            record["uniqueId"] = instance.UniqueId;
            record["scheduleId"] = instance.ScheduleId.GetIdValue();
            record["scheduleName"] = schedule != null ? schedule.Name : "";
            record["isTitleblockRevisionSchedule"] = IsRevisionScheduleInstance(instance);
            record["point"] = ScheduleInstancePointInfo(instance);
            record["box"] = BoxInfo(SafeBoundingBox(instance, sheet));
            record["cellScan"] = cellScan;
            return record;
        }

        public static Dictionary<string, object> BuildViewportRecord(ViewSheet sheet, Viewport viewport, Autodesk.Revit.DB.View view)
        {
            Dictionary<string, object> record = new Dictionary<string, object>();
            record["sheetId"] = sheet.Id.GetIdValue();
            record["sheetNumber"] = sheet.SheetNumber;
            record["sheetName"] = sheet.Name;
            record["viewportId"] = viewport.Id.GetIdValue();
            record["viewId"] = view.Id.GetIdValue();
            record["viewName"] = view.Name;
            record["viewType"] = view.ViewType.ToString();
            record["scale"] = view.Scale;
            record["boxCenter"] = PointInfo(SafeViewportBoxCenter(viewport));
            record["box"] = SafeViewportBox(viewport);
            return record;
        }

        public static Dictionary<string, object> BuildViewportTagRecord(
            Document document,
            ViewSheet sheet,
            Viewport viewport,
            Autodesk.Revit.DB.View view,
            IndependentTag tag,
            string tagText,
            int maxTextChars,
            List<string> warnings)
        {
            Dictionary<string, object> record = new Dictionary<string, object>();
            record["kind"] = "viewportTag";
            record["id"] = tag.Id.GetIdValue();
            record["elementId"] = tag.Id.GetIdValue();
            record["tagId"] = tag.Id.GetIdValue();
            record["uniqueId"] = tag.UniqueId;
            record["sheetId"] = sheet.Id.GetIdValue();
            record["sheetNumber"] = sheet.SheetNumber;
            record["sheetName"] = sheet.Name;
            record["viewportId"] = viewport.Id.GetIdValue();
            record["viewId"] = view.Id.GetIdValue();
            record["viewName"] = view.Name;
            record["viewType"] = view.ViewType.ToString();
            record["tagText"] = TrimText(tagText, maxTextChars);
            record["tagTextNormalized"] = NormalizeForSearch(tagText);
            record["text"] = TrimText(tagText, maxTextChars);
            record["textNormalized"] = NormalizeForSearch(tagText);
            record["box"] = BoxInfo(SafeBoundingBox(tag, view));

            Element tagType = SafeGetElement(document, tag.GetTypeId());
            if (tagType != null)
            {
                record["tagFamilyName"] = FamilyNameForElement(tagType);
                record["tagTypeName"] = SafeElementName(tagType);
            }

            ElementId taggedElementId = ResolveTaggedLocalElementId(tag, warnings);
            if (taggedElementId == null || taggedElementId == ElementId.InvalidElementId)
            {
                record["taggedElementResolved"] = false;
                AddOnce(warnings, "viewport_tag_tagged_element_unresolved");
                return record;
            }

            record["taggedElementId"] = taggedElementId.GetIdValue();
            Element taggedElement = SafeGetElement(document, taggedElementId);
            if (taggedElement == null)
            {
                record["taggedElementResolved"] = false;
                AddOnce(warnings, "viewport_tag_tagged_element_not_found");
                return record;
            }

            record["taggedElementResolved"] = true;
            record["taggedCategory"] = taggedElement.Category != null ? taggedElement.Category.Name : "";
            record["taggedFamilyName"] = FamilyNameForElement(taggedElement);
            record["taggedTypeName"] = TypeNameForElement(document, taggedElement);
            return record;
        }

        public static Dictionary<string, object> BuildScheduleCellScan(
            int scannedRows,
            int scannedColumns,
            bool truncated,
            List<Dictionary<string, object>> matches,
            bool readFailed,
            string readError)
        {
            Dictionary<string, object> scan = new Dictionary<string, object>();
            scan["scannedRows"] = scannedRows;
            scan["scannedColumns"] = scannedColumns;
            scan["truncated"] = truncated;
            scan["matchCount"] = matches.Count;
            scan["matches"] = matches;
            scan["readFailed"] = readFailed;
            scan["readError"] = readError;
            return scan;
        }

        public static Dictionary<string, object> BuildScheduleRecord(
            ViewSchedule schedule,
            bool nameMatches,
            int matchCount,
            List<Dictionary<string, object>> sections)
        {
            Dictionary<string, object> record = new Dictionary<string, object>();
            record["id"] = schedule.Id.GetIdValue();
            record["uniqueId"] = schedule.UniqueId;
            record["name"] = schedule.Name;
            record["viewType"] = schedule.ViewType.ToString();
            record["isTemplate"] = schedule.IsTemplate;
            record["nameMatched"] = nameMatches;
            record["cellMatchCount"] = matchCount;
            record["sections"] = sections;
            return record;
        }

        public static Dictionary<string, object> BuildScheduleCellEvidenceRow(ViewSchedule schedule, Dictionary<string, object> match)
        {
            Dictionary<string, object> flat = new Dictionary<string, object>();
            flat["kind"] = "scheduleCell";
            flat["scheduleId"] = schedule.Id.GetIdValue();
            flat["scheduleName"] = schedule.Name;
            flat["section"] = match.ContainsKey("section") ? match["section"] : "";
            flat["row"] = match.ContainsKey("row") ? match["row"] : null;
            flat["column"] = match.ContainsKey("column") ? match["column"] : null;
            flat["text"] = match.ContainsKey("text") ? match["text"] : "";
            return flat;
        }

        public static Dictionary<string, object> BuildPlacedScheduleCellEvidenceRow(
            ViewSheet sheet,
            ScheduleSheetInstance instance,
            ViewSchedule schedule,
            int row,
            int column,
            string text,
            int maxTextChars)
        {
            Dictionary<string, object> flat = new Dictionary<string, object>();
            flat["kind"] = "scheduleCell";
            flat["sheetId"] = sheet.Id.GetIdValue();
            flat["sheetNumber"] = sheet.SheetNumber;
            flat["sheetName"] = sheet.Name;
            flat["scheduleInstanceId"] = instance.Id.GetIdValue();
            flat["scheduleId"] = schedule.Id.GetIdValue();
            flat["scheduleName"] = schedule.Name;
            flat["section"] = "body";
            flat["row"] = row;
            flat["column"] = column;
            flat["text"] = TrimText(text, maxTextChars);
            flat["textNormalized"] = NormalizeForSearch(text);
            return flat;
        }

        public static Dictionary<string, object> BuildScheduleCellMatch(string section, int row, int column, string text, int maxTextChars)
        {
            Dictionary<string, object> cell = new Dictionary<string, object>();
            cell["section"] = section;
            cell["row"] = row;
            cell["column"] = column;
            cell["text"] = TrimText(text, maxTextChars);
            return cell;
        }

        public static Dictionary<string, object> CloneRecord(Dictionary<string, object> record)
        {
            return new Dictionary<string, object>(record);
        }

        public static string TrimText(string value, int maxTextChars)
        {
            if (value == null) return "";
            value = value.Replace("\r", " ").Replace("\n", " ").Replace("\t", " ").Trim();
            if (maxTextChars <= 0) return "...";
            if (value.Length <= maxTextChars) return value;
            return value.Substring(0, maxTextChars) + "...";
        }

        public static string SafeText(TextNote textNote)
        {
            try
            {
                return textNote.Text ?? "";
            }
            catch
            {
                return "";
            }
        }

        public static string ReadScheduleCell(ViewSchedule schedule, SectionType sectionType, int row, int column)
        {
            try
            {
                return schedule.GetCellText(sectionType, row, column) ?? "";
            }
            catch
            {
                return "";
            }
        }

        public static bool ContainsPreNormalized(string value, string normalizedQuery)
        {
            if (string.IsNullOrWhiteSpace(normalizedQuery)) return true;
            return NormalizeForSearch(value).Contains(normalizedQuery);
        }

        public static string NormalizeForSearch(string value)
        {
            if (value == null) return "";
            string form = value.Normalize(NormalizationForm.FormD);
            StringBuilder builder = new StringBuilder(form.Length);
            foreach (char ch in form)
            {
                UnicodeCategory category = CharUnicodeInfo.GetUnicodeCategory(ch);
                if (category != UnicodeCategory.NonSpacingMark)
                {
                    char mapped = ch;
                    if (mapped == '\u0423' || mapped == '\u0443')
                    {
                        mapped = 'y';
                    }
                    else if (mapped == '\u0131')
                    {
                        mapped = 'i';
                    }

                    builder.Append(char.ToLowerInvariant(mapped));
                }
            }
            return builder.ToString();
        }

        public static SectionType SectionTypeForName(string sectionName)
        {
            string normalized = NormalizeSectionName(sectionName);
            if (normalized == "footer") return SectionType.Footer;
            if (normalized == "body") return SectionType.Body;
            return SectionType.Header;
        }

        public static string NormalizeSectionName(string sectionName)
        {
            string normalized = (sectionName ?? "").Trim().ToLowerInvariant();
            if (normalized == "footer" || normalized == "body" || normalized == "header")
            {
                return normalized;
            }
            return "header";
        }

        public static string SafeTagText(IndependentTag tag, List<string> warnings)
        {
            try
            {
                return tag != null ? tag.TagText ?? "" : "";
            }
            catch
            {
                AddOnce(warnings, "viewport_tag_text_read_failed");
                return "";
            }
        }

        public static void AddOnce(List<string> values, string value)
        {
            if (values == null || string.IsNullOrWhiteSpace(value)) return;
            if (!values.Contains(value))
            {
                values.Add(value);
            }
        }

        public static int EstimateObjectBytes(object value, AnnotationEvidenceByteEstimateKind kind)
        {
            if (value == null) return 4;
            string text = value as string;
            if (text != null)
            {
                return kind == AnnotationEvidenceByteEstimateKind.Schedule
                    ? (text.Length * 2) + 8
                    : 16 + (text.Length * 2);
            }
            if (value is bool)
            {
                return kind == AnnotationEvidenceByteEstimateKind.Schedule ? 5 : 32;
            }
            if (value is int || value is long || value is double || value is float || value is decimal)
            {
                return kind == AnnotationEvidenceByteEstimateKind.Schedule ? 16 : 32;
            }

            IDictionary dictionary = value as IDictionary;
            if (dictionary != null)
            {
                int total = kind == AnnotationEvidenceByteEstimateKind.Schedule ? 16 : 32;
                foreach (DictionaryEntry entry in dictionary)
                {
                    if (kind == AnnotationEvidenceByteEstimateKind.Schedule)
                    {
                        string key = entry.Key != null ? entry.Key.ToString() : "";
                        total += (key.Length * 2) + EstimateObjectBytes(entry.Value, kind) + 12;
                    }
                    else
                    {
                        total += 8 + EstimateObjectBytes(entry.Key, kind) + EstimateObjectBytes(entry.Value, kind);
                    }
                }
                return total;
            }

            IEnumerable enumerable = value as IEnumerable;
            if (enumerable != null)
            {
                int total = kind == AnnotationEvidenceByteEstimateKind.Schedule ? 16 : 32;
                foreach (object item in enumerable)
                {
                    total += EstimateObjectBytes(item, kind) + (kind == AnnotationEvidenceByteEstimateKind.Schedule ? 4 : 0);
                }
                return total;
            }

            return kind == AnnotationEvidenceByteEstimateKind.Schedule
                ? 128
                : 64 + (Convert.ToString(value, CultureInfo.InvariantCulture) ?? "").Length * 2;
        }

        private static Dictionary<string, object> PointInfo(XYZ point)
        {
            if (point == null) return null;
            Dictionary<string, object> result = new Dictionary<string, object>();
            result["x"] = Math.Round(point.X, 6);
            result["y"] = Math.Round(point.Y, 6);
            result["z"] = Math.Round(point.Z, 6);
            return result;
        }

        private static Dictionary<string, object> BoxInfo(BoundingBoxXYZ box)
        {
            if (box == null) return null;
            return BoxFromPoints(box.Min, box.Max);
        }

        private static Dictionary<string, object> BoxFromPoints(XYZ min, XYZ max)
        {
            Dictionary<string, object> result = new Dictionary<string, object>();
            result["min"] = PointInfo(min);
            result["max"] = PointInfo(max);
            return result;
        }

        private static XYZ SafeViewportBoxCenter(Viewport viewport)
        {
            try
            {
                return viewport.GetBoxCenter();
            }
            catch
            {
                return null;
            }
        }

        private static Dictionary<string, object> SafeViewportBox(Viewport viewport)
        {
            try
            {
                Outline outline = viewport.GetBoxOutline();
                return BoxFromPoints(outline.MinimumPoint, outline.MaximumPoint);
            }
            catch
            {
                return null;
            }
        }

        private static Dictionary<string, object> ScheduleInstancePointInfo(ScheduleSheetInstance instance)
        {
            try
            {
                System.Reflection.PropertyInfo pointProperty = instance.GetType().GetProperty("Point");
                if (pointProperty == null) return null;
                return PointInfo(pointProperty.GetValue(instance, null) as XYZ);
            }
            catch
            {
                return null;
            }
        }

        private static bool IsRevisionScheduleInstance(ScheduleSheetInstance instance)
        {
            try
            {
                System.Reflection.PropertyInfo revisionProperty = instance.GetType().GetProperty("IsTitleblockRevisionSchedule");
                if (revisionProperty == null) return false;
                object value = revisionProperty.GetValue(instance, null);
                return value is bool && (bool)value;
            }
            catch
            {
                return false;
            }
        }

        private static Element SafeGetElement(Document document, ElementId id)
        {
            try
            {
                if (document == null || id == null || id == ElementId.InvalidElementId) return null;
                return document.GetElement(id);
            }
            catch
            {
                return null;
            }
        }

        private static BoundingBoxXYZ SafeBoundingBox(Element element, Autodesk.Revit.DB.View view)
        {
            try
            {
                return element != null ? element.get_BoundingBox(view) : null;
            }
            catch
            {
                return null;
            }
        }

        private static string SafeElementName(Element element)
        {
            try
            {
                return element != null ? element.Name ?? "" : "";
            }
            catch
            {
                return "";
            }
        }

        private static string FamilyNameForElement(Element element)
        {
            try
            {
                if (element == null) return "";

                ElementType type = element as ElementType;
                if (type != null)
                {
                    return type.FamilyName ?? "";
                }

                FamilyInstance instance = element as FamilyInstance;
                if (instance != null && instance.Symbol != null)
                {
                    return instance.Symbol.FamilyName ?? "";
                }
            }
            catch
            {
                return "";
            }

            return "";
        }

        private static string TypeNameForElement(Document document, Element element)
        {
            try
            {
                if (document == null || element == null) return "";
                ElementId typeId = element.GetTypeId();
                Element typeElement = SafeGetElement(document, typeId);
                return SafeElementName(typeElement);
            }
            catch
            {
                return "";
            }
        }

        private static ElementId ResolveTaggedLocalElementId(IndependentTag tag, List<string> warnings)
        {
            if (tag == null) return null;

            try
            {
                System.Reflection.MethodInfo method = tag.GetType().GetMethod("GetTaggedLocalElementIds", Type.EmptyTypes);
                if (method != null)
                {
                    IEnumerable ids = method.Invoke(tag, null) as IEnumerable;
                    if (ids != null)
                    {
                        foreach (object item in ids)
                        {
                            ElementId id = item as ElementId;
                            if (id != null && id != ElementId.InvalidElementId)
                            {
                                return id;
                            }
                        }
                    }
                }
            }
            catch
            {
                AddOnce(warnings, "viewport_tag_tagged_local_element_ids_read_failed");
            }

            try
            {
                System.Reflection.MethodInfo method = tag.GetType().GetMethod("GetTaggedElementIds", Type.EmptyTypes);
                if (method != null)
                {
                    IEnumerable ids = method.Invoke(tag, null) as IEnumerable;
                    if (ids != null)
                    {
                        foreach (object item in ids)
                        {
                            ElementId linkedId = TryReadElementIdProperty(item, "LinkedElementId");
                            if (linkedId != null && linkedId != ElementId.InvalidElementId)
                            {
                                AddOnce(warnings, "viewport_tag_linked_element_unresolved");
                                continue;
                            }

                            ElementId hostId = TryReadElementIdProperty(item, "HostElementId");
                            if (hostId != null && hostId != ElementId.InvalidElementId)
                            {
                                return hostId;
                            }
                        }
                    }
                }
            }
            catch
            {
                AddOnce(warnings, "viewport_tag_tagged_element_ids_read_failed");
            }

            return null;
        }

        private static ElementId TryReadElementIdProperty(object value, string propertyName)
        {
            try
            {
                if (value == null) return null;
                System.Reflection.PropertyInfo property = value.GetType().GetProperty(propertyName);
                if (property == null) return null;
                return property.GetValue(value, null) as ElementId;
            }
            catch
            {
                return null;
            }
        }
    }
}
