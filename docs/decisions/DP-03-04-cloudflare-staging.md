# DP-03/DP-04 — Cloudflare Connector and Origin Staging Evidence

**Evidence date:** 2026-07-22
**Collector:** revAgent implementation assistant through BatchMode SSH
**Host:** `bt@192.168.90.154` (`revagent`)

## Installed connector

- `cloudflared version 2026.7.2 (built 2026-07-15-13:29 UTC)` was installed from Cloudflare's
  current Linux amd64 release package.
- The existing credential for tunnel `bb68cbcb-eedf-474e-aaee-145d160ed004` was staged at
  `/etc/cloudflared/bb68cbcb-eedf-474e-aaee-145d160ed004.json` as `root:root` mode `0600`.
- Its SHA-256 was
  `065a4b89183b2673be6fb36683e20d1c1a5c2a659cc0991a17b9f729b292d7e2`, exactly matching the
  independently held coordinator copy. The credential content is not retained in git.
- `/etc/cloudflared` is `root:root` mode `0700`; `config.yml` is `root:root` mode `0644`.

## Frozen staging origin

The locally managed tunnel configuration binds the confirmed public name to the loopback-only Caddy
origin introduced by PR #273:

```yaml
tunnel: bb68cbcb-eedf-474e-aaee-145d160ed004
credentials-file: /etc/cloudflared/bb68cbcb-eedf-474e-aaee-145d160ed004.json
ingress:
  - hostname: gateway.revagent.app
    service: http://127.0.0.1:8081
    originRequest:
      connectTimeout: 5s
  - service: http_status:404
```

`cloudflared tunnel ingress validate` returned `OK`, and the rule probe for
`https://gateway.revagent.app/mcp` matched rule 0 and `http://127.0.0.1:8081`.

## Connector proof and safe stopped state

A bounded 18-second foreground run proved both Cloudflare network paths before being terminated
intentionally:

```text
UDP Connectivity  region1.v2.argotunnel.com  PASS  QUIC connection successful
UDP Connectivity  region2.v2.argotunnel.com  PASS  QUIC connection successful
TCP Connectivity  region1.v2.argotunnel.com  PASS  HTTP/2 connection successful
TCP Connectivity  region2.v2.argotunnel.com  PASS  HTTP/2 connection successful
```

Four connector indexes became active during the probe. The later `context canceled`, connection
termination, and exit `124` records are expected consequences of the deliberate timeout, not an
authentication or reachability failure.

The installed systemd unit is `/etc/systemd/system/cloudflared.service` and executes:

```text
/usr/bin/cloudflared --no-autoupdate --config /etc/cloudflared/config.yml tunnel run
```

It was deliberately left `disabled` and `inactive`. The Gateway image and populated host environment do
not exist yet, and no PostgreSQL/Gateway/Caddy container is running; starting a persistent connector now
would only replace Cloudflare error 1033/HTTP 530 with an origin-unavailable response and could be
mistaken for a live service. After the bounded proof, `cloudflared tunnel info` showed no active connector
and `https://gateway.revagent.app/healthz` again returned the expected HTTP 530.

## Docker and origin-artifact staging

The same SSH session installed Docker Engine 29.6.2 and Docker Compose v5.3.1 from Docker's official
Ubuntu repository. Docker is enabled and active; no containers were started. The previously configured
Ookla Speedtest package repository did not publish an Ubuntu 26.04 Release file, so its exact source file
was moved reversibly from `ookla_speedtest-cli.list` to `ookla_speedtest-cli.list.disabled` before package
installation. It was not deleted.

The merge result of PR #273 was installed root-owned under `/opt/revagent/deploy/phase1`. Local and host
SHA-256 values matched:

| File | SHA-256 |
|---|---|
| `docker-compose.yml` | `28b934c35ec1b0169347ce7b6844420b074f3b99bddb29554d66f8846475677f` |
| `.env.example` | `85746d96186a90c8659dbbc848cbc70026c92bbe1a07e9abb88d9667c85ca19a` |
| `Caddyfile` | `09b9c63f760b5e82166db48cc00d4a85839f507273e78b7dc55d52ee16baa2c3` |
| `README.md` | `7479b20fd0761aba864438330476f59a65bd1512784325aad585dcf213c4bf56` |

`docker compose ... config --quiet` passed against the staged `.env.example`. Post-checks showed zero
running containers, no listener on TCP 8081, and `cloudflared` still disabled/inactive. No image was
pulled, no placeholder secret was promoted into a runtime environment, and no public service was opened.

## Remaining activation gate

The implementation assistant owns the remaining SSH-executable steps under R-G: obtain the immutable
Gateway image from the implementation pipeline, populate the root-owned deployment environment after
DP-5/OIDC closure, start and verify the real origin, then enable `cloudflared`. Pilot-entry evidence must
show the connector active, loopback-only listening, `/healthz` success through the public FQDN, TLS,
restart/reconnect, and audit-safe failure behavior. No new Cloudflare token or account authorization is
currently required.
