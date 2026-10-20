# Sourced by scripts/test-sandbox-gvisor.sh; tested by scripts/test-engine-guard.sh.
# Exits the calling script unless this Docker engine has gVisor and no Agora containers.
# Fails closed: any docker command that fails aborts before anything is created or removed.

refuse() { echo "$*" >&2; exit 1; }

if ! runtimes="$(docker info --format '{{range $name, $_ := .Runtimes}}{{$name}} {{end}}')"; then
    refuse "Could not query this Docker engine; refusing to run."
fi
case " $runtimes " in
    *" runsc "*) ;;
    *) refuse "gVisor (runsc) is not registered with this Docker engine. See docs/getting-started.md." ;;
esac

# Running and stopped (-a): SandboxDocker.removeOrphans deletes stopped runtime containers too.
# Each listing is checked on its own; a failure in one must not be masked by the others.
if ! by_label="$(docker ps -a --format '{{.Names}}' --filter label=agora.managed=runtime)"; then
    refuse "Could not list runtime-labelled containers; refusing to run."
fi
if ! by_name="$(docker ps -a --format '{{.Names}}' --filter name=agora-run-)"; then
    refuse "Could not list agora-run-* containers; refusing to run."
fi
if ! by_project="$(docker ps -a --format '{{.Names}} {{.Label "com.docker.compose.project"}}')"; then
    refuse "Could not list compose containers; refusing to run."
fi
by_project="$(printf '%s\n' "$by_project" | awk '$2 ~ /^agora/ {print $1}')"
others="$(printf '%s\n' "$by_label" "$by_name" "$by_project" | sed '/^$/d' | sort -u)"
if [ -n "$others" ]; then
    echo "This engine hosts Agora containers; the suite could delete their code runs (and they ours):" >&2
    printf '%s\n' "$others" | sed 's/^/  /' >&2
    refuse "Run it on a dedicated Docker engine. Never start a second dockerd in another WSL distro."
fi
