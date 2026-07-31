using System;
using System.IO;
using System.Net;
using System.Net.Sockets;
using System.Text;
using System.Threading;
using Autodesk.Revit.UI;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;
using RevitMCPSDK.API.Models.JsonRPC;
using RevitMCPSDK.API.Interfaces;
using RevAgent.Contracts.AddinLoopback;
using RevAgentPlugin.Configuration;
using RevAgentPlugin.Utils;

namespace RevAgentPlugin.Core
{
    public class SocketService
    {
        private const int SocketReadBufferBytes = AddinFrameLimits.SocketReadBufferBytes;
        private const int DefaultMaxMessageBytes = AddinFrameLimits.DefaultMaxRequestPayloadBytes;
        private const int AbsoluteMaxMessageBytes = AddinFrameLimits.AbsoluteMaxRequestPayloadBytes;

        private enum SocketMessageFraming
        {
            Unknown,
            LegacyJson,
            LengthPrefixed
        }

        private class SocketRequestMetrics
        {
            public string Framing { get; set; }
            public long RequestBytes { get; set; }
            public long ReceiveMs { get; set; }
            public long ParseMs { get; set; }
            public long ExecuteMs { get; set; }
            public long ResponseBytes { get; set; }
        }

        private static SocketService _instance;
        private TcpListener _listener;
        private Thread _listenerThread;
        private bool _isRunning;
        private int _port = 8080;
        private UIApplication _uiApp;
        private ICommandRegistry _commandRegistry;
        private ILogger _logger;
        private CommandExecutor _commandExecutor;
        private readonly int _maxMessageBytes = ResolveMaxMessageBytes();
        private const string DataPlaneIntakeQuarantinedMessage =
            "Data-plane intake is quarantined after a timed-out Revit ExternalEvent; restart Revit before sending another command.";
        private readonly object _dataPlaneIntakeGate = new object();
        private bool _dataPlaneIntakeQuarantined;

        public static SocketService Instance
        {
            get
            {
                if(_instance == null)
                    _instance = new SocketService();
                return _instance;
            }
        }

        private SocketService()
        {
            _commandRegistry = new RevitCommandRegistry();
            _logger = new Logger();
        }

        private static int ResolveMaxMessageBytes()
        {
            string configured = RevAgentEnvironment.Get("REVAGENT_MAX_MESSAGE_BYTES", "REVIT_MCP_MAX_MESSAGE_BYTES");
            if (int.TryParse(configured, out int parsed) && parsed > 0)
            {
                return Math.Min(parsed, AbsoluteMaxMessageBytes);
            }

            return DefaultMaxMessageBytes;
        }

        public bool IsRunning => _isRunning;

        public int Port
        {
            get => _port;
            set => _port = value;
        }

        private int ResolveConfiguredPort(ConfigurationManager configManager)
        {
            string envPort = RevAgentEnvironment.Get(
                "REVAGENT_PLUGIN_PORT",
                "REVAGENT_PORT",
                "REVIT_MCP_PLUGIN_PORT",
                "REVIT_MCP_PORT");

            if (!string.IsNullOrWhiteSpace(envPort) &&
                int.TryParse(envPort, out int parsedEnvPort) &&
                parsedEnvPort > 0 &&
                parsedEnvPort <= 65535)
            {
                return parsedEnvPort;
            }

            int configuredPort = configManager?.Config?.Settings?.Port ?? 0;
            if (configuredPort > 0 && configuredPort <= 65535)
            {
                return configuredPort;
            }

            return 8080;
        }

        // Initialization.
        public void Initialize(UIApplication uiApp)
        {
            _uiApp = uiApp;

            // Initialize ExternalEventManager.
            ExternalEventManager.Instance.Initialize(uiApp, _logger);

            // Get the current Revit version.
            var versionAdapter = new RevitMCPSDK.API.Utils.RevitVersionAdapter(_uiApp.Application);
            string currentVersion = versionAdapter.GetRevitVersion();
            _logger.Info("Current Revit version: {0}", currentVersion);



            // Create CommandExecutor.
            _commandExecutor = new CommandExecutor(_commandRegistry, _logger);

            // Load configuration and register commands.
            ConfigurationManager configManager = new ConfigurationManager(_logger);
            configManager.LoadConfiguration();


            // Read the service port from configuration or environment.
            _port = ResolveConfiguredPort(configManager);

            // Load commands.
            CommandManager commandManager = new CommandManager(
                _commandRegistry, _logger, configManager, _uiApp);
            commandManager.LoadCommands();

            _logger.Info($"Socket service initialized on port {_port}");
        }

