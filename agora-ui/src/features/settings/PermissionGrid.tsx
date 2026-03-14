import { useState } from 'react';

/**
 * All permission flags, grouped by category.
 * Values must match src/permissions.ts bitmask positions.
 */
const PERMISSION_GROUPS: { label: string; perms: { name: string; bit: bigint; desc: string }[] }[] = [
  {
    label: 'General',
    perms: [
      { name: 'Administrator', bit: 1n << 0n, desc: 'Full access — bypasses all checks' },
      { name: 'ManageServer', bit: 1n << 1n, desc: 'Edit server name, icon, settings' },
      { name: 'ManageChannels', bit: 1n << 2n, desc: 'Create, edit, delete channels' },
      { name: 'ManageRoles', bit: 1n << 3n, desc: 'Create, edit, delete roles' },
      { name: 'ManageEmoji', bit: 1n << 4n, desc: 'Add or remove custom emoji' },
    ],
  },
  {
    label: 'Membership',
    perms: [
      { name: 'KickMembers', bit: 1n << 5n, desc: 'Remove members from the server' },
      { name: 'BanMembers', bit: 1n << 6n, desc: 'Permanently ban members' },
      { name: 'CreateInvites', bit: 1n << 7n, desc: 'Create invite links' },
      { name: 'ChangeNickname', bit: 1n << 8n, desc: 'Change own nickname' },
      { name: 'ManageNicknames', bit: 1n << 9n, desc: "Change others' nicknames" },
    ],
  },
  {
    label: 'Text',
    perms: [
      { name: 'ViewChannel', bit: 1n << 10n, desc: 'See channels and read messages' },
      { name: 'SendMessages', bit: 1n << 11n, desc: 'Send messages in text channels' },
      { name: 'ManageMessages', bit: 1n << 12n, desc: 'Delete or pin messages' },
      { name: 'EmbedLinks', bit: 1n << 13n, desc: 'Embed links in messages' },
      { name: 'UploadFiles', bit: 1n << 14n, desc: 'Attach files to messages' },
      { name: 'AddReactions', bit: 1n << 15n, desc: 'Add reactions to messages' },
      { name: 'MentionEveryone', bit: 1n << 16n, desc: 'Use @everyone and @here' },
      { name: 'ReadMessageHistory', bit: 1n << 17n, desc: 'Read older messages' },
      { name: 'UseExternalEmoji', bit: 1n << 18n, desc: 'Use emoji from other servers' },
    ],
  },
  {
    label: 'Voice',
    perms: [
      { name: 'VoiceConnect', bit: 1n << 20n, desc: 'Join voice channels' },
      { name: 'VoiceSpeak', bit: 1n << 21n, desc: 'Speak in voice channels' },
      { name: 'VoiceVideo', bit: 1n << 22n, desc: 'Share video in voice channels' },
      { name: 'VoiceMuteMembers', bit: 1n << 23n, desc: 'Mute other members' },
      { name: 'VoiceDeafenMembers', bit: 1n << 24n, desc: 'Deafen other members' },
      { name: 'VoiceMoveMembers', bit: 1n << 25n, desc: 'Move members between voice channels' },
      { name: 'VoicePriority', bit: 1n << 26n, desc: 'Priority speaker mode' },
    ],
  },
  {
    label: 'Bots',
    perms: [
      { name: 'ManageBots', bit: 1n << 27n, desc: 'Create and manage bots' },
      { name: 'UseBots', bit: 1n << 28n, desc: 'Interact with bots' },
    ],
  },
];

interface PermissionGridProps {
  /** Current permission bitmask as stringified bigint */
  permissions: string;
  /** Called with the updated bitmask string */
  onChange: (permissions: string) => void;
  /** Tri-state mode for channel overrides (allow/deny/inherit) */
  triState?: false;
}

interface TriStatePermissionGridProps {
  allow: string;
  deny: string;
  onChange: (allow: string, deny: string) => void;
  triState: true;
}

type Props = PermissionGridProps | TriStatePermissionGridProps;

export function PermissionGrid(props: Props) {
  if (props.triState) {
    return <TriStateGrid {...props} />;
  }
  return <BinaryGrid {...props} />;
}

function BinaryGrid({ permissions, onChange }: PermissionGridProps) {
  const bits = BigInt(permissions);

  function toggle(bit: bigint) {
    const updated = bits & bit ? bits & ~bit : bits | bit;
    onChange(updated.toString());
  }

  return (
    <div className="space-y-4">
      {PERMISSION_GROUPS.map((group) => (
        <div key={group.label}>
          <h4 className="text-xs font-semibold text-text-muted uppercase tracking-wider mb-2">
            {group.label}
          </h4>
          <div className="space-y-1">
            {group.perms.map((p) => (
              <label
                key={p.name}
                className="flex items-center gap-3 px-2 py-1.5 rounded hover:bg-surface-hover cursor-pointer"
              >
                <input
                  type="checkbox"
                  checked={!!(bits & p.bit)}
                  onChange={() => toggle(p.bit)}
                  className="accent-primary"
                />
                <div>
                  <span className="text-sm text-text">{p.name}</span>
                  <p className="text-xs text-text-muted">{p.desc}</p>
                </div>
              </label>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

function TriStateGrid({ allow, deny, onChange }: TriStatePermissionGridProps) {
  const allowBits = BigInt(allow);
  const denyBits = BigInt(deny);

  function cycle(bit: bigint) {
    const isAllowed = !!(allowBits & bit);
    const isDenied = !!(denyBits & bit);

    let newAllow = allowBits;
    let newDeny = denyBits;

    if (isAllowed) {
      // allow → deny
      newAllow &= ~bit;
      newDeny |= bit;
    } else if (isDenied) {
      // deny → inherit
      newDeny &= ~bit;
    } else {
      // inherit → allow
      newAllow |= bit;
    }

    onChange(newAllow.toString(), newDeny.toString());
  }

  function stateLabel(bit: bigint): string {
    if (allowBits & bit) return 'Allow';
    if (denyBits & bit) return 'Deny';
    return 'Inherit';
  }

  function stateColor(bit: bigint): string {
    if (allowBits & bit) return 'text-green-400';
    if (denyBits & bit) return 'text-red-400';
    return 'text-text-muted';
  }

  return (
    <div className="space-y-4">
      {PERMISSION_GROUPS.map((group) => (
        <div key={group.label}>
          <h4 className="text-xs font-semibold text-text-muted uppercase tracking-wider mb-2">
            {group.label}
          </h4>
          <div className="space-y-1">
            {group.perms.map((p) => (
              <button
                key={p.name}
                onClick={() => cycle(p.bit)}
                className="flex items-center gap-3 w-full px-2 py-1.5 rounded hover:bg-surface-hover text-left"
              >
                <span className={`text-xs font-mono w-14 ${stateColor(p.bit)}`}>
                  {stateLabel(p.bit)}
                </span>
                <div>
                  <span className="text-sm text-text">{p.name}</span>
                  <p className="text-xs text-text-muted">{p.desc}</p>
                </div>
              </button>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
