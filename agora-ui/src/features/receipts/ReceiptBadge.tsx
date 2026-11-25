import { useReceiptAttention } from './receiptStore';

export function ReceiptBadge({ count, className = '' }: { count: number; className?: string }) {
  if (count <= 0) return null;
  const label = `${count} ${count === 1 ? 'receipt' : 'receipts'} contradicted or disputed`;
  return (
    <span
      className={`inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded bg-danger/20 px-1.5 py-0.5 text-[11px] font-semibold leading-none text-danger ${className}`}
      title={label}
      role="img"
      aria-label={label}
      data-testid="receipt-badge"
    >
      <svg className="h-3 w-3 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={3} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M12 5v8M12 18v.5" />
      </svg>
      <span aria-hidden="true">{count}</span>
    </span>
  );
}

/** The badge for one thread in a list: follows the loaded receipts, else the list's count. */
export function ThreadReceiptBadge({ threadId, fromList }: { threadId: string; fromList?: number | null }) {
  return <ReceiptBadge count={useReceiptAttention(threadId, fromList)} />;
}
