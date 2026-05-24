using System;
using System.ComponentModel;
using System.Collections.Generic;
using System.Diagnostics;
using System.Text;
using System.Windows;
using System.Windows.Interop;
using System.Windows.Media;
using System.Windows.Threading;
using revit_mcp_plugin.Core;

namespace revit_mcp_plugin.UI
{
    public partial class McpTaskStatusWindow : Window
    {
        private const int MaxHistoryItems = 50;
        private static readonly object PlacementSync = new object();
        private static bool _hasSessionPlacement;
        private static double _sessionLeft;
        private static double _sessionTop;

        private readonly DispatcherTimer _elapsedTimer;
        private readonly List<string> _history = new List<string>();
        private DateTime _startedAtUtc;
        private long _fixedElapsedMs;
        private bool _isRunning;
        private bool _allowClose;
        private bool _isClosed;
        private bool _placementInitialized;
        private bool _suppressPlacementSave;

        public bool IsClosed
        {
            get { return _isClosed; }
        }

        public McpTaskStatusWindow()
        {
            InitializeComponent();
            ApplyVersionInfo();

            _elapsedTimer = new DispatcherTimer(DispatcherPriority.Background);
            _elapsedTimer.Interval = TimeSpan.FromMilliseconds(500);
            _elapsedTimer.Tick += delegate { UpdateElapsedText(); };

            AckButton.Click += delegate
            {
                if (!_isRunning)
                {
                    Hide();
                }
            };
            Closing += OnClosing;
            Closed += delegate { _isClosed = true; };
            LocationChanged += OnLocationChanged;
            Loaded += delegate { EnsureWindowPlacement(); };
        }

        public void ForceClose()
        {
            _allowClose = true;
            Close();
        }

        public void ShowRunning(McpTaskInfo task)
        {
            _isRunning = true;
            _startedAtUtc = task.StartedAtUtc;
            _fixedElapsedMs = 0;

            ApplyPalette("#FFFFF3D6", "#FFD18A00");
            TitleText.Text = "revAgent is working";
            TaskText.Text = "Task: " + SafeTaskName(task);
            MessageText.Text = "Please do not use Revit until this finishes.";
            ErrorText.Text = string.Empty;
            ErrorText.Visibility = Visibility.Collapsed;
            AckButton.Visibility = Visibility.Collapsed;

            UpdateElapsedText();
            RefreshHistoryText();
            _elapsedTimer.Start();
            ShowAndPosition();
        }

        public void ShowCompleted(McpTaskInfo task)
        {
            _isRunning = false;
            _fixedElapsedMs = GetDisplayElapsedMs(task);
            _elapsedTimer.Stop();

            ApplyPalette("#FFE8F5E9", "#FF2E7D32");
            TitleText.Text = "revAgent task completed";
            TaskText.Text = "Task: " + SafeTaskName(task);
            MessageText.Text = "You can use Revit now.";
            ErrorText.Text = string.Empty;
            ErrorText.Visibility = Visibility.Collapsed;
            AckButton.Visibility = Visibility.Visible;

            UpdateElapsedText("Duration");
            AddHistory(task, "completed");
            ShowAndPosition();
        }

        public void ShowFailed(McpTaskInfo task)
        {
            _isRunning = false;
            _fixedElapsedMs = GetDisplayElapsedMs(task);
            _elapsedTimer.Stop();

            ApplyPalette("#FFFFEBEE", "#FFC62828");
            TitleText.Text = "revAgent task failed";
            TaskText.Text = "Task: " + SafeTaskName(task);
            MessageText.Text = "You can use Revit now. Check Codex for details.";
            ErrorText.Text = string.IsNullOrWhiteSpace(task.Error) ? string.Empty : "Error: " + task.Error;
            ErrorText.Visibility = string.IsNullOrWhiteSpace(task.Error) ? Visibility.Collapsed : Visibility.Visible;
            AckButton.Visibility = Visibility.Visible;

            UpdateElapsedText("Duration");
            AddHistory(task, "failed");
            ShowAndPosition();
        }

