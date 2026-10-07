# @mesgme/hetzner-cloud-power

Power Hetzner Cloud servers on and off from swamp, without opening the Hetzner
Cloud console.

This package extends the official
[`@swamp/hetzner-cloud`](https://swamp-club.com) `servers` model type, which
can create, look up and sync servers but has no power actions. It adds three
methods to that type. Nothing is tied to a particular account or server: each
model points at one server by name and uses an API token for that server's
project.

## Methods

| Method     | Hetzner API action                         | Waits until |
| ---------- | ------------------------------------------ | ----------- |
| `poweron`  | `POST /servers/{id}/actions/poweron`       | `running`   |
| `shutdown` | `POST /servers/{id}/actions/shutdown` (ACPI, graceful) | `off` |
| `poweroff` | `POST /servers/{id}/actions/poweroff` (hard, like pulling the plug) | `off` |

Each method reads the server's current status first. `poweron` on a running
server, and `poweroff` or `shutdown` on a powered-off one, fail with "already
running" or "already powered off" without calling the action endpoint. These are refusals, not faults: the
server is already where you wanted it, so a scheduler can treat them as no-ops.
Each request to Hetzner times out after 30 seconds with a clear error.

After the action, the method polls the server until it reaches the target
status or runs out of attempts. It then refreshes the official `state` resource
and writes a `power` resource with `action`, `previousStatus`, `status`,
`reachedTarget` and the Hetzner `actionId`.

A graceful `shutdown` depends on the OS handling ACPI. If the server is still
running when polling stops, the method succeeds with `reachedTarget: false`.
Check later, or use `poweroff`. Both `maxPollAttempts` and `pollIntervalMs`
can be set per run.

## Setup

You need a Hetzner Cloud API token with **Read & Write** permission
(Hetzner Cloud console → your project → Security → API tokens).

```bash
swamp extension pull @mesgme/hetzner-cloud-power   # also pulls @swamp/hetzner-cloud

# Create a vault, if you don't have one, and store the token once.
# `put` prompts for the value.
swamp vault create local_encryption hetzner
swamp vault put hetzner HETZNER_API_TOKEN

# Point a model at an existing server by name, then look it up once so the
# model knows the server's id.
swamp model create @swamp/hetzner-cloud/servers my-server \
  --global-arg name=my-hetzner-server \
  --global-arg 'token=${{ vault.get("hetzner", "HETZNER_API_TOKEN") }}'
swamp model method run my-server lookup
```

If `token` is not set, the methods use the `HETZNER_API_TOKEN` environment
variable, just as the official type does.

## Usage

```bash
swamp model method run my-server poweron
swamp model method run my-server shutdown
swamp model method run my-server poweroff

# A longer wait for a slow shutdown
swamp model method run my-server shutdown --input maxPollAttempts=100

# The last power action
swamp data query 'model("my-server") && specName == "power" && isLatest' --select content
```

## Licence

MIT. See [LICENSE](LICENSE). This package contains no code from
`@swamp/hetzner-cloud`; it only depends on that package.
