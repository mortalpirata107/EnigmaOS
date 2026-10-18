import React from 'react';
import { motion } from 'framer-motion';
import { 
  Terminal, 
  Globe, 
  Folder, 
  Code, 
  Search 
} from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';
import { CapsuleRightEndCap } from './NotchEars';
import { useVirtualDesktops, VirtualDesktopItem } from '../hooks/useVirtualDesktops';

interface LeftCapsuleProps {
  innerRef?: React.Ref<HTMLDivElement>;
  onOpenSearch?: () => void;
}

export const LeftCapsule: React.FC<LeftCapsuleProps> = ({ 
  innerRef,
  onOpenSearch 
}) => {
  const { state, switchDesktop } = useVirtualDesktops();
  const desktops = state.desktops;

  const handleLaunch = (cmd: string) => {
    invoke('launch_app', { execCommand: cmd }).catch((err) => {
      console.warn(`[LeftCapsule] Failed to launch ${cmd}:`, err);
    });
  };

  const appShortcuts = [
    { id: 'term', name: 'Alacritty', icon: Terminal, cmd: 'alacritty' },
    { id: 'web', name: 'Brave Browser', icon: Globe, cmd: 'brave' },
    { id: 'files', name: 'Dolphin', icon: Folder, cmd: 'dolphin' },
    { id: 'code', name: 'VS Code', icon: Code, cmd: 'code' },
  ];

  // Desktops fallback seguro en caso de que KWin tarde en reportar
  const safeDesktops: VirtualDesktopItem[] = desktops && desktops.length > 0 
    ? desktops 
    : [
        { id: '0', index: 0, name: '01', is_current: true },
        { id: '1', index: 1, name: '02', is_current: false },
        { id: '2', index: 2, name: '03', is_current: false },
        { id: '3', index: 3, name: '04', is_current: false },
      ];

  return (
    <motion.div
      ref={innerRef}
      id="left-capsule"
      data-input-region="true"
      animate={{ opacity: [1, 0.999, 1] }}
      transition={{ duration: 2, repeat: Infinity, ease: 'linear' }}
      className="flex items-center h-[34px] pointer-events-auto select-none m-0 p-0"
      style={{ top: 0, margin: 0, padding: 0, willChange: 'opacity, transform', transform: 'translateZ(0)' }}
    >
      {/* 1. Contenedor Físico Principal: Chasis con bordes definidos y micro-relieve afilado */}
      <div
        className="flex items-center h-[34px] text-white select-none pl-3.5 pr-3 neu-chassis border-l-0 rounded-r-2xl"
      >
        <div className="flex items-center gap-2.5 h-full">
          {/* 1. Botón EOS: Micro-relieve limpio con icono rojo y texto blanco */}
          <motion.button
            whileHover={{ scale: 1.05 }}
            whileTap={{ scale: 0.94 }}
            onClick={onOpenSearch}
            className="h-7 flex items-center gap-1.5 px-2.5 rounded-xl whitespace-nowrap bg-[#111116] border border-white/5 hover:border-[#EF4444]/30 shadow-[1px_1px_3px_#000,inset_0_1px_0_rgba(255,255,255,0.06)] text-white cursor-pointer active:scale-95 transition-all"
            title="Menú del Sistema EndeavourOS / Búsqueda (Alt + Espacio)"
          >
            <motion.div
              animate={{ 
                scale: [1, 1.06, 1],
                filter: [
                  'drop-shadow(0 0 3px rgba(239,68,68,0.7))',
                  'drop-shadow(0 0 6px rgba(239,68,68,0.95))',
                  'drop-shadow(0 0 3px rgba(239,68,68,0.7))'
                ]
              }}
              transition={{ duration: 3.5, repeat: Infinity, ease: 'easeInOut' }}
              className="flex items-center justify-center shrink-0"
            >
              <svg
                className="w-3.5 h-3.5"
                viewBox="0 0 100 100"
                fill="none"
                xmlns="http://www.w3.org/2000/svg"
              >
                <path
                  d="M50 12 L84 84 C84 84 62 72 50 78 C38 72 16 84 16 84 Z"
                  fill="url(#eosCrimsonLogo)"
                />
                <path d="M50 12 L70 80 C70 80 57 74 50 78 Z" fill="#EF4444" opacity="0.95" />
                <path d="M50 12 L30 80 C30 80 43 74 50 78 Z" fill="#DC2626" opacity="0.95" />
                <defs>
                  <linearGradient id="eosCrimsonLogo" x1="16" y1="12" x2="84" y2="84" gradientUnits="userSpaceOnUse">
                    <stop stopColor="#7F1D1D" />
                    <stop offset="0.5" stopColor="#DC2626" />
                    <stop offset="1" stopColor="#EF4444" />
                  </linearGradient>
                </defs>
              </svg>
            </motion.div>

            <span className="font-mono text-xs font-bold tracking-widest text-white">
              EOS
            </span>
          </motion.button>

          {/* Separador vertical tallado */}
          <div className="w-[1.5px] h-3.5 bg-red-950/80 shadow-[1px_0_0_rgba(255,255,255,0.05),0_0_6px_rgba(239,68,68,0.4)] rounded-full" />

          {/* 2. Indicador de Workspace: Píldora uniforme h-7 con micro-cavidad interior */}
          <div className="h-7 flex items-center gap-1 px-1.5 rounded-full bg-[#08080C] border border-white/5 shadow-[inset_1px_1px_3px_#000,0_1px_0_rgba(255,255,255,0.04)] whitespace-nowrap">
            {safeDesktops.map((ws: VirtualDesktopItem) => {
              const isActive = ws.is_current;
              const label = ws.index !== undefined ? `0${ws.index + 1}` : ws.name;
              return (
                <motion.button
                  key={ws.id || ws.index}
                  onClick={(e) => {
                    e.stopPropagation();
                    switchDesktop(ws.id);
                  }}
                  whileHover={{ scale: 1.06 }}
                  whileTap={{ scale: 0.94 }}
                  className={`relative px-2 py-0.5 rounded-full text-xs font-mono font-bold transition-all cursor-pointer ${
                    isActive
                      ? 'bg-[#181822] text-white border border-[#EF4444]/60 shadow-[0_0_8px_rgba(239,68,68,0.3)]'
                      : 'text-white/60 hover:text-white px-1.5'
                  }`}
                  title={`Cambiar a Escritorio Virtual ${label} (KWin)`}
                >
                  {label}
                </motion.button>
              );
            })}
          </div>

          {/* Separador vertical tallado */}
          <div className="w-[1.5px] h-3.5 bg-red-950/80 shadow-[1px_0_0_rgba(255,255,255,0.05),0_0_6px_rgba(239,68,68,0.4)] rounded-full" />

          {/* 3. 4 Botones circulares de acceso rápido: Micro-relieve sutil y nítido */}
          <div className="flex items-center gap-1.5">
            {appShortcuts.map((app) => {
              const Icon = app.icon;
              return (
                <motion.button
                  key={app.id}
                  onClick={() => handleLaunch(app.cmd)}
                  whileHover={{ scale: 1.12 }}
                  whileTap={{ scale: 0.92 }}
                  className="w-7 h-7 rounded-full bg-[#111116] border border-white/5 hover:border-[#EF4444]/30 hover:bg-[#16161E] shadow-[1px_1px_3px_#000,inset_0_1px_0_rgba(255,255,255,0.06)] flex items-center justify-center text-[#EF4444] hover:text-white active:scale-95 transition-all cursor-pointer"
                  title={app.name}
                >
                  <Icon className="w-3.5 h-3.5 text-[#EF4444]" />
                </motion.button>
              );
            })}
          </div>

          {/* Separador vertical tallado */}
          <div className="w-[1.5px] h-3.5 bg-red-950/80 shadow-[1px_0_0_rgba(255,255,255,0.05),0_0_6px_rgba(239,68,68,0.4)] rounded-full" />

          {/* 4. Píldora 🔍 Búsqueda: Ranura tallada limpia a altura uniforme h-7 */}
          <motion.button
            whileHover={{ scale: 1.04 }}
            whileTap={{ scale: 0.96 }}
            onClick={onOpenSearch}
            className="h-7 flex items-center gap-1.5 px-3 rounded-full bg-[#08080C] border border-white/5 hover:border-[#EF4444]/30 shadow-[inset_1px_1px_3px_#000,0_1px_0_rgba(255,255,255,0.04)] text-white hover:text-white whitespace-nowrap transition-all cursor-pointer"
            title="Búsqueda rápida y lanzador (Alt + Espacio)"
          >
            <Search className="w-3 h-3 text-[#EF4444]" />
            <span className="font-mono text-xs font-semibold tracking-wide text-white whitespace-nowrap">
              Búsqueda
            </span>
          </motion.button>
        </div>
      </div>

      {/* 2. Ala/Curva derecha (S-Curve) perfectamente integrada */}
      <CapsuleRightEndCap className="-ml-[1px]" />
    </motion.div>
  );
};
