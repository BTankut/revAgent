import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  readFileSync,
  realpathSync,
} from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  captureProductionSourceAnchor,
  productionSourceAnchorDigest,
} from "./production-source-anchor.mjs";
import {
  parseProductionLaunchEncodedArguments,
  productionLaunchBootstrapIdentity,
  productionLaunchEncodedCommand,
  productionLaunchEntrypoint,
  productionLaunchPowerShellArguments,
} from "./production-launch-bootstrap.mjs";

const ATTESTATION_PROTOCOL = "rbp-production-launch-attestation/v4";
const PIPE_ENVIRONMENT_KEY = "RBP_PRODUCTION_LAUNCH_PIPES";
const PIPE_NAME_PATTERN =
  /^rbp-production-(?:auth|receipt)-[0-9a-f]{32}$/u;
const SESSION_TOKEN_PATTERN = /^[0-9a-f]{64}$/u;
const HELPER_PIPE_ENVIRONMENT_KEY = "RBP_PRODUCTION_AUTH_PIPE";
const HELPER_PARENT_ENVIRONMENT_KEY = "RBP_PRODUCTION_EXPECTED_PARENT_PID";
const HELPER_CHILD_ENVIRONMENT_KEY = "RBP_PRODUCTION_EXPECTED_CHILD_PID";

