using System;
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
                if (IsAutoStartDisabled() || uiApplication == null)
                {
                    return;
                }

                SocketService service = SocketService.Instance;
                if (service.IsRunning)
                {
                    return;
                }

                service.Initialize(uiApplication);
                service.Start();
            }
            catch (Exception ex)
            {
                System.Diagnostics.Trace.WriteLine($"Failed to auto-start revAgent bridge service: {ex}");
            }
        }

        private static bool IsAutoStartDisabled()
        {
            string value = RevAgentEnvironment.Get("REVAGENT_AUTOSTART", "REVIT_MCP_AUTOSTART");
            return RevAgentEnvironment.IsFalseLike(value);
        }
    }
}
