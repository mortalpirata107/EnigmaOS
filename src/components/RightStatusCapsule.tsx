import React, { useState, useRef, useCallback, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { listen } from '@tauri-apps/api/event';
import { 
  Wifi, 
  Bluetooth, 
  Volume2, 
  VolumeX, 
  Mic, 
  MicOff, 
  Bell, 
  BellOff, 
  Battery,
  Globe
} from 'lucide-react';
import { CapsuleLeftEndCap } from './NotchEars';
import { useAudioControl } from '../hooks/useAudioControl';
import { useDetailedBluetooth } from '../hooks/useDetailedBluetooth';
import { useDetailedNetwork } from '../hooks/useDetailedNetwork';
import { BluetoothContent } from './BluetoothContent';
import { NetworkContent } from './NetworkContent';
import { VolumeContent } from './VolumeContent';
import { syncAllTopBarRegions } from '../utils/syncInputRegions';

export type ActiveMenu = 'wifi' | 'bluetooth' | 'volume' | null;

interface RightStatusCapsuleProps {
  innerRef?: React.Ref<HTMLDivElement>;
  onPopoverChange?: (isOpen: boolean) => void;
}

// Configuración de resorte líquida y reactiva para el morphing in-place de los botones
const springTransition = {
  type: 'spring' as const,
  stiffness: 350,
  damping: 28,
  mass: 0.75,
};

export const RightStatusCapsule: React.FC<RightStatusCapsuleProps> = ({ 
  innerRef,
  onPopoverChange 
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const [dndActive, setDndActive] = useState<boolean>(false);
  const [activeMenu, setActiveMenu] = useState<ActiveMenu>(null);
  const leaveTimerRef = useRef<number | null>(null);
  const isAnimatingRef = useRef<boolean>(false);
  const animTimeoutRef = useRef<number | null>(null);

  const { volume, is_muted, is_mic_muted, toggleMicMute } = useAudioControl();
  const { state: btState } = useDetailedBluetooth();
  const { network } = useDetailedNetwork();

  // =========================================================================
  // 1. GESTIÓN EFICIENTE DE HITBOX CON RUST / WAYLAND (SIN SOBRECARGA IPC)
  // =========================================================================
  const syncInputRegions = useCallback((_isExpandedTarget?: boolean) => {
    syncAllTopBarRegions();
  }, []);

  // ResizeObserver que respeta las animaciones para no saturar Wayland IPC
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    let lastW = 0, lastH = 0;
    let debounceTimer: number | null = null;
    const observer = new ResizeObserver((entries) => {
      if (isAnimatingRef.current) return;
      const rect = entries[0].contentRect;
      if (Math.abs(rect.width - lastW) < 12 && Math.abs(rect.height - lastH) < 8) return;
      lastW = rect.width; lastH = rect.height;
      if (debounceTimer) window.clearTimeout(debounceTimer);
      debounceTimer = window.setTimeout(() => {
        syncInputRegions();
      }, 100);
    });

    observer.observe(el);
    syncInputRegions();

    return () => {
      observer.disconnect();
      if (debounceTimer) window.clearTimeout(debounceTimer);
      if (leaveTimerRef.current) clearTimeout(leaveTimerRef.current);
      if (animTimeoutRef.current) clearTimeout(animTimeoutRef.current);
    };
  }, [syncInputRegions]);

  // =========================================================================
  // 2. INTERACCIÓN REACTIVA: HOVER Y CLIC DIRECTO CON ANTIRREBOTE
  // =========================================================================
  const handleToggle = useCallback((menu: ActiveMenu) => {
    if (leaveTimerRef.current) {
      window.clearTimeout(leaveTimerRef.current);
      leaveTimerRef.current = null;
    }
    setActiveMenu((prev) => {
      const next = prev === menu ? null : menu;
      onPopoverChange?.(next !== null);
      syncInputRegions(next !== null);
      return next;
    });
  }, [onPopoverChange, syncInputRegions]);

  const handleMouseEnter = useCallback((menu: ActiveMenu) => {
    if (leaveTimerRef.current) {
      window.clearTimeout(leaveTimerRef.current);
      leaveTimerRef.current = null;
    }
    setActiveMenu(menu);
    onPopoverChange?.(menu !== null);

    // Activa la hitbox extendida al instante en Wayland
    syncInputRegions(true);

    isAnimatingRef.current = true;
    if (animTimeoutRef.current) clearTimeout(animTimeoutRef.current);
    animTimeoutRef.current = window.setTimeout(() => {
      isAnimatingRef.current = false;
      syncInputRegions(true);
    }, 320);
  }, [onPopoverChange, syncInputRegions]);

  const handleMouseLeave = useCallback(() => {
    if (leaveTimerRef.current) {
      window.clearTimeout(leaveTimerRef.current);
    }
    // Histeresis de 180ms para evitar parpadeos accidentales por micro-movimientos
    leaveTimerRef.current = window.setTimeout(() => {
      setActiveMenu(null);
      onPopoverChange?.(false);
      isAnimatingRef.current = true;
      if (animTimeoutRef.current) clearTimeout(animTimeoutRef.current);
      animTimeoutRef.current = window.setTimeout(() => {
        isAnimatingRef.current = false;
        syncInputRegions(false);
      }, 300);
    }, 180);
  }, [onPopoverChange, syncInputRegions]);

  // Soporte para apertura remota vía IPC
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    listen<string>('open_popover', (e) => {
      const target = e.payload as ActiveMenu;
      handleMouseEnter(target);
    }).then((unsub) => {
      unlisten = unsub;
    }).catch(() => {});

    return () => {
      if (unlisten) unlisten();
    };
  }, [handleMouseEnter]);

  // Icono reactivo de red
  const renderNetworkIcon = () => {
    if (network.conn_type === 'none' || network.state === 'disconnected') {
      return (
        <div className="relative flex items-center justify-center" title="Sin Conexión a Internet">
          <Globe className="w-3.5 h-3.5 text-[#b82a2a]/60" />
          <div className="absolute inset-0 flex items-center justify-center">
            <div className="w-4 h-[1.5px] bg-[#b82a2a] rotate-45" />
          </div>
        </div>
      );
    }
    if (network.conn_type === 'ethernet') {
      return (
        <div className="flex items-center justify-center" title={`Ethernet Cableado: ${network.name}`}>
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className="w-3.5 h-3.5 text-[#b82a2a] drop-shadow-[0_0_4px_rgba(184,42,42,0.6)]"
          >
            <rect width="14" height="10" x="2" y="3" rx="2" />
            <path d="M5 13h8" />
            <path d="M9 13v4" />
            <path d="M6 17h6" />
            <path d="M19 8v6a2 2 0 0 1-2 2h-1" />
            <circle cx="19" cy="8" r="1" fill="#b82a2a" />
          </svg>
        </div>
      );
    }
    return (
      <div className="flex items-center justify-center" title={`Wi-Fi: ${network.name}`}>
        <Wifi className="w-3.5 h-3.5 text-[#b82a2a] drop-shadow-[0_0_4px_rgba(184,42,42,0.6)]" />
      </div>
    );
  };

  const isWifiExpanded = activeMenu === 'wifi';
  const isBtExpanded = activeMenu === 'bluetooth';
  const isVolExpanded = activeMenu === 'volume';

  const setCombinedRef = useCallback((node: HTMLDivElement | null) => {
    (containerRef as React.MutableRefObject<HTMLDivElement | null>).current = node;
    if (typeof innerRef === 'function') {
      innerRef(node);
    } else if (innerRef) {
      (innerRef as React.MutableRefObject<HTMLDivElement | null>).current = node;
    }
  }, [innerRef]);

  return (
    <div
      ref={setCombinedRef}
      id="right-status-capsule"
      data-input-region="true"
      onMouseLeave={handleMouseLeave}
      className="relative flex items-start justify-end pointer-events-auto select-none overflow-visible min-h-[34px] m-0 p-0"
      style={{ top: 0, margin: 0, padding: 0 }}
    >
      {/* 1. Ala/Curva izquierda (S-Curve) */}
      <CapsuleLeftEndCap className="-mr-[1px] mt-0 shrink-0 z-10" />

      {/* 2. Contenedor Físico limpio y afilado con bordes definidos */}
      <div className="relative overflow-visible neu-chassis border-r-0 rounded-l-2xl pl-3 pr-3.5 py-0.5">
        {/* =========================================================================
            ORDEN EXACTO EXIGIDO:
            Wifi - microfono - bluetooth - notificaciones | volumen - bateria
            ========================================================================= */}
        <div className="relative z-10 flex items-start gap-2 overflow-visible h-[30px] pt-[1px]">
          
          {/* =========================================================================
              1. WIFI / RED (EL BOTÓN SE TRANSFORMA Y EXPANDE DIRECTAMENTE)
              ========================================================================= */}
          <motion.div
            layout
            transition={springTransition}
            data-menu-expanded={isWifiExpanded ? 'true' : undefined}
            onClick={() => handleToggle('wifi')}
            onMouseEnter={() => handleMouseEnter('wifi')}
            onMouseLeave={handleMouseLeave}
            animate={{
              width: isWifiExpanded ? 350 : 28,
              height: isWifiExpanded ? (network.conn_type === 'ethernet' ? 220 : 400) : 28,
              borderRadius: isWifiExpanded ? 24 : 9999,
            }}
            style={{ willChange: 'width, height, transform, opacity', transform: 'translateZ(0)' }}
            className={`relative overflow-hidden transition-colors self-start origin-top ${
              isWifiExpanded
                ? 'mt-0 flex flex-col items-stretch justify-start neu-chassis rounded-3xl cursor-default z-40'
                : 'h-7 flex items-center justify-center bg-[#111116] border border-white/5 hover:border-[#EF4444]/30 hover:bg-[#16161E] shadow-[1px_1px_3px_#000,inset_0_1px_0_rgba(255,255,255,0.06)] text-[#EF4444] hover:text-white cursor-pointer z-10 active:scale-95'
            }`}
            title={isWifiExpanded ? undefined : network.name ? `Red: ${network.name} (Clic para detalles)` : 'Estado de Red (Clic para ver)'}
          >
            <AnimatePresence initial={false}>
              {isWifiExpanded ? (
                <motion.div
                  key="wifi-expanded-panel"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  transition={{ duration: 0.15 }}
                  className="w-full h-full flex flex-col min-h-0"
                >
                  <NetworkContent />
                </motion.div>
              ) : (
                <motion.div
                  key="wifi-collapsed-icon"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  transition={{ duration: 0.12 }}
                  className="w-full h-full flex items-center justify-center"
                >
                  {renderNetworkIcon()}
                </motion.div>
              )}
            </AnimatePresence>
          </motion.div>

          {/* =========================================================================
              2. MICRÓFONO (BOTÓN RÁPIDO - TOGGLE DIRECTO)
              ========================================================================= */}
          <motion.button
            layout="position"
            transition={springTransition}
            whileHover={{ scale: 1.08 }}
            whileTap={{ scale: 0.92 }}
            onClick={(e) => {
              e.stopPropagation();
              toggleMicMute();
            }}
            type="button"
            className={`w-7 h-7 self-start rounded-full flex items-center justify-center transition-all cursor-pointer ${
              is_mic_muted
                ? 'bg-[#181822] text-white border border-[#EF4444]/60 shadow-[0_0_8px_rgba(239,68,68,0.3)]'
                : 'bg-[#111116] border border-white/5 hover:border-[#EF4444]/30 hover:bg-[#16161E] shadow-[1px_1px_3px_#000,inset_0_1px_0_rgba(255,255,255,0.06)] text-[#EF4444] hover:text-white'
            }`}
            title={is_mic_muted ? 'Micrófono Silenciado (Clic para activar)' : 'Micrófono Activo (Clic para silenciar)'}
          >
            {is_mic_muted ? <MicOff className="w-3.5 h-3.5 text-[#EF4444]" /> : <Mic className="w-3.5 h-3.5 text-[#EF4444]" />}
          </motion.button>

          {/* =========================================================================
              3. BLUETOOTH (EL BOTÓN SE TRANSFORMA Y EXPANDE DIRECTAMENTE)
              ========================================================================= */}
          <motion.div
            layout
            transition={springTransition}
            data-menu-expanded={isBtExpanded ? 'true' : undefined}
            onClick={() => handleToggle('bluetooth')}
            onMouseEnter={() => handleMouseEnter('bluetooth')}
            onMouseLeave={handleMouseLeave}
            animate={{
              width: isBtExpanded ? 350 : 28,
              height: isBtExpanded ? 380 : 28,
              borderRadius: isBtExpanded ? 24 : 9999,
            }}
            style={{ willChange: 'width, height, transform, opacity', transform: 'translateZ(0)' }}
            className={`relative overflow-hidden transition-colors self-start origin-top ${
              isBtExpanded
                ? 'mt-0 flex flex-col items-stretch justify-start neu-chassis rounded-3xl cursor-default z-40'
                : 'h-7 flex items-center justify-center bg-[#111116] border border-white/5 hover:border-[#EF4444]/30 hover:bg-[#16161E] shadow-[1px_1px_3px_#000,inset_0_1px_0_rgba(255,255,255,0.06)] text-[#EF4444] hover:text-white cursor-pointer z-10 active:scale-95'
            }`}
            title={isBtExpanded ? undefined : btState.powered ? 'Bluetooth Activado (Clic para dispositivos)' : 'Bluetooth Apagado'}
          >
            <AnimatePresence initial={false}>
              {isBtExpanded ? (
                <motion.div
                  key="bt-expanded-panel"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  transition={{ duration: 0.15 }}
                  className="w-full h-full flex flex-col min-h-0"
                >
                  <BluetoothContent />
                </motion.div>
              ) : (
                <motion.div
                  key="bt-collapsed-icon"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  transition={{ duration: 0.12 }}
                  className="w-full h-full flex items-center justify-center"
                >
                  <Bluetooth className={`w-3.5 h-3.5 ${btState.powered ? 'text-white' : 'text-[#EF4444]'}`} />
                </motion.div>
              )}
            </AnimatePresence>
          </motion.div>

          {/* =========================================================================
              4. NOTIFICACIONES / MODO NO MOLESTAR (BOTÓN RÁPIDO)
              ========================================================================= */}
          <motion.button
            layout="position"
            transition={springTransition}
            whileHover={{ scale: 1.08 }}
            whileTap={{ scale: 0.92 }}
            onClick={(e) => {
              e.stopPropagation();
              setDndActive(!dndActive);
            }}
            type="button"
            className={`w-7 h-7 self-start rounded-full flex items-center justify-center transition-all cursor-pointer ${
              dndActive
                ? 'bg-[#181822] text-white border border-[#EF4444]/60 shadow-[0_0_8px_rgba(239,68,68,0.3)]'
                : 'bg-[#111116] border border-white/5 hover:border-[#EF4444]/30 hover:bg-[#16161E] shadow-[1px_1px_3px_#000,inset_0_1px_0_rgba(255,255,255,0.06)] text-[#EF4444] hover:text-white'
            }`}
            title={dndActive ? 'Modo No Molestar Activado' : 'Modo No Molestar Inactivo'}
          >
            {dndActive ? <BellOff className="w-3.5 h-3.5 text-white" /> : <Bell className="w-3.5 h-3.5 text-[#EF4444]" />}
          </motion.button>

          {/* Separador vertical tallado */}
          <motion.div
            layout="position"
            transition={springTransition}
            className="w-[1.5px] h-3.5 bg-red-950/80 shadow-[1px_0_0_rgba(255,255,255,0.05),0_0_6px_rgba(239,68,68,0.4)] rounded-full self-center"
          />

          {/* =========================================================================
              6. VOLUMEN (EL BOTÓN SE TRANSFORMA Y EXPANDE DIRECTAMENTE)
              ========================================================================= */}
          <motion.div
            layout
            transition={springTransition}
            data-menu-expanded={isVolExpanded ? 'true' : undefined}
            onClick={() => handleToggle('volume')}
            onMouseEnter={() => handleMouseEnter('volume')}
            onMouseLeave={handleMouseLeave}
            animate={{
              width: isVolExpanded ? 360 : (is_muted ? 68 : 64),
              height: isVolExpanded ? 400 : 28,
              borderRadius: isVolExpanded ? 24 : 9999,
            }}
            style={{ willChange: 'width, height, transform, opacity', transform: 'translateZ(0)' }}
            className={`relative overflow-hidden transition-colors self-start origin-top ${
              isVolExpanded
                ? 'mt-0 flex flex-col items-stretch justify-start neu-chassis rounded-3xl cursor-default z-40'
                : 'h-7 px-2.5 flex items-center justify-center bg-[#08080C] border border-white/5 hover:border-[#EF4444]/30 shadow-[inset_1px_1px_3px_#000,0_1px_0_rgba(255,255,255,0.04)] text-white cursor-pointer z-10'
            }`}
            title={isVolExpanded ? undefined : is_muted ? 'Audio Silenciado' : `Volumen: ${volume}% (Clic para mezclar)`}
          >
            <AnimatePresence initial={false}>
              {isVolExpanded ? (
                <motion.div
                  key="vol-expanded-panel"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  transition={{ duration: 0.15 }}
                  className="w-full h-full flex flex-col min-h-0"
                >
                  <VolumeContent />
                </motion.div>
              ) : (
                <motion.div
                  key="vol-collapsed-pill"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  transition={{ duration: 0.12 }}
                  className="flex items-center gap-1.5 whitespace-nowrap"
                >
                  {is_muted ? <VolumeX className="w-3.5 h-3.5 text-white" /> : <Volume2 className="w-3.5 h-3.5 text-[#EF4444]" />}
                  <span className="font-mono font-bold text-white text-[11px] font-mono-num whitespace-nowrap">
                    {is_muted ? 'MUTE' : `${volume}%`}
                  </span>
                </motion.div>
              )}
            </AnimatePresence>
          </motion.div>

          {/* =========================================================================
              7. BATERÍA: Píldora uniforme h-7 con micro-relieve limpio
              ========================================================================= */}
          <motion.div 
            layout="position"
            transition={springTransition}
            whileHover={{ scale: 1.05 }}
            className="flex items-center gap-1.5 h-7 px-2.5 rounded-full bg-[#08080C] border border-white/5 hover:border-[#EF4444]/30 shadow-[inset_1px_1px_3px_#000,0_1px_0_rgba(255,255,255,0.04)] cursor-pointer text-white shrink-0 whitespace-nowrap self-start" 
            title="Batería: 100% (Conectado a CA)"
          >
            <motion.div
              animate={{ 
                filter: [
                  'drop-shadow(0 0 2px rgba(239,68,68,0.6))',
                  'drop-shadow(0 0 5px rgba(239,68,68,0.9))',
                  'drop-shadow(0 0 2px rgba(239,68,68,0.6))'
                ]
              }}
              transition={{ duration: 4, repeat: Infinity, ease: 'easeInOut' }}
            >
              <Battery className="w-3.5 h-3.5 text-[#EF4444]" />
            </motion.div>
            <span className="font-mono font-bold text-white text-[11px] font-mono-num whitespace-nowrap">100%</span>
          </motion.div>

        </div>
      </div>
    </div>
  );
};

export const RightCapsule = RightStatusCapsule;