const SERVER_AUTHENTICATION_HELPER = String.raw`
$ErrorActionPreference = 'Stop'
$authenticationProtocol = 'rbp-production-launch-authentication/v1'
$utf8Strict = [Text.UTF8Encoding]::new($false, $true)
$pipe = $null
$reader = $null
$writer = $null
$serverProcess = $null
$managementRows = $null
$managementSearcher = $null
$argvPointer = [IntPtr]::Zero
$nativeType = $null
try {
    $pipeName = [Environment]::GetEnvironmentVariable('RBP_PRODUCTION_AUTH_PIPE')
    $expectedParentPidText = [Environment]::GetEnvironmentVariable(
        'RBP_PRODUCTION_EXPECTED_PARENT_PID'
    )
    $expectedChildPidText = [Environment]::GetEnvironmentVariable(
        'RBP_PRODUCTION_EXPECTED_CHILD_PID'
    )
    $expectedParentPid = 0
    $expectedChildPid = 0
    if (
        [string]::IsNullOrWhiteSpace($pipeName) -or
        -not [int]::TryParse(
            $expectedParentPidText,
            [Globalization.NumberStyles]::None,
            [Globalization.CultureInfo]::InvariantCulture,
            [ref]$expectedParentPid
        ) -or
        -not [int]::TryParse(
            $expectedChildPidText,
            [Globalization.NumberStyles]::None,
            [Globalization.CultureInfo]::InvariantCulture,
            [ref]$expectedChildPid
        )
    ) {
        throw 'Production launcher server authentication inputs are invalid'
    }

    $assemblyName = [Reflection.AssemblyName]::new(
        'RbpProductionServerNative_' + [Guid]::NewGuid().ToString('N')
    )
    $assemblyBuilder = [AppDomain]::CurrentDomain.DefineDynamicAssembly(
        $assemblyName,
        [Reflection.Emit.AssemblyBuilderAccess]::Run
    )
    $moduleBuilder = $assemblyBuilder.DefineDynamicModule($assemblyName.Name)
    $typeBuilder = $moduleBuilder.DefineType(
        'RbpProductionServerNative',
        (
            [Reflection.TypeAttributes]::Public -bor
            [Reflection.TypeAttributes]::Abstract -bor
            [Reflection.TypeAttributes]::Sealed
        )
    )
    $pipeMethod = $typeBuilder.DefinePInvokeMethod(
        'GetNamedPipeServerProcessId',
        'kernel32.dll',
        (
            [Reflection.MethodAttributes]::Public -bor
            [Reflection.MethodAttributes]::Static -bor
            [Reflection.MethodAttributes]::PinvokeImpl
        ),
        [Reflection.CallingConventions]::Standard,
        [bool],
        [Type[]]@([IntPtr], [UInt32].MakeByRefType()),
        [Runtime.InteropServices.CallingConvention]::Winapi,
        [Runtime.InteropServices.CharSet]::Unicode
    )
    $pipeMethod.SetImplementationFlags(
        $pipeMethod.GetMethodImplementationFlags() -bor
        [Reflection.MethodImplAttributes]::PreserveSig
    )
    $argvMethod = $typeBuilder.DefinePInvokeMethod(
        'CommandLineToArgvW',
        'shell32.dll',
        (
            [Reflection.MethodAttributes]::Public -bor
            [Reflection.MethodAttributes]::Static -bor
            [Reflection.MethodAttributes]::PinvokeImpl
        ),
        [Reflection.CallingConventions]::Standard,
        [IntPtr],
        [Type[]]@([string], [Int32].MakeByRefType()),
        [Runtime.InteropServices.CallingConvention]::Winapi,
        [Runtime.InteropServices.CharSet]::Unicode
    )
    $argvMethod.SetImplementationFlags(
        $argvMethod.GetMethodImplementationFlags() -bor
        [Reflection.MethodImplAttributes]::PreserveSig
    )
    $freeMethod = $typeBuilder.DefinePInvokeMethod(
        'LocalFree',
        'kernel32.dll',
        (
            [Reflection.MethodAttributes]::Public -bor
            [Reflection.MethodAttributes]::Static -bor
            [Reflection.MethodAttributes]::PinvokeImpl
        ),
        [Reflection.CallingConventions]::Standard,
        [IntPtr],
        [Type[]]@([IntPtr]),
        [Runtime.InteropServices.CallingConvention]::Winapi,
        [Runtime.InteropServices.CharSet]::Unicode
    )
    $freeMethod.SetImplementationFlags(
        $freeMethod.GetMethodImplementationFlags() -bor
        [Reflection.MethodImplAttributes]::PreserveSig
    )
    $nativeType = $typeBuilder.CreateType()

    $pipe = [IO.Pipes.NamedPipeClientStream]::new(
        '.',
        $pipeName,
        [IO.Pipes.PipeDirection]::InOut,
        [IO.Pipes.PipeOptions]::None,
        [Security.Principal.TokenImpersonationLevel]::Identification
    )
    $pipe.Connect(30000)
    $serverArguments = [object[]]@(
        $pipe.SafePipeHandle.DangerousGetHandle(),
        [uint32]0
    )
    $serverProcessResult = $nativeType.GetMethod(
        'GetNamedPipeServerProcessId'
    ).Invoke($null, $serverArguments)
    if (-not [bool]$serverProcessResult) {
        throw 'GetNamedPipeServerProcessId rejected the launcher server handle'
    }
    $serverPid = [uint32]$serverArguments[1]
    if ($serverPid -ne $expectedParentPid) {
        throw (
            'Production launcher server PID does not equal the Node OS parent PID'
        )
    }

    $serverProcess = [Diagnostics.Process]::GetProcessById([int]$serverPid)
    $serverExecutable = [IO.Path]::GetFullPath(
        $serverProcess.MainModule.FileName
    )
    $managementSearcher = [System.Management.ManagementObjectSearcher]::new(
        (
            'SELECT CommandLine FROM Win32_Process WHERE ProcessId = ' +
            $serverPid.ToString([Globalization.CultureInfo]::InvariantCulture)
        )
    )
    $managementRows = $managementSearcher.Get()
    $serverCommandLine = $null
    foreach ($managementRow in $managementRows) {
        if ($null -ne $serverCommandLine) {
            throw 'Launcher process query returned more than one OS process row'
        }
        $serverCommandLine = [string]$managementRow.Properties[
            'CommandLine'
        ].Value
    }
    if ([string]::IsNullOrWhiteSpace($serverCommandLine)) {
        throw 'Launcher OS command line is unavailable'
    }
    $argvArguments = [object[]]@($serverCommandLine, [int]0)
    $argvPointer = [IntPtr]$nativeType.GetMethod(
        'CommandLineToArgvW'
    ).Invoke($null, $argvArguments)
    $argumentCount = [int]$argvArguments[1]
    if ($argvPointer -eq [IntPtr]::Zero -or $argumentCount -lt 1) {
        throw 'CommandLineToArgvW could not parse the launcher OS command line'
    }
    $serverArgv = [Collections.Generic.List[string]]::new()
    for ($index = 0; $index -lt $argumentCount; $index += 1) {
        $argumentPointer = [Runtime.InteropServices.Marshal]::ReadIntPtr(
            $argvPointer,
            $index * [IntPtr]::Size
        )
        [void]$serverArgv.Add(
            [Runtime.InteropServices.Marshal]::PtrToStringUni($argumentPointer)
        )
    }

    $reader = [IO.StreamReader]::new(
        $pipe,
        $utf8Strict,
        $false,
        4096,
        $true
    )
    $writer = [IO.StreamWriter]::new(
        $pipe,
        [Text.UTF8Encoding]::new($false),
        4096,
        $true
    )
    $writer.AutoFlush = $true
    $helperPid = [Diagnostics.Process]::GetCurrentProcess().Id
    $writer.WriteLine(
        'AUTH' + [char]9 +
        $authenticationProtocol + [char]9 +
        $expectedChildPid.ToString(
            [Globalization.CultureInfo]::InvariantCulture
        ) + [char]9 +
        $helperPid.ToString([Globalization.CultureInfo]::InvariantCulture)
    )
    $readTask = $reader.ReadLineAsync()
    if (-not $readTask.Wait(30000)) {
        throw 'Production launcher authentication response timed out'
    }
    $responseLine = $readTask.Result
    $responseFields = [string[]]$responseLine.Split([char]9)
    if (
        $responseFields.Count -ne 2 -or
        $responseFields[0] -ne 'OK' -or
        $responseFields[1] -notmatch '^[0-9a-f]{64}$'
    ) {
        throw 'Production launcher authentication response was invalid'
    }

    $outputValues = [Collections.Generic.List[string]]::new()
    [void]$outputValues.Add(
        $serverPid.ToString([Globalization.CultureInfo]::InvariantCulture)
    )
    [void]$outputValues.Add($serverExecutable)
    [void]$outputValues.Add(
        $serverArgv.Count.ToString([Globalization.CultureInfo]::InvariantCulture)
    )
    for ($index = 0; $index -lt $serverArgv.Count; $index += 1) {
        [void]$outputValues.Add($serverArgv[$index])
    }
    [void]$outputValues.Add($responseFields[1])
    $encodedOutputValues = [Collections.Generic.List[string]]::new()
    for ($index = 0; $index -lt $outputValues.Count; $index += 1) {
        [void]$encodedOutputValues.Add(
            [Convert]::ToBase64String(
                $utf8Strict.GetBytes($outputValues[$index])
            )
        )
    }
    [Console]::Out.WriteLine(
        'OK' + [char]9 +
        [string]::Join([char]9, $encodedOutputValues)
    )
    exit 0
}
catch {
    [Console]::Error.WriteLine($_.Exception.Message)
    exit 91
}
finally {
    if ($argvPointer -ne [IntPtr]::Zero -and $null -ne $nativeType) {
        try {
            [void]$nativeType.GetMethod('LocalFree').Invoke(
                $null,
                [object[]]@($argvPointer)
            )
        }
        catch {
            # Native cleanup must not replace the authentication result.
        }
    }
    foreach ($disposable in @(
        $reader,
        $writer,
        $pipe,
        $serverProcess,
        $managementRows,
        $managementSearcher
    )) {
        if ($null -ne $disposable) {
            try {
                $disposable.Dispose()
            }
            catch {
                # Cleanup must not replace the authentication result.
            }
        }
    }
}
`;

