import { useEffect, useRef, useState, useCallback } from 'react';
import { createPortal } from 'react-dom';

interface ReactionPickerProps {
  onSelect: (emoji: string) => void;
  onClose: () => void;
  anchorRef?: React.RefObject<HTMLElement | null>;
}

const emojiCategories = [
  {
    name: 'Smileys',
    emojis: [
      '\u{1F600}', '\u{1F602}', '\u{1F605}', '\u{1F923}', '\u{1F60A}', '\u{1F607}', '\u{1F609}', '\u{1F60D}',
      '\u{1F618}', '\u{1F970}', '\u{1F60B}', '\u{1F61C}', '\u{1F917}', '\u{1F914}', '\u{1F644}', '\u{1F612}',
      '\u{1F624}', '\u{1F621}', '\u{1F622}', '\u{1F62D}', '\u{1F631}', '\u{1F633}', '\u{1F634}', '\u{1F60E}',
    ],
  },
  {
    name: 'Gestures',
    emojis: [
      '\u{1F44D}', '\u{1F44E}', '\u{1F44F}', '\u{1F64C}', '\u{1F4AA}', '\u{270C}\u{FE0F}', '\u{1F44C}', '\u{1F91D}',
      '\u{1F64F}', '\u{1F91E}', '\u{1F448}', '\u{1F449}', '\u{261D}\u{FE0F}', '\u{270B}',
    ],
  },
  {
    name: 'Hearts',
    emojis: [
      '\u{2764}\u{FE0F}', '\u{1F9E1}', '\u{1F49B}', '\u{1F49A}', '\u{1F499}', '\u{1F49C}', '\u{1F5A4}', '\u{1F90D}',
      '\u{1F494}', '\u{1F495}', '\u{1F496}', '\u{1F49E}',
    ],
  },
  {
    name: 'Objects',
    emojis: [
      '\u{1F389}', '\u{1F388}', '\u{1F381}', '\u{1F3C6}', '\u{1F525}', '\u{2B50}', '\u{1F31F}', '\u{26A1}',
      '\u{1F4A1}', '\u{1F4AF}', '\u{2705}', '\u{274C}', '\u{2753}', '\u{1F4AC}', '\u{1F4E3}', '\u{1F514}',
    ],
  },
];

const PICKER_HEIGHT = 320;

export function ReactionPicker({ onSelect, onClose, anchorRef }: ReactionPickerProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);

  const updatePosition = useCallback(() => {
    const anchor = anchorRef?.current;
    if (!anchor) return;
    const rect = anchor.getBoundingClientRect();
    const spaceAbove = rect.top;
    const spaceBelow = window.innerHeight - rect.bottom;

    let top: number;
    if (spaceBelow >= PICKER_HEIGHT || spaceBelow >= spaceAbove) {
      top = rect.bottom + 4;
    } else {
      top = rect.top - PICKER_HEIGHT - 4;
    }

    let left = rect.left;
    if (left + 288 > window.innerWidth) {
      left = window.innerWidth - 288 - 8;
    }

    setPos({ top, left });
  }, [anchorRef]);

  useEffect(() => {
    updatePosition();
  }, [updatePosition]);

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        onClose();
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [onClose]);

  const picker = (
    <div
      ref={ref}
      style={pos ? { position: 'fixed', top: pos.top, left: pos.left } : { position: 'fixed', top: -9999, left: -9999 }}
      className="bg-surface border border-border rounded-lg shadow-lg p-2 w-72 z-50 max-h-80 overflow-y-auto"
    >
      {emojiCategories.map((category) => (
        <div key={category.name}>
          <div className="text-xs font-semibold text-text-dim px-1 pt-1 pb-0.5">
            {category.name}
          </div>
          <div className="flex flex-wrap">
            {category.emojis.map((emoji) => (
              <button
                key={emoji}
                onClick={() => onSelect(emoji)}
                className="w-8 h-8 flex items-center justify-center rounded hover:bg-surface-hover transition-colors text-base"
              >
                {emoji}
              </button>
            ))}
          </div>
        </div>
      ))}
    </div>
  );

  return createPortal(picker, document.body);
}