        public void Start()
        {
            if (_isRunning) return;

            int requestedPort = _port;
            int maxAutoPort = Math.Min(65535, requestedPort + 20);
            Exception lastError = null;

            for (int candidatePort = requestedPort; candidatePort <= maxAutoPort; candidatePort++)
            {
                try
                {
                    _listener = new TcpListener(IPAddress.Loopback, candidatePort);
                    _listener.Start();
                    _port = candidatePort;
                    _isRunning = true;

                    _listenerThread = new Thread(ListenForClients)
                    {
                        IsBackground = true
                    };
                    _listenerThread.Start();
                    _logger.Info("Socket service started on port {0}", _port);
                    return;
                }
                catch (SocketException ex)
                {
                    lastError = ex;
                    _listener = null;
                    if (ex.SocketErrorCode != SocketError.AddressAlreadyInUse)
                    {
                        break;
                    }
                }
                catch (Exception ex)
                {
                    lastError = ex;
                    _listener = null;
                    break;
                }
            }

            _isRunning = false;
            if (lastError != null)
            {
                _logger.Error("Failed to start socket service from port {0}: {1}", requestedPort, lastError.Message);
            }
        }

        public void Stop()
        {
            if (!_isRunning) return;

            try
            {
                _isRunning = false;

                _listener?.Stop();
                _listener = null;

                if(_listenerThread!=null && _listenerThread.IsAlive)
                {
                    _listenerThread.Join(1000);
                }

                McpTaskStatusWindowController.Instance.Shutdown();
            }
            catch (Exception)
            {
                // log error
            }
        }

        private void ListenForClients()
        {
            try
            {
                while (_isRunning)
                {
                    TcpClient client = _listener.AcceptTcpClient();

                    Thread clientThread = new Thread(HandleClientCommunication)
                    {
                        IsBackground = true
                    };
                    clientThread.Start(client);
                }
            }
            catch (SocketException)
            {
                _logger?.Warning("Socket listener stopped.");
            }
            catch(Exception ex)
            {
                _logger?.Error("Socket listener failed: {0}", ex);
            }
        }

        private void HandleClientCommunication(object clientObj)
        {
            TcpClient tcpClient = (TcpClient)clientObj;
            NetworkStream stream = tcpClient.GetStream();

            try
            {
                byte[] buffer = new byte[SocketReadBufferBytes];
                MemoryStream pending = new MemoryStream();
                SocketMessageFraming framing = SocketMessageFraming.Unknown;
                DateTime? receiveStartedAtUtc = null;

                while (_isRunning && tcpClient.Connected)
                {
                    // Read client messages.
                    int bytesRead = 0;

                    try
                    {
                        bytesRead = stream.Read(buffer, 0, buffer.Length);
                    }
                    catch (IOException)
                    {
                        // Client disconnected.
                        break;
                    }

                    if (bytesRead == 0)
                    {
                        // Client disconnected.
                        break;
                    }

                    if (!receiveStartedAtUtc.HasValue)
                    {
                        receiveStartedAtUtc = DateTime.UtcNow;
                    }

                    pending.Write(buffer, 0, bytesRead);
                    if (pending.Length > _maxMessageBytes + 4)
                    {
                        string oversizedResponse = CreateErrorResponse(
                            null,
                            JsonRPCErrorCodes.InvalidRequest,
                            $"JSON-RPC message exceeds maximum size of {_maxMessageBytes} bytes");
                        WriteResponse(stream, oversizedResponse, framing == SocketMessageFraming.LengthPrefixed);
                        throw new InvalidDataException("JSON-RPC message exceeded maximum size.");
                    }

                    bool processedMessage;
                    do
                    {
                        processedMessage = TryProcessPendingMessages(stream, pending, ref framing, receiveStartedAtUtc);
                    }
                    while (processedMessage && pending.Length > 0);

                    if (pending.Length == 0)
                    {
                        receiveStartedAtUtc = null;
                    }
                }
            }
            catch(Exception ex)
            {
                _logger?.Error("Socket client handler failed: {0}", ex);
            }
            finally
            {
                tcpClient.Close();
            }
        }