function normalizedPath(value) {
  const normalized = path.normalize(value);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function samePath(left, right) {
  return normalizedPath(left) === normalizedPath(right);
}

function sha256File(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

function exactRegularFile(value, label) {
  if (!path.isAbsolute(value)) {
    throw new Error(`${label} must be an absolute path`);
  }
  const lexical = path.resolve(value);
  if (!existsSync(lexical)) {
    throw new Error(`${label} does not exist: ${lexical}`);
  }
  const stat = lstatSync(lexical);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`${label} must be a physical regular file: ${lexical}`);
  }
  const real = realpathSync(lexical);
  return {
    path: lexical,
    realPath: real,
    sha256: sha256File(real),
  };
}

function encodeProtocolField(value) {
  return Buffer.from(value, "utf8").toString("base64");
}

function decodeProtocolField(value, label) {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(
    value,
  )) {
    throw new Error(`${label} is not canonical base64`);
  }
  const decoded = Buffer.from(value, "base64");
  if (decoded.toString("base64") !== value) {
    throw new Error(`${label} is not canonical base64`);
  }
  const text = decoded.toString("utf8");
  if (!Buffer.from(text, "utf8").equals(decoded)) {
    throw new Error(`${label} is not valid UTF-8`);
  }
  return text;
}

function parseInteger(value, label) {
  if (!/^(?:0|[1-9][0-9]*)$/u.test(value)) {
    throw new Error(`${label} is not a canonical non-negative integer`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`${label} exceeds the JavaScript safe integer range`);
  }
  return parsed;
}

