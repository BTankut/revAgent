using System;
using System.Collections.Generic;
using System.Threading;
using Autodesk.Revit.DB;
using Autodesk.Revit.DB.Plumbing;
using Autodesk.Revit.UI;
using Newtonsoft.Json.Linq;
using RevitMCPSDK.API.Interfaces;

namespace RevitMCPPipeHeaderNormalizeCommandSet.Commands
{
    public class NormalizePipeHeaderOverlapCommand : IRevitCommand
    {
        private readonly NormalizePipeHeaderOverlapEventHandler _handler;
        private readonly ExternalEvent _event;

        public NormalizePipeHeaderOverlapCommand(UIApplication uiApp)
        {
            _handler = new NormalizePipeHeaderOverlapEventHandler();
            _event = ExternalEvent.Create(_handler);
        }

        public string CommandName
        {
            get { return "normalize_pipe_header_overlap"; }
        }

        public object Execute(JObject parameters, string requestId)
        {
            _handler.Reset();
            _handler.Mode = Text(parameters, "mode", "preview");
            _handler.Plan = parameters["plan"] as JObject;
            _handler.CommitToken = Text(parameters, "commitToken", "");
            _event.Raise();
            if (!_handler.WaitForCompletion(120000))
            {
                return Result(false, _handler.Mode, null, "normalize_pipe_header_overlap timed out before completion");
            }
            if (_handler.Exception != null)
            {
                return Result(false, _handler.Mode, null, _handler.Exception.ToString());
            }
            return _handler.Result ?? Result(false, _handler.Mode, null, "normalize_pipe_header_overlap returned no result");
        }

        private static string Text(JObject obj, string key, string fallback)
        {
            JToken token = obj != null ? obj[key] : null;
            string value = token != null ? token.ToString() : "";
            return string.IsNullOrWhiteSpace(value) ? fallback : value;
        }

        private static JObject Result(bool success, string mode, string planId, string error)
        {
            JObject result = new JObject();
            result["success"] = success;
            result["mode"] = mode;
            if (!string.IsNullOrWhiteSpace(planId)) result["planId"] = planId;
            result["errors"] = new JArray(error);
            result["warnings"] = new JArray();
            result["previewRows"] = new JArray();
            result["mappings"] = new JArray();
            result["mutateModel"] = false;
            return result;
        }
    }

    public class NormalizePipeHeaderOverlapEventHandler : IWaitableExternalEventHandler
    {
        private readonly ManualResetEventSlim _complete = new ManualResetEventSlim(false);

        public string Mode { get; set; }
        public JObject Plan { get; set; }
        public string CommitToken { get; set; }
        public JObject Result { get; private set; }
        public Exception Exception { get; private set; }

        public void Reset()
        {
            Result = null;
            Exception = null;
            _complete.Reset();
        }

        public bool WaitForCompletion(int timeoutMs)
        {
            return _complete.Wait(timeoutMs);
        }

        public void Execute(UIApplication app)
        {
            try
            {
                Document document = app != null && app.ActiveUIDocument != null ? app.ActiveUIDocument.Document : null;
                if (document == null)
                {
                    Result = PipeHeaderOverlapExecutor.Error(Mode, PlanId(Plan), "No active Revit document.");
                    return;
                }
                Result = PipeHeaderOverlapExecutor.Execute(document, Mode, Plan, CommitToken);
            }
            catch (Exception ex)
            {
                Exception = ex;
            }
            finally
            {
                _complete.Set();
            }
        }

        public string GetName()
        {
            return "Revit MCP Pipe Header Overlap Normalization";
        }

        private static string PlanId(JObject plan)
        {
            return plan != null && plan["planId"] != null ? plan["planId"].ToString() : "";
        }
    }

    internal static class PipeHeaderOverlapExecutor
    {
        private const double ConnectorToleranceFt = 0.015;
        private const double MinimumBreakClearanceFt = 0.03;
        private const double MaximumBranchExtensionMm = 150.0;
        private const string StrategyFittingToBranchPipe = "fitting_to_branch_pipe";
        private const string StrategyPipeOffsetToBranchPipe = "pipe_offset_to_branch_pipe";
        private const string StrategyDeleteOrphanOverlapFitting = "delete_orphan_overlap_fitting";

