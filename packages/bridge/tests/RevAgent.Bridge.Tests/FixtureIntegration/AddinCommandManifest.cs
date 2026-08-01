using Newtonsoft.Json;
using Newtonsoft.Json.Linq;

namespace RevAgent.Bridge.Tests.FixtureIntegration;

/// <summary>
/// The source of truth for the P3-T3 "all 21 commands" acceptance clause:
/// <c>src/revit-plugin/revAgentCommandSet/command.json</c>, the manifest the
/// add-in's <c>CommandManager</c> actually loads.
/// </summary>
/// <remarks>
/// The manifest carries 23 entries. Twenty-one are the shipped command set
/// documented in <c>docs/implementation-plan/appendix/E2-addin-map.md</c>; the
/// remaining two, <c>execute_batch</c> and <c>get_document_context</c>, are the
/// additive O1 loopback protocol methods (P-ADDIN-3 and P-BRIDGE-5) rather than
/// members of the 21-command inventory.
/// </remarks>
internal static class AddinCommandManifest
{
    /// <summary>
    /// The 21-command inventory as documented by the E2 add-in map. The
    /// manifest, not this list, drives the tests; this list exists so a
    /// manifest drift fails loudly.
    /// </summary>
    internal static IReadOnlyList<string> DocumentedCommands { get; } = new[]
    {
        "get_current_view_elements",
        "get_current_view_info",
        "get_selected_elements",
        "send_code_to_revit",
        "list_open_views",
        "activate_view",
        "close_view",
        "clear_selection",
        "delete_review_view",
        "get_ui_state",
        "find_elements",
        "inspect_levels",
        "inspect_sheet_text",
        "inspect_schedules",
        "count_annotations",
        "extract_spatial_snapshot",
        "get_spatial_change_state",
        "open_existing_plan_for_element_level",
        "focus_elements",
        "section_box_elements",
        "create_3d_view_for_elements",
    };

    /// <summary>
    /// The additive O1 loopback protocol methods that share the manifest with
    /// the 21 commands.
    /// </summary>
    internal static IReadOnlyList<string> ProtocolAdditions { get; } = new[]
    {
        "execute_batch",
        "get_document_context",
    };

    /// <summary>
    /// Commands the O1-T3 fixture answers with a completed ordinary result:
    /// the thirteen advertised batchable descriptors plus the fixture's own
    /// <c>send_code_to_revit</c> handler
    /// (<c>packages/addin-loopback-fixture/src/schemaValidation.ts</c> and
    /// <c>src/fixture.ts</c>).
    /// </summary>
    internal static IReadOnlyList<string> FixtureAnsweredCommands { get; } = new[]
    {
        "get_current_view_elements",
        "get_current_view_info",
        "get_selected_elements",
        "send_code_to_revit",
        "list_open_views",
        "delete_review_view",
        "get_ui_state",
        "find_elements",
        "inspect_levels",
        "inspect_sheet_text",
        "inspect_schedules",
        "count_annotations",
        "extract_spatial_snapshot",
        "get_spatial_change_state",
    };

    /// <summary>
    /// Reads every <c>commandName</c> from the add-in command manifest.
    /// </summary>
    internal static IReadOnlyList<string> ReadManifestCommandNames()
    {
        string path = Path.Combine(
            AddinLoopbackFixtureProcess.FindRepositoryRoot(),
            "src",
            "revit-plugin",
            "revAgentCommandSet",
            "command.json");
        using var textReader = File.OpenText(path);
        using var jsonReader = new JsonTextReader(textReader)
        {
            DateParseHandling = DateParseHandling.None,
            FloatParseHandling = FloatParseHandling.Decimal,
        };
        JObject manifest = JObject.Load(jsonReader);
        var commands = manifest["commands"] as JArray ??
            throw new InvalidOperationException(
                "The add-in command manifest omitted the commands array.");

        var names = new List<string>(commands.Count);
        foreach (JToken entry in commands)
        {
            var command = entry as JObject ??
                throw new InvalidOperationException(
                    "An add-in command manifest entry was not an object.");
            names.Add(
                command.Value<string>("commandName") ??
                throw new InvalidOperationException(
                    "An add-in command manifest entry omitted commandName."));
        }

        return names;
    }

    /// <summary>
    /// The manifest-derived 21-command inventory: every manifest command that
    /// is not one of the additive O1 protocol methods.
    /// </summary>
    internal static IReadOnlyList<string> ReadTwentyOneCommands()
    {
        var additions = new HashSet<string>(
            ProtocolAdditions,
            StringComparer.Ordinal);
        return ReadManifestCommandNames()
            .Where(name => !additions.Contains(name))
            .ToList();
    }
}
