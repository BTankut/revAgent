import assert from "node:assert/strict";
import { adaptScheduleSource } from "../build/tools/reconcile_schedule_adapter.js";
import {
  normalizeReconciliationText,
  tokenizeReconciliationText,
} from "../build/tools/reconcile_normalization.js";

const realShapeResult = {
  Success: true,
  Guarded: false,
  Partial: false,
  ScanStoppedReason: "completed",
  Warnings: ["native warning"],
  Schedules: [
    {
      Id: 202,
      Name: "Mechanical Equipment Schedule",
      Sections: [
        {
          Section: "Header",
          Rows: [
            {
              Row: 0,
              Cells: [
                { Column: 0, Text: "Mark" },
                { Column: 1, Text: "Description" },
                { Column: 2, Text: "Unit" },
              ],
            },
          ],
        },
        {
          Section: "Body",
          Rows: [
            {
              Row: 0,
              Cells: [
                { Column: 0, Text: "Number" },
                { Column: 1, Text: "Name" },
                { Column: 2, Text: "Unit" },
              ],
            },
            {
              Row: 1,
              Cells: [
                { Column: 0, Text: "FCU-01" },
                { Column: 1, Text: "Fan coil \u00d8100 1,5 l/s" },
                { Column: 2, Text: "adet" },
              ],
            },
            {
              Row: 2,
              Cells: [
                { Column: 0, Text: "QHK-310" },
                { Column: 1, Text: "Damper \u0410\u0412\u0421 2 m\u00b3/h" },
                { Column: 2, Text: "pcs" },
              ],
            },
          ],
        },
      ],
    },
  ],
};

const adapted = await adaptScheduleSource({
  kind: "inspect_schedules_result",
  result: realShapeResult,
});

assert.equal(adapted.success, true);
assert.equal(adapted.guarded, false);
assert.equal(adapted.partial, false);
assert.equal(adapted.scanStoppedReason, "completed");
assert.equal(adapted.visibilityBasis, "displayedScheduleCells");
assert.equal(adapted.scheduleRecords.length, 2);
assert.equal(adapted.summary.scheduleRecordCount, 2);
assert.equal(adapted.summary.skippedHeaderLikeRows, 1);
assert.equal(adapted.evidenceRows.length, 2);
assert.equal(adapted.warnings[0], "native warning");
assert.match(adapted.notices.join("\n"), /Skipped 1 header-like body row/);

const firstRecord = adapted.scheduleRecords[0];
assert.equal(firstRecord.scheduleRowId, "202:body:1");
assert.equal(firstRecord.scheduleId, "202");
assert.equal(firstRecord.scheduleName, "Mechanical Equipment Schedule");
assert.equal(firstRecord.identityText, "FCU-01");
assert.equal(firstRecord.comparisonText, "Fan coil \u00d8100 1,5 l/s");
assert.match(firstRecord.normalizedKey, /FCU 01/);
assert.match(firstRecord.normalizedKey, /DN 100/);
assert.match(firstRecord.normalizedKey, /1\.5 LPS/);
assert.deepEqual(
  firstRecord.tokenProfile.tokens
    .filter((token) => ["code", "dimension"].includes(token.type))
    .map((token) => `${token.type}:${token.value}`),
  ["code:FCU01", "dimension:DN100", "dimension:1.5LPS"],
);

const secondRecord = adapted.scheduleRecords[1];
assert.match(secondRecord.normalizedKey, /ABC/);
assert.equal(secondRecord.tokenProfile.tokens.some((token) => token.type === "dimension" && token.value === "2M3H"), true);

const fallbackHeadersDoNotOverrideActualHeaders = await adaptScheduleSource({
  kind: "inspect_schedules_result",
  result: realShapeResult,
  columnHeaders: ["Wrong identity", "Wrong comparison"],
});
assert.equal(fallbackHeadersDoNotOverrideActualHeaders.success, true);
assert.equal(fallbackHeadersDoNotOverrideActualHeaders.guarded, false);
assert.equal(fallbackHeadersDoNotOverrideActualHeaders.scheduleRecords.length, 2);

