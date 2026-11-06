import { afterEach, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { api } from '../../lib/api';
import { MAX_FILE_SIZE_MB, StorageSettings } from './StorageSettings';

const fileSettings = { 'files.max_size_bytes': 26214400, 'files.allowed_extensions': ['mp4'], 'files.retention_days': null, 'files.exif_strip': true };
const stats = { totalFiles: 0, totalBytes: '0', imageCount: 0, imageBytes: '0', expiringFiles: 0, quotaBytes: null, quotaUsedPercent: null };

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

function mockLoad() {
  vi.spyOn(api, 'get').mockImplementation(async (path: string) => (path === '/admin/storage' ? stats : fileSettings));
}

test('a max file size over the server cap explains the cap and is not sent', async () => {
  mockLoad();
  const patch = vi.spyOn(api, 'patch').mockResolvedValue({});
  render(<StorageSettings />);
  const input = await screen.findByLabelText('Max File Size (MB)');
  expect(input).toHaveAttribute('max', String(MAX_FILE_SIZE_MB));
  fireEvent.change(input, { target: { value: '200' } });
  expect(screen.getByRole('alert')).toHaveTextContent(`The most this server allows is ${MAX_FILE_SIZE_MB} MB.`);
  const save = screen.getByRole('button', { name: 'Save Settings' });
  expect(save).toBeDisabled();
  fireEvent.submit(save.closest('form')!);
  expect(patch).not.toHaveBeenCalled();
});

test('the server cap itself saves, in bytes', async () => {
  mockLoad();
  const patch = vi.spyOn(api, 'patch').mockResolvedValue({});
  render(<StorageSettings />);
  fireEvent.change(await screen.findByLabelText('Max File Size (MB)'), { target: { value: String(MAX_FILE_SIZE_MB) } });
  fireEvent.click(screen.getByRole('button', { name: 'Save Settings' }));
  expect(await screen.findByText('File settings saved.')).toBeInTheDocument();
  expect(patch).toHaveBeenCalledWith('/admin/settings/files', expect.objectContaining({ 'files.max_size_bytes': MAX_FILE_SIZE_MB * 1048576 }));
});
