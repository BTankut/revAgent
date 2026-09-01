import { describe, expect, it } from "vitest";

import { retryableFixtureBindError } from "../src/caseStackSupervisor.js";

/**
 * The adjacent-port retry loop in `spawnAdditionalFixture` can only absorb a
 * bind race if the classifier recognises the shape the OS actually produced.
 * On the Windows runner the dominant shape is EACCES, not EADDRINUSE: a
 * dynamic WinNAT/Hyper-V port exclusion or an `SO_EXCLUSIVEADDRUSE` holder
 * rejects the bind with "permission denied" rather than "address already in
 * use". Classifying only EADDRINUSE made the retry loop unreachable there.
 */
describe("retryableFixtureBindError", () => {
  it("retries the Windows EACCES form reported through fixture stderr", () => {
    // This is the verbatim message shape `readinessExitError` produces: prose
    // only, no errno, no cause. The message branch is therefore the only one
    // that can match a fixture that died before readiness.
    const error = new Error(
      "addin_loopback_fixture exited before readiness (1); " +
        "stderr: listen EACCES: permission denied 127.0.0.1:56763",
    );

    expect(retryableFixtureBindError(error)).toBe(true);
  });

  it("still retries the EADDRINUSE form", () => {
    expect(
      retryableFixtureBindError(
        new Error(
          "addin_loopback_fixture exited before readiness (1); " +
            "stderr: listen EADDRINUSE: address already in use 127.0.0.1:43123",
        ),
      ),
    ).toBe(true);
  });

  it.each(["EADDRINUSE", "EACCES", "EADDRNOTAVAIL"])(
    "retries an in-process bind probe rejected with %s",
    (code) => {
      const error = Object.assign(new Error("listen failed"), { code });
      expect(retryableFixtureBindError(error)).toBe(true);
    },
  );

  it("retries when the transient cause is nested", () => {
    const error = new Error("additional fixture start failed", {
      cause: new Error("listen EACCES: permission denied 127.0.0.1:56763"),
    });
    expect(retryableFixtureBindError(error)).toBe(true);
  });

  it("retries when a transient cause is inside an AggregateError", () => {
    const error = new AggregateError(
      [
        new Error("cleanup was incomplete"),
        new Error("listen WSAEACCES: permission denied 127.0.0.1:56763"),
      ],
      "additional fixture start failed and cleanup was incomplete",
    );
    expect(retryableFixtureBindError(error)).toBe(true);
  });

  it("does not retry a genuine fixture defect", () => {
    // The loop must still surface real failures instead of burning six
    // offsets on something no other port can fix.
    expect(
      retryableFixtureBindError(
        new Error("additional fixture did not bind the parent-selected port"),
      ),
    ).toBe(false);
    expect(
      retryableFixtureBindError(
        new Error(
          "addin_loopback_fixture exited before readiness (1); " +
            "stderr: SyntaxError: Unexpected end of JSON input",
        ),
      ),
    ).toBe(false);
    expect(
      retryableFixtureBindError(
        Object.assign(new Error("open failed with EACCES"), {
          code: "EACCES",
          syscall: "open",
        }),
      ),
    ).toBe(false);
    expect(retryableFixtureBindError(new Error("permission check EACCES"))).toBe(false);
    expect(retryableFixtureBindError("listen EACCES")).toBe(false);
  });
});
