# yungle-cli

Send and sync files with [Yungle](https://yungle.co) from the command line.

```bash
npm install -g yungle-cli
yungle auth login
yungle send ~/Shoot --to client@example.com
```

## Why a CLI

Yungle's upload engine is resumable at part granularity and sized for 100 GB
transfers. Until this existed, the only thing that could drive it was a browser
tab that had to stay open — which is the wrong process to hand an eight-hour
upload to. This one survives a closed laptop lid: interrupt `yungle send`, run
the same command again, and it continues from the last committed part instead of
starting over.

## Commands

| | |
|---|---|
| `yungle auth login` | Save an API key (or set `YUNGLE_API_KEY`) |
| `yungle auth status` | Which key is in use, and what it may do |
| `yungle send <paths…>` | Send files; prints the share link |
| `yungle push <paths…> --collection <id>` | Upload into a collection |
| `yungle ls transfers\|collections\|contacts` | List things |
| `yungle rm transfer <id>` | Revoke a transfer |
| `yungle mcp install` | Let an AI assistant read your Yungle |
| `yungle mcp status` | Show where that is installed |

`--json` on any command prints a machine-readable object on stdout; progress
goes to stderr, so `yungle send … --json \| jq` works.

Folders keep their structure. Hidden files are skipped when walking a directory
and kept when named directly.

## Letting an assistant read your Yungle

```bash
yungle mcp install
```

Writes the [Yungle MCP server](https://www.npmjs.com/package/yungle-mcp) into
whichever clients you have — Claude Desktop, Claude Code, Cursor, Windsurf —
so you can ask *"what did I send last week?"* or *"did the client download it
yet?"* instead of opening the dashboard. Restart the client afterwards; they
read their MCP config at startup.

`--dry-run` shows what would change and writes nothing. `--client <id>` targets
one. Re-running is safe: it reports `already current` when nothing needs doing,
and updates the entry if your key has changed.

**It refuses a key that can write.** The MCP server has no tool that sends,
invites, revokes or deletes, so a write scope grants an assistant nothing it can
use — while putting a credential that *could* change your account into a file an
assistant reads. Create a read-only key at
[yungle.co/dashboard/settings/api](https://yungle.co/dashboard/settings/api);
reading the API works on every plan, free included.

Two things worth knowing. Your key ends up in that client's config file in plain
text — that is how stdio MCP servers receive credentials, and it is why the
read-only rule above is enforced rather than suggested. And a config file that
does not parse is **refused, never overwritten**: it holds every other MCP server
you have set up, and a trailing comma is not a reason to replace it. The previous
contents are copied to `<config>.yungle-bak` before any change.

## Resuming

State lives in `~/.cache/yungle/`. A session is keyed by the *local files* —
their paths, sizes and modification times — because that is all the next
invocation has to go on; it cannot know the transfer id of a process that was
killed. Run the same command with the same files and it resumes; change a file
and it starts over, because resuming into a row whose declared size no longer
matches fails at the very end with an error that points nowhere useful.

Sessions expire after two hours, matching the lifetime of the upload tokens
they hold.

## Credentials

Read from `YUNGLE_API_KEY` first, then `~/.config/yungle/config.json` (written
`0600`). A key acts as one workspace and can be revoked at any time from
Settings → API keys.

Every account can use the API: transfers and contacts on the free plan,
collections on a paid one. The first 10 GB of API uploads each month are free.
Full documentation:
<https://yungle.co/developers>

## What it cannot do

Your vault and end-to-end encrypted transfers are not reachable through the API
this is built on. Their keys are derived in the client and never sent to us, so
a server-side API has nothing to offer — see
<https://yungle.co/developers/unsupported>. Reaching them from a local client is
possible in principle and is not built yet.