        private bool TryProcessPendingMessages(
            NetworkStream stream,
            MemoryStream pending,
            ref SocketMessageFraming framing,
            DateTime? receiveStartedAtUtc)
        {
            byte[] data = pending.ToArray();
            if (data.Length == 0)
            {
                return false;
            }

            if (framing == SocketMessageFraming.Unknown)
            {
                framing = DetectMessageFraming(data);
                if (framing == SocketMessageFraming.Unknown)
                {
                    return false;
                }
            }

            if (framing == SocketMessageFraming.LengthPrefixed)
            {
                if (data.Length < 4)
                {
                    return false;
                }

                int messageLength = ReadNetworkInt32(data, 0);
                if (messageLength <= 0 || messageLength > _maxMessageBytes)
                {
                    string response = CreateErrorResponse(
                        null,
                        JsonRPCErrorCodes.InvalidRequest,
                        $"Invalid JSON-RPC frame length: {messageLength}");
                    WriteResponse(stream, response, true);
                    throw new InvalidDataException($"Invalid JSON-RPC frame length: {messageLength}");
                }

                if (data.Length < 4 + messageLength)
                {
                    return false;
                }

                string message = Encoding.UTF8.GetString(data, 4, messageLength);
                ProcessAndWriteResponse(
                    stream,
                    message,
                    true,
                    messageLength + 4,
                    GetReceiveElapsedMs(receiveStartedAtUtc));
                ReplacePendingBytes(pending, data, 4 + messageLength);
                return true;
            }

            string legacyMessage = Encoding.UTF8.GetString(data, 0, data.Length);
            if (!IsCompleteJson(legacyMessage))
            {
                return false;
            }

            ProcessAndWriteResponse(
                stream,
                legacyMessage,
                false,
                data.Length,
                GetReceiveElapsedMs(receiveStartedAtUtc));
            pending.SetLength(0);
            return true;
        }

        private void ProcessAndWriteResponse(
            NetworkStream stream,
            string message,
            bool lengthPrefixed,
            long requestBytes,
            long receiveMs)
        {
            System.Diagnostics.Trace.WriteLine($"Received message bytes: {Encoding.UTF8.GetByteCount(message)}");

            SocketRequestMetrics metrics = new SocketRequestMetrics
            {
                Framing = lengthPrefixed ? "length-prefixed" : "legacy-json",
                RequestBytes = requestBytes,
                ReceiveMs = receiveMs
            };
            string response = ProcessJsonRPCRequest(message, metrics);
            WriteResponse(stream, response, lengthPrefixed);
        }

        private long GetReceiveElapsedMs(DateTime? receiveStartedAtUtc)
        {
            if (!receiveStartedAtUtc.HasValue)
            {
                return 0;
            }

            double elapsed = (DateTime.UtcNow - receiveStartedAtUtc.Value).TotalMilliseconds;
            return elapsed < 0 ? 0 : (long)elapsed;
        }

        private SocketMessageFraming DetectMessageFraming(byte[] data)
        {
            int first = 0;
            while (first < data.Length && IsAsciiWhitespace(data[first]))
            {
                first++;
            }

            if (first < data.Length && data[first] == (byte)'{')
            {
                return SocketMessageFraming.LegacyJson;
            }

            if (data.Length >= 4)
            {
                int messageLength = ReadNetworkInt32(data, 0);
                if (messageLength > 0 && messageLength <= _maxMessageBytes)
                {
                    return SocketMessageFraming.LengthPrefixed;
                }
            }

            return SocketMessageFraming.Unknown;
        }

        private bool IsAsciiWhitespace(byte value)
        {
            return value == 0x20 || value == 0x09 || value == 0x0A || value == 0x0D;
        }

        private int ReadNetworkInt32(byte[] data, int offset)
        {
            uint payloadLength = LengthPrefixedFrameCodec.ReadPayloadLength(data, offset);
            return payloadLength > int.MaxValue ? -1 : (int)payloadLength;
        }

        private void WriteResponse(NetworkStream stream, string response, bool lengthPrefixed)
        {
            byte[] responseData = Encoding.UTF8.GetBytes(response);
            if (lengthPrefixed)
            {
                byte[] header = new byte[4];
                LengthPrefixedFrameCodec.WritePayloadLength(header, 0, (uint)responseData.Length);
                stream.Write(header, 0, header.Length);
            }

            stream.Write(responseData, 0, responseData.Length);
        }