function exactSystemPowerShell() {
  const windowsRoot = process.env.SystemRoot ?? process.env.WINDIR;
  if (windowsRoot === undefined || !path.win32.isAbsolute(windowsRoot)) {
    throw new Error("SystemRoot is unavailable for launcher authentication");
  }
  return exactRegularFile(
    path.win32.join(
      windowsRoot,
      "System32",
      "WindowsPowerShell",
      "v1.0",
      "powershell.exe",
    ),
    "exact SystemRoot Windows PowerShell",
  ).realPath;
}

function authenticateLauncherServer(authenticationPipeName) {
  const powershell = exactSystemPowerShell();
  const encodedHelper = Buffer.from(
    SERVER_AUTHENTICATION_HELPER,
    "utf16le",
  ).toString("base64");
  const result = spawnSync(
    powershell,
    [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-EncodedCommand",
      encodedHelper,
    ],
    {
      encoding: "utf8",
      env: {
        SystemRoot: process.env.SystemRoot ?? process.env.WINDIR,
        WINDIR: process.env.WINDIR ?? process.env.SystemRoot,
        [HELPER_PIPE_ENVIRONMENT_KEY]: authenticationPipeName,
        [HELPER_PARENT_ENVIRONMENT_KEY]: String(process.ppid),
        [HELPER_CHILD_ENVIRONMENT_KEY]: String(process.pid),
      },
      shell: false,
      timeout: 35_000,
      windowsHide: true,
    },
  );
  if (
    result.error !== undefined ||
    result.status !== 0 ||
    typeof result.stdout !== "string"
  ) {
    const detail =
      result.error instanceof Error
        ? result.error.message
        : String(result.stderr).trim();
    throw new Error(
      `trusted production launcher server authentication failed${
        detail.length > 0 ? `: ${detail}` : ""
      }`,
    );
  }
  const outputLines = result.stdout
    .split(/\r?\n/u)
    .filter((line) => line.length > 0);
  if (outputLines.length !== 1) {
    throw new Error(
      "trusted production launcher authentication returned unexpected output",
    );
  }
  const outputFields = outputLines[0].split("\t");
  if (outputFields.length < 2 || outputFields[0] !== "OK") {
    throw new Error(
      "trusted production launcher authentication returned a malformed record",
    );
  }
  const values = outputFields
    .slice(1)
    .map((field, index) =>
      decodeProtocolField(field, `launcher authentication field ${String(index)}`),
    );
  if (values.length < 4) {
    throw new Error(
      "trusted production launcher authentication record is incomplete",
    );
  }
  const serverPid = parseInteger(values[0], "launcher server PID");
  const serverExecutable = values[1];
  const argumentCount = parseInteger(values[2], "launcher argument count");
  if (values.length !== 4 + argumentCount) {
    throw new Error(
      "trusted production launcher authentication argument count is invalid",
    );
  }
  const serverArguments = values.slice(3, 3 + argumentCount);
  const token = values.at(-1);
  if (
    serverPid !== process.ppid ||
    token === undefined ||
    !SESSION_TOKEN_PATTERN.test(token)
  ) {
    throw new Error(
      "trusted production launcher authentication is not bound to the OS parent",
    );
  }
  return {
    powershell,
    serverExecutable,
    serverArguments,
    token,
  };
}

