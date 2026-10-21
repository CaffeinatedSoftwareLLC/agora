#!/usr/bin/env python3
"""Validate a rendered compose config (`docker compose config --format json` on stdin)
before anything in e2e/ops starts or removes it.

  validate_compose.py <project> <api-port> <web-port>

Every service, volume, network and published port is checked, not just the ones the ops
compose file is expected to define, so an extra file, an inherited variable or a typo
can't point a `down -v` or an `up` at the live `agora` stack or at `agora-e2e`.
Everything is an allowlist: top-level keys, service keys (only the ones the ops compose
file renders to) and their values, volume and network options.
Exit 1 with one line per problem.
"""
import json
import re
import sys

PROJECTS = {'agora-ops', 'agora-ops-restore'}
FORBIDDEN_SERVICES = {'runner', 'socket-proxy', 'sandbox-image', 'cap-gateway', 'caddy', 'tailscale', 'tailnet'}
ALLOWED_SERVICES = {'postgres', 'redis', 'migrate', 'api', 'web'}
RESERVED_PORTS = {80, 443, 3000, 8080, 3200, 8280}
IMAGES = {
    'postgres': re.compile(r'^postgres:16-alpine$'),
    'redis': re.compile(r'^redis:7-alpine$'),
    'migrate': re.compile(r'^agora-ops-server:(old|new)$'),
    'api': re.compile(r'^agora-ops-server:(old|new)$'),
    'web': re.compile(r'^agora-ops-web:(old|new)$'),
}


def bad_name(name):
    return name.startswith('agora_') or name.startswith('agora-e2e') or name == 'agora'


def main():
    project, api_port, web_port = sys.argv[1], int(sys.argv[2]), int(sys.argv[3])
    errors = []
    if project not in PROJECTS:
        errors.append(f'project {project!r} is not an ops project')
    cfg = json.load(sys.stdin)
    if cfg.get('name') != project:
        errors.append(f'rendered project name {cfg.get("name")!r} is not {project!r}')
    for key in sorted(set(cfg) - {'name', 'services', 'volumes', 'networks'}):
        errors.append(f'top-level key {key!r} (configs, secrets, ...) is not allowed')

    # Allowlists, not denylists: a safely named volume can still bind any host directory
    # through driver/driver_opts (type=none, o=bind, device=...), and a network can join
    # another one through its driver or options. Only a plain local volume and a plain
    # bridge network pass.
    volumes = cfg.get('volumes') or {}
    for key, v in volumes.items():
        v = v or {}
        name = v.get('name', '')
        if v.get('external'):
            errors.append(f'volume {key}: external volumes are not allowed')
        if v.get('driver', 'local') != 'local':
            errors.append(f'volume {key}: driver {v.get("driver")!r} is not allowed')
        if 'driver_opts' in v:
            errors.append(f'volume {key}: driver_opts are not allowed ({json.dumps(v["driver_opts"])})')
        for extra in sorted(set(v) - {'name', 'external', 'driver', 'driver_opts'}):
            errors.append(f'volume {key}: option {extra!r} is not allowed')
        if not name.startswith(project + '_') or bad_name(name):
            errors.append(f'volume {key}: resolved name {name!r} is not prefixed with {project}_')
    networks = cfg.get('networks') or {}
    if not networks:
        errors.append('no networks rendered')
    for key, n in networks.items():
        n = n or {}
        name = n.get('name', '')
        if n.get('external'):
            errors.append(f'network {key}: external networks are not allowed')
        if n.get('driver', 'bridge') != 'bridge':
            errors.append(f'network {key}: driver {n.get("driver")!r} is not allowed')
        if 'driver_opts' in n:
            errors.append(f'network {key}: driver_opts are not allowed ({json.dumps(n["driver_opts"])})')
        if n.get('ipam') not in (None, {}):
            errors.append(f'network {key}: ipam settings are not allowed')
        for extra in sorted(set(n) - {'name', 'external', 'driver', 'driver_opts', 'ipam'}):
            errors.append(f'network {key}: option {extra!r} is not allowed')
        if name != f'{project}_net':
            errors.append(f'network {key}: resolved name {name!r} is not {project}_net')

    allowed_ports = {api_port, web_port}
    services = cfg.get('services') or {}
    for svc, s in services.items():
        if svc in FORBIDDEN_SERVICES or svc not in ALLOWED_SERVICES:
            errors.append(f'service {svc!r} is not allowed')
            continue
        errors.extend(f'service {svc}: {e}' for e in check_service(svc, s, services, volumes, networks, allowed_ports))
    for e in errors:
        print(f'compose guard: {e}')
    if errors:
        sys.exit(1)
    published = sorted({int(p['published']) for s in cfg['services'].values() for p in s.get('ports') or []})
    print(' '.join(str(p) for p in published))


# The only service keys docker-compose.ops.yml renders to. Anything else (volumes_from,
# configs, secrets, devices, cap_add, security_opt, privileged, pid, ipc, network_mode,
# userns_mode, cgroup_parent, extra_hosts, links, external_links, sysctls, tmpfs,
# device_cgroup_rules, container_name, ...) is refused, known or not.
SERVICE_KEYS = {'build', 'command', 'depends_on', 'entrypoint', 'environment', 'healthcheck',
                'image', 'networks', 'ports', 'profiles', 'restart', 'volumes'}
