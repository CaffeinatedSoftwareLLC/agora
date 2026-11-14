# The owner's shell in an Agora box (docs/box-terminal.md). Root-owned; bash is started with
# --rcfile pointing here, so nothing from any home folder is sourced.
case $- in *i*) ;; *) return ;; esac

PS1='\[\e[1;32m\]operator\[\e[0m\]@\[\e[1m\]box\[\e[0m\]:\w\$ '
HISTFILE="$HOME/.bash_history"

printf '\033[33magora: this is your own account in the agent'"'"'s box (user "operator"). The agent cannot read or change this shell.\033[0m\n'
printf '\033[33magora: to act as the agent, in its workspace, with its login: as-agent <command>  (as-agent claude, as-agent git status, as-agent npm test). Do not run the agent'"'"'s code from here.\033[0m\n'
printf '\033[33magora: what you type in an as-agent session is on the agent'"'"'s side of the wall, and the agent can see it. Never type a password or token into this box.\033[0m\n'
