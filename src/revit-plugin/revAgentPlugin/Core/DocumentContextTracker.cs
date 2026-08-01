using System;
using System.Collections.Generic;
using System.Reflection;
using Autodesk.Revit.ApplicationServices;
using Autodesk.Revit.DB;
using Autodesk.Revit.DB.Events;
using Autodesk.Revit.UI.Events;
using Newtonsoft.Json.Linq;
using RevAgent.Contracts.AddinLoopback;
using RevitApplication = Autodesk.Revit.ApplicationServices.Application;

namespace RevAgentPlugin.Core
{
    /// <summary>
    /// RES-3 glue for the cached <c>get_document_context</c> command: thin
    /// Revit application-event handlers feed the pure
    /// <see cref="AddinDocumentContextAggregator"/> with cheap reads (titles,
    /// paths, worksharing flags, and active-view identity) captured on the
    /// Revit API/UI thread at event time. Serving the command later never
    /// raises an ExternalEvent and never composes get_current_view_info plus
    /// list_open_views (O1 Appendix A.3 prohibition).
    /// </summary>
    public sealed class DocumentContextTracker
    {
        private static readonly Lazy<DocumentContextTracker> LazyInstance =
            new Lazy<DocumentContextTracker>(() => new DocumentContextTracker());

        private static readonly PropertyInfo ElementIdValueProperty =
            typeof(ElementId).GetProperty("Value", BindingFlags.Instance | BindingFlags.Public) ??
            typeof(ElementId).GetProperty("IntegerValue", BindingFlags.Instance | BindingFlags.Public);

        private readonly object _gate = new object();
        private readonly AddinDocumentContextAggregator _aggregator =
            new AddinDocumentContextAggregator();
        private ControlledApplication _subscribedApplication;

        private DocumentContextTracker()
        {
        }

        public static DocumentContextTracker Instance
        {
            get { return LazyInstance.Value; }
        }

        /// <summary>
        /// True only while Revit application events maintain the cache; the
        /// doc_context_cached_v1 capability advertisement fails closed on it.
        /// </summary>
        public bool IsEventBacked
        {
            get
            {
                lock (_gate)
                {
                    return _subscribedApplication != null;
                }
            }
        }

        /// <summary>
        /// Returns the exact Appendix A.3 success result from the cache
        /// without touching the Revit API.
        /// </summary>
        public JObject ReadResultObject()
        {
            return _aggregator.Read().ToResultObject();
        }

        public void Subscribe(ControlledApplication application)
        {
            if (application == null) throw new ArgumentNullException("application");

            lock (_gate)
            {
                if (ReferenceEquals(_subscribedApplication, application)) return;
                if (_subscribedApplication != null)
                {
                    DetachHandlers(_subscribedApplication);
                }

                application.DocumentOpened += OnDocumentOpened;
                application.DocumentCreated += OnDocumentCreated;
                application.DocumentClosing += OnDocumentClosing;
                application.DocumentClosed += OnDocumentClosed;
                application.DocumentSavedAs += OnDocumentSavedAs;
                _subscribedApplication = application;
            }

            // OnStartup subscription precedes any document open, so the empty
            // baseline is a truthful ready snapshot rather than warming.
            try
            {
                _aggregator.RecordStartupBaseline();
            }
            catch (Exception ex)
            {
                SafeMarkUnavailable(ex);
            }
        }

        public void Unsubscribe(ControlledApplication application)
        {
            lock (_gate)
            {
                ControlledApplication current = _subscribedApplication;
                if (current == null) return;
                if (application != null && !ReferenceEquals(current, application)) return;

                DetachHandlers(current);
                _subscribedApplication = null;
            }

            try
            {
                _aggregator.MarkUnavailable(
                    "Document context tracker is not subscribed to Revit application events");
            }
            catch
            {
                // Invalidation must never throw during Revit shutdown.
            }
        }

        /// <summary>
        /// Called from the add-in application's ViewActivated hook: refreshes
        /// the full open-document list plus the active document/view context.
        /// </summary>
        public void NotifyViewActivated(ViewActivatedEventArgs args)
        {
            try
            {
                if (args == null) return;
                View view = args.CurrentActiveView;
                Document document = args.Document ?? (view != null ? view.Document : null);
                if (document == null) return;

                _aggregator.RecordViewActivated(
                    EnumerateOpenDocuments(document.Application),
                    GetStableKey(document),
                    CreateViewState(view),
                    ReadDisciplineHint(view));
            }
            catch (Exception ex)
            {
                SafeMarkUnavailable(ex);
            }
        }

        private void DetachHandlers(ControlledApplication application)
        {
            application.DocumentOpened -= OnDocumentOpened;
            application.DocumentCreated -= OnDocumentCreated;
            application.DocumentClosing -= OnDocumentClosing;
            application.DocumentClosed -= OnDocumentClosed;
            application.DocumentSavedAs -= OnDocumentSavedAs;
        }

