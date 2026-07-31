using System.Text.Json;

namespace RevAgent.Bridge.Gateway.Protocol;

internal static class RbpPayloadValidator
{
    internal static IReadOnlyDictionary<string, string> FrozenSchemaDigests =>
        RbpFrozenSchemaValidator.SchemaDigests;

    internal static void ValidateKnown(
        JsonElement rawEnvelope,
        RbpEnvelope envelope)
    {
        ArgumentNullException.ThrowIfNull(envelope);
        if (envelope.Disposition != RbpEnvelopeDisposition.Known)
        {
            return;
        }

        RbpSchemaFailure? schemaFailure =
            RbpFrozenSchemaValidator.ValidateEnvelope(rawEnvelope);
        if (schemaFailure is not null)
        {
            throw Invalid(schemaFailure.Path, schemaFailure.Message);
        }

        RbpSchemaFailure? semanticFailure =
            ValidateSemantic(envelope);
        if (semanticFailure is not null)
        {
            throw Invalid(
                semanticFailure.Path,
                semanticFailure.Message);
        }
    }

    private static RbpSchemaFailure? ValidateSemantic(
        RbpEnvelope envelope)
    {
        return envelope.Type switch
        {
            "invoke_batch" => ValidateInvokeBatch(envelope.Payload),
            "invoke" => ValidateRecoveryClearances(
                envelope.Payload.GetProperty("recovery_clearances"),
                "/payload/recovery_clearances"),
            "partial" => ValidatePartial(envelope.Payload),
            "result" => ValidateResult(envelope.Payload),
            _ => null,
        };
    }

    private static RbpSchemaFailure? ValidateInvokeBatch(
        JsonElement payload)
    {
        JsonElement steps = payload.GetProperty("steps");
        RbpSchemaFailure? duplicate = ValidateUniqueInvocationIds(
            steps,
            "/payload/steps");
        if (duplicate is not null)
        {
            return duplicate;
        }

        RbpSchemaFailure? clearances = ValidateRecoveryClearances(
            payload.GetProperty("recovery_clearances"),
            "/payload/recovery_clearances");
        if (clearances is not null)
        {
            return clearances;
        }

        int index = 0;
        foreach (JsonElement step in steps.EnumerateArray())
        {
            string expected;
            try
            {
                expected = Rfc8785Json.MakeParametersDigest(
                    step.GetProperty("params"));
            }
            catch (Exception exception) when (
                exception is RbpFrameException or
                    InvalidOperationException or
                    FormatException)
            {
                return Failure(
                    $"/payload/steps/{index}/params",
                    "step params are not RFC 8785 JSON");
            }

            if (!string.Equals(
                    step.GetProperty("params_digest").GetString(),
                    expected,
                    StringComparison.Ordinal))
            {
                return Failure(
                    $"/payload/steps/{index}/params_digest",
                    "params_digest does not match the RFC 8785 step params");
            }

            index++;
        }

        string expectedBatchDigest;
        try
        {
            expectedBatchDigest = Rfc8785Json.MakeBatchDigest(
                RbpBatchDigestInput.Parse(payload));
        }
        catch (Exception exception) when (
            exception is RbpFrameException or
                InvalidOperationException or
                FormatException or
                OverflowException)
        {
            return Failure(
                "/payload/batch_digest",
                "batch digest material is not valid RFC 8785 JSON");
        }

        return string.Equals(
            payload.GetProperty("batch_digest").GetString(),
            expectedBatchDigest,
            StringComparison.Ordinal)
            ? null
            : Failure(
                "/payload/batch_digest",
                "batch_digest does not match the frozen batch semantics");
    }

    private static RbpSchemaFailure? ValidateRecoveryClearances(
        JsonElement clearances,
        string path)
    {
        var holdIds = new HashSet<string>(StringComparer.Ordinal);
        string? previous = null;
        int index = 0;
        foreach (JsonElement clearance in clearances.EnumerateArray())
        {
            // The typed parse is the one seam into Section 6.2.1 clearance
            // acceptance: an entry that cannot become an acceptance input is
            // rejected at this boundary and never reaches the journal.
            RbpRecoveryClearance parsed;
            try
            {
                parsed = RbpRecoveryClearance.Parse(clearance);
            }
            catch (FormatException exception)
            {
                return Failure($"{path}/{index}", exception.Message);
            }

            if (!holdIds.Add(parsed.HoldId))
            {
                return Failure(
                    $"{path}/{index}/hold_id",
                    "recovery clearance hold_id values must be unique");
            }

            if (previous is not null &&
                string.CompareOrdinal(previous, parsed.HoldId) > 0)
            {
                return Failure(
                    path,
                    "recovery clearances must be sorted by hold_id");
            }

            previous = parsed.HoldId;
            index++;
        }

        return null;
    }

