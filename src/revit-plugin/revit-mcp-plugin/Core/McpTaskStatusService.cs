using System;
using System.Collections.Generic;
using System.Threading;
using Newtonsoft.Json;

namespace revit_mcp_plugin.Core
{
    public class McpTaskInfo
    {
        [JsonProperty("id")]
        public string Id { get; set; }

        [JsonProperty("requestId")]
        public string RequestId { get; set; }

        [JsonProperty("method")]
        public string Method { get; set; }

        [JsonProperty("taskName")]
        public string TaskName { get; set; }

        [JsonProperty("state")]
        public string State { get; set; }

        [JsonProperty("startedAtUtc")]
        public DateTime StartedAtUtc { get; set; }

        [JsonProperty("finishedAtUtc")]
        public DateTime? FinishedAtUtc { get; set; }

        [JsonProperty("elapsedMs")]
        public long ElapsedMs
        {
            get { return GetElapsedMs(DateTime.UtcNow); }
        }

        [JsonProperty("port")]
        public int Port { get; set; }

        [JsonProperty("error")]
        public string Error { get; set; }

        [JsonProperty("framing")]
        public string Framing { get; set; }

        [JsonProperty("requestBytes")]
        public long? RequestBytes { get; set; }

        [JsonProperty("receiveMs")]
        public long? ReceiveMs { get; set; }

        [JsonProperty("parseMs")]
        public long? ParseMs { get; set; }

        [JsonProperty("executeMs")]
        public long? ExecuteMs { get; set; }

        [JsonProperty("responseBytes")]
        public long? ResponseBytes { get; set; }

        public long GetElapsedMs(DateTime nowUtc)
        {
            DateTime end = FinishedAtUtc ?? nowUtc;
            double elapsed = (end - StartedAtUtc).TotalMilliseconds;
            return elapsed < 0 ? 0 : (long)elapsed;
        }

        public McpTaskInfo Clone()
        {
            return new McpTaskInfo
            {
                Id = Id,
                RequestId = RequestId,
                Method = Method,
                TaskName = TaskName,
                State = State,
                StartedAtUtc = StartedAtUtc,
                FinishedAtUtc = FinishedAtUtc,
                Port = Port,
                Error = Error,
                Framing = Framing,
                RequestBytes = RequestBytes,
                ReceiveMs = ReceiveMs,
                ParseMs = ParseMs,
                ExecuteMs = ExecuteMs,
                ResponseBytes = ResponseBytes
            };
        }
    }

    public sealed class McpTaskStatusService
    {
        private const int MaxRecentTasks = 100;
        private static readonly Lazy<McpTaskStatusService> LazyInstance =
            new Lazy<McpTaskStatusService>(() => new McpTaskStatusService());

        private readonly object _sync = new object();
        private readonly List<McpTaskInfo> _recentTasks = new List<McpTaskInfo>();
        private readonly List<string> _planPending = new List<string>();
        private readonly List<string> _planCompleted = new List<string>();
        private int _sequence;
        private McpTaskInfo _activeTask;

        public static McpTaskStatusService Instance
        {
            get { return LazyInstance.Value; }
        }

        private McpTaskStatusService()
        {
        }

        public McpTaskInfo BeginTask(
            string requestId,
            string method,
            string taskName,
            int port,
            string framing = null,
            long? requestBytes = null,
            long? receiveMs = null,
            long? parseMs = null)
        {
            DateTime now = DateTime.UtcNow;
            McpTaskInfo task = new McpTaskInfo
            {
                Id = string.Format("{0}-{1}", now.ToString("yyyyMMdd-HHmmssfff"), Interlocked.Increment(ref _sequence)),
                RequestId = requestId,
                Method = string.IsNullOrWhiteSpace(method) ? "unknown" : method,
                TaskName = string.IsNullOrWhiteSpace(taskName) ? method : taskName,
                State = "running",
                StartedAtUtc = now,
                Port = port,
                Framing = framing,
                RequestBytes = requestBytes,
                ReceiveMs = receiveMs,
                ParseMs = parseMs
            };

            lock (_sync)
            {
                _activeTask = task;
                return task.Clone();
            }
        }

        public McpTaskInfo CompleteTask(McpTaskInfo startedTask, long? executeMs = null, long? responseBytes = null)
        {
            return FinishTask(startedTask, "completed", null, executeMs, responseBytes);
        }

        public McpTaskInfo FailTask(McpTaskInfo startedTask, string error, long? executeMs = null, long? responseBytes = null)
        {
            return FinishTask(startedTask, "failed", Trim(error?.Trim(), 600), executeMs, responseBytes);
        }

        public McpTaskInfo GuardTask(McpTaskInfo startedTask, string reason, long? executeMs = null, long? responseBytes = null)
        {
            return FinishTask(startedTask, "guarded", Trim(reason?.Trim(), 600), executeMs, responseBytes);
        }

        public object GetSnapshot(bool isRunning, int port)
        {
            lock (_sync)
            {
                McpTaskInfo active = _activeTask != null ? _activeTask.Clone() : null;
                McpTaskInfo[] recent = new McpTaskInfo[_recentTasks.Count];
                for (int i = 0; i < _recentTasks.Count; i++)
                {
                    recent[i] = _recentTasks[i].Clone();
                }

                return new
                {
                    service = new
                    {
                        isRunning = isRunning,
                        port = port
                    },
                    activeTask = active,
                    recentTasks = recent,
                    recentHistoryCount = recent.Length,
                    recentHistoryCapacity = MaxRecentTasks,
                    plan = new
                    {
                        pending = _planPending.ToArray(),
                        completed = _planCompleted.ToArray()
                    }
                };
            }
        }

        private McpTaskInfo FinishTask(
            McpTaskInfo startedTask,
            string state,
            string error,
            long? executeMs,
            long? responseBytes)
        {
            if (startedTask == null)
            {
                return null;
            }

            lock (_sync)
            {
                McpTaskInfo task = _activeTask != null && _activeTask.Id == startedTask.Id
                    ? _activeTask
                    : startedTask.Clone();

                task.State = state;
                task.FinishedAtUtc = DateTime.UtcNow;
                task.Error = error;
                if (executeMs.HasValue)
                {
                    task.ExecuteMs = executeMs;
                }
                if (responseBytes.HasValue)
                {
                    task.ResponseBytes = responseBytes;
                }

                if (_activeTask != null && _activeTask.Id == task.Id)
                {
                    _activeTask = null;
                }

                AddRecentTask(task);
                return task.Clone();
            }
        }

        private void AddRecentTask(McpTaskInfo task)
        {
            _recentTasks.Insert(0, task.Clone());
            while (_recentTasks.Count > MaxRecentTasks)
            {
                _recentTasks.RemoveAt(_recentTasks.Count - 1);
            }
        }

        private static string Trim(string value, int maxLength)
        {
            if (string.IsNullOrEmpty(value) || value.Length <= maxLength)
            {
                return value;
            }

            return value.Substring(0, maxLength) + "...";
        }

    }
}