        private void ReplacePendingBytes(MemoryStream pending, byte[] data, int consumedBytes)
        {
            pending.SetLength(0);
            if (consumedBytes < data.Length)
            {
                pending.Write(data, consumedBytes, data.Length - consumedBytes);
                pending.Position = pending.Length;
            }
        }

        private bool IsCompleteJson(string json)
        {
            try
            {
                JsonConvert.DeserializeObject<JsonRPCRequest>(json);
                return true;
            }
            catch (JsonReaderException)
            {
                return false;
            }
            catch (JsonException)
            {
                return true;
            }
        }

        private string ProcessJsonRPCRequest(string requestJson, SocketRequestMetrics metrics)
        {
            JsonRPCRequest request;
            bool dataPlaneIntakeGateTaken = false;

            try
            {
                // Parse JSON-RPC request.
                System.Diagnostics.Stopwatch parseTimer = System.Diagnostics.Stopwatch.StartNew();
                request = JsonConvert.DeserializeObject<JsonRPCRequest>(requestJson);
                parseTimer.Stop();
                if (metrics != null)
                {
                    metrics.ParseMs = parseTimer.ElapsedMilliseconds;
                }

                // Verify that the request format is valid.
                if (request == null || !request.IsValid())
                {
                    return CreateErrorResponse(
                        null,
                        JsonRPCErrorCodes.InvalidRequest,
                        "Invalid JSON-RPC request"
                    );
                }

                if (string.Equals(request.Method, "mcp_status", StringComparison.OrdinalIgnoreCase))
                {
                    object snapshot = McpTaskStatusService.Instance.GetSnapshot(_isRunning, _port, _maxMessageBytes);
                    return CreateSuccessResponse(request.Id, snapshot);
                }

                // Command wrappers and their ExternalEvent handlers are process-wide
                // singletons. Keep status reads outside this gate, but serialize every
                // data-plane request before touching mutable command parameters.
                Monitor.Enter(_dataPlaneIntakeGate, ref dataPlaneIntakeGateTaken);

                if (_dataPlaneIntakeQuarantined)
                {
                    return CreateErrorResponse(
                        request.Id,
                        JsonRPCErrorCodes.InternalError,
                        DataPlaneIntakeQuarantinedMessage);
                }

                // Search for the command in the registry.
                if (!_commandRegistry.TryGetCommand(request.Method, out var command))
                {
                    return CreateErrorResponse(request.Id, JsonRPCErrorCodes.MethodNotFound,
                        $"Method '{request.Method}' not found");
                }

                // Execute command.
                McpTaskInfo activeTask = null;
                try
                {
                    string taskName = ExtractTaskDisplayName(request);
                    string wrapperAction = ExtractRequestParamText(request, "wrapperAction");
                    string logicalToolName = ExtractRequestParamText(request, "logicalToolName", "toolName");
                    string parentTaskName = ExtractRequestParamText(request, "parentTaskName");
                    string parentTaskId = ExtractRequestParamText(request, "parentTaskId");
                    bool suppressTaskStatusWindow =
                        (string.Equals(request.Method, "extract_spatial_snapshot", StringComparison.OrdinalIgnoreCase) ||
                         string.Equals(request.Method, "get_spatial_change_state", StringComparison.OrdinalIgnoreCase)) &&
                        ExtractRequestParamBool(request, "suppressTaskStatusWindow");
                    activeTask = McpTaskStatusService.Instance.BeginTask(
                        request.Id,
                        request.Method,
                        taskName,
                        _port,
                        metrics != null ? metrics.Framing : null,
                        metrics != null ? (long?)metrics.RequestBytes : null,
                        metrics != null ? (long?)metrics.ReceiveMs : null,
                        metrics != null ? (long?)metrics.ParseMs : null,
                        wrapperAction,
                        logicalToolName,
                        parentTaskName,
                        parentTaskId);
                    if (!suppressTaskStatusWindow) McpTaskStatusWindowController.Instance.ShowRunning(activeTask);

                    System.Diagnostics.Stopwatch executeTimer = System.Diagnostics.Stopwatch.StartNew();
                    object result = command.Execute(request.GetParamsObject(), request.Id);
                    executeTimer.Stop();
                    if (metrics != null)
                    {
                        metrics.ExecuteMs = executeTimer.ElapsedMilliseconds;
                    }

                    string response = CreateSuccessResponse(request.Id, result);
                    if (metrics != null)
                    {
                        metrics.ResponseBytes = GetResponseWireBytes(response, metrics.Framing);
                    }

                    if (IsCommandResultGuarded(result, out string guardReason))
                    {
                        McpTaskInfo guardedTask = McpTaskStatusService.Instance.GuardTask(
                            activeTask,
                            guardReason,
                            metrics != null ? (long?)metrics.ExecuteMs : null,
                            metrics != null ? (long?)metrics.ResponseBytes : null);
                        LogTaskMetrics(guardedTask, metrics);
                        if (!suppressTaskStatusWindow) McpTaskStatusWindowController.Instance.ShowGuarded(guardedTask);
                    }
                    else if (IsCommandResultFailure(result, out string commandError))
                    {
                        McpTaskInfo failedTask = McpTaskStatusService.Instance.FailTask(
                            activeTask,
                            commandError,
                            metrics != null ? (long?)metrics.ExecuteMs : null,
                            metrics != null ? (long?)metrics.ResponseBytes : null);
                        LogTaskMetrics(failedTask, metrics);
                        if (!suppressTaskStatusWindow) McpTaskStatusWindowController.Instance.ShowFailed(failedTask);
                    }
                    else
                    {
                        McpTaskInfo completedTask = McpTaskStatusService.Instance.CompleteTask(
                            activeTask,
                            metrics != null ? (long?)metrics.ExecuteMs : null,
                            metrics != null ? (long?)metrics.ResponseBytes : null);
                        LogTaskMetrics(completedTask, metrics);
                        if (!suppressTaskStatusWindow) McpTaskStatusWindowController.Instance.ShowCompleted(completedTask);
                    }

                    return response;
                }
                catch (AddinBatchRequestException ex)
                {
                    // Appendix A.4: a malformed, non-batchable, or budget/id
                    // violating execute_batch request maps to a standard
                    // JSON-RPC error with zero executed steps and no
                    // TransactionGroup. This path never quarantines intake.
                    string response = CreateErrorResponse(request.Id, ex.JsonRpcErrorCode, ex.Message);
                    if (metrics != null)
                    {
                        metrics.ResponseBytes = GetResponseWireBytes(response, metrics.Framing);
                    }

                    McpTaskInfo rejectedTask = McpTaskStatusService.Instance.FailTask(
                        activeTask,
                        ex.Message,
                        metrics != null && metrics.ExecuteMs > 0 ? (long?)metrics.ExecuteMs : null,
                        metrics != null ? (long?)metrics.ResponseBytes : null);
                    LogTaskMetrics(rejectedTask, metrics);
                    McpTaskStatusWindowController.Instance.ShowFailed(rejectedTask);
                    return response;
                }
                catch (Exception ex)
                {
                    if (ContainsTimeoutException(ex))
                    {
                        // ExternalEvent timeout does not cancel a pending or running Revit
                        // handler. Quarantine before releasing the process-wide intake gate
                        // so no later request can overwrite singleton handler parameters.
                        _dataPlaneIntakeQuarantined = true;
                        _logger?.Error(DataPlaneIntakeQuarantinedMessage);
                    }

                    string response = CreateErrorResponse(request.Id, JsonRPCErrorCodes.InternalError, ex.Message);
                    if (metrics != null)
                    {
                        metrics.ResponseBytes = GetResponseWireBytes(response, metrics.Framing);
                    }

                    McpTaskInfo failedTask = McpTaskStatusService.Instance.FailTask(
                        activeTask,
                        ex.Message,
                        metrics != null && metrics.ExecuteMs > 0 ? (long?)metrics.ExecuteMs : null,
                        metrics != null ? (long?)metrics.ResponseBytes : null);
                    LogTaskMetrics(failedTask, metrics);
                    McpTaskStatusWindowController.Instance.ShowFailed(failedTask);
                    return response;
                }
            }
            catch (JsonException)
            {
                // JSON parsing error.
                return CreateErrorResponse(
                    null,
                    JsonRPCErrorCodes.ParseError,
                    "Invalid JSON"
                );
            }
            catch (Exception ex)
            {
                // Catch other errors produced when processing requests.
                return CreateErrorResponse(
                    null,
                    JsonRPCErrorCodes.InternalError,
                    $"Internal error: {ex.Message}"
                );
            }
            finally
            {
                if (dataPlaneIntakeGateTaken)
                {
                    Monitor.Exit(_dataPlaneIntakeGate);
                }
            }
        }