        public static JObject Execute(Document document, string mode, JObject plan, string commitToken)
        {
            string normalizedMode = string.IsNullOrWhiteSpace(mode) ? "preview" : mode;
            string planId = Text(plan, "planId", "");
            JObject step = FirstStep(plan);
            if (step == null)
            {
                return Error(normalizedMode, planId, "Plan must contain one normalize_pipe_header_overlap step.");
            }
            if (Text(step, "operation", "") != "normalize_pipe_header_overlap")
            {
                return Error(normalizedMode, planId, "Step operation must be normalize_pipe_header_overlap.");
            }

            PairAnalysis analysis = AnalyzePair(document, step);
            JObject row = analysis.ToPreviewRow(planId, Text(step, "stepId", "step-001"));

            if (normalizedMode == "commit")
            {
                if (!analysis.SafeForFutureCommit)
                {
                    JObject blocked = BaseResult(false, normalizedMode, planId);
                    blocked["errors"] = analysis.Errors;
                    blocked["warnings"] = analysis.Warnings;
                    blocked["previewRows"] = new JArray(row);
                    blocked["mutateModel"] = false;
                    return blocked;
                }

                CommitResult commit = CommitPair(document, analysis);
                JObject result = BaseResult(commit.Success, normalizedMode, planId);
                JObject commitRow = analysis.ToPreviewRow(planId, Text(step, "stepId", "step-001"));
                commitRow["status"] = commit.Success ? "committed" : "failed";
                commitRow["willMutateModel"] = commit.Success;
                commitRow["mutateModel"] = commit.Success;
                commitRow["newHeaderSegmentId"] = commit.NewHeaderSegmentId;
                commitRow["newTeeFittingId"] = commit.NewTeeFittingId;
                commitRow["branchPipeAdjusted"] = commit.BranchPipeAdjusted;
                commitRow["deletedElementIds"] = new JArray(commit.DeletedElementIds);
                result["warnings"] = commit.Warnings;
                result["errors"] = commit.Errors;
                result["previewRows"] = new JArray(commitRow);
                result["mutateModel"] = commit.Success;
                return result;
            }

            JObject preview = BaseResult(analysis.SafeForFutureCommit, normalizedMode, planId);
            preview["warnings"] = analysis.Warnings;
            preview["errors"] = analysis.Errors;
            preview["previewRows"] = new JArray(row);
            preview["mutateModel"] = false;
            return preview;
        }

        public static JObject Error(string mode, string planId, string error)
        {
            JObject result = BaseResult(false, mode, planId);
            result["errors"] = new JArray(error);
            result["warnings"] = new JArray();
            result["previewRows"] = new JArray();
            result["mutateModel"] = false;
            return result;
        }

        private static JObject BaseResult(bool success, string mode, string planId)
        {
            JObject result = new JObject();
            result["success"] = success;
            result["mode"] = mode;
            result["planId"] = planId;
            result["riskLevel"] = "critical";
            result["mappings"] = new JArray();
            result["audit"] = new JObject
            {
                ["mode"] = mode,
                ["nativeCommand"] = "normalize_pipe_header_overlap"
            };
            return result;
        }

