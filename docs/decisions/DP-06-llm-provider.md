# DP-06 — LLM Provider, Models, and Region

**Status:** Awaiting operator confirmation
**Gate:** Pilot entry
**Recommended default:** Current cloud provider through the OpenAI-compatible adapter

## Decision

Record the initial provider endpoint, main planning model, optional router model, region, quota owner, and spend boundary. The choice configures D8; it does not fork Gateway code.

## Requirements

- API credentials exist only on the Gateway host.
- The endpoint contract remains OpenAI-compatible and capability flags describe tool-search, code-exec, context, and cost support.
- Region selection considers Gateway-to-LLM latency and data-residency obligations.
- Provider failure and rate-limit behavior is observable and bounded.

## Consequences

- The Phase-1 `.env` inventory names the endpoint/model keys but contains no values.
- A later local-LLM deployment remains a configuration variant on an on-prem Gateway.

## Confirmation prompt

Record provider, endpoint/region, main model, router-model decision, quota/spend owner, and secret custodian in `DP-log.md`.