    private static RbpSchemaFailure? ValidatePartial(JsonElement payload)
    {
        if (!string.Equals(
                payload.GetProperty("kind").GetString(),
                "chunk",
                StringComparison.Ordinal))
        {
            return null;
        }

        string data =
            payload.GetProperty("data").GetString() ??
            string.Empty;
        int padding = data.EndsWith("==", StringComparison.Ordinal)
            ? 2
            : data.EndsWith('=') ? 1 : 0;
        long decodedBytes =
            ((long)data.Length / 4 * 3) - padding;
        if (decodedBytes > RbpProtocolLimits.MaximumPartialBytes)
        {
            return Failure(
                "/payload/data",
                "decoded partial chunk exceeds 1 MiB");
        }

        if (payload.TryGetProperty(
                "artifact_id",
                out JsonElement artifactId))
        {
            string expected =
                "artifact:" + artifactId.GetString();
            if (!string.Equals(
                    payload.GetProperty("stream_id").GetString(),
                    expected,
                    StringComparison.Ordinal))
            {
                return Failure(
                    "/payload/stream_id",
                    "artifact stream_id must match artifact_id");
            }
        }

        return null;
    }

    private static RbpSchemaFailure? ValidateResult(JsonElement payload)
    {
        return string.Equals(
            payload.GetProperty("kind").GetString(),
            "batch",
            StringComparison.Ordinal)
            ? ValidateBatchResult(payload)
            : ValidateInvocationResult(payload);
    }

    private static RbpSchemaFailure? ValidateInvocationResult(
        JsonElement payload)
    {
        if (!payload.TryGetProperty(
                "artifacts",
                out JsonElement artifacts))
        {
            return null;
        }

        var artifactIds = new HashSet<string>(StringComparer.Ordinal);
        long combinedSize = 0;
        int index = 0;
        foreach (JsonElement artifact in artifacts.EnumerateArray())
        {
            long artifactIndex = ReadInteger(
                artifact.GetProperty("artifact_index"));
            if (artifactIndex != index)
            {
                return Failure(
                    $"/payload/artifacts/{index}/artifact_index",
                    "artifact_index must equal its descriptor position");
            }

            string artifactId =
                artifact.GetProperty("artifact_id").GetString() ??
                string.Empty;
            if (!artifactIds.Add(artifactId))
            {
                return Failure(
                    $"/payload/artifacts/{index}/artifact_id",
                    "artifact_id values must be unique");
            }

            if (!string.Equals(
                    artifact.GetProperty("stream_id").GetString(),
                    "artifact:" + artifactId,
                    StringComparison.Ordinal))
            {
                return Failure(
                    $"/payload/artifacts/{index}/stream_id",
                    "artifact stream_id must match artifact_id");
            }

            combinedSize = AddWithoutOverflow(
                combinedSize,
                ReadInteger(artifact.GetProperty("total_size")));
            index++;
        }

        return combinedSize >
               RbpProtocolLimits.MaximumInlineResultBytes
            ? Failure(
                "/payload/artifacts",
                "combined artifact descriptors exceed 32 MiB")
            : null;
    }

