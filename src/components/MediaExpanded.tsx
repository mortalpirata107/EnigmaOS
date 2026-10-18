import React, { useState, useEffect, useRef } from 'react';
import { motion, AnimatePresence, type Variants } from 'framer-motion';
import { 
  Play, 
  Pause, 
  SkipBack, 
  SkipForward, 
  Cpu, 
  MemoryStick, 
  Thermometer, 
  Bluetooth, 
  Wifi, 
  Volume2, 
  VolumeX, 
  Mic,
  MicOff,
  Bell, 
  BellOff,
  Activity,
  Palette
} from 'lucide-react';
import { useMediaSession } from '../hooks/useMediaSession';
import { useSystemTelemetry } from '../hooks/useSystemTelemetry';
import { useBluetooth } from '../hooks/useBluetooth';
import { useAudioControl } from '../hooks/useAudioControl';
import { useVisualSettings, THEMES, type ThemeId } from '../hooks/useVisualSettings';

export type NotchSection = 'media' | 'telemetry' | 'settings';
export const NOTCH_SECTIONS: NotchSection[] = ['media', 'telemetry', 'settings'];

interface MediaExpandedProps {
  activeTab?: NotchSection;
  onTabChange?: (tab: NotchSection) => void;
  onClose?: () => void;
}