const scheduleWithoutHeaderSection = {
  success: true,
  schedules: [
    {
      id: 606,
      name: "Electrical Circuit Schedule",
      sections: [
        {
          section: "body",
          rows: [
            {
              row: 1,
              cells: [
                { column: 0, text: "Distribution Board" },
                { column: 1, text: "LP-01" },
                { column: 2, text: "C-12" },
              ],
            },
          ],
        },
      ],
    },
  ],
};

const fallbackHeaderMapByName = await adaptScheduleSource({
  kind: "inspect_schedules_result",
  result: scheduleWithoutHeaderSection,
  columnHeaders: { "Family and Type": 0, Panel: 1, "Circuit Number": 2 },
  columnMapping: { identity: "Family and Type", comparisonText: "Family and Type" },
});
assert.equal(fallbackHeaderMapByName.success, true);
assert.equal(fallbackHeaderMapByName.guarded, false);
assert.equal(fallbackHeaderMapByName.scheduleRecords[0].identityText, "Distribution Board");
assert.equal(fallbackHeaderMapByName.scheduleRecords[0].comparisonText, "Distribution Board");

const fallbackHeaderMapByIndex = await adaptScheduleSource({
  kind: "inspect_schedules_result",
  result: scheduleWithoutHeaderSection,
  columnHeaders: { "0": "Family and Type", "1": "Panel", "2": "Circuit Number" },
  columnMapping: { identity: "Family and Type", comparisonText: "Family and Type" },
});
assert.equal(fallbackHeaderMapByIndex.success, true);
assert.equal(fallbackHeaderMapByIndex.guarded, false);
assert.equal(fallbackHeaderMapByIndex.scheduleRecords[0].identityText, "Distribution Board");

const partialResult = {
  success: true,
  partial: true,
  scanStoppedReason: "max_rows",
  lastReadSection: "body",
  lastReadRow: 10,
  lastReadColumn: 1,
  lastReadItemId: 303,
  schedules: [
    {
      id: 303,
      name: "Partial Schedule",
      sections: [
        {
          section: "header",
          cells: [
            {
              row: 0,
              cells: [
                { column: 0, text: "Identity" },
                { column: 1, text: "Description" },
              ],
            },
          ],
        },
        {
          section: "body",
          cells: [
            {
              row: 10,
              cells: [
                { column: 0, text: "P-01" },
                { column: 1, text: "Partial row" },
              ],
            },
          ],
        },
      ],
    },
  ],
};

const partialAdapted = await adaptScheduleSource({
  kind: "inspect_schedules_result",
  result: partialResult,
});

assert.equal(partialAdapted.success, true);
assert.equal(partialAdapted.partial, true);
assert.equal(partialAdapted.scanStoppedReason, "max_rows");
assert.equal(partialAdapted.lastReadSection, "body");
assert.equal(partialAdapted.lastReadRow, 10);
assert.equal(partialAdapted.lastReadColumn, 1);
assert.equal(partialAdapted.lastReadItemId, 303);
assert.equal(partialAdapted.scheduleRecords[0].scheduleRowId, "303:body:10");

const explicitMapping = await adaptScheduleSource({
  kind: "inspect_schedules_result",
  result: {
    success: true,
    schedules: [
      {
        id: 404,
        name: "No Header",
        sections: [
          {
            section: "body",
            rows: [
              {
                row: 5,
                cells: [
                  { column: 0, text: "NH-01" },
                  { column: 1, text: "No header row" },
                ],
              },
            ],
          },
        ],
      },
    ],
  },
  columnMapping: { identity: 0, comparisonText: 1 },
});
assert.equal(explicitMapping.success, true);
assert.equal(explicitMapping.guarded, false);
assert.equal(explicitMapping.scheduleRecords[0].scheduleRowId, "404:body:5");

