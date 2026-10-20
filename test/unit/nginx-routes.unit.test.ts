import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';

/**
 * Validates that every top-level route prefix registered in backend route
 * files has a corresponding entry in the nginx.conf proxy regex.
 *
 * Without this, new route prefixes work in dev (Vite proxy) but silently
 * serve index.html in production (nginx), causing 405 errors.
 */
describe('nginx route prefix coverage', () => {
    const projectRoot = join(__dirname, '..', '..');

    const nginxConf = readFileSync(join(projectRoot, 'agora-ui', 'nginx.conf'), 'utf-8');

    // The API proxy regex: location ~ ^/(auth|servers|...)(/|$) {
    // The (/|$) suffix is optional here so the anchor test below can report it missing.
    const API_LOCATION = /location\s+~\s+\^\/\(([\w|-]+)\)(\(\/\|\$\))?\s*\{/;

    function getNginxPrefixes(): Set<string> {
        const match = nginxConf.match(API_LOCATION);
        if (!match) throw new Error('Could not find API proxy regex in nginx.conf');
        return new Set(match[1].split('|'));
    }

    // Body of the location block whose header matches `header`.
    function locationBody(header: RegExp): string {
        const m = header.exec(nginxConf);
        if (!m) throw new Error(`Could not find location ${header} in nginx.conf`);
        let depth = 0;
        const start = nginxConf.indexOf('{', m.index);
        for (let i = start; i < nginxConf.length; i++) {
            if (nginxConf[i] === '{') depth++;
            else if (nginxConf[i] === '}' && --depth === 0) return nginxConf.slice(start + 1, i);
        }
        throw new Error(`Unclosed location ${header} in nginx.conf`);
    }

    function getBackendPrefixes(): Set<string> {
        const routesDir = join(projectRoot, 'src', 'routes');
        const prefixes = new Set<string>();

        // Scan all route files for registered paths
        const routeFiles = readdirSync(routesDir).filter(f => f.endsWith('.ts'));
        for (const file of routeFiles) {
            const content = readFileSync(join(routesDir, file), 'utf-8');
            // Match app.get('/prefix..., app.post('/prefix..., etc.
            const routePattern = /app\.(get|post|put|patch|delete|head|options)\(\s*'\/([a-zA-Z][a-zA-Z0-9-]*)/g;
            let m;
            while ((m = routePattern.exec(content)) !== null) {
                prefixes.add(m[2]);
            }
        }

        // Exclude prefixes that are handled specially (not proxied via the main regex)
        // /health is handled inline in app.ts, no route file
        prefixes.delete('health');

        return prefixes;
    }

    // Also scan app.ts for inline routes like /health
    function getAppInlinePrefixes(): Set<string> {
        const appTs = readFileSync(join(projectRoot, 'src', 'app.ts'), 'utf-8');
        const prefixes = new Set<string>();
        const pattern = /app\.(get|post|put|patch|delete)\(\s*'\/([a-zA-Z][a-zA-Z0-9-]*)/g;
        let m;
        while ((m = pattern.exec(appTs)) !== null) {
            prefixes.add(m[2]);
        }
        return prefixes;
    }

    it('every backend route prefix is listed in nginx.conf proxy regex', () => {
        const nginxPrefixes = getNginxPrefixes();
        const backendPrefixes = getBackendPrefixes();

        const missing: string[] = [];
        for (const prefix of backendPrefixes) {
            if (!nginxPrefixes.has(prefix)) {
                missing.push(prefix);
            }
        }

        if (missing.length > 0) {
            throw new Error(
                `Backend route prefix(es) missing from nginx.conf proxy regex:\n` +
                `  ${missing.join(', ')}\n\n` +
                `Add them to the regex in agora-ui/nginx.conf line ~10:\n` +
                `  location ~ ^/(${[...nginxPrefixes].join('|')}|${missing.join('|')}) {`
            );
        }
    });

    it('API prefixes are anchored to whole path segments (#127)', () => {
        // Without (/|$), /admin also matches /administrator and /files matches /files-page.
        expect(nginxConf.match(API_LOCATION)?.[2]).toBe('(/|$)');
    });

    it('both representations of the admin URLs send Vary: Accept (#127)', () => {
        // /admin/users and /admin/storage are an SPA page (Accept: text/html) and an API
        // endpoint (fetch) at the same URL. The JSON comes from the admin location; the
        // HTML comes from the /index.html location the rewrite lands on.
        const admin = locationBody(/location\s+~\s+\^\/admin\(/);
        expect(admin).toMatch(/rewrite\s+\^\s+\/index\.html\s+last;/);
        expect(admin).toMatch(/add_header\s+Vary\s+Accept\s+always;/);
        expect(locationBody(/location\s+=\s+\/index\.html\s*\{/)).toMatch(/add_header\s+Vary\s+Accept\s+always;/);
    });

    it('nginx regex does not contain stale prefixes with no backend routes', () => {
        const nginxPrefixes = getNginxPrefixes();
        const backendPrefixes = getBackendPrefixes();
        const appPrefixes = getAppInlinePrefixes();
        const allBackend = new Set([...backendPrefixes, ...appPrefixes]);

        // Prefixes that exist in nginx proactively for routes that use them
        // as sub-paths (e.g., /channels/:id/messages) or are planned but not
        // yet implemented. Update this list when adding/removing prefixes.
        const knownExtras = new Set([
            'messages',  // Routes are under /channels/:id/messages, but nginx prefix catches /messages/* too
            'roles',     // Role CRUD endpoints planned under /servers/:id/roles
        ]);

        const stale: string[] = [];
        for (const prefix of nginxPrefixes) {
            if (!allBackend.has(prefix) && !knownExtras.has(prefix)) {
                stale.push(prefix);
            }
        }

        if (stale.length > 0) {
            throw new Error(
                `nginx.conf contains prefixes with no matching backend routes:\n` +
                `  ${stale.join(', ')}\n\n` +
                `Either these routes were removed, or they're registered in a non-standard way.\n` +
                `If they're intentional, add them to knownExtras in this test.`
            );
        }
    });
});
