using System;
using System.Threading;
using System.Windows.Threading;
using revit_mcp_plugin.UI;

namespace revit_mcp_plugin.Core
{
    public sealed class McpTaskStatusWindowController
    {
        private static readonly Lazy<McpTaskStatusWindowController> LazyInstance =
            new Lazy<McpTaskStatusWindowController>(() => new McpTaskStatusWindowController());

        private readonly object _sync = new object();
        private Thread _uiThread;
        private Dispatcher _dispatcher;
        private McpTaskStatusWindow _window;

        public static McpTaskStatusWindowController Instance
        {
            get { return LazyInstance.Value; }
        }

        private McpTaskStatusWindowController()
        {
        }

        public void ShowRunning(McpTaskInfo task)
        {
            Post(task, delegate(McpTaskStatusWindow window, McpTaskInfo snapshot)
            {
                window.ShowRunning(snapshot);
            });
        }

        public void ShowCompleted(McpTaskInfo task)
        {
            Post(task, delegate(McpTaskStatusWindow window, McpTaskInfo snapshot)
            {
                window.ShowCompleted(snapshot);
            });
        }

        public void ShowFailed(McpTaskInfo task)
        {
            Post(task, delegate(McpTaskStatusWindow window, McpTaskInfo snapshot)
            {
                window.ShowFailed(snapshot);
            });
        }

        public void Shutdown()
        {
            Dispatcher dispatcher;
            McpTaskStatusWindow window;

            lock (_sync)
            {
                dispatcher = _dispatcher;
                window = _window;
                _dispatcher = null;
                _window = null;
                _uiThread = null;
            }

            if (dispatcher == null)
            {
                return;
            }

            try
            {
                dispatcher.BeginInvoke(new Action(delegate
                {
                    try
                    {
                        if (window != null)
                        {
                            window.ForceClose();
                        }
                    }
                    finally
                    {
                        dispatcher.BeginInvokeShutdown(DispatcherPriority.Background);
                    }
                }));
            }
            catch
            {
            }
        }

        private void Post(McpTaskInfo task, Action<McpTaskStatusWindow, McpTaskInfo> action)
        {
            if (task == null || action == null)
            {
                return;
            }

            McpTaskInfo snapshot = task.Clone();
            Dispatcher dispatcher = EnsureDispatcher();
            if (dispatcher == null)
            {
                return;
            }

            dispatcher.BeginInvoke(new Action(delegate
            {
                try
                {
                    if (_window == null || _window.IsClosed)
                    {
                        _window = new McpTaskStatusWindow();
                    }

                    action(_window, snapshot);
                }
                catch
                {
                    try
                    {
                        _window = new McpTaskStatusWindow();
                        action(_window, snapshot);
                    }
                    catch
                    {
                    }
                }
            }));
        }

        private Dispatcher EnsureDispatcher()
        {
            lock (_sync)
            {
                if (_dispatcher != null && !_dispatcher.HasShutdownStarted && !_dispatcher.HasShutdownFinished)
                {
                    return _dispatcher;
                }

                ManualResetEventSlim ready = new ManualResetEventSlim(false);

                _uiThread = new Thread(new ThreadStart(delegate
                {
                    _dispatcher = Dispatcher.CurrentDispatcher;
                    _window = new McpTaskStatusWindow();
                    ready.Set();
                    Dispatcher.Run();
                }));

                _uiThread.Name = "Revit MCP Task Status UI";
                _uiThread.IsBackground = true;
                _uiThread.SetApartmentState(ApartmentState.STA);
                _uiThread.Start();

                ready.Wait(5000);
                return _dispatcher;
            }
        }
    }
}
