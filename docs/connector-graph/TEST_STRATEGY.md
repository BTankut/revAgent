# Connector Graph Test Strategy

The connector graph foundation is tested without Revit first. Revit extraction
branches should consume the same schema and add live-model smoke tests only
after their read-only extractor code exists.

## Local Test Entrypoints

Run only connector graph checks:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\test-connector-graph.ps1
```

Run the aggregate non-Revit suite:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\test-all.ps1
```

If C# Revit add-in code is changed, also run the Revit 2022 build check:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\build-revit-plugin.ps1 -RevitVersion 2022 -SkipPayloadCopy
```

## Coverage

The `MepConnectorGraph.Tests` runner builds against .NET Framework 4.8 and
checks:

- schema fixture loading and enum serialization.
- deterministic JSON round trip behavior.
- tree traversal readiness.
- cycle detection.
- disconnected network and island detection.
- ambiguous direction and missing system data findings.
- invalid edge endpoint structural errors.
- Revit internal unit conversion helpers.

The fixture set is intentionally small. It should remain easy to inspect during
PR review and stable enough for downstream branches to use as compatibility
tests.

## Branch Requirements

Any branch that emits or consumes connector graph JSON should add at least one
test in one of these forms:

- Pure unit test against `MepConnectorGraph`.
- Fixture test under `tests/fixtures/connector-graph/`.
- Read-only Revit smoke test that exports JSON and validates it with
  `TopologyValidator`.

Branches must not silently coerce invalid topology. Open ends, disconnected
islands, cycles, missing system data, and direction ambiguity must be reported
with findings.

## Reviewer Checklist

- The JSON still uses `schemaVersion: "mep.connector-graph.v1"` unless the PR is
  an intentional schema migration.
- New fields are optional or covered by a migration note.
- Revit 2022 and .NET Framework 4.8 compatibility is preserved.
- Production code does not introduce Neo4j, NetworkX, external services, or
  runtime dependencies outside the repo's existing deployment model.
- New extractor logic is read-only unless an explicit dry-run/visualization flag
  is documented and tested.
- Fixture JSON is deterministic and reviewable.
- `scripts/test-connector-graph.ps1` passes.
- `scripts/test-all.ps1` passes before merge.