        private static PairAnalysis AnalyzePair(Document document, JObject step)
        {
            PairAnalysis analysis = new PairAnalysis();
            analysis.Operation = "normalize_pipe_header_overlap";
            int firstId;
            int secondId;
            if (!TryGetPairIds(step, out firstId, out secondId))
            {
                analysis.Errors.Add("Exactly two pipe ids are required.");
                return analysis;
            }
            analysis.FirstElementId = firstId;
            analysis.SecondElementId = secondId;

            Pipe first = document.GetElement(new ElementId(firstId)) as Pipe;
            Pipe second = document.GetElement(new ElementId(secondId)) as Pipe;
            if (first == null || second == null)
            {
                analysis.Errors.Add("Both targets must be Autodesk.Revit.DB.Plumbing.Pipe elements.");
                return analysis;
            }

            LocationCurve firstCurve = first.Location as LocationCurve;
            LocationCurve secondCurve = second.Location as LocationCurve;
            if (firstCurve == null || secondCurve == null)
            {
                analysis.Errors.Add("Both pipes must have line-based LocationCurve geometry.");
                return analysis;
            }

            analysis.FirstLengthMm = firstCurve.Curve.Length * 304.8;
            analysis.SecondLengthMm = secondCurve.Curve.Length * 304.8;
            analysis.FirstDiameterMm = first.Diameter * 304.8;
            analysis.SecondDiameterMm = second.Diameter * 304.8;
            analysis.SameDiameter = Math.Abs(first.Diameter - second.Diameter) < 0.0001;
            analysis.SameSystemType = SameSystemType(first, second);
            analysis.Collinear = Collinear(firstCurve, secondCurve);
            analysis.OverlapMm = OverlapMm(firstCurve, secondCurve);

            Connector firstShared;
            Connector secondShared;
            Connector firstOpposite;
            Connector secondOpposite;
            FindSharedOpenConnectors(first, second, out firstShared, out secondShared, out firstOpposite, out secondOpposite);
            analysis.HasSharedOpenEndpoint = firstShared != null && secondShared != null;
            analysis.FirstOppositeConnected = firstOpposite != null && firstOpposite.IsConnected;
            analysis.SecondOppositeConnected = secondOpposite != null && secondOpposite.IsConnected;

            Pipe header = analysis.FirstLengthMm >= analysis.SecondLengthMm ? first : second;
            Pipe overlap = analysis.FirstLengthMm >= analysis.SecondLengthMm ? second : first;
            Connector overlapBranchConnector = analysis.FirstLengthMm >= analysis.SecondLengthMm ? secondOpposite : firstOpposite;
            LocationCurve headerCurve = analysis.FirstLengthMm >= analysis.SecondLengthMm ? firstCurve : secondCurve;
            analysis.HeaderPipeId = header.Id.IntegerValue;
            analysis.OverlapPipeId = overlap.Id.IntegerValue;

            Connector fittingConnector;
            Connector branchConnector;
            Element fitting;
            Pipe branchPipe;
            Pipe branchOffsetPipe;
            string strategy;
            ResolveBranchPath(overlap, overlapBranchConnector, out fittingConnector, out fitting, out branchPipe, out branchConnector, out branchOffsetPipe, out strategy);
            analysis.ExistingBranchFittingId = fitting != null ? fitting.Id.IntegerValue : 0;
            analysis.BranchPipeId = branchPipe != null ? branchPipe.Id.IntegerValue : 0;
            analysis.BranchOffsetPipeId = branchOffsetPipe != null ? branchOffsetPipe.Id.IntegerValue : 0;
            analysis.NormalizationStrategy = strategy;
            analysis.OrphanFittingOnly = strategy == StrategyDeleteOrphanOverlapFitting;
            analysis.BranchConnectorOwnerIsPipe = branchConnector != null && branchPipe != null;

            if (analysis.BranchConnectorOwnerIsPipe)
            {
                analysis.BranchConnectorOrigin = branchConnector.Origin;
                analysis.TeePoint = ProjectPointToLine(headerCurve.Curve, branchConnector.Origin);
                analysis.BranchConnectorToHeaderMm = Distance(branchConnector.Origin, analysis.TeePoint) * 304.8;
                double teeParameter;
                analysis.TeePointInsideHeader = IsPointInsideLineSegment(headerCurve.Curve, analysis.TeePoint, out teeParameter);
                double headerLength = headerCurve.Curve.Length;
                analysis.TeePointEndClearanceMm = Math.Min(teeParameter, headerLength - teeParameter) * 304.8;
                analysis.BranchExtensionCollinear = BranchExtensionStaysCollinear(branchPipe, branchConnector.Origin, analysis.TeePoint);
            }

            if (!analysis.SameSystemType) analysis.Errors.Add("Pipe system types differ.");
            if (!analysis.SameDiameter) analysis.Errors.Add("Pipe diameters differ.");
            if (!analysis.Collinear) analysis.Errors.Add("Pipe curves are not collinear.");
            if (analysis.OverlapMm <= 1.0) analysis.Errors.Add("Pipe curves do not have meaningful overlap.");
            if (!analysis.HasSharedOpenEndpoint) analysis.Errors.Add("Pipes do not share a coincident open endpoint.");
            if (!analysis.FirstOppositeConnected || !analysis.SecondOppositeConnected) analysis.Errors.Add("Both opposite connectors must be connected.");
            if (!analysis.BranchConnectorOwnerIsPipe && !analysis.OrphanFittingOnly) analysis.Errors.Add("The branch behind the overlap pipe could not be resolved to a pipe-owned connector.");
            if (analysis.BranchConnectorOwnerIsPipe && analysis.BranchConnectorToHeaderMm > MaximumBranchExtensionMm)
            {
                analysis.Errors.Add("Branch connector is too far from the header centerline for safe tee normalization.");
            }
            if (analysis.BranchConnectorOwnerIsPipe && !analysis.TeePointInsideHeader)
            {
                analysis.Errors.Add("Projected branch tee point is not inside the header pipe segment.");
            }
            if (analysis.BranchConnectorOwnerIsPipe && analysis.TeePointEndClearanceMm <= MinimumBreakClearanceFt * 304.8)
            {
                analysis.Errors.Add("Projected tee point is too close to a header endpoint for BreakCurve.");
            }
            if (analysis.BranchConnectorOwnerIsPipe && !analysis.BranchExtensionCollinear)
            {
                analysis.Errors.Add("Moving the branch pipe endpoint to the header would skew the branch pipe.");
            }
            if (analysis.OrphanFittingOnly)
            {
                analysis.Warnings.Add("Preview is single-pair only; commit deletes the overlap pipe and its orphan open fitting in one transaction.");
            }
            else
            {
                analysis.Warnings.Add("Preview is single-pair only; commit replaces the overlap/fitting with a tee in one transaction and must be followed by post-commit connectivity and clash audit.");
            }
            return analysis;
        }

