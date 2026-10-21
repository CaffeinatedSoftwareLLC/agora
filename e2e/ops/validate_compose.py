#!/usr/bin/env python3
"""Validate a rendered compose config (`docker compose config --format json` on stdin)
before anything in e2e/ops starts or removes it.

  validate_compose.py <project> <api-port> <web-port>

Every service, volume, network and published port is checked, not just the ones the ops
compose file is expected to define, so an extra file, an inherited variable or a typo
can't point a `down -v` or an `up` at the live `agora` stack or at `agora-e2e`.
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
    for svc, s in (cfg.get('services') or {}).items():
        if svc in FORBIDDEN_SERVICES or svc not in ALLOWED_SERVICES:
            errors.append(f'service {svc!r} is not allowed')
            continue
        if s.get('container_name'):
            errors.append(f'service {svc}: container_name is not allowed')
        if s.get('network_mode') or s.get('pid') or s.get('privileged'):
            errors.append(f'service {svc}: network_mode/pid/privileged are not allowed')
        image = s.get('image', '')
        if not IMAGES[svc].match(image):
            errors.append(f'service {svc}: image {image!r} is not allowed')
        for m in s.get('volumes') or []:
            if m.get('type') != 'volume' or m.get('source') not in volumes:
                errors.append(f'service {svc}: mount {m.get("source")!r} ({m.get("type")}) is not a project volume')
        for net in (s.get('networks') or {}):
            if net not in networks:
                errors.append(f'service {svc}: network {net!r} is not declared')
        for p in s.get('ports') or []:
            published = int(p.get('published') or 0)
            if published in RESERVED_PORTS:
                errors.append(f'service {svc}: port {published} belongs to the live or e2e stack')
            if published not in allowed_ports:
                errors.append(f'service {svc}: published port {published!r} is not one of {sorted(allowed_ports)}')
            if p.get('host_ip') != '127.0.0.1':
                errors.append(f'service {svc}: port {published} is not bound to 127.0.0.1')
    for e in errors:
        print(f'compose guard: {e}')
    if errors:
        sys.exit(1)
    published = sorted({int(p['published']) for s in cfg['services'].values() for p in s.get('ports') or []})
    print(' '.join(str(p) for p in published))


if __name__ == '__main__':
    main()