    private static RbpSchemaFailure? ValidateBatchResult(
        JsonElement payload)
    {
        JsonElement steps = payload.GetProperty("steps");
        RbpSchemaFailure? duplicate = ValidateUniqueInvocationIds(
            steps,
            "/payload/steps");
        if (duplicate is not null)
        {
            return duplicate;
        }

        JsonElement[] rows = steps.EnumerateArray().ToArray();
        int firstNonSuccess = Array.FindIndex(
            rows,
            step => !string.Equals(
                Status(step),
                "completed",
                StringComparison.Ordinal));
        bool atomic = payload.GetProperty("atomic").GetBoolean();
        string batchStatus =
            payload.GetProperty("status").GetString() ??
            string.Empty;
        string transactionState =
            payload.GetProperty("transaction_state").GetString() ??
            string.Empty;
        bool allowsAllReadMissingCarrierFailures =
            atomic &&
            string.Equals(
                batchStatus,
                "failed",
                StringComparison.Ordinal) &&
            string.Equals(
                transactionState,
                "rolled_back",
                StringComparison.Ordinal) &&
            rows.Length > 0 &&
            rows.All(IsKnownEnvironmentFailure);
        bool allowsMultipleNonSuccessSteps =
            allowsAllReadMissingCarrierFailures ||
            (atomic &&
             string.Equals(
                 batchStatus,
                 "indeterminate",
                 StringComparison.Ordinal) &&
             string.Equals(
                 transactionState,
                 "indeterminate",
                 StringComparison.Ordinal));

        for (int index = 0; index < rows.Length; index++)
        {
            JsonElement step = rows[index];
            if (ReadInteger(step.GetProperty("index")) != index)
            {
                return Failure(
                    $"/payload/steps/{index}/index",
                    "batch step index must equal its position");
            }

            string status = Status(step);
            if (!allowsMultipleNonSuccessSteps &&
                firstNonSuccess >= 0 &&
                index > firstNonSuccess &&
                !string.Equals(
                    status,
                    "not_started",
                    StringComparison.Ordinal))
            {
                return Failure(
                    $"/payload/steps/{index}/status",
                    "steps after the first non-success must be not_started");
            }

            JsonElement error = default;
            bool hasError = step.TryGetProperty("error", out error);
            string? faultClass = hasError
                ? error.GetProperty("fault_class").GetString()
                : null;
            if (string.Equals(
                    status,
                    "indeterminate",
                    StringComparison.Ordinal) &&
                (!hasError ||
                 !IsIndeterminateError(error)))
            {
                return Failure(
                    $"/payload/steps/{index}/error",
                    "indeterminate step lacks the unknown-outcome contract");
            }

            if (string.Equals(status, "failed", StringComparison.Ordinal) &&
                string.Equals(
                    faultClass,
                    "cancelled",
                    StringComparison.Ordinal))
            {
                return Failure(
                    $"/payload/steps/{index}/error/fault_class",
                    "failed step cannot use the cancelled fault");
            }

            if (string.Equals(
                    status,
                    "cancelled",
                    StringComparison.Ordinal) &&
                !string.Equals(
                    faultClass,
                    "cancelled",
                    StringComparison.Ordinal))
            {
                return Failure(
                    $"/payload/steps/{index}/error/fault_class",
                    "cancelled step requires the cancelled fault");
            }

            if ((string.Equals(
                     status,
                     "failed",
                     StringComparison.Ordinal) ||
                 string.Equals(
                     status,
                     "cancelled",
                     StringComparison.Ordinal)) &&
                string.Equals(
                    faultClass,
                    "journal_indeterminate",
                    StringComparison.Ordinal))
            {
                return Failure(
                    $"/payload/steps/{index}/error/fault_class",
                    "journal_indeterminate requires an indeterminate step");
            }

            if (hasError)
            {
                bool stepReplayed =
                    step.GetProperty("replayed").GetBoolean();
                bool? errorReplayed = OptionalBoolean(error, "replayed");
                if (errorReplayed == true && !stepReplayed)
                {
                    return Failure(
                        $"/payload/steps/{index}/error/replayed",
                        "nested replay cannot exceed enclosing step replay");
                }

                if (!stepReplayed && errorReplayed != false)
                {
                    return Failure(
                        $"/payload/steps/{index}/error/replayed",
                        "fresh step requires nested error.replayed false");
                }

                bool stepLate =
                    OptionalBoolean(
                        step,
                        "late_after_indeterminate") == true;
                bool errorLate =
                    OptionalBoolean(
                        error,
                        "late_after_indeterminate") == true;
                if (stepLate != errorLate)
                {
                    return Failure(
                        $"/payload/steps/{index}/late_after_indeterminate",
                        "nested error and step disagree on late state");
                }

                if (errorLate &&
                    (!SameOptionalString(
                         step,
                         error,
                         "verification_hold_id") ||
                     !SameOptionalString(
                         step,
                         error,
                         "result_digest")))
                {
                    return Failure(
                        $"/payload/steps/{index}/verification_hold_id",
                        "late nested error and step evidence differ");
                }
            }
        }

        int? expectedFailureIndex =
            firstNonSuccess < 0 ? null : firstNonSuccess;
        JsonElement failedIndex =
            payload.GetProperty("failed_step_index");
        int? actualFailureIndex =
            failedIndex.ValueKind == JsonValueKind.Null
                ? null
                : checked((int)ReadInteger(failedIndex));
        if (actualFailureIndex != expectedFailureIndex)
        {
            return Failure(
                "/payload/failed_step_index",
                "failed_step_index does not identify first non-success");
        }

        int firstIndeterminate = Array.FindIndex(
            rows,
            step => string.Equals(
                Status(step),
                "indeterminate",
                StringComparison.Ordinal));
        bool exactUnavailableReadPrefix =
            atomic &&
            string.Equals(
                batchStatus,
                "indeterminate",
                StringComparison.Ordinal) &&
            string.Equals(
                transactionState,
                "indeterminate",
                StringComparison.Ordinal) &&
            firstNonSuccess >= 0 &&
            firstIndeterminate > firstNonSuccess &&
            rows[firstNonSuccess..firstIndeterminate]
                .All(IsKnownEnvironmentFailure);
        string expectedStatus = exactUnavailableReadPrefix
            ? "indeterminate"
            : firstNonSuccess < 0
                ? "completed"
                : Status(rows[firstNonSuccess]);
        if (!string.Equals(
                batchStatus,
                expectedStatus,
                StringComparison.Ordinal))
        {
            return Failure(
                "/payload/status",
                "batch status does not match first non-success");
        }

        bool validTransactionState = !atomic
            ? string.Equals(
                transactionState,
                "not_applicable",
                StringComparison.Ordinal)
            : batchStatus switch
            {
                "completed" => string.Equals(
                    transactionState,
                    "committed",
                    StringComparison.Ordinal),
                "indeterminate" => string.Equals(
                    transactionState,
                    "indeterminate",
                    StringComparison.Ordinal),
                "cancelled" =>
                    string.Equals(
                        transactionState,
                        "committed",
                        StringComparison.Ordinal) ||
                    string.Equals(
                        transactionState,
                        "rolled_back",
                        StringComparison.Ordinal),
                _ => string.Equals(
                    transactionState,
                    "rolled_back",
                    StringComparison.Ordinal),
            };
        if (!validTransactionState)
        {
            return Failure(
                "/payload/transaction_state",
                "transaction_state contradicts atomic batch status");
        }

        if (payload.GetProperty("replayed").GetBoolean() &&
            rows.Any(
                step =>
                    !string.Equals(
                        Status(step),
                        "not_started",
                        StringComparison.Ordinal) &&
                    !step.GetProperty("replayed").GetBoolean()))
        {
            return Failure(
                "/payload/replayed",
                "replayed batch contains a fresh terminal step");
        }

        return null;
    }