        private void OnDocumentOpened(object sender, DocumentOpenedEventArgs args)
        {
            RecordDocumentsChangedEvent(
                args != null && args.Status == RevitAPIEventStatus.Succeeded ? args.Document : null);
        }

        private void OnDocumentCreated(object sender, DocumentCreatedEventArgs args)
        {
            RecordDocumentsChangedEvent(
                args != null && args.Status == RevitAPIEventStatus.Succeeded ? args.Document : null);
        }

        private void OnDocumentSavedAs(object sender, DocumentSavedAsEventArgs args)
        {
            RecordDocumentsChangedEvent(
                args != null && args.Status == RevitAPIEventStatus.Succeeded ? args.Document : null);
        }

        private void OnDocumentClosing(object sender, DocumentClosingEventArgs args)
        {
            try
            {
                if (args == null) return;
                Document document = args.Document;
                if (document == null) return;

                _aggregator.RecordDocumentClosing(args.DocumentId, GetStableKey(document));
            }
            catch (Exception ex)
            {
                SafeMarkUnavailable(ex);
            }
        }

        private void OnDocumentClosed(object sender, DocumentClosedEventArgs args)
        {
            try
            {
                if (args == null) return;
                _aggregator.RecordDocumentClosed(
                    args.DocumentId,
                    args.Status == RevitAPIEventStatus.Succeeded);
            }
            catch (Exception ex)
            {
                SafeMarkUnavailable(ex);
            }
        }

        private void RecordDocumentsChangedEvent(Document document)
        {
            try
            {
                if (document == null) return;
                _aggregator.RecordDocumentsChanged(EnumerateOpenDocuments(document.Application));
            }
            catch (Exception ex)
            {
                SafeMarkUnavailable(ex);
            }
        }

        private void SafeMarkUnavailable(Exception exception)
        {
            try
            {
                _aggregator.MarkUnavailable(
                    exception != null ? exception.Message : null);
            }
            catch
            {
                // The revision ceiling and event-handler safety both forbid
                // letting invalidation itself escape into Revit.
            }
        }

        private static IReadOnlyList<AddinDocumentContextDocumentSource> EnumerateOpenDocuments(
            RevitApplication application)
        {
            List<AddinDocumentContextDocumentSource> sources =
                new List<AddinDocumentContextDocumentSource>();
            if (application == null)
            {
                return sources;
            }

            HashSet<string> seenKeys = new HashSet<string>(StringComparer.Ordinal);
            foreach (Document document in application.Documents)
            {
                if (document == null || document.IsLinked) continue;

                string stableKey = GetStableKey(document);
                if (!seenKeys.Add(stableKey)) continue;

                sources.Add(new AddinDocumentContextDocumentSource(
                    stableKey,
                    ReadTitle(document),
                    AddinDocumentContextContract.ComputePathDigest(ReadPathName(document)),
                    document.IsWorkshared));
            }

            return sources;
        }

        private static string GetStableKey(Document document)
        {
            string pathName = ReadPathName(document);
            return string.IsNullOrEmpty(pathName)
                ? "untitled|" + ReadTitle(document)
                : "path|" + pathName;
        }

        private static string ReadTitle(Document document)
        {
            string title = document.Title;
            return string.IsNullOrEmpty(title) ? "Untitled" : title;
        }

        private static string ReadPathName(Document document)
        {
            return document.PathName;
        }

        private static AddinDocumentContextViewState CreateViewState(View view)
        {
            if (view == null) return null;

            string viewId = ReadElementIdValue(view.Id);
            string name = view.Name;
            if (string.IsNullOrEmpty(viewId) || string.IsNullOrEmpty(name)) return null;

            return new AddinDocumentContextViewState(
                viewId,
                name,
                view.ViewType.ToString(),
                ReadLevelName(view));
        }

        private static string ReadElementIdValue(ElementId elementId)
        {
            if (elementId == null || ElementIdValueProperty == null) return null;
            object value = ElementIdValueProperty.GetValue(elementId, null);
            return value != null
                ? Convert.ToString(value, System.Globalization.CultureInfo.InvariantCulture)
                : null;
        }

        private static string ReadLevelName(View view)
        {
            try
            {
                Level level = view.GenLevel;
                return level != null ? level.Name : null;
            }
            catch
            {
                // Not every view type supports an associated level.
                return null;
            }
        }

        private static string ReadDisciplineHint(View view)
        {
            try
            {
                return view != null
                    ? AddinDocumentContextContract.NormalizeDisciplineHint(view.Discipline.ToString())
                    : null;
            }
            catch
            {
                // Not every view type supports a discipline.
                return null;
            }
        }
    }
}