        public void ShowGuarded(McpTaskInfo task)
        {
            _isRunning = false;
            _fixedElapsedMs = GetDisplayElapsedMs(task);
            _elapsedTimer.Stop();

            ApplyPalette("#FFE8F1FA", "#FF2F6F9F");
            TitleText.Text = "revAgent task guarded";
            TaskText.Text = "Task: " + SafeTaskName(task);
            MessageText.Text = "Guarded / blocked by safety. No unsafe Revit action was run.";
            ErrorText.Text = string.IsNullOrWhiteSpace(task.Error) ? string.Empty : "Safety note: " + task.Error;
            ErrorText.Visibility = string.IsNullOrWhiteSpace(task.Error) ? Visibility.Collapsed : Visibility.Visible;
            AckButton.Visibility = Visibility.Visible;

            UpdateElapsedText("Duration");
            AddHistory(task, "guarded");
            ShowAndPosition();
        }

        private void ShowAndPosition()
        {
            if (_isClosed)
            {
                return;
            }

            if (!IsVisible)
            {
                Show();
            }

            EnsureWindowPlacement();
        }

        private void AttachRevitOwner()
        {
            IntPtr owner = Process.GetCurrentProcess().MainWindowHandle;
            if (owner == IntPtr.Zero)
            {
                return;
            }

            new WindowInteropHelper(this).Owner = owner;
        }

        private void EnsureWindowPlacement()
        {
            if (_placementInitialized)
            {
                return;
            }

            if (!ApplySessionPlacement())
            {
                PositionDefaultWindow();
            }

            _placementInitialized = true;
        }

        private bool ApplySessionPlacement()
        {
            double left;
            double top;
            lock (PlacementSync)
            {
                if (!_hasSessionPlacement)
                {
                    return false;
                }

                left = _sessionLeft;
                top = _sessionTop;
            }

            Rect area = SystemParameters.WorkArea;
            double width = GetPlacementWidth();
            double height = GetPlacementHeight();
            left = Clamp(left, area.Left, Math.Max(area.Left, area.Right - width));
            top = Clamp(top, area.Top, Math.Max(area.Top, area.Bottom - height));
            SetWindowPosition(left, top);
            return true;
        }

        private void PositionDefaultWindow()
        {
            Rect area = SystemParameters.WorkArea;
            SetWindowPosition(area.Right - GetPlacementWidth() - 24, area.Top + 24);
        }

        private void SetWindowPosition(double left, double top)
        {
            _suppressPlacementSave = true;
            try
            {
                Left = left;
                Top = top;
            }
            finally
            {
                _suppressPlacementSave = false;
            }
        }

        private void OnLocationChanged(object sender, EventArgs e)
        {
            if (_suppressPlacementSave || !_placementInitialized || _isClosed || !IsVisible)
            {
                return;
            }

            if (double.IsNaN(Left) || double.IsNaN(Top) ||
                double.IsInfinity(Left) || double.IsInfinity(Top))
            {
                return;
            }

            lock (PlacementSync)
            {
                _sessionLeft = Left;
                _sessionTop = Top;
                _hasSessionPlacement = true;
            }
        }

        private double GetPlacementWidth()
        {
            return ActualWidth > 0 ? ActualWidth : Width;
        }

        private double GetPlacementHeight()
        {
            return ActualHeight > 0 ? ActualHeight : Height;
        }

        private static double Clamp(double value, double min, double max)
        {
            if (value < min)
            {
                return min;
            }

            if (value > max)
            {
                return max;
            }

            return value;
        }

        private void ApplyPalette(string background, string border)
        {
            RootBorder.Background = (Brush)new BrushConverter().ConvertFromString(background);
            RootBorder.BorderBrush = (Brush)new BrushConverter().ConvertFromString(border);
        }

        private void ApplyVersionInfo()
        {
            McpVersionInfo version = McpVersionInfo.Read();
            VersionText.Text = version.VersionDisplay;
            UpdateStatusText.Text = version.FormatUpdateStatusLine();
            UpdateStatusText.Visibility = string.IsNullOrWhiteSpace(UpdateStatusText.Text)
                ? Visibility.Collapsed
                : Visibility.Visible;

            string tooltip = version.FormatToolTip();
            VersionText.ToolTip = tooltip;
            UpdateStatusText.ToolTip = tooltip;
        }