        private static bool ContainsTimeoutException(Exception exception)
        {
            if (exception == null)
            {
                return false;
            }

            if (exception is TimeoutException)
            {
                return true;
            }

            AggregateException aggregateException = exception as AggregateException;
            if (aggregateException != null)
            {
                foreach (Exception innerException in aggregateException.InnerExceptions)
                {
                    if (ContainsTimeoutException(innerException))
                    {
                        return true;
                    }
                }
            }

            return ContainsTimeoutException(exception.InnerException);
        }

        private long GetResponseWireBytes(string response, string framing)
        {
            long bytes = Encoding.UTF8.GetByteCount(response ?? string.Empty);
            if (string.Equals(framing, "length-prefixed", StringComparison.OrdinalIgnoreCase))
            {
                bytes += 4;
            }

            return bytes;
        }

        private void LogTaskMetrics(McpTaskInfo task, SocketRequestMetrics metrics)
        {
            if (task == null || metrics == null)
            {
                return;
            }

            long totalMs = task.ElapsedMs + metrics.ReceiveMs + metrics.ParseMs;
            _logger?.Info(
                "MCP task metrics: requestId={0}; method={1}; taskName=\"{2}\"; state={3}; framing={4}; requestBytes={5}; receiveMs={6}; parseMs={7}; executeMs={8}; responseBytes={9}; totalMs={10}",
                task.RequestId,
                task.Method,
                task.TaskName,
                task.State,
                metrics.Framing,
                metrics.RequestBytes,
                metrics.ReceiveMs,
                metrics.ParseMs,
                metrics.ExecuteMs,
                metrics.ResponseBytes,
                totalMs);
        }

