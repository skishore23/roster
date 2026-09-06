# Coding from the terminal

`roster coding` is the terminal client for the same Coding rooms, conversations,
jobs, task graph, review frontier, and guarded delivery actions shown at
`/coding`. Authenticated commands use the Roster HTTP API. Live room and
execution updates use the same narrow, caller-scoped SpacetimeDB subscriptions
as the web client; the CLI does not poll an idle run or open the repository as
a second control plane.

## Quick start

From a prepared checkout, the normal entry point is one command:

```bash
npm run cli -- coding
```

For ordinary loopback use, do not set `ROSTER_API_URL` or
`ROSTER_API_TOKEN`; the defaults are already correct. In particular, do not
paste placeholder secrets from documentation. If a previous shell exported a
placeholder, clear it before launching:

```bash
unset ROSTER_API_TOKEN
```

If the loopback Roster server is not ready, the command starts the local
SpacetimeDB and Roster stack, waits for `/readyz`, and then opens the terminal
workspace. When the selected repository has no saved Coding profile, it
explains the bounded scan and asks once whether it should inspect tracked files
and assemble the durable specialist team. Accepting keeps the entire first-run
flow in the terminal. Ctrl-C detaches and stops only a stack that this terminal
started; it never aborts durable work.

If the conventional `roster-local` database belongs to an older SpacetimeDB
login, automatic startup preserves that database and creates a fresh,
installation-local database instead. The selected database and its private
service-token path are retained under the ignored `.spacetime/` directory for
later launches. Explicitly configured SpacetimeDB databases or credentials are
never replaced automatically.

The unavoidable machine prerequisites are installed once:

```bash
npm install
npm --prefix spacetimedb install
spacetime --version
```

Use `ROSTER_CODING_AUTOSTART=0` when an operator or service manager must own the
server lifecycle explicitly.

## Connect to an existing server

The same command attaches without restarting an existing Roster server. To
select another local server explicitly:

```bash
export ROSTER_API_URL=http://127.0.0.1:8787
```

Only when the server itself was started with API authentication should the
client export the exact same token:

```bash
export ROSTER_API_TOKEN='the-exact-token-configured-on-the-server'
```

`ROSTER_API_URL` is the server origin, without embedded credentials. The token
must match the server's `ROSTER_API_TOKEN` when API authentication is enabled.
Keep it out of shell history, checked-in environment files, command output, and
bug reports. A local server uses `http://127.0.0.1:8787` by default.

After `npm run build`, run `npm link` once to expose `roster`. From an unlinked
checkout, replace `roster` in the examples with `npm run cli --`.

## Interactive room

Open the terminal workspace with:

```bash
roster coding
```

The TUI lists the selected Coding workspace's rooms, opens the conversation and
current execution, follows task and teammate progress, shows questions that
need a human answer, and makes the certified review available before delivery.
Starting a prompt creates a room; replying sends a message into the existing
logical conversation. A terminal continuation keeps that conversation but may
receive a new execution and job.

Pressing Ctrl-C closes or detaches the local terminal view. It does **not**
cancel, abort, retry, close, or merge the durable job. Use the explicit command
for the state transition you intend.

## Exact selectors

Coding uses several identities deliberately:

- `workspaceId` selects one saved repository workspace: its room, reviewed
  team, and repository policy. It is distinct from the server-owned control
  workspace used for shared event storage.
- `conversationId` is the stable logical room and survives a terminal
  continuation.
- `executionId` identifies one immutable orchestration execution and its Git
  frontier.
- `jobId` identifies the durable queued attempt that admitted that execution.

Commands print these values after `ask`, `send`, and `retry`. Save the returned
selector instead of searching for the newest job later. Commands that inspect
or change one execution use the stable conversation ID plus the exact
`--job <job-id>` selector:

```bash
roster coding status <conversation-id> --job <job-id>
```

This prevents a terminal continuation or retry from silently changing the
execution being reviewed, aborted, or delivered. `rooms` is workspace-scoped,
and `ask` has no prior job. `send` is conversation-scoped and returns the
selector to use next; the server decides whether it routes to active work or
admits a fresh continuation.

