<!-- author: ai -->

# Speaker: open decisions on secrets, owner login, network placement and SSH

<sub>AI-written</sub>

Companion to [DESIGN.md](DESIGN.md), which defines agents, asks, grants and services. This document lists the options for the parts not yet decided. It deliberately makes no recommendation.

## Goals

1. **Drop-in.** Someone else can run speaker on their own network with one container, a couple of settings, and no bespoke infrastructure.
2. **Secure and truly usable.** Best-practice handling of secrets and approvals that the owner will actually keep using day to day.
3. **Not a soft spot.** Speaker holds every upstream credential, so it is the most valuable target on the network. Taking it over, or copying its disk, should yield as little as possible.
4. **Brutally simple state.** Only durable settings are written to disk: services, groups, sandbox hosts and the encrypted upstream keys. Agents, grants and asks live in memory; after a restart agents enroll and ask again.

## A. Upstream keys at rest

Speaker must hold the real keys to add them to calls. The question is what unlocks them.

| Option | How it works | Restart | A copied disk reveals | Setup for a new user |
| --- | --- | --- | --- | --- |
| A1. Plain files, owner-only permissions | Keys stored as files readable only by speaker | unattended | everything | none |
| A2. Master key in the environment | Keys encrypted (AES-256-GCM) with a key from an environment variable or Docker secret | unattended | nothing, unless the environment file is copied too | generate one random value |
| A3. Unlock passphrase after each restart | Owner types a passphrase in `/admin` (password manager autofill) after a push notification "speaker is locked"; keys decrypted into memory only | owner must unlock | nothing | choose a passphrase |
| A4. Passkey unlock | A passkey's PRF output (WebAuthn) unwraps the master key; unlock is a biometric tap on the owner's phone | owner must tap | nothing | register a passkey (and a recovery passphrase) |
| A5. Key held by another device | A small key holder on another always-on machine releases the master key only to speaker's network identity | unattended while the holder is up | nothing | run a second service |
| A6. Host-bound secret store | systemd credentials or a TPM seal the master key to the machine | unattended | nothing off that machine | Linux host with TPM; awkward in containers |
| A7. External secret manager | Speaker fetches keys from Vault, 1Password Connect, Infisical or similar at startup | unattended | nothing | requires that product |

Related: whatever unlocks the keys, they exist in speaker's memory while it runs, so a compromised running speaker exposes them. Options here protect the disk and backups, not a live takeover.

## B. Owner login to `/admin`

Approvals are the security boundary, so owner login matters as much as key storage.

| Option | How it works | Drop-in cost |
| --- | --- | --- |
| B1. Built-in password | HTTP Basic or a login form with a strong password | none |
| B2. Passkey login | WebAuthn sign-in from the owner's phone or password manager; can share the credential with A4 | small, needs HTTPS |
| B3. Tailscale identity | Speaker served through Tailscale; the visitor's tailnet login identifies the owner, no password | requires Tailscale, and speaker served by it |
| B4. Existing single sign-on proxy | Authelia, oauth2-proxy or similar in front of `/admin` | requires that proxy |

## C. Network placement and hardening

| Option | How it works | Drop-in cost |
| --- | --- | --- |
| C1. Published LAN port | Container port published on the host; agents reach it on the LAN | none, but everyone on the LAN can reach it |
| C2. Tailnet-only node | Speaker runs with its own Tailscale node (sidecar or embedded) and is reachable only on the tailnet, with HTTPS from Tailscale | requires Tailscale; removes reverse proxy and certificate setup |
| C3. Behind an existing reverse proxy | Owner's proxy terminates HTTPS and forwards to speaker | requires a proxy; must forward the client address correctly |

Hardening measures independent of placement (each can be on or off):

- Run as a non-root user in a read-only container with no shell tools beyond what it needs.
- Outbound connections only to configured service hosts (egress allowlist).
- Few dependencies, small codebase, pinned versions.
- Every grant short by default, every call logged, one-click revoke of everything.
- A decoy service that no legitimate task needs, alerting on any ask for it.
- Approval of any change to services or keys requires the owner's second factor (B2/B4), not just the session.

## D. SSH: how speaker gives an agent a shell on a target host

| Option | How it works | Live time limit and revoke | Commands logged | Target setup |
| --- | --- | --- | --- | --- |
| D1. Certificates only | Speaker signs a short-lived certificate for the agent's own key; the agent connects directly | no (valid until expiry; open sessions continue) | no | trust speaker's CA in `sshd` |
| D2. Full proxy | The agent connects to speaker; speaker logs into the target itself and relays shell, commands and file transfer | yes (speaker closes the connection) | yes | depends on how speaker logs in (below) |
| D3. Tunnel-only jump host | Speaker relays the encrypted connection; the agent still authenticates to the target | yes (speaker cuts the tunnel) | no | as D1, plus the agent needs target credentials |

How speaker logs into the target under D2:

| Option | How it works | Secret stored by speaker |
| --- | --- | --- |
| D2a. Tailscale SSH | Targets run Tailscale with SSH; the tailnet policy lets speaker's identity log in as named users | none |
| D2b. Dedicated speaker key | A key made for speaker only, authorized on each target; loaded into memory at unlock | one SSH key |
| D2c. Speaker's own certificates | Speaker signs a fresh short-lived certificate for itself per connection | the CA key |

Common to D2: the agent connects with plain `ssh` to a listener speaker opens on a random port only while that SSH grant is active, authenticating with the throwaway key it sent in its ask. Port forwarding is refused, so the target cannot become a gateway into the rest of the network. Speaker can use the system OpenSSH client with its own `ssh_config` for the outbound connection (host aliases, `ProxyJump`, `known_hosts`, Tailscale names).

## E. SSH limited to a folder

What is and is not possible:

| Option | Covers | Limit enforced by | Target setup |
| --- | --- | --- | --- |
| E1. Path-checked file transfer in speaker | `sftp`, `scp` (SFTP mode, the OpenSSH default) and editors using SFTP; read-only or read-write under one path | speaker, on every file operation (only possible with D2) | none |
| E2. Sandboxed shell on the target | any command, with only the granted folder writable (or visible) | the target, e.g. a forced command that starts the session in a bubblewrap or systemd sandbox bound to the folder | install and configure a sandbox wrapper |
| E3. sshd chroot | file transfer only, one fixed folder per login user | `sshd` configuration | static per user, not per grant |
| E4. rsync restricted | rsync to one folder | the `rrsync` forced-command script on the target | per key or per grant on the target |

A plain shell cannot be limited to a folder by SSH alone: once a command runs, it can read whatever the login user can. Folder-limited shells need E2; folder-limited file access needs E1 (or E3/E4 with static target configuration).

## F. What a new user does to install

The aim is one container and at most these settings: the public URL, the owner login (B), the key unlock method (A), and optionally a push-notification topic and Tailscale. Services, groups and SSH targets are added in `/admin`.
