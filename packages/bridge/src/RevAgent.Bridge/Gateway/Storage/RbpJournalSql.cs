namespace RevAgent.Bridge.Gateway.Storage;

internal static class RbpJournalSql
{
    internal const string InboundBoundsByRsid = """
        SELECT COALESCE(
                 (
                   SELECT seq
                   FROM rbp_inbound_receipts
                   WHERE rsid=$rsid
                   ORDER BY seq
                   LIMIT 1
                 ),
                 0
               ),
               COALESCE(
                 (
                   SELECT seq
                   FROM rbp_inbound_receipts
                   WHERE rsid=$rsid
                   ORDER BY seq DESC
                   LIMIT 1
                 ),
                 0
               ),
               COALESCE(
                 (
                   SELECT seq-1
                   FROM rbp_inbound_receipts
                   WHERE rsid=$rsid AND handoff_state='pending'
                   ORDER BY seq
                   LIMIT 1
                 ),
                 (
                   SELECT seq
                   FROM rbp_inbound_receipts
                   WHERE rsid=$rsid
                   ORDER BY seq DESC
                   LIMIT 1
                 ),
                 0
               );
        """;

    internal const string InboundIdentityBySequence = """
        SELECT seq,immutable_digest
        FROM rbp_inbound_receipts
        WHERE rsid=$rsid AND seq=$seq;
        """;
}
