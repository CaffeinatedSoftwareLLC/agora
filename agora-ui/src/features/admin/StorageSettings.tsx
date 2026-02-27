import { useEffect, useState } from 'react';
import { api, ApiError } from '../../lib/api';
import { Button } from '../../components/ui/Button';
import type { FileSettings, StorageStats } from '../../lib/contracts/admin';

const RETENTION_OPTIONS = [
  { value: null as number | null, label: 'Off (keep forever)' },
  { value: 7, label: '7 days' },
  { value: 30, label: '30 days' },
  { value: 90, label: '90 days' },
  { value: 365, label: '365 days' },
];

function formatBytes(bytesStr: string): string {
  const bytes = Number(bytesStr);
  if (bytes === 0) return '0 B';
  if (bytes >= 1073741824) return `${(bytes / 1073741824).toFixed(2)} GB`;
  if (bytes >= 1048576) return `${(bytes / 1048576).toFixed(2)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} B`;
}

export function StorageSettings() {
  const [stats, setStats] = useState<StorageStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [newExtension, setNewExtension] = useState('');

  // Editable copies of settings
  const [maxSizeMB, setMaxSizeMB] = useState(25);
  const [allowedExtensions, setAllowedExtensions] = useState<string[]>([]);
  const [retentionDays, setRetentionDays] = useState<number | null>(null);
  const [exifStrip, setExifStrip] = useState(true);

  useEffect(() => {
    Promise.all([
      api.get<FileSettings>('/admin/settings/files'),
      api.get<StorageStats>('/admin/storage'),
    ])
      .then(([fileSettings, storageStats]) => {
        setStats(storageStats);
        setMaxSizeMB(Math.round((fileSettings['files.max_size_bytes'] ?? 26214400) / 1048576));
        setAllowedExtensions(fileSettings['files.allowed_extensions'] ?? []);
        setRetentionDays(fileSettings['files.retention_days'] ?? null);
        setExifStrip(fileSettings['files.exif_strip'] ?? true);
      })
      .catch((err) => {
        setError(err instanceof ApiError ? err.code : 'Failed to load file settings');
      })
      .finally(() => setLoading(false));
  }, []);

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError('');
    setSuccess('');
    try {
      await api.patch('/admin/settings/files', {
        'files.max_size_bytes': maxSizeMB * 1048576,
        'files.allowed_extensions': allowedExtensions,
        'files.retention_days': retentionDays,
        'files.exif_strip': exifStrip,
      });
      setSuccess('File settings saved.');
    } catch (err) {
      setError(err instanceof ApiError ? err.code : 'Failed to save settings');
    } finally {
      setSaving(false);
    }
  }

  function addExtension() {
    const ext = newExtension.trim().toLowerCase().replace(/^\./, '');
    if (ext && /^[a-z0-9]+$/.test(ext) && !allowedExtensions.includes(ext)) {
      setAllowedExtensions([...allowedExtensions, ext]);
    }
    setNewExtension('');
  }

  function removeExtension(ext: string) {
    setAllowedExtensions(allowedExtensions.filter((e) => e !== ext));
  }

  if (loading) {
    return <p className="text-text-muted">Loading file settings...</p>;
  }

  return (
    <div>
      <h2 className="text-xl font-bold mb-6">File Storage</h2>

      {/* Storage Usage Section */}
      {stats && (
        <div className="mb-8">
          <h3 className="text-sm font-semibold text-text-muted uppercase tracking-wide mb-3">
            Storage Usage
          </h3>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-4">
            <div className="bg-surface rounded-lg border border-border p-4">
              <p className="text-text-muted text-sm">Total Files</p>
              <p className="text-2xl font-bold">{stats.totalFiles}</p>
            </div>
            <div className="bg-surface rounded-lg border border-border p-4">
              <p className="text-text-muted text-sm">Total Storage</p>
              <p className="text-2xl font-bold">{formatBytes(stats.totalBytes)}</p>
            </div>
            <div className="bg-surface rounded-lg border border-border p-4">
              <p className="text-text-muted text-sm">Images</p>
              <p className="text-2xl font-bold">
                {stats.imageCount}
                <span className="text-sm font-normal text-text-muted ml-2">
                  ({formatBytes(stats.imageBytes)})
                </span>
              </p>
            </div>
          </div>

          {stats.quotaBytes && stats.quotaUsedPercent != null && (
            <div className="bg-surface rounded-lg border border-border p-4">
              <div className="flex justify-between text-sm mb-2">
                <span className="text-text-muted">Quota Usage</span>
                <span>
                  {formatBytes(stats.totalBytes)} of {formatBytes(stats.quotaBytes)}
                  <span className="text-text-muted ml-2">
                    ({stats.quotaUsedPercent.toFixed(1)}%)
                  </span>
                </span>
              </div>
              <div className="w-full bg-surface-hover rounded-full h-3">
                <div
                  className={`h-3 rounded-full transition-all ${
                    stats.quotaUsedPercent >= 90
                      ? 'bg-danger'
                      : stats.quotaUsedPercent >= 70
                        ? 'bg-warn'
                        : 'bg-primary'
                  }`}
                  style={{ width: `${Math.min(stats.quotaUsedPercent, 100)}%` }}
                />
              </div>
            </div>
          )}

          {stats.expiringFiles > 0 && (
            <p className="text-text-muted text-sm mt-2">
              {stats.expiringFiles} file{stats.expiringFiles !== 1 ? 's' : ''} pending expiration
            </p>
          )}
        </div>
      )}

      {/* Settings Section */}
      <h3 className="text-sm font-semibold text-text-muted uppercase tracking-wide mb-3">
        Settings
      </h3>
      <form onSubmit={handleSave} className="max-w-lg flex flex-col gap-5">
        {/* Max File Size */}
        <div className="flex flex-col gap-1">
          <label htmlFor="max-file-size" className="text-sm text-text-muted">
            Max File Size (MB)
          </label>
          <input
            id="max-file-size"
            type="number"
            min={1}
            max={100}
            value={maxSizeMB}
            onChange={(e) => setMaxSizeMB(Number(e.target.value))}
            className="bg-surface border border-border rounded px-3 py-2 text-text focus:outline-none focus:ring-2 focus:ring-primary w-32"
          />
          <span className="text-xs text-text-muted">
            1 MB - 100 MB ({(maxSizeMB * 1048576).toLocaleString()} bytes)
          </span>
        </div>

        {/* Allowed Extensions */}
        <div className="flex flex-col gap-2">
          <label className="text-sm text-text-muted">Allowed Extensions</label>
          <div className="flex flex-wrap gap-2">
            {allowedExtensions.map((ext) => (
              <span
                key={ext}
                className="inline-flex items-center gap-1 bg-primary/15 text-text text-sm px-2 py-1 rounded"
              >
                .{ext}
                <button
                  type="button"
                  onClick={() => removeExtension(ext)}
                  className="text-text-muted hover:text-danger ml-1"
                  aria-label={`Remove .${ext}`}
                >
                  x
                </button>
              </span>
            ))}
          </div>
          <div className="flex gap-2">
            <input
              type="text"
              value={newExtension}
              onChange={(e) => setNewExtension(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  addExtension();
                }
              }}
              placeholder="e.g. png"
              className="bg-surface border border-border rounded px-3 py-2 text-text placeholder-text-dim focus:outline-none focus:ring-2 focus:ring-primary w-40 text-sm"
            />
            <Button type="button" variant="secondary" onClick={addExtension}>
              Add
            </Button>
          </div>
        </div>

        {/* Retention Period */}
        <fieldset className="flex flex-col gap-1">
          <legend className="text-sm text-text-muted mb-2">File Retention</legend>
          {RETENTION_OPTIONS.map((opt) => (
            <label
              key={String(opt.value)}
              className={`flex items-center gap-3 p-2 rounded border cursor-pointer ${
                retentionDays === opt.value
                  ? 'border-primary bg-primary/10'
                  : 'border-border hover:bg-surface-hover'
              }`}
            >
              <input
                type="radio"
                name="retentionDays"
                checked={retentionDays === opt.value}
                onChange={() => setRetentionDays(opt.value)}
              />
              <span className="text-sm">{opt.label}</span>
            </label>
          ))}
        </fieldset>

        {/* EXIF Stripping */}
        <label className="flex items-center gap-3 cursor-pointer">
          <input
            type="checkbox"
            checked={exifStrip}
            onChange={(e) => setExifStrip(e.target.checked)}
            className="w-4 h-4 rounded border-border"
          />
          <div>
            <p className="text-sm font-medium">Strip EXIF Data</p>
            <p className="text-text-muted text-xs">
              Remove metadata (GPS, camera info) from uploaded images for privacy
            </p>
          </div>
        </label>

        {error && <p className="text-danger text-sm">{error}</p>}
        {success && <p className="text-online text-sm">{success}</p>}

        <Button type="submit" loading={saving}>
          Save Settings
        </Button>
      </form>
    </div>
  );
}
