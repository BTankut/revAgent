# DP-08 — Gateway Host

**Status:** Confirmed
**Decision date:** 2026-07-22
**Gate:** Pilot entry

## Recorded decision

The Phase-1 Gateway host is ready as a dedicated office Ubuntu Server:

- SSH target: `bt@192.168.90.154`
- Authentication: ED25519 key only
- Password authentication: disabled
- Keyboard-interactive authentication: disabled
- Workload ownership: dedicated to revAgent

This confirmation was supplied explicitly in the M0 goal instruction and must not be reopened without an R-F amendment.

## Security boundary

The repository records only the non-secret connection identity above. Private keys, host credentials, tunnel tokens, runtime secrets, and recovery material must remain outside git.

## M0 live reachability evidence — 2026-07-22

The implementing assistant collected this evidence directly through BatchMode public-key SSH:

```text
$ ssh -o BatchMode=yes bt@192.168.90.154 'whoami; hostname; lsb_release -a; nproc; free -h; df -h; uname -a'
bt
revagent
Distributor ID: Ubuntu
Description: Ubuntu 26.04 LTS
Release: 26.04
Codename: resolute
8
Mem: 30Gi total, 776Mi used, 28Gi free, 5.0Mi shared, 1.2Gi buff/cache, 29Gi available
Swap: 8.0Gi total, 0B used, 8.0Gi free
/: 226G size, 12G used, 204G available, 6%
/boot: 2.0G size, 97M used, 1.7G available, 6%
/boot/efi: 1.1G size, 6.4M used, 1.1G available, 1%
/mnt/hdd-data: 916G size, 2.1M used, 870G available, 1%
Linux revagent 7.0.0-28-generic #28-Ubuntu SMP PREEMPT_DYNAMIC Sun Jun 21 01:01:36 UTC 2026 x86_64 GNU/Linux
```

The omitted `df -h` rows were only tmpfs/credential pseudo-mounts. This evidence passes the M0 live
reachability and resource-inventory requirement; it does not claim production service readiness.

## Remaining operational verification

The host choice and M0 live reachability are confirmed. Later operational readiness remains open:

- **Implementation owner:** revAgent implementation assistant through the confirmed SSH path.
- **M7 evidence still required:** install and verify Docker/Compose and the production tunnel/origin only
  after their frozen configuration exists; retain power-recovery and UPS evidence.
- **WAN resilience disposition:** the router has no dual-WAN/LTE capability. Barış Tankut accepted the
  resulting WAN-outage risk on 2026-07-22. This closes the LTE decision item without claiming redundant
  connectivity; M7 operations evidence must carry the accepted single-WAN limitation explicitly.

These checks validate the confirmed host; they do not reopen DP-8.