BUILD_KEYS = {'context', 'dockerfile'}
HEALTHCHECK_KEYS = {'test', 'interval', 'timeout', 'retries'}
DEPENDS_KEYS = {'condition', 'required'}
DEPENDS_CONDITIONS = {'service_started', 'service_healthy', 'service_completed_successfully'}
PORT_KEYS = {'host_ip', 'mode', 'protocol', 'published', 'target'}
MOUNT_KEYS = {'source', 'target', 'type', 'volume'}
BUILT = {'migrate': '', 'api': '', 'web': '/agora-ui'}   # services built from the checkout, and the context suffix


def is_str_list(v):
    return isinstance(v, list) and all(isinstance(x, str) for x in v)


def check_service(svc, s, services, volumes, networks, allowed_ports):
    errors = []
    for key in sorted(set(s) - SERVICE_KEYS):
        errors.append(f'key {key!r} is not allowed')
    image = s.get('image', '')
    if not IMAGES[svc].match(image):
        errors.append(f'image {image!r} is not allowed')
    if 'build' in s:
        b = s['build'] or {}
        if svc not in BUILT:
            errors.append('build is not allowed for this service')
        for key in sorted(set(b) - BUILD_KEYS):
            errors.append(f'build option {key!r} is not allowed')
        ctx = b.get('context', '')
        if not (isinstance(ctx, str) and ctx.startswith('/') and ctx.endswith(BUILT.get(svc, '\0')) and '://' not in ctx):
            errors.append(f'build context {ctx!r} is not a local checkout path')
        if b.get('dockerfile') != 'Dockerfile':
            errors.append(f'build dockerfile {b.get("dockerfile")!r} is not Dockerfile')
    if s.get('command') is not None and not is_str_list(s['command']):
        errors.append('command must be a list of strings')
    if s.get('entrypoint') is not None:
        errors.append('entrypoint is not allowed')
    env = s.get('environment') or {}
    if not isinstance(env, dict) or not all(isinstance(v, str) or v is None for v in env.values()):
        errors.append('environment must map names to strings')
    for dep, d in (s.get('depends_on') or {}).items():
        if dep not in services:
            errors.append(f'depends_on {dep!r} is not a service of this project')
        for key in sorted(set(d or {}) - DEPENDS_KEYS):
            errors.append(f'depends_on option {key!r} is not allowed')
        if (d or {}).get('condition') not in DEPENDS_CONDITIONS:
            errors.append(f'depends_on condition {(d or {}).get("condition")!r} is not allowed')
    hc = s.get('healthcheck') or {}
    for key in sorted(set(hc) - HEALTHCHECK_KEYS):
        errors.append(f'healthcheck option {key!r} is not allowed')
    if hc and not is_str_list(hc.get('test')):
        errors.append('healthcheck test must be a list of strings')
    if not set(s.get('profiles') or []) <= {'web'}:
        errors.append(f'profiles {s.get("profiles")!r} are not allowed')
    if s.get('restart', 'no') not in ('no', 'unless-stopped'):
        errors.append(f'restart {s.get("restart")!r} is not allowed')
    nets = s.get('networks') or {}
    if not isinstance(nets, dict) or not nets:
        errors.append('must join the project network')
    for net, opts in (nets.items() if isinstance(nets, dict) else []):
        if net not in networks:
            errors.append(f'network {net!r} is not declared')
        if opts not in (None, {}):
            errors.append(f'network {net!r} options (aliases, addresses, ...) are not allowed')
    for m in s.get('volumes') or []:
        for key in sorted(set(m) - MOUNT_KEYS):
            errors.append(f'mount option {key!r} is not allowed')
        if m.get('type') != 'volume' or m.get('source') not in volumes:
            errors.append(f'mount {m.get("source")!r} ({m.get("type")}) is not a project volume')
        if m.get('volume') not in (None, {}):
            errors.append(f'mount {m.get("source")!r} volume options are not allowed')
        if not str(m.get('target', '')).startswith('/'):
            errors.append(f'mount target {m.get("target")!r} is not an absolute path')
    for p in s.get('ports') or []:
        for key in sorted(set(p) - PORT_KEYS):
            errors.append(f'port option {key!r} is not allowed')
        published = int(p.get('published') or 0)
        if published in RESERVED_PORTS:
            errors.append(f'port {published} belongs to the live or e2e stack')
        if published not in allowed_ports:
            errors.append(f'published port {published!r} is not one of {sorted(allowed_ports)}')
        if p.get('host_ip') != '127.0.0.1':
            errors.append(f'port {published} is not bound to 127.0.0.1')
        if p.get('protocol', 'tcp') != 'tcp' or p.get('mode', 'ingress') != 'ingress':
            errors.append(f'port {published}: only tcp/ingress is allowed')
    return errors


if __name__ == '__main__':
    main()
