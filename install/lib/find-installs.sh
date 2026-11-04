#!/bin/sh
# Prints the folder of every Agora install on this machine's Docker engine, one per line (the
# folder Compose recorded on each install's api container). The Windows doctor and uninstaller
# run this inside the distro: a script in the release, so no shell quoting has to survive
# wsl.exe's command line.
fmt='{{.Label "com.docker.compose.project.working_dir"}}'
if docker info >/dev/null 2>&1; then
    docker ps -a --filter label=com.docker.compose.service=api --format "$fmt"
elif sudo -n docker info >/dev/null 2>&1; then
    sudo -n docker ps -a --filter label=com.docker.compose.service=api --format "$fmt"
fi | sed '/^$/d' | sort -u