        private static CommitResult CommitPair(Document document, PairAnalysis analysis)
        {
            CommitResult result = new CommitResult();
            Transaction transaction = new Transaction(document, "Normalize pipe header overlap");
            try
            {
                transaction.Start();

                Pipe header = document.GetElement(new ElementId(analysis.HeaderPipeId)) as Pipe;
                Pipe overlap = document.GetElement(new ElementId(analysis.OverlapPipeId)) as Pipe;
                Pipe branchPipe = document.GetElement(new ElementId(analysis.BranchPipeId)) as Pipe;
                Pipe branchOffsetPipe = analysis.BranchOffsetPipeId > 0
                    ? document.GetElement(new ElementId(analysis.BranchOffsetPipeId)) as Pipe
                    : null;
                Element fitting = analysis.ExistingBranchFittingId > 0
                    ? document.GetElement(new ElementId(analysis.ExistingBranchFittingId))
                    : null;

                if (header == null) throw new InvalidOperationException("Header pipe was not found at commit time.");
                if (overlap == null) throw new InvalidOperationException("Overlap pipe was not found at commit time.");
                if (!analysis.OrphanFittingOnly && branchPipe == null) throw new InvalidOperationException("Branch pipe was not found at commit time.");

                if (fitting != null)
                {
                    AddDeletedIds(result, document.Delete(fitting.Id));
                }
                if (document.GetElement(overlap.Id) != null)
                {
                    AddDeletedIds(result, document.Delete(overlap.Id));
                }
                if (branchOffsetPipe != null && document.GetElement(branchOffsetPipe.Id) != null)
                {
                    AddDeletedIds(result, document.Delete(branchOffsetPipe.Id));
                }
                document.Regenerate();

                if (analysis.OrphanFittingOnly)
                {
                    transaction.Commit();
                    result.Success = true;
                    result.Warnings.Add("Committed orphan overlap/fitting cleanup; run post-commit audit before processing the next pair.");
                    return result;
                }

                branchPipe = document.GetElement(new ElementId(analysis.BranchPipeId)) as Pipe;
                if (branchPipe == null) throw new InvalidOperationException("Branch pipe was deleted while removing the old fitting.");
                MoveBranchEndpoint(branchPipe, analysis.BranchConnectorOrigin, analysis.TeePoint);
                result.BranchPipeAdjusted = true;
                document.Regenerate();

                header = document.GetElement(new ElementId(analysis.HeaderPipeId)) as Pipe;
                if (header == null) throw new InvalidOperationException("Header pipe was deleted before BreakCurve.");
                ElementId newHeaderSegmentId = PlumbingUtils.BreakCurve(document, header.Id, analysis.TeePoint);
                if (newHeaderSegmentId == null || newHeaderSegmentId == ElementId.InvalidElementId)
                {
                    throw new InvalidOperationException("BreakCurve did not return a new header segment id.");
                }
                result.NewHeaderSegmentId = newHeaderSegmentId.IntegerValue;
                document.Regenerate();

                header = document.GetElement(new ElementId(analysis.HeaderPipeId)) as Pipe;
                Pipe newHeaderSegment = document.GetElement(newHeaderSegmentId) as Pipe;
                branchPipe = document.GetElement(new ElementId(analysis.BranchPipeId)) as Pipe;
                if (header == null || newHeaderSegment == null || branchPipe == null)
                {
                    throw new InvalidOperationException("Could not reacquire header, new header segment, or branch pipe after BreakCurve.");
                }

                Connector headerConnector = FindConnectorNear(header, analysis.TeePoint, true);
                Connector newHeaderConnector = FindConnectorNear(newHeaderSegment, analysis.TeePoint, true);
                Connector branchConnector = FindConnectorNear(branchPipe, analysis.TeePoint, true);
                if (headerConnector == null) throw new InvalidOperationException("Original header connector at tee point was not found.");
                if (newHeaderConnector == null) throw new InvalidOperationException("New header segment connector at tee point was not found.");
                if (branchConnector == null) throw new InvalidOperationException("Branch pipe connector at tee point was not found.");

                string teeError;
                FamilyInstance tee = TryCreateTeeFitting(document, headerConnector, newHeaderConnector, branchConnector, out teeError);
                if (tee == null)
                {
                    throw new InvalidOperationException("NewTeeFitting failed for all connector orders: " + teeError);
                }
                result.NewTeeFittingId = tee.Id.IntegerValue;
                document.Regenerate();

                transaction.Commit();
                result.Success = true;
                result.Warnings.Add("Committed one pipe header overlap normalization; run post-commit audit before processing the next pair.");
                return result;
            }
            catch (Exception ex)
            {
                result.Errors.Add(ex.Message);
                result.Warnings.Add("Transaction was rolled back; model state should be unchanged for this pair.");
                if (transaction.GetStatus() == TransactionStatus.Started)
                {
                    transaction.RollBack();
                }
                return result;
            }
        }

