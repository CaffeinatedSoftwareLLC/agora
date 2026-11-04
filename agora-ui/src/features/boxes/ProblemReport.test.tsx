import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { api, ApiError } from '../../lib/api';
import { ProblemReport } from './ProblemReport';

const REPORT = 'agora 1.4.0\ndatabase: ok\nredis: ok\nrunner: runsc missing\nboxd: last seen 3m ago\nbox builder: failed (five failed starts)';
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

it('shows the whole report and sends it only on Send', async () => {
  const post = vi.spyOn(api, 'post').mockImplementation(async (path: string) => (path === '/admin/problem-report/preview'
    ? { report: REPORT } : { reportId: 'PR-7Q2K' }) as never);
  render(<ProblemReport />);
  expect(post).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Check and show report' }));
  const text = await screen.findByTestId('problem-report-text');
  expect(text.textContent).toBe(REPORT);
  expect(text.tagName).toBe('PRE');
  expect(screen.getByText(/goes to/)).toHaveTextContent('push.agora.host');
  expect(screen.getByText(/goes to/)).toHaveTextContent('Nothing has been sent yet.');
  expect(post).toHaveBeenCalledTimes(1);
  expect(post).toHaveBeenCalledWith('/admin/problem-report/preview');

  fireEvent.click(screen.getByRole('button', { name: 'Send' }));
  await waitFor(() => expect(post).toHaveBeenLastCalledWith('/admin/problem-report/send', { report: REPORT }));
  expect(await screen.findByTestId('problem-report-id')).toHaveTextContent('PR-7Q2K');
  expect(screen.queryByTestId('problem-report-text')).toBeNull();
});

it("Don't send discards the preview without sending", async () => {
  const post = vi.spyOn(api, 'post').mockResolvedValue({ report: REPORT } as never);
  render(<ProblemReport />);
  fireEvent.click(screen.getByRole('button', { name: 'Check and show report' }));
  await screen.findByTestId('problem-report-text');
  fireEvent.click(screen.getByRole('button', { name: "Don't send" }));
  expect(screen.queryByTestId('problem-report-text')).toBeNull();
  expect(post).toHaveBeenCalledTimes(1);
});

it('says why sending failed and keeps the report', async () => {
  vi.spyOn(api, 'post').mockImplementation(async (path: string) => {
    if (path === '/admin/problem-report/preview') return { report: REPORT } as never;
    throw new ApiError(502, 'collector_unreachable');
  });
  render(<ProblemReport />);
  fireEvent.click(screen.getByRole('button', { name: 'Check and show report' }));
  await screen.findByTestId('problem-report-text');
  fireEvent.click(screen.getByRole('button', { name: 'Send' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('Could not reach the report service');
  expect(screen.getByTestId('problem-report-text')).toBeInTheDocument();
});
