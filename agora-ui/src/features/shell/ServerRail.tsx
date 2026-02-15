import { useState, useEffect, useRef } from 'react';
import { useServerStore } from '../../stores/serverStore';
import { useNavigate } from 'react-router-dom';
import { CreateServerModal } from '../servers/CreateServerModal';
import { JoinServerModal } from '../servers/JoinServerModal';

export function ServerRail() {
  const servers = useServerStore(s => s.servers);
  const activeServerId = useServerStore(s => s.activeServerId);
  const setActiveServer = useServerStore(s => s.setActiveServer);
  const navigate = useNavigate();
  const [showCreateServer, setShowCreateServer] = useState(false);
  const [showJoinServer, setShowJoinServer] = useState(false);
  const [showMenu, setShowMenu] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  const serverList = Array.from(servers.values());

  const handleServerClick = (serverId: string) => {
    setActiveServer(serverId);
    navigate(`/app/${serverId}`);
  };

  const handleDMClick = () => {
    setActiveServer(null);
    navigate('/app/dms');
  };

  // Close menu when clicking outside
  useEffect(() => {
    if (!showMenu) return;
    const handleClick = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setShowMenu(false);
      }
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [showMenu]);

  return (
    <div className="w-[72px] bg-bg flex flex-col items-center py-3 gap-2 overflow-y-auto shrink-0">
      {/* DM / Home button */}
      <button
        onClick={handleDMClick}
        className={`w-12 h-12 rounded-2xl flex items-center justify-center text-lg font-bold transition-all hover:rounded-xl ${
          activeServerId === null ? 'bg-primary text-white rounded-xl' : 'bg-surface text-text-muted hover:bg-surface-hover hover:text-text'
        }`}
      >
        DM
      </button>

      {/* Separator */}
      <div className="w-8 h-0.5 bg-border rounded-full" />

      {/* Server icons */}
      {serverList.map((server) => (
        <button
          key={server.id}
          onClick={() => handleServerClick(server.id)}
          className={`w-12 h-12 rounded-2xl flex items-center justify-center text-lg font-bold transition-all hover:rounded-xl ${
            activeServerId === server.id
              ? 'bg-primary text-white rounded-xl'
              : 'bg-surface text-text-muted hover:bg-surface-hover hover:text-text'
          }`}
          title={server.name}
        >
          {server.name[0].toUpperCase()}
        </button>
      ))}

      {/* Separator */}
      <div className="w-8 h-0.5 bg-border rounded-full" />

      {/* Add server button with dropdown */}
      <div className="relative" ref={menuRef}>
        <button
          onClick={() => setShowMenu(prev => !prev)}
          className="w-12 h-12 rounded-2xl bg-surface text-online flex items-center justify-center text-2xl font-light hover:rounded-xl hover:bg-online hover:text-white transition-all"
        >
          +
        </button>

        {showMenu && (
          <div className="absolute left-14 bottom-0 bg-surface border border-border rounded-lg shadow-lg py-1 w-40 z-50">
            <button
              onClick={() => {
                setShowMenu(false);
                setShowCreateServer(true);
              }}
              className="w-full px-3 py-2 text-sm text-text-muted hover:text-text hover:bg-surface-hover text-left"
            >
              Create Server
            </button>
            <button
              onClick={() => {
                setShowMenu(false);
                setShowJoinServer(true);
              }}
              className="w-full px-3 py-2 text-sm text-text-muted hover:text-text hover:bg-surface-hover text-left"
            >
              Join Server
            </button>
          </div>
        )}
      </div>

      <CreateServerModal
        isOpen={showCreateServer}
        onClose={() => setShowCreateServer(false)}
      />
      <JoinServerModal
        isOpen={showJoinServer}
        onClose={() => setShowJoinServer(false)}
      />
    </div>
  );
}
