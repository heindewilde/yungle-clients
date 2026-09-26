import { COMMANDS, HELP } from './help';

/**
 * Tab completion scripts, generated from HELP so they cannot fall behind it.
 * Commands complete at the first word; each command's flags after it; files
 * where a command takes paths.
 */

export function flagsByCommand(): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  let current: string | null = null;
  for (const line of HELP.split('\n')) {
    const cmd = line.match(/^ {2}yungle ([a-z-]+)/);
    if (cmd) {
      current = cmd[1]!;
      out[current] ??= [];
      continue;
    }
    const flag = line.match(/^ {4}(--[a-z-]+)/);
    if (flag && current) out[current]!.push(flag[1]!);
    if (/^\S/.test(line)) current = null;
  }
  for (const k of Object.keys(out)) out[k] = [...new Set([...out[k]!, '--json', '--help'])];
  return out;
}

const PATH_COMMANDS = ['send', 'push', 'watch'];

export function completionScript(shell: string): string | null {
  const flags = flagsByCommand();
  const cmds = COMMANDS.join(' ');
  if (shell === 'bash') {
    const cases = Object.entries(flags)
      .map(([c, f]) => `      ${c}) opts="${f.join(' ')}" ;;`)
      .join('\n');
    return `# yungle bash completion. Add to ~/.bashrc:  eval "$(yungle completion bash)"
_yungle() {
  local cur="\${COMP_WORDS[COMP_CWORD]}" cmd="\${COMP_WORDS[1]}" opts=""
  if [ "$COMP_CWORD" -eq 1 ]; then
    COMPREPLY=( $(compgen -W "${cmds}" -- "$cur") ); return
  fi
  case "$cmd" in
${cases}
  esac
  if [[ "$cur" == -* ]]; then COMPREPLY=( $(compgen -W "$opts" -- "$cur") )
  else case "$cmd" in ${PATH_COMMANDS.join('|')}) COMPREPLY=( $(compgen -f -- "$cur") ) ;; esac
  fi
}
complete -o default -F _yungle yungle
`;
  }
  if (shell === 'zsh') {
    const cases = Object.entries(flags)
      .map(([c, f]) => `    ${c}) _arguments '*:file:_files' ${f.map((x) => `'${x}[]'`).join(' ')} ;;`)
      .join('\n');
    return `#compdef yungle
# yungle zsh completion. Save as _yungle somewhere on your $fpath, e.g.:
#   yungle completion zsh > "\${fpath[1]}/_yungle"
_yungle() {
  if (( CURRENT == 2 )); then
    compadd ${cmds}
    return
  fi
  case $words[2] in
${cases}
  esac
}
_yungle "$@"
`;
  }
  if (shell === 'fish') {
    const lines = [
      '# yungle fish completion. Save to ~/.config/fish/completions/yungle.fish',
      `complete -c yungle -f -n '__fish_use_subcommand' -a '${cmds}'`,
    ];
    for (const [c, f] of Object.entries(flags)) {
      for (const flag of f) lines.push(`complete -c yungle -n '__fish_seen_subcommand_from ${c}' -l ${flag.slice(2)}`);
    }
    for (const c of PATH_COMMANDS) lines.push(`complete -c yungle -n '__fish_seen_subcommand_from ${c}' -F`);
    return `${lines.join('\n')}\n`;
  }
  return null;
}