        private string ExtractTaskDisplayName(JsonRPCRequest request)
        {
            string taskName = ExtractRequestParamText(request, "taskName", "displayName", "operationName");
            if (!string.IsNullOrWhiteSpace(taskName))
            {
                return taskName;
            }

            return request == null || string.IsNullOrWhiteSpace(request.Method) ? "revAgent task" : request.Method;
        }

        private JObject GetRequestParamsObject(JsonRPCRequest request)
        {
            if (request == null)
            {
                return null;
            }

            try
            {
                JObject paramsObject = request.Params as JObject;
                if (paramsObject == null && request.Params != null && request.Params.Type == JTokenType.Object)
                {
                    paramsObject = request.GetParamsObject();
                }

                return paramsObject;
            }
            catch
            {
            }

            return null;
        }

        private string ExtractRequestParamText(JsonRPCRequest request, params string[] keys)
        {
            JObject paramsObject = GetRequestParamsObject(request);
            if (paramsObject == null || keys == null)
            {
                return null;
            }

            foreach (string key in keys)
            {
                if (paramsObject.TryGetValue(key, StringComparison.OrdinalIgnoreCase, out JToken value) &&
                    value != null &&
                    value.Type != JTokenType.Null)
                {
                    string text = value.Type == JTokenType.String
                        ? value.Value<string>()
                        : value.ToString();
                    if (!string.IsNullOrWhiteSpace(text))
                    {
                        return text;
                    }
                }
            }

            return null;
        }

        private bool ExtractRequestParamBool(JsonRPCRequest request, params string[] keys)
        {
            JObject paramsObject = GetRequestParamsObject(request);
            if (paramsObject == null || keys == null) return false;
            foreach (string key in keys)
            {
                JToken value;
                if (!paramsObject.TryGetValue(key, StringComparison.OrdinalIgnoreCase, out value) || value == null || value.Type == JTokenType.Null) continue;
                if (value.Type == JTokenType.Boolean) return value.Value<bool>();
                bool parsed;
                if (bool.TryParse(value.ToString(), out parsed)) return parsed;
            }
            return false;
        }

        private bool IsCommandResultGuarded(object result, out string reason)
        {
            reason = null;

            try
            {
                JToken token = result != null ? BridgeResultContract.ToCamelCaseToken(result) : null;

                if (token == null || token.Type != JTokenType.Object)
                {
                    return false;
                }

                JObject obj = (JObject)token;
                if (!IsExplicitSuccessFalse(obj))
                {
                    return false;
                }

                if (GetBooleanProperty(obj, "focusBlocked") == true ||
                    GetBooleanProperty(obj, "guarded") == true ||
                    GetBooleanProperty(obj, "blocked") == true)
                {
                    reason = ExtractGuardMessage(obj);
                    return true;
                }
            }
            catch
            {
            }

            return false;
        }

