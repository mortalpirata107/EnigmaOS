import React from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import type { OpenWindow } from '../hooks/useOpenWindows';
import { WindowPreviewCard } from './WindowPreviewCard';
import { AppIcon } from './IconMapper';

interface WindowPreviewPopoverProps {
  windows: OpenWindow[];
  appIcon: string;
  appName: string;
  onFocus: (id: string) => void;
  onClose: (id: string) => void;
  onMouseEnter?: () => void;
  onMouseLeave?: () => void;
}

export const WindowPreviewPopover: React.FC<WindowPreviewPopoverProps> = ({
  windows,
  appIcon,
  appName,
  onFocus,
  onClose,
  onMouseEnter,
  onMouseLeave,
}) => {
  if (!windows || windows.length === 0) return null;

  const hasMultiple = windows.length > 1;

  return (
    <motion.div
      id="dock-window-previews"
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
      initial={{ opacity: 0, y: 12, scale: 0.94, x: '-50%' }}
      animate={{ opacity: 1, y: 0, scale: 1, x: '-50%' }}
      exit={{ opacity: 0, y: 8, scale: 0.94, x: '-50%' }}
      transition={{ type: 'spring', stiffness: 420, damping: 26 }}
      style={{ left: '50%', bottom: 'calc(100% + 18px)' }}
      className="absolute pointer-events-auto z-[80] select-none"
    >
      {hasMultiple ? (
        /* Caso Multiventana: Bandeja Aero Peek unificada con cabecera y tarjetas interactivas */
        <div className="relative bg-[#08080d]/95 backdrop-blur-3xl p-3 rounded-2xl border border-white/15 shadow-[0_28px_60px_rgba(0,0,0,0.95)] flex flex-col items-center">
          {/* Brillo especular superior */}
          <div className="absolute inset-x-6 top-0 h-px bg-gradient-to-r from-transparent via-white/25 to-transparent pointer-events-none" />

          {/* Cabecera indicadora */}
          <div className="w-full flex items-center justify-between px-2.5 pb-2 text-[10.5px] text-white/60 font-medium tracking-wide border-b border-white/10 mb-2.5">
            <span className="flex items-center gap-1.5 text-white/90 font-semibold">
              <div className="w-4 h-4 flex items-center justify-center">
                <AppIcon windowClass={appIcon} appName={appName} />
              </div>
              {appName}
            </span>
            <span className="text-[9.5px] px-2 py-0.5 rounded-full bg-white/10 text-white/70 font-semibold">
              {windows.length} ventanas abiertas
            </span>
          </div>

          {/* Fila de tarjetas con eliminación optimista y reordenación fluida */}
          <div className="flex items-center gap-3.5 max-w-[88vw] overflow-x-auto p-1 scrollbar-none">
            <AnimatePresence mode="popLayout">
              {windows.map((win) => (
                <WindowPreviewCard
                  key={win.id}
                  window={win}
                  appIcon={appIcon}
                  appName={appName}
                  onFocus={onFocus}
                  onClose={onClose}
                />
              ))}
            </AnimatePresence>
          </div>

          {/* Triángulo/Pip de anclaje visual hacia el icono del dock */}
          <div className="absolute -bottom-1.5 left-1/2 -translate-x-1/2 w-3.5 h-3.5 bg-[#08080d] border-r border-b border-white/15 rotate-45 pointer-events-none" />
        </div>
      ) : (
        /* Caso Ventana Única: Tarjeta nítida individual con anclaje visual */
        <div className="relative flex flex-col items-center">
          <WindowPreviewCard
            window={windows[0]}
            appIcon={appIcon}
            appName={appName}
            onFocus={onFocus}
            onClose={onClose}
            isStandalone={true}
          />
          {/* Triángulo/Pip de anclaje visual hacia el icono del dock */}
          <div className="absolute -bottom-1.5 left-1/2 -translate-x-1/2 w-3.5 h-3.5 bg-[#0a0a0f] border-r border-b border-white/15 rotate-45 pointer-events-none z-10" />
        </div>
      )}
    </motion.div>
  );
};
