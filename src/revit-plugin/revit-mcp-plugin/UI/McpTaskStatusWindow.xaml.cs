using System;
using System.ComponentModel;
using System.Collections.Generic;
using System.Text;
using System.Windows;
using System.Windows.Media;
using System.Windows.Threading;
using revit_mcp_plugin.Core;

namespace revit_mcp_plugin.UI
{
    public partial class McpTaskStatusWindow : Window
    {
        private const int MaxHistoryItems = 50;
        private readonly DispatcherTimer _elapsedTimer;
        private readonly List<string> _history = new List<string>();
        private DateTime _startedAtUtc;
        private long _fixedElapsedMs;
        private bool _isRunning;
        private bool _allowClose;
        private bool _isClosed;

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
            Loaded += delegate { PositionWindow(); };
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
            TitleText.Text = "Revit MCP is working";
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
            _fixedElapsedMs = task.ElapsedMs;
            _elapsedTimer.Stop();

            ApplyPalette("#FFE8F5E9", "#FF2E7D32");
            TitleText.Text = "Revit MCP task completed";
            TaskText.Text = "Task: " + SafeTaskName(task);
            MessageText.Text = "You can use Revit now.";
            ErrorText.Text = string.Empty;
            ErrorText.Visibility = Visibility.Collapsed;
            AckButton.Visibility = Visibility.Visible;

            UpdateElapsedText("Duration");
            AddHistory(task, "Completed");
            ShowAndPosition();
        }

        public void ShowFailed(McpTaskInfo task)
        {
            _isRunning = false;
            _fixedElapsedMs = task.ElapsedMs;
            _elapsedTimer.Stop();

            ApplyPalette("#FFFFEBEE", "#FFC62828");
            TitleText.Text = "Revit MCP task failed";
            TaskText.Text = "Task: " + SafeTaskName(task);
            MessageText.Text = "You can use Revit now. Check Codex for details.";
            ErrorText.Text = string.IsNullOrWhiteSpace(task.Error) ? string.Empty : "Error: " + task.Error;
            ErrorText.Visibility = string.IsNullOrWhiteSpace(task.Error) ? Visibility.Collapsed : Visibility.Visible;
            AckButton.Visibility = Visibility.Visible;

            UpdateElapsedText("Duration");
            AddHistory(task, "Failed");
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

            PositionWindow();
            Activate();
        }

        private void PositionWindow()
        {
            Rect area = SystemParameters.WorkArea;
            Left = area.Right - Width - 24;
            Top = area.Top + 24;
        }

        private void ApplyPalette(string background, string border)
        {
            RootBorder.Background = (Brush)new BrushConverter().ConvertFromString(background);
            RootBorder.BorderBrush = (Brush)new BrushConverter().ConvertFromString(border);
        }

        private void ApplyVersionInfo()
        {
            McpVersionInfo version = McpVersionInfo.Read();
            VersionText.Text = "v" + version.ShortVersion;
            VersionText.ToolTip = string.IsNullOrWhiteSpace(version.SourcePath)
                ? "Revit MCP version: " + version.FullVersion
                : "Revit MCP version: " + version.FullVersion + Environment.NewLine + version.SourcePath;
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
                "{0}  {1}  {2}  ({3})",
                finished,
                state,
                SafeTaskName(task),
                FormatDuration(TimeSpan.FromMilliseconds(task != null ? task.ElapsedMs : 0)));

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
                return "Revit MCP task";
            }

            return task.TaskName;
        }

        private static string FormatDuration(TimeSpan duration)
        {
            int hours = (int)Math.Floor(duration.TotalHours);
            return string.Format("{0:00}:{1:00}:{2:00}", hours, duration.Minutes, duration.Seconds);
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
                Activate();
                return;
            }

            Hide();
        }
    }
}
