using RevAgent.Bridge.Gateway.Protocol;
using RevAgent.Bridge.Gateway.Storage;

namespace RevAgent.Bridge.Tests.Gateway.Storage;

public sealed class RbpJournalOutboxTests
{
    [Fact]
    public async Task QueueResumeAndHeartbeatAckRetainThenPruneExactOutbox()
    {
        using var directory = new RbpJournalTestDirectory();
        RbpOutboundDataDraft first = RbpJournalTestData.Outbound(
            "0197a3c2-0000-7000-8000-000000000401",
            1,
            acknowledgement: 0);
        RbpOutboundDataDraft second = RbpJournalTestData.Outbound(
            "0197a3c2-0000-7000-8000-000000000402",
            2,
            acknowledgement: 0);
        await using (RbpJournalStore store = RbpJournalStore.Open(
                         directory.JournalPath,
                         new TestResumeTokenProtector(),
                         RbpJournalTestData.Options()))
        {
            _ = await store.PersistRegisteredSessionAsync(
                RbpJournalTestData.Registration());
            RbpQueueOutboundResult queuedFirst =
                await store.QueueOutboundDataAsync("rs-test", first);
            RbpQueueOutboundResult queuedSecond =
                await store.QueueOutboundDataAsync("rs-test", second);
            Assert.Equal(1, queuedFirst.Envelope?.Sequence);
            Assert.Equal(2, queuedSecond.Envelope?.Sequence);

            RbpQueueOutboundResult replay =
                await store.QueueOutboundDataAsync("rs-test", first);
            Assert.Equal(1, replay.Envelope?.Sequence);
            Assert.Equal(2, replay.State.Outbox.Count);

            RbpJournalException conflict =
                await Assert.ThrowsAsync<RbpJournalException>(
                    () => store.QueueOutboundDataAsync(
                        "rs-test",
                        RbpJournalTestData.Outbound(
                            first.Id,
                            999,
                            acknowledgement: 0)));
            Assert.Equal(
                RbpJournalErrorCode.ProtocolConflict,
                conflict.ErrorCode);
        }

        await using RbpJournalStore reopened = RbpJournalStore.Open(
            directory.JournalPath,
            new TestResumeTokenProtector(),
            RbpJournalTestData.Options());
        RbpJournalRecoveryPlan recovery =
            await reopened.LoadRecoveryPlanAsync();
        RbpResumeCandidate candidate =
            Assert.Single(recovery.ResumeCandidates);
        Assert.Equal(new long[] { 1, 2 }, candidate.Outbox
            .Select(item => item.Sequence));
        Assert.All(
            candidate.Outbox,
            item => Assert.Equal(0, item.Acknowledgement));

        DateTimeOffset renewed =
            RbpJournalTestData.Now.AddHours(48);
        RbpResumeAcknowledgementResult resume =
            await reopened.ApplyResumeAcknowledgementAsync(
                "rs-test",
                1,
                renewed);
        Assert.Equal(
            RbpAcknowledgementKind.Advanced,
            resume.Acknowledgement.Kind);
        RbpDataEnvelopeSnapshot remaining =
            Assert.Single(resume.Retransmit);
        Assert.Equal(2, remaining.Sequence);
        Assert.Equal(0, remaining.Acknowledgement);
        Assert.Equal(renewed, resume.Session.ResumeExpiresAt);

        _ = await reopened.ActivateConnectionGenerationAsync(1);
        RbpJournalException mismatchedFence =
            await Assert.ThrowsAsync<RbpJournalException>(
                () => reopened.ApplyHeartbeatFenceAcknowledgementAsync(
                    new RbpHeartbeatFence(
                        1,
                        new[] { "rs-test" },
                        Array.Empty<RbpSessionAcknowledgement>(),
                        Array.Empty<string>())));
        Assert.Equal(
            RbpJournalErrorCode.InvalidHeartbeatFence,
            mismatchedFence.ErrorCode);
        Assert.Single(
            Assert.Single(
                    (await reopened.LoadRecoveryPlanAsync())
                        .ResumeCandidates)
                .Outbox);

        RbpHeartbeatFenceResult heartbeat =
            await reopened.ApplyHeartbeatFenceAcknowledgementAsync(
                new RbpHeartbeatFence(
                    1,
                    new[] { "rs-test" },
                    new[] { new RbpSessionAcknowledgement("rs-test", 2) },
                    Array.Empty<string>()));
        Assert.Equal(new[] { "rs-test" }, heartbeat.AcknowledgedRsids);
        Assert.Empty(
            Assert.Single(
                    (await reopened.LoadRecoveryPlanAsync())
                        .ResumeCandidates)
                .Outbox);
    }

