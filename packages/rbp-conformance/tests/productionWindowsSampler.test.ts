import { afterEach, describe, expect, it, vi } from "vitest";

import { sampleProductionDriverWindowsMetrics } from "../src/productionDrivers.js";
import { sampleProductionSoakWindowsMetrics } from "../src/productionSoakAdapter.js";

const { spawnSyncMock } = vi.hoisted(() => ({
  spawnSyncMock: vi.fn(),
}));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    spawnSync: spawnSyncMock,
  };
});

const FORBIDDEN_ENVIRONMENT_KEYS = [
  "NODE_OPTIONS",
  "NODE_PATH",
  "NODE_PRESERVE_SYMLINKS",
  "NODE_COMPILE_CACHE",
  "NODE_DISABLE_COMPILE_CACHE",
  "WS_NO_BUFFER_UTIL",
  "WS_NO_UTF_8_VALIDATE",
] as const;

const POWERSHELL_EXECUTABLE =
  "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";

afterEach(() => {
  vi.clearAllMocks();
});

describe("production Windows resource samplers", () => {
  it("preserves the exact bound executable and scrubs runtime-resolution environment", () => {
    const original = new Map(
      [...FORBIDDEN_ENVIRONMENT_KEYS, "RBP_ALLOWED_PARENT_VALUE"].map(
        (key) => [key, process.env[key]],
      ),
    );
    try {
      for (const key of FORBIDDEN_ENVIRONMENT_KEYS) {
        process.env[key] = `hostile-${key}`;
      }
      process.env.RBP_ALLOWED_PARENT_VALUE = "retained";
      spawnSyncMock.mockReturnValue({
        status: 0,
        stdout: JSON.stringify({
          Id: 4242,
          WorkingSet64: 65_536,
          Handles: 12,
        }),
        stderr: "",
      });

      expect(
        sampleProductionDriverWindowsMetrics([4242], POWERSHELL_EXECUTABLE).get(4242),
      ).toEqual({
        residentBytes: 65_536,
        descriptorCount: 12,
      });
      expect(
        sampleProductionSoakWindowsMetrics([4242], POWERSHELL_EXECUTABLE).get(4242),
      ).toEqual({
        residentBytes: 65_536,
        descriptorCount: 12,
      });

      expect(spawnSyncMock).toHaveBeenCalledTimes(2);
      for (const [executable, args, rawOptions] of spawnSyncMock.mock.calls) {
        expect(executable).toBe(POWERSHELL_EXECUTABLE);
        expect(args).toEqual([
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          "$ids=@(4242); $rows=Get-Process -Id $ids -ErrorAction Stop | Select-Object Id,WorkingSet64,Handles; $rows | ConvertTo-Json -Compress",
        ]);
        const options = rawOptions as {
          env: NodeJS.ProcessEnv;
          shell: boolean;
          windowsHide: boolean;
        };
        expect(options).toMatchObject({
          shell: false,
          windowsHide: true,
        });
        expect(options.env.RBP_ALLOWED_PARENT_VALUE).toBe("retained");
        for (const key of FORBIDDEN_ENVIRONMENT_KEYS) {
          expect(options.env[key]).toBeUndefined();
        }
      }
    } finally {
      for (const [key, value] of original) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });
});
