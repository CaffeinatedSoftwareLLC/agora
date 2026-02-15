import { useContext } from 'react';
import { SocketContext } from '../features/shell/SocketContext';

export function useSocket() {
  return useContext(SocketContext);
}