        private static JObject FirstStep(JObject plan)
        {
            JArray steps = plan != null ? plan["steps"] as JArray : null;
            return steps != null && steps.Count > 0 ? steps[0] as JObject : null;
        }

        private static bool TryGetPairIds(JObject step, out int firstId, out int secondId)
        {
            firstId = 0;
            secondId = 0;
            JObject targets = step["targets"] as JObject;
            JObject args = step["arguments"] as JObject;
            JArray ids = targets != null ? targets["elementIds"] as JArray : null;
            if (ids != null && ids.Count == 2)
            {
                firstId = ids[0].Value<int>();
                secondId = ids[1].Value<int>();
                return true;
            }
            firstId = IntValue(targets, "headerPipeId", IntValue(args, "headerPipeId", 0));
            secondId = IntValue(targets, "overlapPipeId", IntValue(args, "overlapPipeId", 0));
            return firstId > 0 && secondId > 0;
        }

        private static void FindSharedOpenConnectors(Pipe first, Pipe second, out Connector firstShared, out Connector secondShared, out Connector firstOpposite, out Connector secondOpposite)
        {
            firstShared = null;
            secondShared = null;
            firstOpposite = null;
            secondOpposite = null;
            foreach (Connector a in first.ConnectorManager.Connectors)
            {
                foreach (Connector b in second.ConnectorManager.Connectors)
                {
                    if (!a.IsConnected && !b.IsConnected && Distance(a, b) < 0.003)
                    {
                        firstShared = a;
                        secondShared = b;
                    }
                }
            }
            foreach (Connector a in first.ConnectorManager.Connectors)
            {
                if (firstShared == null || Distance(a, firstShared) > 0.003) firstOpposite = a;
            }
            foreach (Connector b in second.ConnectorManager.Connectors)
            {
                if (secondShared == null || Distance(b, secondShared) > 0.003) secondOpposite = b;
            }
        }

        private static void ResolveBranchPath(Pipe overlap, Connector overlapBranchConnector, out Connector fittingConnector, out Element fitting, out Pipe branchPipe, out Connector branchConnector, out Pipe branchOffsetPipe, out string strategy)
        {
            fittingConnector = null;
            fitting = null;
            branchPipe = null;
            branchConnector = null;
            branchOffsetPipe = null;
            strategy = "";
            if (overlapBranchConnector == null || !overlapBranchConnector.IsConnected) return;

            foreach (Connector reference in overlapBranchConnector.AllRefs)
            {
                if (reference.Owner != null &&
                    reference.Owner.Id.IntegerValue != overlap.Id.IntegerValue &&
                    reference.Owner.Category != null &&
                    reference.Owner.Category.Id.IntegerValue == (int)BuiltInCategory.OST_PipeFitting)
                {
                    fittingConnector = reference;
                    fitting = reference.Owner;
                    break;
                }
                if (reference.Owner != null && reference.Owner.Id.IntegerValue != overlap.Id.IntegerValue)
                {
                    Pipe pipeReference = reference.Owner as Pipe;
                    if (pipeReference != null)
                    {
                        branchOffsetPipe = pipeReference;
                    }
                }
            }

            if (fitting != null)
            {
                if (FindPipeBehindFitting(fitting, fittingConnector, overlap.Id.IntegerValue, out branchPipe, out branchConnector))
                {
                    strategy = StrategyFittingToBranchPipe;
                    return;
                }
                if (FittingHasOpenPhysicalConnector(fitting, fittingConnector))
                {
                    strategy = StrategyDeleteOrphanOverlapFitting;
                    return;
                }
            }

            if (branchOffsetPipe != null)
            {
                Connector offsetOpposite = FindOppositeConnector(branchOffsetPipe, overlapBranchConnector.Origin);
                Element offsetFitting;
                Connector offsetFittingConnector;
                FindConnectedFitting(branchOffsetPipe, offsetOpposite, out offsetFitting, out offsetFittingConnector);
                if (offsetFitting != null &&
                    FindPipeBehindFitting(offsetFitting, offsetFittingConnector, branchOffsetPipe.Id.IntegerValue, out branchPipe, out branchConnector))
                {
                    fitting = offsetFitting;
                    fittingConnector = offsetFittingConnector;
                    strategy = StrategyPipeOffsetToBranchPipe;
                }
            }
        }

