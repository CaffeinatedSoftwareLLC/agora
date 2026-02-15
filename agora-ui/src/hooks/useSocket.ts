import { useContext } from 'react';
import { SocketContext } from '../features/shell/SocketProvider';

export function useSocket() {
  return useContext(SocketContext);
}