    [Fact]
    public async Task StaleConnectionGenerationCannotPruneCurrentOutbox()
    {
        using var directory = new RbpJournalTestDirectory();
        await using RbpJournalStore store = RbpJournalStore.Open(
            directory.JournalPath,
            new TestResumeTokenProtector(),
            RbpJournalTestData.Options());
        _ = await store.PersistRegisteredSessionAsync(
            RbpJournalTestData.Registration());
        _ = await store.QueueOutboundDataAsync(
            "rs-test",
            RbpJournalTestData.Outbound(
                "0197a3c2-0000-7000-8000-000000000403",
                3));

        _ = await store.ActivateConnectionGenerationAsync(1);
        _ = await store.ActivateConnectionGenerationAsync(2);

        RbpJournalException stale =
            await Assert.ThrowsAsync<RbpJournalException>(
                () => store.ApplyHeartbeatFenceAcknowledgementAsync(
                    new RbpHeartbeatFence(
                        1,
                        new[] { "rs-test" },
                        new[]
                        {
                            new RbpSessionAcknowledgement("rs-test", 1),
                        },
                        Array.Empty<string>())));
        Assert.Equal(
            RbpJournalErrorCode.InvalidHeartbeatFence,
            stale.ErrorCode);
        Assert.Single(
            Assert.Single(
                    (await store.LoadRecoveryPlanAsync()).ResumeCandidates)
                .Outbox);

        _ = await store.ApplyHeartbeatFenceAcknowledgementAsync(
            new RbpHeartbeatFence(
                2,
                new[] { "rs-test" },
                new[]
                {
                    new RbpSessionAcknowledgement("rs-test", 1),
                },
                Array.Empty<string>()));
        Assert.Empty(
            Assert.Single(
                    (await store.LoadRecoveryPlanAsync()).ResumeCandidates)
                .Outbox);
    }

    [Fact]
    public async Task PostCommitQueueFailureUsesExactRereadBeforeReturn()
    {
        using var directory = new RbpJournalTestDirectory();
        var faults = new ArmedJournalFaultInjector();
        await using RbpJournalStore store = RbpJournalStore.Open(
            directory.JournalPath,
            new TestResumeTokenProtector(),
            RbpJournalTestData.Options(faults));
        _ = await store.PersistRegisteredSessionAsync(
            RbpJournalTestData.Registration());
        RbpOutboundDataDraft draft = RbpJournalTestData.Outbound(
            "0197a3c2-0000-7000-8000-000000000411",
            17,
            acknowledgement: 0);

        faults.Arm(RbpJournalFaultPoint.AfterCommitBeforeReturn);
        RbpQueueOutboundResult recovered =
            await store.QueueOutboundDataAsync("rs-test", draft);
        Assert.Equal(1, recovered.Envelope?.Sequence);
        Assert.Single(recovered.State.Outbox);

        RbpResumeCandidate candidate =
            Assert.Single(
                (await store.LoadRecoveryPlanAsync()).ResumeCandidates);
        Assert.Equal(
            recovered.Envelope?.Id,
            Assert.Single(candidate.Outbox).Id);
    }
}