        private static bool FindPipeBehindFitting(Element fitting, Connector fittingConnectorToIgnore, int ownerIdToExclude, out Pipe branchPipe, out Connector branchConnector)
        {
            branchPipe = null;
            branchConnector = null;
            FamilyInstance familyInstance = fitting as FamilyInstance;
            if (familyInstance == null || familyInstance.MEPModel == null || familyInstance.MEPModel.ConnectorManager == null) return false;
            foreach (Connector fittingSide in familyInstance.MEPModel.ConnectorManager.Connectors)
            {
                if (fittingConnectorToIgnore != null && Distance(fittingSide, fittingConnectorToIgnore) < 0.003) continue;
                foreach (Connector reference in fittingSide.AllRefs)
                {
                    if (reference.Owner != null &&
                        reference.Owner.Id.IntegerValue != fitting.Id.IntegerValue &&
                        reference.Owner.Id.IntegerValue != ownerIdToExclude)
                    {
                        Pipe candidate = reference.Owner as Pipe;
                        if (candidate != null)
                        {
                            branchPipe = candidate;
                            branchConnector = reference;
                            return true;
                        }
                    }
                }
            }
            return false;
        }

        private static bool FittingHasOpenPhysicalConnector(Element fitting, Connector fittingConnectorToIgnore)
        {
            FamilyInstance familyInstance = fitting as FamilyInstance;
            if (familyInstance == null || familyInstance.MEPModel == null || familyInstance.MEPModel.ConnectorManager == null) return false;
            foreach (Connector fittingSide in familyInstance.MEPModel.ConnectorManager.Connectors)
            {
                if (fittingConnectorToIgnore != null && Distance(fittingSide, fittingConnectorToIgnore) < 0.003) continue;
                if (!fittingSide.IsConnected) return true;
            }
            return false;
        }

        private static Connector FindOppositeConnector(Pipe pipe, XYZ point)
        {
            Connector best = null;
            double bestDistance = -1.0;
            foreach (Connector connector in pipe.ConnectorManager.Connectors)
            {
                double distance = connector.Origin.DistanceTo(point);
                if (distance > bestDistance)
                {
                    best = connector;
                    bestDistance = distance;
                }
            }
            return best;
        }

        private static void FindConnectedFitting(Pipe pipe, Connector pipeConnector, out Element fitting, out Connector fittingConnector)
        {
            fitting = null;
            fittingConnector = null;
            if (pipeConnector == null || !pipeConnector.IsConnected) return;
            foreach (Connector reference in pipeConnector.AllRefs)
            {
                if (reference.Owner != null &&
                    reference.Owner.Id.IntegerValue != pipe.Id.IntegerValue &&
                    reference.Owner.Category != null &&
                    reference.Owner.Category.Id.IntegerValue == (int)BuiltInCategory.OST_PipeFitting)
                {
                    fitting = reference.Owner;
                    fittingConnector = reference;
                    return;
                }
            }
        }

        private static bool SameSystemType(Pipe first, Pipe second)
        {
            Parameter a = first.LookupParameter("System Type");
            Parameter b = second.LookupParameter("System Type");
            if (a == null || b == null) return false;
            return a.AsElementId().IntegerValue == b.AsElementId().IntegerValue;
        }

        private static bool Collinear(LocationCurve first, LocationCurve second)
        {
            XYZ a0 = first.Curve.GetEndPoint(0);
            XYZ a1 = first.Curve.GetEndPoint(1);
            XYZ b0 = second.Curve.GetEndPoint(0);
            XYZ b1 = second.Curve.GetEndPoint(1);
            XYZ axisA = (a1 - a0).Normalize();
            XYZ axisB = (b1 - b0).Normalize();
            return Math.Abs(axisA.DotProduct(axisB)) > 0.999 && (b0 - a0).CrossProduct(axisA).GetLength() < 0.01;
        }

        private static double OverlapMm(LocationCurve first, LocationCurve second)
        {
            XYZ a0 = first.Curve.GetEndPoint(0);
            XYZ a1 = first.Curve.GetEndPoint(1);
            XYZ b0 = second.Curve.GetEndPoint(0);
            XYZ b1 = second.Curve.GetEndPoint(1);
            XYZ axis = (a1 - a0).Normalize();
            double aMin = Math.Min(0.0, (a1 - a0).DotProduct(axis));
            double aMax = Math.Max(0.0, (a1 - a0).DotProduct(axis));
            double bT0 = (b0 - a0).DotProduct(axis);
            double bT1 = (b1 - a0).DotProduct(axis);
            double bMin = Math.Min(bT0, bT1);
            double bMax = Math.Max(bT0, bT1);
            return Math.Max(0.0, Math.Min(aMax, bMax) - Math.Max(aMin, bMin)) * 304.8;
        }

