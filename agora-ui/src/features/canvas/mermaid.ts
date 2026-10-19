/**
 * Mermaid source → SVG, rendered in Agora's page with Mermaid's strict security level
 * (its labels are sanitized, no click handlers or scripts). The SVG is then shown in the
 * same sandboxed frame as an SVG artifact, on its white page. The library is loaded on
 * first use only.
 */
let loaded: Promise<typeof import('mermaid').default> | null = null;
let counter = 0;

export async function renderMermaid(source: string): Promise<string> {
  loaded ??= import('mermaid').then(m => {
    m.default.initialize({ startOnLoad: false, securityLevel: 'strict', theme: 'default' });
    return m.default;
  });
  const mermaid = await loaded;
  const { svg } = await mermaid.render(`agora-mermaid-${++counter}`, source);
  return svg;
}