        private void UpdateElapsedText(string label = "Elapsed")
        {
            long elapsedMs = _isRunning
                ? Math.Max(0, (long)(DateTime.UtcNow - _startedAtUtc).TotalMilliseconds)
                : _fixedElapsedMs;

            ElapsedText.Text = label + ": " + FormatDuration(TimeSpan.FromMilliseconds(elapsedMs));
        }

        private void AddHistory(McpTaskInfo task, string state)
        {
            string finished = DateTime.Now.ToString("HH:mm:ss");
            if (task != null && task.FinishedAtUtc.HasValue)
            {
                finished = task.FinishedAtUtc.Value.ToLocalTime().ToString("HH:mm:ss");
            }

            string line = string.Format(
                "{0}  {1}  {2}  ({3}){4}",
                finished,
                StateLabel(state),
                SafeTaskName(task),
                FormatDuration(TimeSpan.FromMilliseconds(GetDisplayElapsedMs(task))),
                FormatMetrics(task));

            _history.Insert(0, line);
            while (_history.Count > MaxHistoryItems)
            {
                _history.RemoveAt(_history.Count - 1);
            }

            RefreshHistoryText();
        }

        private void RefreshHistoryText()
        {
            if (_history.Count == 0)
            {
                HistoryText.Text = "No completed tasks yet.";
                return;
            }

            StringBuilder builder = new StringBuilder();
            for (int i = 0; i < _history.Count; i++)
            {
                if (i > 0)
                {
                    builder.AppendLine();
                }
                builder.Append(_history[i]);
            }
            HistoryText.Text = builder.ToString();
        }

        private static string SafeTaskName(McpTaskInfo task)
        {
            if (task == null || string.IsNullOrWhiteSpace(task.TaskName))
            {
                return "revAgent task";
            }

            return task.TaskName;
        }

        private static string StateLabel(string state)
        {
            if (string.Equals(state, "completed", StringComparison.OrdinalIgnoreCase))
            {
                return "\u2713";
            }

            if (string.Equals(state, "failed", StringComparison.OrdinalIgnoreCase))
            {
                return "\u2715";
            }

            if (string.Equals(state, "guarded", StringComparison.OrdinalIgnoreCase) ||
                string.Equals(state, "blocked", StringComparison.OrdinalIgnoreCase))
            {
                return "guarded";
            }

            return "?";
        }

        private static string FormatMetrics(McpTaskInfo task)
        {
            if (task == null || !task.RequestBytes.HasValue)
            {
                return string.Empty;
            }

            return "  [" + FormatBytes(task.RequestBytes.Value) + "]";
        }

        private static string FormatBytes(long bytes)
        {
            if (bytes < 1024)
            {
                return bytes.ToString() + " B";
            }

            double kib = bytes / 1024.0;
            if (kib < 1024)
            {
                return kib.ToString("0.#") + " KB";
            }

            double mib = kib / 1024.0;
            return mib.ToString("0.##") + " MB";
        }

        private static long GetDisplayElapsedMs(McpTaskInfo task)
        {
            if (task == null)
            {
                return 0;
            }

            long elapsedMs = task.ElapsedMs;
            if (task.ReceiveMs.HasValue)
            {
                elapsedMs += task.ReceiveMs.Value;
            }
            if (task.ParseMs.HasValue)
            {
                elapsedMs += task.ParseMs.Value;
            }

            return elapsedMs;
        }

        private static string FormatDuration(TimeSpan duration)
        {
            if (duration.TotalMilliseconds < 1000)
            {
                return string.Format("{0:0.00}s", duration.TotalMilliseconds / 1000.0);
            }

            if (duration.TotalSeconds < 60)
            {
                return string.Format("{0:0.#}s", duration.TotalSeconds);
            }

            if (duration.TotalHours < 1)
            {
                return string.Format("{0}:{1:00}", (int)duration.TotalMinutes, duration.Seconds);
            }

            return string.Format("{0}h {1:00}m", (int)duration.TotalHours, duration.Minutes);
        }

        private void OnClosing(object sender, CancelEventArgs e)
        {
            if (_allowClose)
            {
                return;
            }

            e.Cancel = true;
            if (_isRunning)
            {
                return;
            }

            Hide();
        }
    }
}