        private bool IsCommandResultFailure(object result, out string error)
        {
            error = null;

            try
            {
                JToken token = result != null ? BridgeResultContract.ToCamelCaseToken(result) : null;

                if (token == null || token.Type != JTokenType.Object)
                {
                    return false;
                }

                JObject obj = (JObject)token;
                if (obj.TryGetValue("success", StringComparison.OrdinalIgnoreCase, out JToken successToken) &&
                    successToken.Type == JTokenType.Boolean &&
                    successToken.Value<bool>() == false)
                {
                    error = ExtractErrorMessage(obj);
                    return true;
                }

                if (obj.TryGetValue("error", StringComparison.OrdinalIgnoreCase, out JToken errorToken) &&
                    errorToken != null &&
                    errorToken.Type != JTokenType.Null)
                {
                    string text = errorToken.Type == JTokenType.String
                        ? errorToken.Value<string>()
                        : errorToken.ToString(Formatting.None);
                    if (!string.IsNullOrWhiteSpace(text))
                    {
                        error = text;
                        return true;
                    }
                }
            }
            catch
            {
            }

            return false;
        }

        private bool IsExplicitSuccessFalse(JObject obj)
        {
            if (obj == null)
            {
                return false;
            }

            return obj.TryGetValue("success", StringComparison.OrdinalIgnoreCase, out JToken successToken) &&
                successToken.Type == JTokenType.Boolean &&
                successToken.Value<bool>() == false;
        }

        private bool? GetBooleanProperty(JObject obj, string propertyName)
        {
            if (obj == null ||
                !obj.TryGetValue(propertyName, StringComparison.OrdinalIgnoreCase, out JToken token) ||
                token == null ||
                token.Type == JTokenType.Null)
            {
                return null;
            }

            if (token.Type == JTokenType.Boolean)
            {
                return token.Value<bool>();
            }

            if (token.Type == JTokenType.String &&
                bool.TryParse(token.Value<string>(), out bool parsed))
            {
                return parsed;
            }

            return null;
        }

        private string ExtractGuardMessage(JObject obj)
        {
            string reason = ExtractText(obj, "focusBlockReason", "blockReason", "guardReason", "safetyReason");
            string message = ExtractText(obj, "message", "errorMessage", "error");

            if (!string.IsNullOrWhiteSpace(message) && !string.IsNullOrWhiteSpace(reason))
            {
                return message + " [" + reason + "]";
            }

            if (!string.IsNullOrWhiteSpace(message))
            {
                return message;
            }

            if (!string.IsNullOrWhiteSpace(reason))
            {
                return reason;
            }

            return "Command was blocked by a safety guard";
        }

        private string ExtractErrorMessage(JObject obj)
        {
            string text = ExtractText(obj, "errorMessage", "message", "error");
            return string.IsNullOrWhiteSpace(text) ? "Command returned success=false" : text;
        }

        private string ExtractText(JObject obj, params string[] keys)
        {
            foreach (string key in keys)
            {
                if (obj.TryGetValue(key, StringComparison.OrdinalIgnoreCase, out JToken value) &&
                    value != null &&
                    value.Type != JTokenType.Null)
                {
                    string text = value.Type == JTokenType.String
                        ? value.Value<string>()
                        : value.ToString(Formatting.None);
                    if (!string.IsNullOrWhiteSpace(text))
                    {
                        return text;
                    }
                }
            }

            return null;
        }

        private string CreateSuccessResponse(string id, object result)
        {
            var response = new JsonRPCSuccessResponse
            {
                Id = id,
                Result = BridgeResultContract.CreateResultPayload(result)
            };

            return response.ToJson();
        }

        private string CreateErrorResponse(string id, int code, string message, object data = null)
        {
            var response = new JsonRPCErrorResponse
            {
                Id = id,
                Error = new JsonRPCError
                {
                    Code = code,
                    Message = message,
                    Data = data != null ? BridgeResultContract.ToCamelCaseToken(data) : null
                }
            };

            return response.ToJson();
        }
    }
}
