using System;
using Autodesk.Revit.UI;
using System.Reflection;
using System.Windows.Media.Imaging;
using Autodesk.Revit.UI.Events;



namespace revit_mcp_plugin.Core
{
    public class Application : IExternalApplication
    {
        private UIControlledApplication _uiControlledApplication;

        public Result OnStartup(UIControlledApplication application)
        {
            RibbonPanel mcpPanel = application.CreateRibbonPanel("revAgent Bridge");

            PushButtonData pushButtonData = new PushButtonData("ID_EXCMD_TOGGLE_REVIT_MCP", "revAgent\r\nBridge",
                Assembly.GetExecutingAssembly().Location, "revit_mcp_plugin.Core.MCPServiceConnection");
            pushButtonData.ToolTip = "Start or stop the revAgent Revit bridge. It starts automatically with Revit.";
            pushButtonData.Image = new BitmapImage(new Uri("/revit-mcp-plugin;component/Core/Ressources/icon-16.png", UriKind.RelativeOrAbsolute));
            pushButtonData.LargeImage = new BitmapImage(new Uri("/revit-mcp-plugin;component/Core/Ressources/icon-32.png", UriKind.RelativeOrAbsolute));
            mcpPanel.AddItem(pushButtonData);

            PushButtonData mcp_settings_pushButtonData = new PushButtonData("ID_EXCMD_MCP_SETTINGS", "Settings",
                Assembly.GetExecutingAssembly().Location, "revit_mcp_plugin.Core.Settings");
            mcp_settings_pushButtonData.ToolTip = "revAgent bridge settings";
            mcp_settings_pushButtonData.Image = new BitmapImage(new Uri("/revit-mcp-plugin;component/Core/Ressources/settings-16.png", UriKind.RelativeOrAbsolute));
            mcp_settings_pushButtonData.LargeImage = new BitmapImage(new Uri("/revit-mcp-plugin;component/Core/Ressources/settings-32.png", UriKind.RelativeOrAbsolute));
            mcpPanel.AddItem(mcp_settings_pushButtonData);

            _uiControlledApplication = application;
            _uiControlledApplication.Idling += OnIdling;

            return Result.Succeeded;
        }

        public Result OnShutdown(UIControlledApplication application)
        {
            if (_uiControlledApplication != null)
            {
                _uiControlledApplication.Idling -= OnIdling;
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
            string value = Environment.GetEnvironmentVariable("REVIT_MCP_AUTOSTART");
            return string.Equals(value, "0", StringComparison.OrdinalIgnoreCase) ||
                   string.Equals(value, "false", StringComparison.OrdinalIgnoreCase) ||
                   string.Equals(value, "off", StringComparison.OrdinalIgnoreCase) ||
                   string.Equals(value, "no", StringComparison.OrdinalIgnoreCase);
        }
    }
}
