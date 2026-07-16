using RevitMCPSDK.API.Interfaces;
using System;
using System.IO;

namespace RevAgentPlugin.Utils
{
    public class Logger : ILogger
    {
        private readonly string _logFilePath;
        private LogLevel _currentLogLevel = LogLevel.Info;

        public Logger()
        {
            try
            {
                _logFilePath = Path.Combine(PathManager.GetLogsDirectoryPath(), $"mcp_{DateTime.Now:yyyyMMdd}.log");
            }
            catch
            {
                string fallbackRoot = Path.Combine(Path.GetTempPath(), "DPE", "revAgent", "Logs", "revit-plugin");
                Directory.CreateDirectory(fallbackRoot);
                _logFilePath = Path.Combine(fallbackRoot, $"mcp_{DateTime.Now:yyyyMMdd}.log");
            }

        }

        public void Log(LogLevel level, string message, params object[] args)
        {
            if (level < _currentLogLevel)
                return;

            string formattedMessage = args.Length > 0 ? string.Format(message, args) : message;
            string logEntry = $"{DateTime.Now:yyyy-MM-dd HH:mm:ss} [{level}] {formattedMessage}";

            // Output to the debug window.
            System.Diagnostics.Debug.WriteLine(logEntry);

            // Write to the log file.
            try
            {
                File.AppendAllText(_logFilePath, logEntry + Environment.NewLine);
            }
            catch
            {
                // Logging must never interrupt Revit command execution.
            }
        }

        public void Debug(string message, params object[] args)
        {
            Log(LogLevel.Debug, message, args);
        }

        public void Info(string message, params object[] args)
        {
            Log(LogLevel.Info, message, args);
        }

        public void Warning(string message, params object[] args)
        {
            Log(LogLevel.Warning, message, args);
        }

        public void Error(string message, params object[] args)
        {
            Log(LogLevel.Error, message, args);
        }
    }
}
