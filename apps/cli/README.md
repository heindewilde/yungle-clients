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

`--json` on any command prints a machine-readable object on stdout; progress
goes to stderr, so `yungle send … --json \| jq` works.

Folders keep their structure. Hidden files are skipped when walking a directory
and kept when named directly.

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

The API is available on any paid Yungle plan. Full documentation:
<https://yungle.co/developers>

## What it cannot do

Your vault and end-to-end encrypted transfers are not reachable through the API
this is built on. Their keys are derived in the client and never sent to us, so
a server-side API has nothing to offer — see
<https://yungle.co/developers/unsupported>. Reaching them from a local client is
possible in principle and is not built yet.