## Automation commands

List rooms in a saved repository workspace:

```bash
roster coding rooms --workspace <workspace-id>
```

Start a conversation and retain the returned conversation, execution, and job
IDs:

```bash
roster coding ask --workspace <workspace-id> --review reviewed \
  "Update the parser and add focused regression coverage"
```

Inspect or follow that exact execution:

```bash
roster coding status <conversation-id> --job <job-id>
roster coding wait <conversation-id> --job <job-id>
```

`status` reads one bounded snapshot. `wait` follows snapshots until the exact
job becomes terminal or needs human attention. It obtains a short-lived viewer
capability from the authenticated API, subscribes to the exact room and
execution views, and coalesces each transactional update. Ctrl-C detaches from
`wait`; it does not send an abort.

Send a follow-up or answer into the room:

```bash
roster coding send <conversation-id> \
  "Keep the public type unchanged and add the edge-case test."
```

The response is authoritative about whether the message was routed to the
active job or admitted as a new continuation. If it returns a new job ID, use
that ID for every later execution-specific command.

Review the exact certified candidate, then request its guarded integration:

```bash
roster coding review <conversation-id> --job <job-id>
roster coding merge <conversation-id> --job <job-id> --yes
```

`review` is read-only and projects the server's bounded changed-file and patch
frontier. `merge` asks Roster to integrate the certified commit into its
recorded target. It does not run `git merge`, `git rebase`, `git cherry-pick`,
or `git push` in the caller's checkout.

Use explicit recovery and delivery decisions:

```bash
roster coding abort <conversation-id> --job <job-id> \
  --reason "The requested behavior changed" --yes
roster coding retry <conversation-id> --job <failed-job-id> --yes
roster coding close <conversation-id> --job <terminal-job-id> --yes
```

`abort` queues a durable cancellation command for that job. `retry` admits a
fresh bounded execution, lease, branch, worktree, and job under the same
conversation; it never revives the old worker. `close` settles an eligible
terminal delivery without merging it, preserving the certified branch or
recorded no-change result according to server policy.

Use `--json` with automation commands when another program will consume the
result. Treat returned IDs as opaque strings and pass them back unchanged.

## Authority boundary

The terminal client is a projection and intent client. Roster and SpacetimeDB
remain authoritative for workspace membership, logical `WorkspaceNode`
identity, topology, task admission, leases and fences, retries, budgets,
ordered receipts, accepted outputs, certification, and runtime-binding epochs.
The client cannot write receipt streams, claim tasks, replace a node runtime,
accept a draft, or decide a semantic conflict.

The server resolves the requested conversation and job before minting each CLI
realtime session. Repository workspace, conversation, job, and execution are
all mandatory exact selectors; the returned control-workspace identity is not
interchangeable with the repository workspace. The viewer capability is
low-use and expires quickly. The web page has no boot secret: it also mints a
grant lazily through an authenticated, exact-scope HttpOnly page session.
Clients hash the grant and redeem it with `joinCanvasRun` for the selected
execution. Expiry and explicit revocation remove capability-derived access, so
a saved database identity or reconnect cannot retain access indefinitely or
read another run unless that identity also has an independent durable
membership. Before expiry, `wait` and the TUI dispose the old transport
generation, mint and redeem a fresh grant for the same exact selectors, and
resubscribe. The replacement subscription applies before further
table-triggered HTTP projections; renewal is not polling. Abort, terminal
state, denial, and close clear renewal, reconnect, and coalescing timers.

Git delivery has the same boundary. Coding workers edit an isolated run
checkout, and Roster records the baseline and certified commit. `roster coding
merge` invokes the server's exact-old-value, clean-target integration guard.
The terminal's current directory and local Git state grant no delivery
authority, and the client never treats an uncommitted patch or branch movement
as certification.

This separation also makes disconnects safe: closing the TUI, losing the
network, or terminating `wait` only stops observation. Durable work continues
until Roster reaches a terminal state or receives an explicit authorized
command.
