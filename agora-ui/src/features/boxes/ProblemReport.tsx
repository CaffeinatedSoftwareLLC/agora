import { useState } from 'react';
import { Button } from '../../components/ui/Button';
import { boxApi } from './api';
import { TOUCH, boxError } from './boxRules';

/** Where Send goes (docs/agent-boxes.md §12.5); the API forwards it there. */
const DESTINATION = 'push.agora.host';

/**
 * Admin → Instance → Report setup problem (docs/agent-boxes.md §12.5). The API runs the checks
 * it can (versions, database, Redis, runner, boxd, the edge, box states; no secrets) and returns
 * the report. The whole report is shown first; nothing leaves the server until Send.
 */
export function ProblemReport() {
  const [report, setReport] = useState<string | null>(null);
  const [busy, setBusy] = useState<'preview' | 'send' | null>(null);
  const [error, setError] = useState('');
  const [reportId, setReportId] = useState<string | null>(null);

  const preview = async () => {
    setBusy('preview');
    setError('');
    setReportId(null);
    try {
      const res = await boxApi.previewProblemReport();
      setReport(res.report ?? '');
    } catch (err) {
      setError(boxError(err));
    } finally {
      setBusy(null);
    }
  };

  const send = async () => {
    if (report === null) return;
    setBusy('send');
    setError('');
    try {
      const res = await boxApi.sendProblemReport(report);
      setReportId(res.reportId);
    } catch (err) {
      setError(boxError(err));
    } finally {
      setBusy(null);
    }
  };

  const size = report === null ? 0 : new Blob([report]).size;

  return (
    <section className="mt-8 flex max-w-2xl flex-col gap-3" aria-labelledby="problem-report-heading">
      <h3 id="problem-report-heading" className="text-lg font-semibold">Report setup problem</h3>
      <p className="text-sm text-text-muted">
        Something wrong with this install? Agora checks its database, Redis, the code runner, boxd, the edge and every box,
        and shows you the report before anything is sent.
      </p>
      {report === null && (
        <div><Button variant="secondary" onClick={() => void preview()} loading={busy === 'preview'} className={TOUCH}>Check and show report</Button></div>
      )}

      {report !== null && reportId === null && (
        <>
          <p className="text-sm text-text">
            This is everything that will be sent: the text below, and nothing else, goes to <code>{DESTINATION}</code> when you
            press Send, and is kept there for 90 days. Nothing has been sent yet.
          </p>
          <pre className="max-h-[50dvh] overflow-auto whitespace-pre-wrap break-all rounded border border-border bg-bg p-3 font-mono text-xs text-text"
            data-testid="problem-report-text" tabIndex={0} aria-label="Problem report">{report}</pre>
          <p className="text-xs text-text-muted">{(size / 1024).toFixed(1)} KB</p>
          <div className="flex flex-col-reverse gap-2 md:flex-row">
            <Button variant="secondary" onClick={() => { setReport(null); setError(''); }} disabled={busy !== null} className={TOUCH}>Don&apos;t send</Button>
            <Button variant="secondary" onClick={() => void preview()} loading={busy === 'preview'} disabled={busy !== null} className={TOUCH}>Check again</Button>
            <Button onClick={() => void send()} loading={busy === 'send'} disabled={busy !== null} className={TOUCH}>Send</Button>
          </div>
        </>
      )}

      {reportId !== null && (
        <div className="rounded border border-online/40 bg-online/10 p-3 text-sm" role="status">
          <p className="text-text">Sent. Your report ID is <code className="select-all font-mono" data-testid="problem-report-id">{reportId}</code>.</p>
          <p className="mt-1 text-text-muted">Quote it when you open an issue.</p>
          <div className="mt-2 flex gap-2">
            <Button variant="secondary" onClick={() => { void navigator.clipboard?.writeText(reportId); }}>Copy ID</Button>
            <Button variant="secondary" onClick={() => { setReport(null); setReportId(null); }}>Done</Button>
          </div>
        </div>
      )}
      {error && <p className="text-sm text-danger" role="alert">{error}</p>}
    </section>
  );
}
