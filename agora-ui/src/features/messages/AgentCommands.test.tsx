import { beforeEach, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { ApiError, api } from '../../lib/api';
import { useAgentCommands } from './AgentCommands';

function Commands({ onAccepted }: { onAccepted: () => void }) {
  const { tryHandle, panel } = useAgentCommands('channel', onAccepted);
  return <><button onClick={() => tryHandle('/start claude')}>Start command</button>{panel}</>;
}

beforeEach(() => { vi.restoreAllMocks(); });

it('explains how to add a missing agent instead of showing bot_not_in_channel', async () => {
  vi.spyOn(api, 'post').mockRejectedValue(new ApiError(400, 'bot_not_in_channel'));
  const accepted = vi.fn();
  render(<Commands onAccepted={accepted} />);
  fireEvent.click(screen.getByRole('button', { name: 'Start command' }));
  await screen.findByText("That agent isn't in this channel yet. Choose Add agent in this channel, or ask the server owner or an administrator.");
  expect(screen.queryByText('bot_not_in_channel')).toBeNull();
  expect(accepted).not.toHaveBeenCalled();
});
