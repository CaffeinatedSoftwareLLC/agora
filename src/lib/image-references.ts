/** Local image references in Markdown links, code spans, quotes, or bare paths.
 * Keep the dependency-free host copy in agora-host/src/image-references.ts in sync. */
export function extractImagePaths(content: string): string[] {
    const found = new Set<string>();
    const add = (value: string) => {
        const path = value.trim().replace(/^<|>$/g, '');
        if (/\.(?:png|jpe?g|gif|webp)$/i.test(path) && !/^[a-z][a-z0-9+.-]*:/i.test(path.replace(/^[A-Za-z]:[\\/]/, '/'))
            && !path.includes('\0') && !path.startsWith('//') && !path.startsWith('\\\\')) found.add(path);
    };
    let rest = content.replace(/\[[^\]\r\n]*\]\(<?([^\r\n]*?)>?\)/g, (_, target: string) => { add(target); return ' '; });
    rest = rest.replace(/`([^`\r\n]+)`|"([^"\r\n]+)"|'([^'\r\n]+)'|<([^<>\r\n]+)>/g,
        (_, ...groups: any[]) => { add(groups.slice(0, 4).find(v => v !== undefined)); return ' '; });
    for (const token of rest.split(/[\s()[\]{}<>"'`,;]+/)) add(token.replace(/[.!?]+$/, ''));
    return [...found];
}
