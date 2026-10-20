import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { FileAttachment } from './FileAttachment';
import type { Attachment } from '../../stores/messageStore';

function attachment(overrides: Partial<Attachment> = {}): Attachment {
  return {
    id: '01HZZZZZZZZZZZZZZZZZZZZZZZ',
    name: 'e2e-doc.pdf',
    mime: 'application/pdf',
    size: 2048,
    width: null,
    height: null,
    url: '/files/01HZZZZZZZZZZZZZZZZZZZZZZZ',
    ...overrides,
  };
}

describe('FileAttachment keyboard access', () => {
  const fetchMock = vi.fn();
  let anchorClick: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchMock.mockReset();
    fetchMock.mockResolvedValue({ ok: true, blob: async () => new Blob(['x']) });
    vi.stubGlobal('fetch', fetchMock);
    URL.createObjectURL = vi.fn(() => 'blob:test');
    URL.revokeObjectURL = vi.fn();
    anchorClick = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
  });

  afterEach(() => {
    anchorClick.mockRestore();
    vi.unstubAllGlobals();
  });

  it('file card is a named button reached by Tab and downloads on Enter', async () => {
    const user = userEvent.setup();
    render(<FileAttachment attachment={attachment()} />);

    const card = screen.getByRole('button', { name: 'Download e2e-doc.pdf' });
    await user.tab();
    expect(card).toHaveFocus();

    await user.keyboard('{Enter}');
    await waitFor(() => expect(anchorClick).toHaveBeenCalledOnce());
    expect(fetchMock).toHaveBeenCalledWith('/files/01HZZZZZZZZZZZZZZZZZZZZZZZ', expect.anything());
  });

  it('image thumbnail opens on Enter and closes on Escape, returning focus', async () => {
    const user = userEvent.setup();
    render(<FileAttachment attachment={attachment({ name: 'cat.png', mime: 'image/png', width: 100, height: 100 })} />);
    await waitFor(() => expect(screen.getByRole('img', { name: 'cat.png' })).toBeInTheDocument());

    const thumb = screen.getByRole('button', { name: 'Open image cat.png' });
    await user.tab();
    expect(thumb).toHaveFocus();

    await user.keyboard('{Enter}');
    const close = screen.getByRole('button', { name: 'Close image cat.png' });
    expect(close).toHaveFocus();

    await user.keyboard('{Escape}');
    expect(screen.queryByRole('button', { name: 'Close image cat.png' })).not.toBeInTheDocument();
    expect(thumb).toHaveFocus();
  });
});
