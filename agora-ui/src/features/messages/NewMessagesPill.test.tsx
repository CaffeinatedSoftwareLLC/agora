import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NewMessagesPill } from './NewMessagesPill';

describe('NewMessagesPill', () => {
  it('renders nothing when count is 0', () => {
    const { container } = render(<NewMessagesPill count={0} onClick={() => {}} />);
    expect(container.firstChild).toBeNull();
  });

  it('renders singular text for count of 1', () => {
    render(<NewMessagesPill count={1} onClick={() => {}} />);
    expect(screen.getByRole('button')).toHaveTextContent('1 new message');
    // Should NOT say "messages" (plural)
    expect(screen.getByRole('button')).not.toHaveTextContent('messages');
  });

  it('renders plural text for count > 1', () => {
    render(<NewMessagesPill count={3} onClick={() => {}} />);
    expect(screen.getByRole('button')).toHaveTextContent('3 new messages');
  });

  it('calls onClick when clicked', async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();
    render(<NewMessagesPill count={2} onClick={onClick} />);
    await user.click(screen.getByRole('button'));
    expect(onClick).toHaveBeenCalledOnce();
  });
});
