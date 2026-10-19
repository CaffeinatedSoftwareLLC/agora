export function ProviderTermsNotice({ content }: { content: string }) {
  return <div className="px-4 py-3 text-sm text-text-muted">
    <p className="whitespace-pre-line [overflow-wrap:anywhere]">{content.replace(/\nReview: \/admin\/provider-terms$/, '')}</p>
    <a className="underline" href="/admin/provider-terms">Review provider terms</a>
  </div>;
}
