import type { InputHTMLAttributes } from 'react';

interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  label: string;
  error?: string;
}

export function Input({ label, error, id, className = '', ...props }: InputProps) {
  const inputId = id || label.toLowerCase().replace(/\s+/g, '-');

  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={inputId} className="text-[13px] text-text-muted">
        {label}
      </label>
      <input
        id={inputId}
        className={`min-h-11 md:min-h-9 bg-surface border border-border rounded-lg px-3 py-2 text-[16px] md:text-[15px] text-text placeholder:text-text-muted/70 focus:outline-none focus:ring-2 focus:ring-primary ${error ? 'border-danger' : ''} ${className}`}
        {...props}
      />
      {error && <span className="text-sm text-danger">{error}</span>}
    </div>
  );
}