function assertCanonicalLauncherHost(authentication) {
  if (!samePath(authentication.serverExecutable, authentication.powershell)) {
    throw new Error(
      "trusted production launcher server is not exact SystemRoot Windows PowerShell",
    );
  }
  const canonicalRepoRoot = realpathSync(
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../.."),
  );
  const entrypoint = process.argv[1];
  if (entrypoint === undefined) {
    throw new Error("trusted production launcher child entrypoint is unavailable");
  }
  if (
    process.execArgv.length !== 2 ||
    process.execArgv[0] !== "-e" ||
    typeof process.execArgv[1] !== "string"
  ) {
    throw new Error(
      "trusted production child did not start from the fixed in-memory loader",
    );
  }
  const actual = authentication.serverArguments;
  if (
    actual.length !== 9 ||
    !samePath(actual[0] ?? "", authentication.powershell) ||
    actual[1] !== "-NoProfile" ||
    actual[2] !== "-NonInteractive" ||
    actual[3] !== "-ExecutionPolicy" ||
    actual[4] !== "Bypass" ||
    actual[5] !== "-EncodedArguments" ||
    actual[7] !== "-EncodedCommand" ||
    actual[8] !== productionLaunchEncodedCommand()
  ) {
    throw new Error(
      "trusted production launcher OS command line is not the canonical " +
        "fixed -EncodedCommand / canonical -EncodedArguments host invocation",
    );
  }
  const payload = parseProductionLaunchEncodedArguments(actual[6] ?? "");
  const expectedArguments = productionLaunchPowerShellArguments({
    ...payload,
    powershellExecutable: authentication.powershell,
  });
  if (
    JSON.stringify(actual.slice(1)) !== JSON.stringify(expectedArguments) ||
    !samePath(payload.repoRoot, canonicalRepoRoot) ||
    !samePath(process.cwd(), payload.repoRoot) ||
    !samePath(productionLaunchEntrypoint(payload), entrypoint) ||
    JSON.stringify(payload.commandArguments) !==
      JSON.stringify(process.argv.slice(2))
  ) {
    throw new Error(
      "trusted production encoded bootstrap payload is not bound to this process",
    );
  }
  return {
    payload,
    identity: productionLaunchBootstrapIdentity(payload),
    initialLoaderSha256: createHash("sha256")
      .update(process.execArgv[1], "utf8")
      .digest("hex"),
  };
}

