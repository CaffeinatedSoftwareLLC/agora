#!/usr/bin/env node
/**
 * The runner's socket-proxy rules, read from docker-compose.prod.yml for one install name, so
 * the tests check (and the gVisor suite runs) the rules production uses, not a copy.
 *
 *   node scripts/lib/socket-proxy-rules.js <instance> [--allowfrom <cidr>]
 *
 * prints the proxy's arguments one per line. Used by scripts/test-sandbox-gvisor.sh and by
 * test/unit/socket-proxy-rules.unit.test.ts and test/sandbox/proxy.sandbox.test.ts.
 */

const fs = require('node:fs');
const path = require('node:path');

const COMPOSE = path.join(__dirname, '..', '..', 'docker-compose.prod.yml');
const INSTANCE = /^[a-z0-9][a-z0-9_-]{0,62}$/;

/** The `command:` arguments of one compose service, with ${AGORA_INSTANCE:-agora} filled in. */
function socketProxyArgs(instance, { file = COMPOSE, service = 'socket-proxy', allowFrom } = {}) {
    if (!INSTANCE.test(instance)) throw new Error(`Invalid install name "${instance}"`);
    const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
    const start = lines.indexOf(`  ${service}:`);
    if (start < 0) throw new Error(`No ${service} service in ${file}`);
    const args = [];
    let inCommand = false;
    for (let i = start + 1; i < lines.length; i++) {
        const line = lines[i];
        if (/^ {2}\S/.test(line) || /^\S/.test(line)) break; // next service or top-level key
        if (/^ {4}command:\s*$/.test(line)) { inCommand = true; continue; }
        if (inCommand && /^ {4}\S/.test(line)) break; // next key of this service
        const m = inCommand && line.match(/^\s+- "(.*)"\s*$/);
        if (m) args.push(m[1].replace(/\\(["\\])/g, '$1')); // YAML double-quoted escapes
    }
    if (args.length === 0) throw new Error(`No command for ${service} in ${file}`);
    const unknown = args.flatMap(a => a.match(/\$\{[^}]*\}/g) ?? []).filter(v => v !== '${AGORA_INSTANCE:-agora}');
    if (unknown.length) throw new Error(`Unexpected variables in the ${service} rules: ${unknown.join(', ')}`);
    return args.map(a => {
        const filled = a.split('${AGORA_INSTANCE:-agora}').join(instance);
        return allowFrom && filled.startsWith('-allowfrom=') ? `-allowfrom=${allowFrom}` : filled;
    });
}

/**
 * The allowlists by HTTP method, anchored the way the proxy anchors them (it adds ^ and $,
 * README "allowlist"). The patterns use only syntax Go's regexp and JavaScript read alike.
 */
function allowRules(args) {
    const rules = {};
    for (const a of args) {
        const m = a.match(/^-allow(GET|HEAD|POST|PUT|PATCH|DELETE)=(.*)$/);
        if (m) (rules[m[1]] ??= []).push(new RegExp(`^${m[2]}$`));
    }
    return rules;
}

/** Whether the proxy would pass this method and path on (the path only: it ignores query strings). */
function allows(rules, method, urlPath) {
    return (rules[method] ?? []).some(re => re.test(urlPath));
}

module.exports = { socketProxyArgs, allowRules, allows, COMPOSE };

if (require.main === module) {
    const [instance, flag, value] = process.argv.slice(2);
    if (!instance) { console.error('usage: socket-proxy-rules.js <instance> [--allowfrom <cidr>]'); process.exit(2); }
    const allowFrom = flag === '--allowfrom' ? value : undefined;
    process.stdout.write(socketProxyArgs(instance, { allowFrom }).join('\n') + '\n');
}
