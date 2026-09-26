import { accentOut, o } from './ui';

/**
 * The help text, as one literal: it is what `yungle help` prints, what the
 * website's CLI reference is tested against (both directions), and the source
 * the command list below is checked against. Commands are indented two spaces,
 * their flags four; headings are flush left.
 */
export const HELP = `yungle — send, receive and keep files with Yungle

Get started
  yungle login                            sign in with your browser
    --key <key>           use an API key instead (servers, CI); asks if left out
    --no-browser          print the link instead of opening it
  yungle whoami                           show who you are signed in as
  yungle logout                           sign out and revoke the session

Send and receive
  yungle send <paths…>                    send files or folders, print the link
    --to <email>          recipient (repeatable, or comma-separated)
    --message <text>      note for the recipients
    --title <text>        label for your dashboard
    --password <text>     recipients must enter this
    --expires <days>      lifetime, clamped to your plan
  yungle get <link>                       download a transfer sent to you
    --out <dir>           where to save (default: current directory)
    --zip                 one zip instead of separate files
    --password <text>     for a protected link; asks if left out
  yungle status [<id|link>]               who opened and downloaded a transfer
  yungle transfers                        list your recent transfers
  yungle revoke <id>                      stop a transfer's link for good

Collections
  yungle push <paths…> --collection <id>  upload into a collection
    --folder <id>         target folder
  yungle watch <dir> --collection <id>    keep uploading new files as they appear
    --interval <seconds>  how often to look (default 10)
    --existing            also upload what is already in the folder
  yungle collections                      list your collections
  yungle contacts                         list your contacts

In the browser
  yungle open [<id>|plan|keys|webhooks]   open the dashboard, or a transfer

Developers
  yungle webhooks ls                      list webhook endpoints
  yungle webhooks listen                  print events as they happen
    --forward-to <url>    also POST each one, signed, to a local server
  yungle mcp install                      connect an AI assistant on this machine
    --client <id>         claude-desktop | claude-code | cursor | windsurf
    --dry-run             show what would change, write nothing
    --allow-write         accept a key with transfers:write (share links)
  yungle mcp status                       show where it is installed
  yungle completion <shell>               tab completion for zsh, bash or fish
  yungle --version                        print the version

Global flags
  --json                  machine-readable output
  --yes                   never ask; for scripts
  --url <base>            use another Yungle (development)

Run a command with --help for examples. Docs: https://yungle.co/developers/cli`;

/** Every top-level command, for "did you mean" and shell completion. */
export const COMMANDS = [
  'login',
  'whoami',
  'logout',
  'send',
  'get',
  'status',
  'transfers',
  'revoke',
  'push',
  'watch',
  'collections',
  'contacts',
  'open',
  'webhooks',
  'mcp',
  'completion',
  'help',
] as const;

/** Old spellings that keep working, never shown in help. */
export const ALIASES: Record<string, string[]> = {
  'auth login': ['login', '--key'],
  'auth status': ['whoami'],
  'ls transfers': ['transfers'],
  'ls collections': ['collections'],
  'ls contacts': ['contacts'],
  ls: ['transfers'],
  'rm transfer': ['revoke'],
  upload: ['push'],
  download: ['get'],
};

/** Rewrite an old spelling to its current form. */
export function resolveAlias(argv: string[]): string[] {
  for (const n of [2, 1]) {
    const key = argv.slice(0, n).join(' ');
    const to = ALIASES[key];
    if (to && argv.length >= n) return [...to, ...argv.slice(n)];
  }
  return argv;
}

export const EXAMPLES: Record<string, string[]> = {
  login: ['yungle login', 'yungle login --key            # on a server: paste a key from Settings → API keys'],
  send: [
    'yungle send ~/Shoot --to anna@studio.nl --message "Final selects"',
    'yungle send report.pdf                        # just a link, nobody emailed',
    'yungle send dist/ --json | jq -r .url         # in a script',
  ],
  get: ['yungle get https://yungle.co/t/emerald-palm-a5mt', 'yungle get <link> --zip --out ~/Downloads'],
  status: ['yungle status                                 # pick from your recent transfers', 'yungle status https://yungle.co/t/emerald-palm-a5mt'],
  push: ['yungle push ~/Shoot --collection 01J8Z3M9Q0W4', 'yungle push raw/ --collection 01J8Z3M9Q0W4 --folder 01J8Z4AB'],
  watch: ['yungle watch ~/Renders --collection 01J8Z3M9Q0W4', 'yungle watch /Volumes/CARD --collection 01J8Z3M9Q0W4 --interval 30'],
  open: ['yungle open', 'yungle open 01J8Z3M9Q0W4                     # a transfer', 'yungle open keys'],
  webhooks: ['yungle webhooks listen --forward-to http://localhost:8080/hooks'],
  mcp: ['yungle mcp install --client claude-code --dry-run', 'yungle mcp status'],
  completion: ['yungle completion zsh > ~/.zfunc/_yungle', 'yungle completion bash >> ~/.bashrc', 'yungle completion fish > ~/.config/fish/completions/yungle.fish'],
};

/** Colour the help for a terminal: headings bold, commands green, flags dim. */
export function renderHelp(text: string): string {
  return text
    .split('\n')
    .map((line) => {
      if (/^\S/.test(line) && !line.startsWith('yungle') && !line.startsWith('Run ')) return o.bold(line);
      const cmd = line.match(/^( {2})(yungle [^ ].*?)( {2,}.*)?$/);
      if (cmd) return `${cmd[1]}${accentOut(cmd[2]!)}${o.dim(cmd[3] ?? '')}`;
      if (/^ {2,4}--/.test(line)) return o.dim(line);
      return line;
    })
    .join('\n');
}

/** The part of HELP about one command, plus its examples. */
export function commandHelp(command: string): string | null {
  const lines = HELP.split('\n');
  const start = lines.findIndex((l) => l.startsWith(`  yungle ${command}`));
  if (start < 0) return null;
  const block = [lines[start]!];
  for (let i = start + 1; i < lines.length && (lines[i]!.startsWith('    ') || lines[i]!.startsWith(`  yungle ${command} `)); i++) {
    block.push(lines[i]!);
  }
  const ex = EXAMPLES[command];
  return [...block, ...(ex ? ['', 'Examples', ...ex.map((l) => `  ${l}`)] : [])].join('\n');
}