function parseReceipt(line) {
  const fields = line.split("\t");
  if (fields[0] === "ERROR") {
    const reason =
      fields.length === 2
        ? `: ${decodeProtocolField(fields[1], "launcher error")}`
        : "";
    throw new Error(`trusted production launcher rejected the handoff${reason}`);
  }
  if (fields.length < 2 || fields[0] !== "OK") {
    throw new Error("trusted production launcher returned a malformed record");
  }
  const values = fields
    .slice(1)
    .map((field, index) =>
      decodeProtocolField(field, `launcher receipt field ${String(index)}`),
    );
  if (values.length < 24 || values[0] !== ATTESTATION_PROTOCOL) {
    throw new Error("trusted production launcher returned an incomplete receipt");
  }
  const argumentCount = parseInteger(values[4], "receipt argument count");
  const fileOffset = 5 + argumentCount;
  const bootstrapCount = parseInteger(
    values[fileOffset + 6],
    "receipt bootstrap field count",
  );
  const bootstrapOffset = fileOffset + 7;
  const sourceCountOffset = bootstrapOffset + bootstrapCount;
  const sourceAnchorCount = parseInteger(
    values[sourceCountOffset],
    "receipt source-anchor field count",
  );
  if (
    bootstrapCount !== 11 ||
    values.length !== sourceCountOffset + 1 + sourceAnchorCount
  ) {
    throw new Error("trusted production launcher receipt field count is invalid");
  }
  const argumentsValue = values.slice(5, 5 + argumentCount);
  const fileValues = values.slice(fileOffset, fileOffset + 6);
  const fileReceipt = (offset) => ({
    path: fileValues[offset],
    realPath: fileValues[offset + 1],
    sha256: fileValues[offset + 2],
  });
  const bootstrapValues = values.slice(
    bootstrapOffset,
    bootstrapOffset + bootstrapCount,
  );
  const sourceAnchorValues = values.slice(sourceCountOffset + 1);
  return {
    protocol: values[0],
    role: values[1],
    childPid: parseInteger(values[2], "receipt child PID"),
    launcherPid: parseInteger(values[3], "receipt launcher PID"),
    arguments: argumentsValue,
    node: fileReceipt(0),
    entrypoint: fileReceipt(3),
    bootstrap: {
      payloadSha256: bootstrapValues[0],
      sourceSha256: bootstrapValues[1],
      templateSha256: bootstrapValues[2],
      initialLoaderSha256: bootstrapValues[3],
      expectedCommit: bootstrapValues[4],
      expectedTree: bootstrapValues[5],
      launcherRelativePath: bootstrapValues[6],
      launcherMode: bootstrapValues[7],
      launcherObjectId: bootstrapValues[8],
      launcherSha256: bootstrapValues[9],
      gitSha256: bootstrapValues[10],
    },
    sourceAnchorValues,
    sourceAnchorDigest: productionSourceAnchorDigest(sourceAnchorValues),
  };
}

