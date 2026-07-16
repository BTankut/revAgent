using System;
using System.IO;
using Autodesk.Revit.UI;
using System.Reflection;
using System.Windows.Media.Imaging;
using Autodesk.Revit.UI.Events;



namespace RevAgentPlugin.Core
{
    public class Application : IExternalApplication
    {
        private UIControlledApplication _uiControlledApplication;

        public Result OnStartup(UIControlledApplication application)
        {
            SpatialChangeTracker.Instance.Subscribe(application.ControlledApplication);

            RibbonPanel mcpPanel = application.CreateRibbonPanel("revAgent");

            PushButtonData pushButtonData = new PushButtonData("ID_EXCMD_REVAGENT_INFO", "revAgent\r\nInfo",
                Assembly.GetExecutingAssembly().Location, "RevAgentPlugin.Core.RevAgentMetadataCommand");
            pushButtonData.ToolTip = "Show revAgent version and release information.";
            pushButtonData.Image = new BitmapImage(new Uri("/revAgentPlugin;component/Core/Ressources/icon-16.png", UriKind.RelativeOrAbsolute));
            pushButtonData.LargeImage = new BitmapImage(new Uri("/revAgentPlugin;component/Core/Ressources/icon-32.png", UriKind.RelativeOrAbsolute));
            mcpPanel.AddItem(pushButtonData);

            _uiControlledApplication = application;
            _uiControlledApplication.Idling += OnIdling;
            _uiControlledApplication.ViewActivated += OnViewActivated;

            return Result.Succeeded;
        }

        public Result OnShutdown(UIControlledApplication application)
        {
            SpatialChangeTracker.Instance.Unsubscribe(application != null ? application.ControlledApplication : null);

            if (_uiControlledApplication != null)
            {
                _uiControlledApplication.Idling -= OnIdling;
                _uiControlledApplication.ViewActivated -= OnViewActivated;
            }

            try
            {
                if (SocketService.Instance.IsRunning)
                {
                    SocketService.Instance.Stop();
                }

                McpTaskStatusWindowController.Instance.Shutdown();
            }
            catch { }

            return Result.Succeeded;
        }

        private void OnIdling(object sender, IdlingEventArgs e)
        {
            if (_uiControlledApplication != null)
            {
                _uiControlledApplication.Idling -= OnIdling;
            }

            StartSocketService(sender as UIApplication);
        }

        private void OnViewActivated(object sender, ViewActivatedEventArgs e)
        {
            // Current-state spatial evidence is bound to the active Revit
            // context. Conservatively invalidate even for same-document view
            // changes; no model data is read or written by this callback.
            SpatialChangeTracker.Instance.InvalidateActiveDocumentView();
        }

        private void StartSocketService(UIApplication uiApplication)
        {
            try
            {
                if (IsAutoStartDisabled())
                {
                    WriteStartupDiagnostic("revAgent bridge autostart skipped: autostart disabled by environment.");
                    return;
                }

                if (uiApplication == null)
                {
                    WriteStartupDiagnostic("revAgent bridge autostart skipped: UIApplication was not available.");
                    return;
                }

                WriteStartupDiagnostic("revAgent bridge autostart starting.");
                SocketService service = SocketService.Instance;
                if (service.IsRunning)
                {
                    WriteStartupDiagnostic("revAgent bridge autostart skipped: socket service already running.");
                    return;
                }

                service.Initialize(uiApplication);
                service.Start();
                WriteStartupDiagnostic("revAgent bridge autostart completed. running=" + service.IsRunning + "; port=" + service.Port);
            }
            catch (Exception ex)
            {
                System.Diagnostics.Trace.WriteLine($"Failed to auto-start revAgent bridge service: {ex}");
                WriteStartupDiagnostic("revAgent bridge autostart failed.", ex);
            }
        }

        private static bool IsAutoStartDisabled()
        {
            string value = RevAgentEnvironment.Get("REVAGENT_AUTOSTART", "REVIT_MCP_AUTOSTART");
            return RevAgentEnvironment.IsFalseLike(value);
        }

        private static void WriteStartupDiagnostic(string message, Exception exception = null)
        {
            try
            {
                string localAppData = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
                string root = string.IsNullOrWhiteSpace(localAppData)
                    ? Path.Combine(Path.GetTempPath(), "DPE", "revAgent", "Logs", "revit-plugin")
                    : Path.Combine(localAppData, "DPE", "revAgent", "Logs", "revit-plugin");
                Directory.CreateDirectory(root);
                string path = Path.Combine(root, $"startup_{DateTime.Now:yyyyMMdd}.log");
                string line = $"{DateTime.Now:yyyy-MM-dd HH:mm:ss} {message}";
                if (exception != null)
                {
                    line += Environment.NewLine + exception;
                }

                File.AppendAllText(path, line + Environment.NewLine);
            }
            catch
            {
                // Startup diagnostics must never affect Revit loading.
            }
        }
    }
}