export const MediaExpanded: React.FC<MediaExpandedProps> = ({
  activeTab: controlledTab,
  onTabChange,
}) => {
  const [internalTab, setInternalTab] = useState<NotchSection>('media');
  const activeTab = controlledTab ?? internalTab;

  const [slideDirection, setSlideDirection] = useState<number>(1);
  const [currentTime, setCurrentTime] = useState<Date>(new Date());
  const [dndActive, setDndActive] = useState<boolean>(false);

  // Real-time hooks
  const { media, playPause, nextTrack, previousTrack, seek } = useMediaSession();
  const telemetry = useSystemTelemetry();
  const { state: btState, togglePower: toggleBtPower, connectDevice } = useBluetooth();
  const { volume, is_muted, is_mic_muted, toggleMute, toggleMicMute } = useAudioControl();
  const { settings: visualSettings, theme, updateSettings } = useVisualSettings();

  // Local song position ticker
  const [localPos, setLocalPos] = useState<number>(media.position_secs);
  useEffect(() => {
    setLocalPos(media.position_secs);
  }, [media.position_secs]);

  useEffect(() => {
    if (media.status !== 'Playing') return;
    const ticker = setInterval(() => {
      setLocalPos((prev) => (prev >= media.duration_secs ? 0 : prev + 1));
    }, 1000);
    return () => clearInterval(ticker);
  }, [media.status, media.duration_secs]);

  // Clock
  useEffect(() => {
    const clockTimer = setInterval(() => setCurrentTime(new Date()), 1000);
    return () => clearInterval(clockTimer);
  }, []);

  const changeTab = (newTab: NotchSection) => {
    const currIdx = NOTCH_SECTIONS.indexOf(activeTab);
    const newIdx = NOTCH_SECTIONS.indexOf(newTab);
    setSlideDirection(newIdx >= currIdx ? 1 : -1);
    if (onTabChange) {
      onTabChange(newTab);
    } else {
      setInternalTab(newTab);
    }
  };

  // Wheel scroll navigation for pages
  const lastWheelTime = useRef<number>(0);
  const handleWheel = (e: React.WheelEvent<HTMLDivElement>) => {
    e.stopPropagation();
    const now = Date.now();
    if (now - lastWheelTime.current < 260) return;
    if (Math.abs(e.deltaY) < 12) return;

    const currentIndex = NOTCH_SECTIONS.indexOf(activeTab);
    if (e.deltaY > 0) {
      const nextIndex = (currentIndex + 1) % NOTCH_SECTIONS.length;
      changeTab(NOTCH_SECTIONS[nextIndex]);
      lastWheelTime.current = now;
    } else if (e.deltaY < 0) {
      const prevIndex = (currentIndex - 1 + NOTCH_SECTIONS.length) % NOTCH_SECTIONS.length;
      changeTab(NOTCH_SECTIONS[prevIndex]);
      lastWheelTime.current = now;
    }
  };

  const formatSeconds = (sec: number) => {
    if (!sec || isNaN(sec) || sec < 0) return '0:00';
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    return `${m}:${s < 10 ? '0' : ''}${s}`;
  };

  const formattedTime = currentTime.toLocaleTimeString('es-ES', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });

  const formattedDate = currentTime.toLocaleDateString('es-ES', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
  });

  const duration = media.duration_secs > 0 ? media.duration_secs : 357;
  const progressPercent = Math.min(100, Math.max(0, (localPos / duration) * 100));
  const isPlaying = media.status === 'Playing';

  const handleSeek = (e: React.MouseEvent<HTMLDivElement>) => {
    e.stopPropagation();
    const rect = e.currentTarget.getBoundingClientRect();
    const clickX = e.clientX - rect.left;
    const ratio = Math.max(0, Math.min(1, clickX / rect.width));
    const targetSec = Math.floor(ratio * duration);
    setLocalPos(targetSec);
    seek(targetSec);
  };

  // Variants for smooth section transitions
  const pageVariants: Variants = {
    initial: (dir: number) => ({
      opacity: 0,
      x: dir > 0 ? 25 : -25,
      filter: 'blur(4px)',
    }),
    animate: {
      opacity: 1,
      x: 0,
      filter: 'blur(0px)',
      transition: { duration: 0.22, ease: 'easeOut' },
    },
    exit: (dir: number) => ({
      opacity: 0,
      x: dir > 0 ? -25 : 25,
      filter: 'blur(4px)',
      transition: { duration: 0.16, ease: 'easeIn' },
    }),
  };

  return (
    <div 
      onWheel={handleWheel}
      className="w-[520px] h-full p-4 text-white select-none flex flex-col justify-between overflow-hidden pointer-events-auto bg-[#0B0B0E]"
    >
      {/* 1. Cabecera y Paginador Superior Centrado */}
      <div className="flex items-center justify-between shrink-0 relative">
        {/* Fecha y Hora en vivo: Texto y Números en BLANCO #FFFFFF, separadores en ROJO CARMESÍ */}
        <div className="flex items-center gap-1.5 font-mono text-xs text-white">
          <span className="font-bold font-mono-num tracking-wide text-white">{formattedTime}</span>
          <span className="text-[#EF4444] font-bold">:</span>
          <span className="text-white/90 capitalize">{formattedDate}</span>
        </div>

        {/* Paginador de 3 Indicadores Centrado en Carril .neu-inset con pastilla .neu-led-red */}
        <div className="absolute left-1/2 -translate-x-1/2 flex items-center gap-2 px-3 py-1.5 rounded-full neu-inset border border-red-950/40 z-30">
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              changeTab('media');
            }}
            className={`cursor-pointer transition-all duration-300 ${
              activeTab === 'media'
                ? 'w-6 h-2 rounded-full neu-led-red'
                : 'w-2 h-2 rounded-full bg-white/20 hover:bg-white/40'
            }`}
            title="Sección 1: Reproductor Multimedia (Scroll)"
          />
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              changeTab('telemetry');
            }}
            className={`cursor-pointer transition-all duration-300 ${
              activeTab === 'telemetry'
                ? 'w-6 h-2 rounded-full neu-led-red'
                : 'w-2 h-2 rounded-full bg-white/20 hover:bg-white/40'
            }`}
            title="Sección 2: Rendimiento y Telemetría (Scroll)"
          />
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              changeTab('settings');
            }}
            className={`cursor-pointer transition-all duration-300 ${
              activeTab === 'settings'
                ? 'w-6 h-2 rounded-full neu-led-red'
                : 'w-2 h-2 rounded-full bg-white/20 hover:bg-white/40'
            }`}
            title="Sección 3: Ajustes y Temas (Scroll)"
          />
        </div>

        {/* Indicador de Sección Activa: Cavidad .neu-inset con punto rojo pulsante y texto en blanco */}
        <div className="flex items-center gap-1.5 px-3 py-1 rounded-full neu-inset text-[10px] font-mono text-white border border-red-950/40">
          <span className="w-2 h-2 rounded-full neu-led-red animate-pulse" />
          <span className="capitalize font-semibold tracking-wide text-white">
            {activeTab === 'media'
              ? 'Multimedia'
              : activeTab === 'telemetry'
              ? 'Telemetría'
              : 'Ajustes'}
          </span>
        </div>
      </div>

      {/* 2. Cuerpo Principal Animado según la Sección Activa */}
      <AnimatePresence mode="wait" custom={slideDirection}>
        {/* =========================================================================
            PÁGINA 1: REPRODUCTOR MULTIMEDIA EXACTO COMO ANTES
            ========================================================================= */}
        {activeTab === 'media' && (
          <motion.div
            key="page-media"
            custom={slideDirection}
            variants={pageVariants}
            initial="initial"
            animate="animate"
            exit="exit"
            className="flex items-center gap-4 py-1 shrink-0"
          >
            {/* Carátula del Álbum en Pozo Neumórfico .neu-inset p-1.5 rounded-2xl */}
            <div className="relative w-20 h-20 rounded-2xl overflow-hidden neu-inset p-1.5 shrink-0 group flex items-center justify-center border border-red-950/50">
              {media.art_url ? (
                <img 
                  src={media.art_url} 
                  alt={media.title} 
                  className="w-full h-full object-cover rounded-xl select-none"
                  onError={(e) => {
                    (e.target as HTMLElement).style.display = 'none';
                  }}
                />
              ) : (
                <div className="w-full h-full rounded-xl bg-[#09090D] flex flex-col justify-between p-1.5 text-white border border-red-950/40">
                  <div className="text-[8px] font-bold font-mono tracking-tighter uppercase border-b border-red-950/30 pb-0.5 text-[#EF4444]">
                    Archiv Produktion
                  </div>
                  <div className="flex items-center justify-center my-auto">
                    <div className="w-8 h-8 rounded-full neu-extruded flex items-center justify-center text-xs font-serif font-black text-[#EF4444]">
                      JSB
                    </div>
                  </div>
                  <div className="text-[7px] font-bold truncate text-white/90">
                    J.S. Bach • Orgelwerke
                  </div>
                </div>
              )}
            </div>

            {/* Detalles de la pista y ecualizador animado */}
            <div className="flex-1 flex flex-col justify-center min-w-0 pr-1">
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0 flex-1 space-y-0.5">
                  <h3 className="text-[15px] font-bold text-white truncate tracking-tight leading-snug" title={media.title}>
                    {media.title || 'Sin reproducción activa'}
                  </h3>
                  <p className="text-xs font-semibold text-white/80 truncate" title={media.artist}>
                    {media.artist || 'Spotify'}
                  </p>
                  {media.album && media.album !== media.title ? (
                    <p className="text-[11px] font-mono text-white/50 truncate" title={media.album}>
                      {media.album}
                    </p>
                  ) : (
                    <p className="text-[10px] font-mono text-[#EF4444]/80 flex items-center gap-1">
                      <span className="w-1.5 h-1.5 rounded-full neu-led-red animate-pulse inline-block" />
                      <span>Reproduciendo en alta fidelidad</span>
                    </p>
                  )}
                </div>

                {/* Visualizador de ondas derecho: Pantalla hundida .neu-inset con barras .neu-led-red */}
                <div className="flex items-end gap-1.5 h-8 px-3 py-1.5 rounded-2xl neu-inset shrink-0 border border-red-950/50">
                  {[45, 90, 35, 100, 70, 95, 60, 80, 40].map((h, i) => (
                    <motion.div
                      key={i}
                      className="w-1 neu-led-red rounded-full"
                      animate={
                        isPlaying
                          ? {
                              height: [`${h * 0.2}%`, `${h}%`, `${h * 0.35}%`],
                            }
                          : { height: '18%' }
                      }
                      transition={{
                        duration: 0.45 + (i % 5) * 0.1,
                        repeat: Infinity,
                        repeatType: 'reverse',
                        ease: 'easeInOut',
                      }}
                    />
                  ))}
                </div>
              </div>
            </div>
          </motion.div>
        )}

        {/* =========================================================================
            PÁGINA 2: TELEMETRÍA Y RENDIMIENTO DEL SISTEMA
            ========================================================================= */}
        {activeTab === 'telemetry' && (
          <motion.div
            key="page-telemetry"
            custom={slideDirection}
            variants={pageVariants}
            initial="initial"
            animate="animate"
            exit="exit"
            className="w-full flex-1 flex flex-col justify-between py-1"
          >
            {/* Tarjetas de CPU, RAM y Térmica */}
            <div className="grid grid-cols-3 gap-2.5">
              {/* Tarjeta CPU Real */}
              <div className="p-2.5 rounded-2xl neu-sunken flex flex-col justify-between border border-[#b82a2a]/20">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-1.5">
                    <Cpu className="w-3.5 h-3.5 text-[#b82a2a]" />
                    <span className="text-[10px] font-mono font-bold tracking-tight text-white">CPU</span>
                  </div>
                  <span className="text-[9px] font-mono text-white/80">{telemetry.cpu_cores} núcleos</span>
                </div>
                <div className="my-1">
                  <p className="text-xl font-black font-mono-num text-white leading-none">
                    {telemetry.cpu_usage.toFixed(1)}%
                  </p>
                </div>
                <div className="space-y-1">
                  <div className="w-full h-1.5 rounded-full bg-[#120204]/60 overflow-hidden neu-sunken">
                    <motion.div 
                      className="h-full bg-gradient-to-r from-[#b82a2a] to-[#d43b3b] rounded-full"
                      style={{ width: `${Math.min(100, Math.max(0, telemetry.cpu_usage))}%` }}
                    />
                  </div>
                  <div className="flex items-center justify-between text-[9px] font-mono text-white/80">
                    <span className="truncate max-w-[85px]">{telemetry.cpu_brand.replace('AMD ', '').replace('Intel ', '')}</span>
                    <span className="font-bold text-white">{telemetry.cpu_temp.toFixed(0)}°C</span>
                  </div>
                </div>
              </div>

              {/* Tarjeta RAM Real */}
              <div className="p-2.5 rounded-2xl neu-sunken flex flex-col justify-between border border-[#b82a2a]/20">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-1.5">
                    <MemoryStick className="w-3.5 h-3.5 text-[#b82a2a]" />
                    <span className="text-[10px] font-mono font-bold tracking-tight text-white">RAM DDR5</span>
                  </div>
                  <span className="text-[9px] font-mono text-white/80">
                    {telemetry.ram_used_gb.toFixed(1)} / {telemetry.ram_total_gb.toFixed(0)} GB
                  </span>
                </div>
                <div className="my-1">
                  <p className="text-xl font-black font-mono-num text-white leading-none">
                    {telemetry.ram_usage.toFixed(1)}%
                  </p>
                </div>
                <div className="space-y-1">
                  <div className="w-full h-1.5 rounded-full bg-[#120204]/60 overflow-hidden neu-sunken">
                    <motion.div 
                      className="h-full bg-gradient-to-r from-[#b82a2a] to-[#d43b3b] rounded-full"
                      style={{ width: `${Math.min(100, Math.max(0, telemetry.ram_usage))}%` }}
                    />
                  </div>
                  <div className="flex items-center justify-between text-[9px] font-mono text-white/80">
                    <span>En uso</span>
                    <span className="font-bold text-white">{(telemetry.ram_total_gb - telemetry.ram_used_gb).toFixed(1)} GB libres</span>
                  </div>
                </div>
              </div>

              {/* Tarjeta Térmica Real */}
              <div className="p-2.5 rounded-2xl neu-sunken flex flex-col justify-between border border-[#b82a2a]/20">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-1.5">
                    <Thermometer className="w-3.5 h-3.5 text-[#b82a2a]" />
                    <span className="text-[10px] font-mono font-bold tracking-tight text-white">TÉRMICA</span>
                  </div>
                  <span className="text-[9px] font-mono text-white/80 font-bold">KWin Wayland</span>
                </div>
                <div className="my-1">
                  <p className="text-xl font-black font-mono-num text-white leading-none">
                    {telemetry.cpu_temp.toFixed(1)}°C
                  </p>
                </div>
                <div className="space-y-1">
                  <div className="w-full h-1.5 rounded-full bg-[#120204]/60 overflow-hidden neu-sunken">
                    <motion.div 
                      className="h-full bg-gradient-to-r from-[#8b1c1c] to-[#b82a2a] rounded-full"
                      style={{ width: `${Math.min(100, (telemetry.cpu_temp / 95) * 100)}%` }}
                    />
                  </div>
                  <div className="flex items-center justify-between text-[9px] font-mono text-white/80">
                    <span>Estado</span>
                    <span className="font-bold text-white">
                      {telemetry.cpu_temp < 60 ? 'Óptimo' : telemetry.cpu_temp < 80 ? 'Moderado' : 'Alto'}
                    </span>
                  </div>
                </div>
              </div>
            </div>

            {/* Fila de Resumen de Sistema y Rendimiento en vivo */}
            <div className="flex items-center justify-between px-3 py-1.5 rounded-xl neu-sunken border border-[#b82a2a]/15 text-[10px] font-mono text-white/80">
              <div className="flex items-center gap-2">
                <Activity className="w-3.5 h-3.5 text-[#b82a2a] animate-pulse" />
                <span className="text-white font-bold">KWin Wayland compositor</span>
                <span className="text-[#b82a2a] font-bold">·</span>
                <span className="text-white/70">Linux EndeavourOS</span>
              </div>
              <div className="flex items-center gap-1.5">
                <span className="text-white/60">Scroll:</span>
                <span className="text-white font-semibold">Cambiar Sección</span>
              </div>
            </div>
          </motion.div>
        )}

        {/* =========================================================================
            PÁGINA 3: AJUSTES, PERSONALIZACIÓN VISUAL Y BLUETOOTH
            ========================================================================= */}
        {activeTab === 'settings' && (
          <motion.div
            key="page-settings"
            custom={slideDirection}
            variants={pageVariants}
            initial="initial"
            animate="animate"
            exit="exit"
            className="w-full flex-1 flex flex-col justify-between py-1 gap-2 overflow-y-auto max-h-[300px] pr-0.5"
          >
            {/* Fila 1: Botones Rápidos de Ajustes (Bluetooth, Wi-Fi, Vol, Mic, DND) */}
            <div className="grid grid-cols-5 gap-1.5 shrink-0">
              {/* 1. Bluetooth Toggle */}
              <motion.button
                whileHover={{ scale: 1.03 }}
                whileTap={{ scale: 0.94 }}
                onClick={(e) => {
                  e.stopPropagation();
                  toggleBtPower(!btState.powered);
                }}
                type="button"
                className={`p-1.5 rounded-xl flex flex-col items-center justify-center gap-0.5 transition-all cursor-pointer ${
                  btState.powered
                    ? 'shadow-[inset_2px_2px_5px_rgba(0,0,0,0.8)] bg-[var(--accent-dim)] border border-[var(--accent-color)]'
                    : 'neu-relief text-white'
                }`}
                title={btState.powered ? 'Bluetooth Activado' : 'Bluetooth Apagado'}
              >
                <Bluetooth className={`w-3.5 h-3.5 ${btState.powered ? 'text-[var(--accent-highlight)]' : 'text-[var(--accent-color)]'}`} />
                <span className="text-[9px] font-mono font-bold text-white">
                  {btState.powered ? 'BT On' : 'BT Off'}
                </span>
              </motion.button>

              {/* 2. Wi-Fi Status */}
              <div className="p-1.5 rounded-xl neu-sunken flex flex-col items-center justify-center gap-0.5 border border-[var(--accent-border)]">
                <Wifi className="w-3.5 h-3.5 text-[var(--accent-color)]" />
                <span className="text-[9px] font-mono font-bold text-white truncate max-w-[70px]">
                  {telemetry.wifi_ssid || 'Wi-Fi'}
                </span>
              </div>

              {/* 3. Volumen / Mute Sink */}
              <motion.button
                whileHover={{ scale: 1.03 }}
                whileTap={{ scale: 0.94 }}
                onClick={(e) => {
                  e.stopPropagation();
                  toggleMute();
                }}
                type="button"
                className={`p-1.5 rounded-xl flex flex-col items-center justify-center gap-0.5 transition-all cursor-pointer ${
                  is_muted
                    ? 'shadow-[inset_2px_2px_5px_rgba(0,0,0,0.8)] bg-[var(--accent-dim)] border border-[var(--accent-color)]'
                    : 'neu-relief text-white'
                }`}
                title={is_muted ? 'Audio Silenciado' : `Volumen: ${volume}%`}
              >
                {is_muted ? <VolumeX className="w-3.5 h-3.5 text-[var(--accent-highlight)]" /> : <Volume2 className="w-3.5 h-3.5 text-[var(--accent-color)]" />}
                <span className="text-[9px] font-mono font-bold text-white">
                  {is_muted ? 'Mute' : `${volume}%`}
                </span>
              </motion.button>

              {/* 4. Micrófono Mute */}
              <motion.button
                whileHover={{ scale: 1.03 }}
                whileTap={{ scale: 0.94 }}
                onClick={(e) => {
                  e.stopPropagation();
                  toggleMicMute();
                }}
                type="button"
                className={`p-1.5 rounded-xl flex flex-col items-center justify-center gap-0.5 transition-all cursor-pointer ${
                  is_mic_muted
                    ? 'shadow-[inset_2px_2px_5px_rgba(0,0,0,0.8)] bg-[var(--accent-dim)] border border-[var(--accent-color)]'
                    : 'neu-relief text-white'
                }`}
                title={is_mic_muted ? 'Micrófono Silenciado' : 'Micrófono Activo'}
              >
                {is_mic_muted ? <MicOff className="w-3.5 h-3.5 text-[var(--accent-highlight)]" /> : <Mic className="w-3.5 h-3.5 text-[var(--accent-color)]" />}
                <span className="text-[9px] font-mono font-bold text-white">
                  {is_mic_muted ? 'Mic Off' : 'Mic On'}
                </span>
              </motion.button>

              {/* 5. Modo No Molestar (DND) */}
              <motion.button
                whileHover={{ scale: 1.03 }}
                whileTap={{ scale: 0.94 }}
                onClick={(e) => {
                  e.stopPropagation();
                  setDndActive(!dndActive);
                }}
                type="button"
                className={`p-1.5 rounded-xl flex flex-col items-center justify-center gap-0.5 transition-all cursor-pointer ${
                  dndActive
                    ? 'shadow-[inset_2px_2px_5px_rgba(0,0,0,0.8)] bg-[var(--accent-dim)] border border-[var(--accent-color)]'
                    : 'neu-relief text-white'
                }`}
                title={dndActive ? 'Modo No Molestar Activado' : 'Modo No Molestar Inactivo'}
              >
                {dndActive ? <BellOff className="w-3.5 h-3.5 text-[var(--accent-highlight)]" /> : <Bell className="w-3.5 h-3.5 text-[var(--accent-color)]" />}
                <span className="text-[9px] font-mono font-bold text-white">
                  {dndActive ? 'DND On' : 'DND Off'}
                </span>
              </motion.button>
            </div>

            {/* Fila 2: PANEL DE PERSONALIZACIÓN VISUAL (DOCK & NOTCH SETTINGS) */}
            <div className="p-2.5 rounded-2xl neu-sunken border border-[var(--accent-border)] space-y-2 shrink-0">
              {/* Encabezado con Icono */}
              <div className="flex items-center justify-between text-[10px] font-mono">
                <div className="flex items-center gap-1.5 text-white font-bold tracking-wider">
                  <Palette className="w-3 h-3 text-[var(--accent-color)]" />
                  <span>PERSONALIZACIÓN VISUAL</span>
                </div>
                <span className="text-[9px] font-mono px-2 py-0.5 rounded-full bg-[var(--accent-dim)] text-[var(--accent-highlight)] border border-[var(--accent-border)] font-bold">
                  {theme.name}
                </span>
              </div>

              {/* Selector de Temas de Acento (4 pastillas / swatches) */}
              <div className="grid grid-cols-4 gap-1.5">
                {(Object.keys(THEMES) as ThemeId[]).map((tId) => {
                  const t = THEMES[tId];
                  const isSelected = visualSettings.theme === tId;
                  return (
                    <motion.button
                      key={tId}
                      whileHover={{ scale: 1.04 }}
                      whileTap={{ scale: 0.94 }}
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        updateSettings({ theme: tId });
                      }}
                      className={`p-1.5 rounded-xl flex items-center justify-center gap-1.5 transition-all cursor-pointer border ${
                        isSelected
                          ? 'bg-black border-[var(--accent-color)] shadow-[0_0_12px_var(--accent-glow)]'
                          : 'bg-white/[0.03] border-white/10 hover:border-white/20'
                      }`}
                      title={`Aplicar tema ${t.name}`}
                    >
                      <span
                        className="w-2.5 h-2.5 rounded-full shrink-0 shadow-sm transition-transform"
                        style={{
                          backgroundColor: t.primary,
                          boxShadow: isSelected ? `0 0 8px ${t.primary}` : undefined,
                          transform: isSelected ? 'scale(1.25)' : 'scale(1)',
                        }}
                      />
                      <span className={`text-[9px] font-mono font-semibold truncate ${isSelected ? 'text-white font-bold' : 'text-white/60'}`}>
                        {t.badge}
                      </span>
                    </motion.button>
                  );
                })}
              </div>

              {/* Controles Deslizantes: Tamaño del Dock y Magnificación de Lupa */}
              <div className="grid grid-cols-2 gap-2 pt-1 border-t border-white/[0.06]">
                {/* Control 1: Tamaño de Iconos */}
                <div className="space-y-1">
                  <div className="flex items-center justify-between text-[9px] font-mono text-white/70">
                    <span>Tamaño Dock</span>
                    <span className="text-white font-bold font-mono-num px-1 rounded bg-white/5 border border-white/10">
                      {visualSettings.dock_size}px
                    </span>
                  </div>
                  <input
                    type="range"
                    min="36"
                    max="64"
                    step="2"
                    value={visualSettings.dock_size}
                    onChange={(e) => updateSettings({ dock_size: Number(e.target.value) })}
                    className="w-full h-1.5 bg-black rounded-lg appearance-none cursor-pointer accent-[var(--accent-color)] border border-white/10"
                    title={`Tamaño del Dock: ${visualSettings.dock_size}px`}
                  />
                </div>

                {/* Control 2: Magnificación de la Lupa */}
                <div className="space-y-1">
                  <div className="flex items-center justify-between text-[9px] font-mono text-white/70">
                    <span>Lupa Zoom</span>
                    <span className="text-white font-bold font-mono-num px-1 rounded bg-white/5 border border-white/10">
                      {visualSettings.magnify_scale.toFixed(2)}x
                    </span>
                  </div>
                  <input
                    type="range"
                    min="1.0"
                    max="1.8"
                    step="0.05"
                    value={visualSettings.magnify_scale}
                    onChange={(e) => updateSettings({ magnify_scale: Number(e.target.value) })}
                    className="w-full h-1.5 bg-black rounded-lg appearance-none cursor-pointer accent-[var(--accent-color)] border border-white/10"
                    title={`Magnificación de la Lupa: ${visualSettings.magnify_scale.toFixed(2)}x`}
                  />
                </div>
              </div>

              {/* Control 3: Velocidad de Auto-Ocultado */}
              <div className="pt-1 border-t border-white/[0.06] flex items-center justify-between">
                <span className="text-[9px] font-mono text-white/70">Auto-Ocultado</span>
                <div className="flex items-center gap-1">
                  {[
                    { label: 'Rápido', ms: 80 },
                    { label: 'Normal', ms: 180 },
                    { label: 'Lento', ms: 380 },
                  ].map((speed) => {
                    const isSelected = visualSettings.autohide_delay_ms === speed.ms;
                    return (
                      <button
                        key={speed.ms}
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          updateSettings({ autohide_delay_ms: speed.ms });
                        }}
                        className={`px-2 py-0.5 rounded-lg text-[9px] font-mono transition-all cursor-pointer ${
                          isSelected
                            ? 'bg-[var(--accent-color)] text-white font-bold shadow-[0_0_8px_var(--accent-glow)]'
                            : 'bg-white/[0.04] text-white/60 hover:text-white border border-white/5'
                        }`}
                        title={`Retardo de auto-ocultado: ${speed.ms}ms`}
                      >
                        {speed.label}
                      </button>
                    );
                  })}
                </div>
              </div>
            </div>

            {/* Fila 3: Dispositivos Bluetooth Emparejados (Compacto) */}
            <div className="p-1.5 rounded-xl neu-sunken border border-[var(--accent-border)] max-h-[56px] overflow-y-auto shrink-0">
              <div className="flex items-center justify-between text-[8.5px] font-mono text-white/70 mb-0.5 px-1">
                <span>BLUETOOTH ({btState.devices.length} vinculados)</span>
                <span className="text-[8px] text-white/40">{btState.powered ? 'Activo' : 'Inactivo'}</span>
              </div>
              {btState.devices.length === 0 ? (
                <div className="text-[9px] font-mono text-white/50 text-center py-0.5">
                  Sin dispositivos emparejados
                </div>
              ) : (
                <div className="space-y-0.5">
                  {btState.devices.slice(0, 2).map((dev) => (
                    <div 
                      key={dev.mac}
                      className="flex items-center justify-between px-1.5 py-0.5 rounded bg-black/40 border border-white/5"
                    >
                      <span className="text-[9px] font-mono text-white truncate max-w-[200px]">
                        {dev.name || dev.mac}
                      </span>
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          connectDevice(dev.mac);
                        }}
                        className={`px-1.5 py-0.2 rounded text-[8px] font-mono ${
                          dev.connected ? 'text-[var(--accent-highlight)] font-bold' : 'text-white/60'
                        }`}
                      >
                        {dev.connected ? 'Conectado' : 'Conectar'}
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* 3. Barra de Progreso y Botonera: SÓLO Y EXCLUSIVAMENTE EN MEDIA */}
      {activeTab === 'media' && (
        <div className="space-y-2 shrink-0 pt-1">
          {/* Barra de Progreso: Ranura profunda .neu-inset con relleno .neu-led-red y punta luminosa */}
          <div className="space-y-1">
            <div 
              onClick={handleSeek}
              className="w-full h-2.5 rounded-full overflow-hidden neu-inset relative cursor-pointer group pointer-events-auto border border-red-950/50 p-0.5"
              title="Haz clic para avanzar o retroceder"
            >
              <motion.div
                className="h-full neu-led-red rounded-full relative"
                style={{ width: `${progressPercent}%` }}
              >
                <div className="absolute right-0 top-1/2 -translate-y-1/2 w-1.5 h-1.5 rounded-full bg-white shadow-[0_0_6px_#ffffff]" />
              </motion.div>
            </div>
            <div className="flex items-center justify-between text-xs font-mono font-bold text-white px-0.5">
              <span className="font-mono-num">{formatSeconds(localPos)}</span>
              <span className="text-[10px] text-white/50 font-normal">Scroll: Cambiar Sección</span>
              <span className="font-mono-num">{formatSeconds(duration)}</span>
            </div>
          </div>

          {/* Botonera de Reproducción: Botones físicos circulares .neu-extruded con Play/Pause agrandado y anillo rojo */}
          <div className="flex items-center justify-center gap-7 pt-0.5 pb-2 shrink-0 relative z-30">
            {/* Anterior */}
            <motion.button
              type="button"
              whileHover={{ scale: 1.1 }}
              whileTap={{ scale: 0.92 }}
              onClick={(e) => {
                e.stopPropagation();
                previousTrack();
              }}
              className="w-11 h-11 rounded-full neu-extruded flex items-center justify-center text-white hover:text-[#EF4444] transition-all cursor-pointer pointer-events-auto active:scale-95 border border-white/5"
              title="Pista Anterior"
            >
              <SkipBack className="w-4 h-4 fill-current" />
            </motion.button>

            {/* Play / Pausa Central: Más grande con anillo interior biselado en rojo carmesí */}
            <motion.button
              type="button"
              whileHover={{ scale: 1.08 }}
              whileTap={{ scale: 0.92 }}
              onClick={(e) => {
                e.stopPropagation();
                playPause();
              }}
              className="w-14 h-14 rounded-full neu-extruded flex items-center justify-center text-white transition-transform cursor-pointer pointer-events-auto active:scale-95 border-2 border-[#EF4444]/60 shadow-[0_0_16px_rgba(239,68,68,0.4)] relative"
              title={isPlaying ? 'Pausar Spotify' : 'Reproducir Spotify'}
            >
              <div className="w-10 h-10 rounded-full neu-inset flex items-center justify-center border border-red-950/40">
                {isPlaying ? (
                  <Pause className="w-5 h-5 fill-[#EF4444] text-[#EF4444]" />
                ) : (
                  <Play className="w-5 h-5 fill-[#EF4444] text-[#EF4444] ml-0.5" />
                )}
              </div>
            </motion.button>

            {/* Siguiente */}
            <motion.button
              type="button"
              whileHover={{ scale: 1.1 }}
              whileTap={{ scale: 0.92 }}
              onClick={(e) => {
                e.stopPropagation();
                nextTrack();
              }}
              className="w-11 h-11 rounded-full neu-extruded flex items-center justify-center text-white hover:text-[#EF4444] transition-all cursor-pointer pointer-events-auto active:scale-95 border border-white/5"
              title="Pista Siguiente"
            >
              <SkipForward className="w-4 h-4 fill-current" />
            </motion.button>
          </div>
        </div>
      )}
    </div>
  );
};