        private static XYZ ProjectPointToLine(Curve curve, XYZ point)
        {
            XYZ start = curve.GetEndPoint(0);
            XYZ end = curve.GetEndPoint(1);
            XYZ axis = (end - start).Normalize();
            double parameter = (point - start).DotProduct(axis);
            return start + axis * parameter;
        }

        private static bool IsPointInsideLineSegment(Curve curve, XYZ point, out double parameter)
        {
            XYZ start = curve.GetEndPoint(0);
            XYZ end = curve.GetEndPoint(1);
            XYZ axis = (end - start).Normalize();
            parameter = (point - start).DotProduct(axis);
            return parameter > MinimumBreakClearanceFt && parameter < curve.Length - MinimumBreakClearanceFt;
        }

        private static bool BranchExtensionStaysCollinear(Pipe branchPipe, XYZ oldConnectorPoint, XYZ teePoint)
        {
            if (branchPipe == null) return false;
            LocationCurve locationCurve = branchPipe.Location as LocationCurve;
            if (locationCurve == null) return false;
            XYZ p0 = locationCurve.Curve.GetEndPoint(0);
            XYZ p1 = locationCurve.Curve.GetEndPoint(1);
            XYZ fixedPoint = p0.DistanceTo(oldConnectorPoint) > p1.DistanceTo(oldConnectorPoint) ? p0 : p1;
            if (fixedPoint.DistanceTo(teePoint) < 0.01) return false;
            XYZ oldAxis = (p1 - p0).Normalize();
            XYZ newAxis = (teePoint - fixedPoint).Normalize();
            return Math.Abs(oldAxis.DotProduct(newAxis)) > 0.999;
        }

        private static void MoveBranchEndpoint(Pipe branchPipe, XYZ oldConnectorPoint, XYZ teePoint)
        {
            LocationCurve locationCurve = branchPipe.Location as LocationCurve;
            if (locationCurve == null) throw new InvalidOperationException("Branch pipe does not have a line-based LocationCurve.");
            XYZ p0 = locationCurve.Curve.GetEndPoint(0);
            XYZ p1 = locationCurve.Curve.GetEndPoint(1);
            bool moveStart = p0.DistanceTo(oldConnectorPoint) <= p1.DistanceTo(oldConnectorPoint);
            XYZ fixedPoint = moveStart ? p1 : p0;
            if (fixedPoint.DistanceTo(teePoint) < 0.01)
            {
                throw new InvalidOperationException("Branch pipe would become too short after endpoint adjustment.");
            }
            Curve newCurve = moveStart ? Line.CreateBound(teePoint, fixedPoint) : Line.CreateBound(fixedPoint, teePoint);
            locationCurve.Curve = newCurve;
        }

        private static Connector FindConnectorNear(Pipe pipe, XYZ point, bool requireOpen)
        {
            Connector best = null;
            double bestDistance = double.MaxValue;
            foreach (Connector connector in pipe.ConnectorManager.Connectors)
            {
                if (requireOpen && connector.IsConnected) continue;
                double distance = connector.Origin.DistanceTo(point);
                if (distance < bestDistance)
                {
                    best = connector;
                    bestDistance = distance;
                }
            }
            return bestDistance <= ConnectorToleranceFt ? best : null;
        }

        private static FamilyInstance TryCreateTeeFitting(Document document, Connector a, Connector b, Connector c, out string lastError)
        {
            lastError = "";
            Connector[][] orders = new Connector[][]
            {
                new Connector[] { a, b, c },
                new Connector[] { b, a, c },
                new Connector[] { a, c, b },
                new Connector[] { c, a, b },
                new Connector[] { b, c, a },
                new Connector[] { c, b, a }
            };
            foreach (Connector[] order in orders)
            {
                SubTransaction sub = new SubTransaction(document);
                try
                {
                    sub.Start();
                    FamilyInstance tee = document.Create.NewTeeFitting(order[0], order[1], order[2]);
                    if (tee == null) throw new InvalidOperationException("NewTeeFitting returned null.");
                    sub.Commit();
                    return tee;
                }
                catch (Exception ex)
                {
                    lastError = ex.Message;
                    if (sub.GetStatus() == TransactionStatus.Started)
                    {
                        sub.RollBack();
                    }
                }
            }
            return null;
        }

        private static void AddDeletedIds(CommitResult result, ICollection<ElementId> ids)
        {
            if (ids == null) return;
            foreach (ElementId id in ids)
            {
                if (id != null && id != ElementId.InvalidElementId)
                {
                    result.DeletedElementIds.Add(id.IntegerValue);
                }
            }
        }

        private static double Distance(Connector a, Connector b)
        {
            try
            {
                return (a.Origin - b.Origin).GetLength();
            }
            catch
            {
                return double.MaxValue;
            }
        }