const outOfBoundsExplicitMapping = await adaptScheduleSource({
  kind: "inspect_schedules_result",
  result: realShapeResult,
  columnMapping: { identity: 0, comparisonText: 99 },
});
assert.equal(outOfBoundsExplicitMapping.success, true);
assert.equal(outOfBoundsExplicitMapping.guarded, true);
assert.equal(outOfBoundsExplicitMapping.reason, "schedule_column_mapping_required");
assert.equal(outOfBoundsExplicitMapping.mappingError.reason, "unresolved_column_ref");

const mappingGuard = await adaptScheduleSource({
  kind: "inspect_schedules_result",
  result: {
    success: true,
    schedules: [
      {
        id: 505,
        name: "Needs Mapping",
        sections: [
          {
            section: "body",
            rows: [
              {
                row: 1,
                cells: [{ column: 0, text: "Only body" }],
              },
            ],
          },
        ],
      },
    ],
  },
});
assert.equal(mappingGuard.success, true);
assert.equal(mappingGuard.guarded, true);
assert.equal(mappingGuard.reason, "schedule_column_mapping_required");
assert.equal(mappingGuard.scanStoppedReason, "needs_scope");

const missingScopeRevitMode = await adaptScheduleSource({
  kind: "revit_schedule",
  columnMapping: { identity: 0, comparisonText: 1 },
});
assert.equal(missingScopeRevitMode.success, true);
assert.equal(missingScopeRevitMode.guarded, true);
assert.equal(missingScopeRevitMode.reason, "needs_scope");
assert.match(missingScopeRevitMode.message, /scheduleIds or nameQuery/);

const liveRevitMode = await adaptScheduleSource({
  kind: "revit_schedule",
  scheduleIds: [202],
  columnMapping: { identity: 0, comparisonText: 1 },
}, {
  sendCommand: async (commandName, params) => {
    assert.equal(commandName, "inspect_schedules");
    assert.deepEqual(params.scheduleIds, [202]);
    assert.equal(params.includeCells, true);
    assert.equal(params.responseMode, "full");
    assert.deepEqual(params.sections, ["header", "body"]);
    return { result: realShapeResult };
  },
});
assert.equal(liveRevitMode.success, true);
assert.equal(liveRevitMode.guarded, false);
assert.equal(liveRevitMode.sourceKind, "revit_schedule");
assert.equal(liveRevitMode.bridgeSourceKind, "inspect_schedules_result");
assert.equal(liveRevitMode.scanPolicy.bridgeExecution, "inspect_schedules");
assert.equal(liveRevitMode.scheduleRecords.length, 2);
assert.match(liveRevitMode.notices.join("\n"), /bounded inspect_schedules/);

assert.equal(normalizeReconciliationText("  Fan\tcoil -- DN\u00a0100  "), "FAN COIL DN 100");
assert.equal(normalizeReconciliationText("i I \u0131 \u0130"), "I I I I");
assert.equal(normalizeReconciliationText("T\u00fcrk\u00e7e a\u00e7\u0131klama"), "TURKCE ACIKLAMA");
assert.equal(normalizeReconciliationText("\u0410\u0412\u0421"), "ABC");
assert.equal(normalizeReconciliationText("\u00d8100"), "DN 100");
assert.equal(normalizeReconciliationText("1,5 l/s 2 m\u00b3/h 5 kcal/h"), "1.5 LPS 2 M3H 5 KCALH");
assert.equal(normalizeReconciliationText("FCU-01 -- fan/coil"), "FCU 01 FAN COIL");

assert.deepEqual(
  tokenizeReconciliationText("FCU-01 \u00d8100 1,5 l/s Fan").map((token) => `${token.type}:${token.value}`),
  ["code:FCU01", "dimension:DN100", "dimension:1.5LPS", "word:FAN"],
);

console.log("schedule adapter tests passed");
