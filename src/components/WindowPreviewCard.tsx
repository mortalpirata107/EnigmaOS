import React, { useState, useEffect } from 'react';
import { motion } from 'framer-motion';
import { invoke } from '@tauri-apps/api/core';
import type { OpenWindow } from '../hooks/useOpenWindows';
import { AppIcon } from './IconMapper';

interface WindowPreviewCardProps {
  window: OpenWindow;
  appIcon: string;
  appName: string;
  onFocus: (id: string) => void;
  onClose: (id: string) => void;
  isStandalone?: boolean;
}

export const WindowPreviewCard: React.FC<WindowPreviewCardProps> = ({
  window: win,
  appIcon,
  appName,
  onFocus,
  onClose,
  isStandalone = false,
}) => {
  const [thumbnailUrl, setThumbnailUrl] = useState<string | null>(null);
  const [isClosing, setIsClosing] = useState(false);

  useEffect(() => {
    let isMounted = true;

    // Intentar cargar miniatura existente de caché
    invoke<string | null>('get_window_thumbnail', { id: win.id })
      .then((data) => {
        if (!isMounted) return;
        if (data) {
          setThumbnailUrl(data);
        } else if (win.is_active) {
          // Si la ventana está activa, capturarla de inmediato
          invoke<string | null>('capture_window_thumbnail_now', { id: win.id })
            .then((fresh) => {
              if (isMounted && fresh) setThumbnailUrl(fresh);
            })
            .catch(() => {});
        }
      })
      .catch(() => {});

    return () => {
      isMounted = false;
    };
  }, [win.id, win.is_active]);

  const handleCloseClick = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsClosing(true);
    setTimeout(() => {
      onClose(win.id);
    }, 140);
  };

  const displayTitle = win.title.trim() || win.app_name || appName || 'Ventana';
  const targetClass = (win.window_class || appIcon || '').toLowerCase();

  // Color de acento de marca para el resplandor ambiental
  const getBrandAccent = () => {
    if (targetClass.includes('discord')) return 'rgba(88, 101, 242, 0.22)';
    if (targetClass.includes('opera') || targetClass.includes('code')) return 'rgba(184, 42, 42, 0.25)';
    if (targetClass.includes('spotify')) return 'rgba(29, 185, 84, 0.22)';
    if (targetClass.includes('antigravity')) return 'rgba(0, 220, 255, 0.2)';
    return 'rgba(184, 42, 42, 0.2)';
  };

  return (
    <motion.div
      initial={{ opacity: 0, scale: 0.95, y: 6 }}
      animate={{
        opacity: isClosing ? 0 : 1,
        scale: isClosing ? 0.88 : 1,
        y: isClosing ? 8 : 0,
      }}
      transition={{ duration: 0.16, ease: 'easeOut' }}
      onClick={() => onFocus(win.id)}
      className={`group relative w-[264px] h-[174px] flex flex-col rounded-2xl overflow-hidden cursor-pointer select-none transition-all duration-200 ${
        isStandalone ? '' : 'flex-shrink-0'
      } ${
        win.is_active
          ? 'bg-[#0e0e14]/95 border border-[var(--accent-color)]/60 shadow-[0_20px_45px_rgba(0,0,0,0.95)] ring-1 ring-[var(--accent-glow)]'
          : 'bg-[#0a0a0f]/95 border border-white/15 hover:border-white/35 shadow-[0_20px_45px_rgba(0,0,0,0.85)] hover:shadow-[0_24px_50px_rgba(0,0,0,0.95)]'
      }`}
    >
      {/* Brillo especular superior */}
      <div className="absolute inset-x-6 top-0 h-px bg-gradient-to-r from-transparent via-white/20 to-transparent pointer-events-none z-30" />

      {/* =========================================================================
          TITLEBAR ESTILO AERO PEEK / macOS CON BOTÓN DE CIERRE DIRECTO [×]
          ========================================================================= */}
      <div className="h-8 px-2.5 flex items-center justify-between bg-black/70 border-b border-white/10 flex-shrink-0 z-20">
        {/* Puntos de ventana macOS */}
        <div className="flex items-center gap-1.5 mr-2">
          {/* Botón rojo de cierre rápido interactivo */}
          <button
            type="button"
            onClick={handleCloseClick}
            title="Cerrar ventana [×]"
            className="w-3 h-3 rounded-full bg-[#ff5f56]/90 hover:bg-[#ff5f56] hover:scale-125 active:scale-90 transition-all flex items-center justify-center group/dot shadow-sm"
          >
            <span className="opacity-0 group-hover/dot:opacity-100 text-[8.5px] text-black font-extrabold leading-none select-none">
              ×
            </span>
          </button>
          <div className="w-2.5 h-2.5 rounded-full bg-[#ffbd2e]/50" />
          <div className="w-2.5 h-2.5 rounded-full bg-[#27c93f]/50" />
        </div>

        {/* Icono y título de la ventana */}
        <div className="flex items-center gap-1.5 min-w-0 flex-1 mr-2 overflow-hidden">
          <div className="w-3.5 h-3.5 flex-shrink-0 flex items-center justify-center opacity-85 group-hover:opacity-100">
            <AppIcon windowClass={win.window_class || appIcon} appName={win.app_name || appName} />
          </div>
          <span
            className="text-[11px] font-semibold text-white/90 truncate leading-none"
            title={displayTitle}
          >
            {displayTitle}
          </span>
        </div>

        {/* Badge activa y botón de cierre directo destacado [×] */}
        <div className="flex items-center gap-1.5 flex-shrink-0">
          {win.is_active && (
            <span className="text-[8px] px-1.5 py-0.5 rounded-full bg-[var(--accent-color)]/25 text-[var(--accent-color)] border border-[var(--accent-color)]/40 font-bold tracking-wider leading-none flex items-center gap-1">
              <span className="w-1 h-1 rounded-full bg-[var(--accent-color)] animate-ping" />
              ACTIVA
            </span>
          )}
          <button
            type="button"
            onClick={handleCloseClick}
            title="Cerrar ventana [×]"
            className="w-5 h-5 rounded-md flex items-center justify-center text-white/40 hover:text-white hover:bg-red-500/80 active:scale-90 transition-all text-xs font-bold leading-none"
          >
            ×
          </button>
        </div>
      </div>

      {/* =========================================================================
          VIEWPORT DE PREVISUALIZACIÓN: CAPTURA REAL O BLUEPRINT AERO PEEK VIVO
          ========================================================================= */}
      <div className="flex-1 relative overflow-hidden flex items-center justify-center bg-[#050508]">
        {thumbnailUrl ? (
          <div className="w-full h-full relative">
            <img
              src={thumbnailUrl}
              alt={displayTitle}
              className="w-full h-full object-cover select-none pointer-events-none group-hover:scale-105 transition-transform duration-300"
            />
            {/* Gradiente sutil para integración de bordes */}
            <div className="absolute inset-0 bg-gradient-to-t from-black/50 via-transparent to-black/20 pointer-events-none" />
          </div>
        ) : (
          /* Blueprint Vectorial de Alta Fidelidad (Simulación Aero Peek) */
          <div className="w-full h-full relative flex flex-col justify-between p-3 select-none overflow-hidden">
            {/* Resplandor ambiental dinámico */}
            <div
              className="absolute inset-0 pointer-events-none blur-xl transition-all duration-300"
              style={{
                background: `radial-gradient(circle at center, ${getBrandAccent()} 0%, transparent 80%)`,
              }}
            />

            {/* Simulación de barra de herramientas / pestañas */}
            <div className="w-full flex items-center gap-1.5 opacity-35 pointer-events-none">
              <div className="w-14 h-1.5 rounded-full bg-white/50" />
              <div className="w-20 h-1.5 rounded-full bg-white/20" />
              <div className="w-10 h-1.5 rounded-full bg-white/20" />
              <div className="flex-1" />
              <div className="w-5 h-1.5 rounded-full bg-white/30" />
            </div>

            {/* Centro de la ventana: Icono oficial con aura y título de estado */}
            <div className="relative flex flex-col items-center justify-center my-auto z-10">
              <div className="w-11 h-11 flex items-center justify-center mb-1.5 drop-shadow-[0_4px_16px_rgba(0,0,0,0.9)] group-hover:scale-110 transition-transform duration-200">
                <AppIcon windowClass={win.window_class || appIcon} appName={win.app_name || appName} />
              </div>
              <span className="text-[10px] font-medium text-white/60 tracking-wider">
                {win.is_active ? 'VENTANA EN PRIMER PLANO' : 'CLIC PARA ENFOCAR'}
              </span>
            </div>

            {/* Simulación de barra de estado inferior */}
            <div className="w-full flex items-center justify-between opacity-25 pointer-events-none">
              <div className="w-16 h-1 rounded-full bg-white/40" />
              <div className="w-10 h-1 rounded-full bg-white/30" />
            </div>
          </div>
        )}

        {/* Resalte luminoso inferior interactivo al pasar el cursor */}
        <div className="pointer-events-none absolute inset-x-0 bottom-0 h-[2px] bg-gradient-to-r from-transparent via-[var(--accent-color)] to-transparent opacity-0 group-hover:opacity-100 transition-opacity duration-200" />
      </div>
    </motion.div>
  );
};