        private static double Distance(XYZ a, XYZ b)
        {
            try
            {
                return (a - b).GetLength();
            }
            catch
            {
                return double.MaxValue;
            }
        }

        private static string Text(JObject obj, string key, string fallback)
        {
            JToken token = obj != null ? obj[key] : null;
            string value = token != null ? token.ToString() : "";
            return string.IsNullOrWhiteSpace(value) ? fallback : value;
        }

        private static int IntValue(JObject obj, string key, int fallback)
        {
            JToken token = obj != null ? obj[key] : null;
            int value;
            return token != null && int.TryParse(token.ToString(), out value) ? value : fallback;
        }
    }

    internal class PairAnalysis
    {
        public string Operation;
        public int FirstElementId;
        public int SecondElementId;
        public int HeaderPipeId;
        public int OverlapPipeId;
        public int ExistingBranchFittingId;
        public int BranchPipeId;
        public int BranchOffsetPipeId;
        public string NormalizationStrategy;
        public double FirstLengthMm;
        public double SecondLengthMm;
        public double FirstDiameterMm;
        public double SecondDiameterMm;
        public double OverlapMm;
        public double BranchConnectorToHeaderMm;
        public double TeePointEndClearanceMm;
        public bool SameSystemType;
        public bool SameDiameter;
        public bool Collinear;
        public bool HasSharedOpenEndpoint;
        public bool FirstOppositeConnected;
        public bool SecondOppositeConnected;
        public bool BranchConnectorOwnerIsPipe;
        public bool OrphanFittingOnly;
        public bool TeePointInsideHeader;
        public bool BranchExtensionCollinear;
        public XYZ BranchConnectorOrigin;
        public XYZ TeePoint;
        public readonly JArray Errors = new JArray();
        public readonly JArray Warnings = new JArray();

        public bool SafeForFutureCommit
        {
            get { return Errors.Count == 0; }
        }

        public JObject ToPreviewRow(string planId, string stepId)
        {
            JObject row = new JObject
            {
                ["planId"] = planId,
                ["stepId"] = stepId,
                ["operation"] = Operation,
                ["riskLevel"] = "critical",
                ["willMutateModel"] = false,
                ["status"] = "preview",
                ["firstElementId"] = FirstElementId,
                ["secondElementId"] = SecondElementId,
                ["headerPipeId"] = HeaderPipeId,
                ["overlapPipeId"] = OverlapPipeId,
                ["existingBranchFittingId"] = ExistingBranchFittingId,
                ["branchPipeId"] = BranchPipeId,
                ["branchOffsetPipeId"] = BranchOffsetPipeId,
                ["normalizationStrategy"] = NormalizationStrategy ?? "",
                ["firstLengthMm"] = Math.Round(FirstLengthMm, 1),
                ["secondLengthMm"] = Math.Round(SecondLengthMm, 1),
                ["firstDiameterMm"] = Math.Round(FirstDiameterMm, 1),
                ["secondDiameterMm"] = Math.Round(SecondDiameterMm, 1),
                ["overlapMm"] = Math.Round(OverlapMm, 1),
                ["branchConnectorToHeaderMm"] = Math.Round(BranchConnectorToHeaderMm, 1),
                ["teePointEndClearanceMm"] = Math.Round(TeePointEndClearanceMm, 1),
                ["sameSystemType"] = SameSystemType,
                ["sameDiameter"] = SameDiameter,
                ["collinear"] = Collinear,
                ["hasSharedOpenEndpoint"] = HasSharedOpenEndpoint,
                ["bothOppositeEndsConnected"] = FirstOppositeConnected && SecondOppositeConnected,
                ["branchConnectorOwnerIsPipe"] = BranchConnectorOwnerIsPipe,
                ["orphanFittingOnly"] = OrphanFittingOnly,
                ["teePointInsideHeader"] = TeePointInsideHeader,
                ["branchExtensionCollinear"] = BranchExtensionCollinear,
                ["commitEnabled"] = SafeForFutureCommit
            };
            if (TeePoint != null)
            {
                row["teePoint"] = new JObject
                {
                    ["x"] = Math.Round(TeePoint.X, 6),
                    ["y"] = Math.Round(TeePoint.Y, 6),
                    ["z"] = Math.Round(TeePoint.Z, 6)
                };
            }
            return row;
        }
    }

    internal class CommitResult
    {
        public bool Success;
        public int NewHeaderSegmentId;
        public int NewTeeFittingId;
        public bool BranchPipeAdjusted;
        public readonly List<int> DeletedElementIds = new List<int>();
        public readonly JArray Errors = new JArray();
        public readonly JArray Warnings = new JArray();
    }
}
