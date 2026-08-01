using System.Text;
using RevAgent.Bridge.Bootstrap.Configuration;
using RevAgent.Bridge.Bootstrap.Diagnostics;
using RevAgent.Bridge.Bootstrap.Enrollment;

namespace RevAgent.Bridge.Enrollment;

/// <summary>
/// Builds the doctor report's enrollment section and drives the
/// <c>doctor --re-enroll</c> flow. The section carries only non-secret
/// evidence: the enrolled flag, the fingerprint policy name, and bounded
/// diagnostic codes. Neither the enrollment token nor the device token can
/// reach the report; the token itself is taken from the
/// <see cref="EnrollmentTokenEnvironmentVariable"/> environment variable so
/// it never appears on a command line.
/// </summary>
internal static class BridgeEnrollmentDoctor
{
    internal const string EnrollmentTokenEnvironmentVariable =
        BridgeConfigurationLoader.EnrollmentTokenEnvironmentVariable;

    internal static BridgeDoctorEnrollmentReport CreateStateReport(
        Func<IBridgeCredentialReader> readerFactory)
    {
        ArgumentNullException.ThrowIfNull(readerFactory);
        (bool enrolled, string? error) = ReadEnrollmentState(readerFactory);
        return new BridgeDoctorEnrollmentReport(
            enrolled,
            BridgeMachineFingerprintPolicy.Name,
            ReEnrollAttempted: false,
            ReEnrollSucceeded: null,
            error);
    }

    internal static async Task<BridgeDoctorEnrollmentReport> RunReEnrollAsync(
        Func<IBridgeCredentialReader> readerFactory,
        Func<BridgeEnrollmentCoordinator> coordinatorFactory,
        string? enrollmentTokenValue,
        CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(readerFactory);
        ArgumentNullException.ThrowIfNull(coordinatorFactory);
        string? error = null;
        var succeeded = false;
        if (string.IsNullOrEmpty(enrollmentTokenValue))
        {
            error = "enrollment_token_missing";
        }
        else
        {
            BridgeEnrollmentToken? token = null;
            try
            {
                token = BridgeEnrollmentToken.Parse(enrollmentTokenValue);
            }
            catch (ArgumentException)
            {
                error = "enrollment_token_invalid";
            }

            if (token is not null)
            {
                using (token)
                {
                    error = await ReEnrollCoreAsync(
                            coordinatorFactory,
                            token,
                            cancellationToken)
                        .ConfigureAwait(false);
                    succeeded = error is null;
                }
            }
        }

        (bool enrolled, string? stateError) =
            ReadEnrollmentState(readerFactory);
        return new BridgeDoctorEnrollmentReport(
            enrolled,
            BridgeMachineFingerprintPolicy.Name,
            ReEnrollAttempted: true,
            ReEnrollSucceeded: succeeded,
            error ?? stateError);
    }

    private static async Task<string?> ReEnrollCoreAsync(
        Func<BridgeEnrollmentCoordinator> coordinatorFactory,
        BridgeEnrollmentToken token,
        CancellationToken cancellationToken)
    {
        try
        {
            _ = await coordinatorFactory()
                .ReEnrollAsync(token, cancellationToken)
                .ConfigureAwait(false);
            return null;
        }
        catch (BridgeCredentialUnavailableException exception)
        {
            return ToDiagnosticCode(exception.ErrorCode.ToString());
        }
        catch (BridgeCredentialStoreException exception)
        {
            return "store_" + ToDiagnosticCode(exception.ErrorCode.ToString());
        }
    }

    private static (bool Enrolled, string? Error) ReadEnrollmentState(
        Func<IBridgeCredentialReader> readerFactory)
    {
        try
        {
            using BridgeRuntimeCredentialState? state =
                readerFactory().Load();
            return (state?.IsEnrolled is true, null);
        }
        catch (BridgeCredentialStoreException exception)
        {
            return (
                false,
                "store_" + ToDiagnosticCode(exception.ErrorCode.ToString()));
        }
    }

    private static string ToDiagnosticCode(string pascalCase)
    {
        var builder = new StringBuilder(pascalCase.Length + 8);
        foreach (char character in pascalCase)
        {
            if (char.IsUpper(character))
            {
                if (builder.Length > 0)
                {
                    _ = builder.Append('_');
                }

                _ = builder.Append(char.ToLowerInvariant(character));
            }
            else
            {
                _ = builder.Append(character);
            }
        }

        return builder.ToString();
    }
}