    private static RbpSchemaFailure? ValidateUniqueInvocationIds(
        JsonElement steps,
        string path)
    {
        var invocationIds = new HashSet<string>(StringComparer.Ordinal);
        int index = 0;
        foreach (JsonElement step in steps.EnumerateArray())
        {
            string invocationId =
                step.GetProperty("invocation_id").GetString() ??
                string.Empty;
            if (!invocationIds.Add(invocationId))
            {
                return Failure(
                    $"{path}/{index}/invocation_id",
                    "batch invocation_id values must be unique");
            }

            index++;
        }

        return null;
    }

    private static bool IsKnownEnvironmentFailure(JsonElement step)
    {
        if (!string.Equals(
                Status(step),
                "failed",
                StringComparison.Ordinal) ||
            !step.TryGetProperty("error", out JsonElement error))
        {
            return false;
        }

        return string.Equals(
                   error.GetProperty("fault_class").GetString(),
                   "environment",
                   StringComparison.Ordinal) &&
               error.GetProperty("retryable").GetBoolean() &&
               string.Equals(
                   error.GetProperty("outcome").GetString(),
                   "known",
                   StringComparison.Ordinal) &&
               !error.GetProperty("verification_required").GetBoolean();
    }

    private static bool IsIndeterminateError(JsonElement error)
    {
        return string.Equals(
                   error.GetProperty("fault_class").GetString(),
                   "journal_indeterminate",
                   StringComparison.Ordinal) &&
               !error.GetProperty("retryable").GetBoolean() &&
               string.Equals(
                   error.GetProperty("outcome").GetString(),
                   "indeterminate",
                   StringComparison.Ordinal) &&
               error.GetProperty("verification_required").GetBoolean() &&
               error.TryGetProperty("verification_hold_id", out _) &&
               error.TryGetProperty("mutation_scope", out _);
    }

    private static bool? OptionalBoolean(
        JsonElement owner,
        string name)
    {
        return owner.TryGetProperty(name, out JsonElement value)
            ? value.GetBoolean()
            : null;
    }

    private static bool SameOptionalString(
        JsonElement left,
        JsonElement right,
        string name)
    {
        bool leftHas = left.TryGetProperty(name, out JsonElement leftValue);
        bool rightHas =
            right.TryGetProperty(name, out JsonElement rightValue);
        return leftHas == rightHas &&
               (!leftHas ||
                string.Equals(
                    leftValue.GetString(),
                    rightValue.GetString(),
                    StringComparison.Ordinal));
    }

    private static string Status(JsonElement step) =>
        step.GetProperty("status").GetString() ?? string.Empty;

    private static long ReadInteger(JsonElement value)
    {
        return RbpJsonNumber.TryReadExactInt64(value, out long integer)
            ? integer
            : throw new InvalidOperationException(
                "Schema-validated integer could not be read.");
    }

    private static long AddWithoutOverflow(long left, long right) =>
        left > long.MaxValue - right ? long.MaxValue : left + right;

    private static RbpSchemaFailure Failure(
        string path,
        string message) =>
        new(path, message);

    private static RbpFrameException Invalid(
        string path,
        string message) =>
        new(
            RbpFrameErrorCode.InvalidEnvelope,
            $"RBP frozen payload validation failed: {message}.",
            path);
}