function connectToLauncher(pipeName, sessionToken, sourceAnchor, bootstrap) {
  return new Promise((resolve, reject) => {
    const pipePath = `\\\\.\\pipe\\${pipeName}`;
    const socket = net.createConnection(pipePath);
    let response = "";
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      socket.destroy();
      reject(new Error("trusted production launcher attestation timed out"));
    }, 45_000);
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      socket.destroy();
      if (error === undefined) resolve(value);
      else reject(error);
    };
    socket.setEncoding("utf8");
    socket.on("connect", () => {
      if (
        process.argv[2] === "__launcher-attestation-request-timeout-probe"
      ) {
        return;
      }
      const requestValues = [
        ATTESTATION_PROTOCOL,
        sessionToken,
        process.execPath,
        process.argv[1] ?? "",
        sourceAnchor.digestSha256,
        bootstrap.identity.values[6],
        bootstrap.identity.values[7],
        bootstrap.identity.values[8],
        bootstrap.initialLoaderSha256,
        String(process.argv.slice(2).length),
        ...process.argv.slice(2),
      ];
      socket.write(
        `REQUEST\t${requestValues.map(encodeProtocolField).join("\t")}\n`,
      );
    });
    socket.on("data", (chunk) => {
      response += chunk;
      const newline = response.indexOf("\n");
      if (newline === -1) {
        if (Buffer.byteLength(response, "utf8") > 64 * 1024) {
          finish(new Error("trusted production launcher response is too large"));
        }
        return;
      }
      try {
        finish(undefined, parseReceipt(response.slice(0, newline).replace(/\r$/u, "")));
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)));
      }
    });
    socket.on("error", (error) => {
      finish(
        new Error(
          `trusted production launcher handoff failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        ),
      );
    });
    socket.on("end", () => {
      if (!settled) {
        finish(new Error("trusted production launcher closed without a receipt"));
      }
    });
  });
}

async function receiveLaunchReceipt() {
  const pipeNames = process.env[PIPE_ENVIRONMENT_KEY];
  delete process.env[PIPE_ENVIRONMENT_KEY];
  delete process.env.RBP_PRODUCTION_LAUNCH_PIPE;
  if (pipeNames === undefined) return undefined;
  if (process.platform !== "win32") {
    throw new Error("trusted production launcher attestation is Windows-only");
  }
  const [authenticationPipeName, receiptPipeName, ...extra] =
    pipeNames.split("|");
  if (
    extra.length !== 0 ||
    authenticationPipeName === undefined ||
    receiptPipeName === undefined ||
    !PIPE_NAME_PATTERN.test(authenticationPipeName) ||
    !PIPE_NAME_PATTERN.test(receiptPipeName) ||
    authenticationPipeName === receiptPipeName
  ) {
    throw new Error("trusted production launcher pipe names are malformed");
  }
  const authentication = authenticateLauncherServer(authenticationPipeName);
  const bootstrap = assertCanonicalLauncherHost(authentication);
  const canonicalRepoRoot = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../../..",
  );
  const sourceAnchor = captureProductionSourceAnchor({
    repoRoot: canonicalRepoRoot,
    nodeExecutable: process.execPath,
    powershellExecutable: authentication.powershell,
  });
  if (
    sourceAnchor.commit !== bootstrap.payload.expectedCommit ||
    sourceAnchor.tree !== bootstrap.payload.expectedTree
  ) {
    throw new Error(
      "trusted production encoded bootstrap commit/tree is not current HEAD",
    );
  }
  const receipt = await connectToLauncher(
    receiptPipeName,
    authentication.token,
    sourceAnchor,
    bootstrap,
  );
  return { authentication, bootstrap, receipt, sourceAnchor };
}

const launchState = await receiveLaunchReceipt();
const launchReceipt = launchState?.receipt;

function assertFileReceipt(actual, expected, label) {
  if (
    typeof expected !== "object" ||
    expected === null ||
    !samePath(actual.path, expected.path) ||
    !samePath(actual.realPath, expected.realPath) ||
    actual.sha256 !== expected.sha256
  ) {
    throw new Error(`${label} does not match the trusted launcher receipt`);
  }
}

/**
 * Verifies the two OS-pipe launcher handoffs established before this process
 * loaded production JavaScript. There is intentionally no setter, test
 * override, or caller-provided capability: imported code without the live
 * canonical host cannot create production-valid evidence.
 */
export function assertTrustedProductionLaunch({ repoRoot, role }) {
  if (launchReceipt === undefined) {
    throw new Error(
      "production evidence commands require the tracked external PowerShell launcher",
    );
  }
  if (
    typeof launchReceipt !== "object" ||
    launchReceipt === null ||
    launchReceipt.protocol !== ATTESTATION_PROTOCOL ||
    launchReceipt.role !== role ||
    launchReceipt.childPid !== process.pid ||
    launchReceipt.launcherPid !== process.ppid ||
    !Array.isArray(launchReceipt.arguments) ||
    JSON.stringify(launchReceipt.arguments) !==
      JSON.stringify(process.argv.slice(2))
  ) {
    throw new Error("trusted production launcher receipt is not bound to this process");
  }

  const canonicalRepoRoot = realpathSync(path.resolve(repoRoot));
  if (
    launchState === undefined ||
    !samePath(process.cwd(), launchState.bootstrap.payload.repoRoot)
  ) {
    throw new Error(
      "trusted production launcher working directory is not bound to this process",
    );
  }
  if (
    !samePath(canonicalRepoRoot, launchState.sourceAnchor.repoRoot) ||
    launchReceipt.sourceAnchorDigest !== launchState.sourceAnchor.digestSha256 ||
    JSON.stringify(launchReceipt.sourceAnchorValues) !==
      JSON.stringify(launchState.sourceAnchor.values)
  ) {
    throw new Error(
      "trusted production launcher source anchor is not bound to this worktree",
    );
  }
  const expectedEntrypoints = {
    "prepare-wrapper": path.join(
      canonicalRepoRoot,
      "packages",
      "rbp-conformance",
      "scripts",
      "prepare-production.mjs",
    ),
    cli: path.join(
      canonicalRepoRoot,
      "packages",
      "rbp-conformance",
      "dist",
      "src",
      "cli.js",
    ),
    "cli-bootstrap": path.join(
      canonicalRepoRoot,
      "packages",
      "rbp-conformance",
      "scripts",
      "production-cli-bootstrap.mjs",
    ),
  };
  const expectedEntrypoint = expectedEntrypoints[role];
  if (expectedEntrypoint === undefined) {
    throw new Error(`unsupported trusted production launcher role: ${String(role)}`);
  }

  const node = exactRegularFile(process.execPath, "production controller Node");
  const entrypointValue = process.argv[1];
  if (entrypointValue === undefined) {
    throw new Error("trusted production entrypoint is unavailable");
  }
  const entrypoint = exactRegularFile(
    entrypointValue,
    "production process entrypoint",
  );
  if (!samePath(entrypoint.path, expectedEntrypoint)) {
    throw new Error(
      `trusted production launcher role ${role} requires ${expectedEntrypoint}`,
    );
  }
  const launcherRelativePath =
    "packages/rbp-conformance/scripts/invoke-production.ps1";
  const launcherSource = launchState.sourceAnchor.sources.find(
    (source) => source.relativePath === launcherRelativePath,
  );
  const bootstrapReceipt = launchReceipt.bootstrap;
  const bootstrapIdentity = launchState.bootstrap.identity;
  if (
    bootstrapReceipt === null ||
    typeof bootstrapReceipt !== "object" ||
    launcherSource === undefined ||
    launchState.bootstrap.payload.role !== role ||
    bootstrapReceipt.payloadSha256 !== bootstrapIdentity.values[6] ||
    bootstrapReceipt.sourceSha256 !== bootstrapIdentity.values[7] ||
    bootstrapReceipt.templateSha256 !== bootstrapIdentity.values[8] ||
    bootstrapReceipt.initialLoaderSha256 !==
      launchState.bootstrap.initialLoaderSha256 ||
    bootstrapReceipt.expectedCommit !== launchState.sourceAnchor.commit ||
    bootstrapReceipt.expectedTree !== launchState.sourceAnchor.tree ||
    bootstrapReceipt.launcherRelativePath !== launcherRelativePath ||
    bootstrapReceipt.launcherMode !== launcherSource.mode ||
    bootstrapReceipt.launcherObjectId !== launcherSource.objectId ||
    bootstrapReceipt.launcherSha256 !== launcherSource.sha256 ||
    bootstrapReceipt.gitSha256 !== launchState.sourceAnchor.git.sha256
  ) {
    throw new Error(
      "production launcher Git blob/bootstrap identity is not receipt-bound",
    );
  }
  assertFileReceipt(node, launchReceipt.node, "production controller Node");
  assertFileReceipt(
    entrypoint,
    launchReceipt.entrypoint,
    "production process entrypoint",
  );
  return launchState.sourceAnchor;
}

export function assertTrustedProductionSourceCurrent({ repoRoot, expected }) {
  if (launchState === undefined || launchReceipt === undefined) {
    throw new Error(
      "production source verification requires the tracked external launcher",
    );
  }
  const current = captureProductionSourceAnchor({
    repoRoot,
    nodeExecutable: process.execPath,
    powershellExecutable: launchState.authentication.powershell,
  });
  if (
    current.digestSha256 !== launchReceipt.sourceAnchorDigest ||
    JSON.stringify(current.values) !==
      JSON.stringify(launchReceipt.sourceAnchorValues) ||
    (
      expected !== undefined &&
      (
        current.digestSha256 !== expected.digestSha256 ||
        JSON.stringify(current.values) !== JSON.stringify(expected.values)
      )
    )
  ) {
    throw new Error(
      "production source/Git anchor changed after the trusted launcher handoff",
    );
  }
  return current;
}
