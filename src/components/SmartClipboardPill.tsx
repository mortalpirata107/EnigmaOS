import React from 'react';
import { motion } from 'framer-motion';
import { Code2, Globe, Image as ImageIcon, Clipboard, History, X } from 'lucide-react';

export interface ClipboardRecord {
  id: number;
  content_type: 'color' | 'code' | 'url' | 'image' | 'text';
  preview: string;
  full_content: string;
  meta_info: string;
  timestamp: number;
}

interface SmartClipboardPillProps {
  item: ClipboardRecord;
  isPaused?: boolean;
  onOpenHistory: () => void;
  onDismiss: () => void;
  onMouseEnter?: () => void;
  onMouseLeave?: () => void;
}

export const SmartClipboardPill: React.FC<SmartClipboardPillProps> = ({
  item,
  isPaused = false,
  onOpenHistory,
  onDismiss,
  onMouseEnter,
  onMouseLeave,
}) => {
  return (
    <motion.div
      initial={{ opacity: 0, y: -8, scale: 0.95 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: -6, scale: 0.96 }}
      transition={{ type: 'spring', stiffness: 380, damping: 26 }}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
      className="w-full h-full flex items-center justify-between px-3.5 select-none relative"
    >
      {/* Icono + Tipo + Preview (Clic para abrir Historial) */}
      <div
        onClick={(e) => {
          e.stopPropagation();
          onOpenHistory();
        }}
        className="flex items-center gap-2.5 min-w-0 flex-1 mr-2 cursor-pointer group"
        title="Clic para abrir el historial"
      >
        {item.content_type === 'color' && (
          <div className="flex items-center gap-2">
            <div
              className="w-5 h-5 rounded-full border border-white/40 shadow-[0_0_10px_rgba(255,255,255,0.25)] shrink-0"
              style={{ backgroundColor: item.preview }}
            />
            <div className="flex flex-col min-w-0">
              <span className="text-[10px] text-white/50 font-medium leading-none uppercase tracking-wider">
                Color
              </span>
              <span className="text-xs font-mono font-bold text-white tracking-wide truncate">
                {item.preview}
              </span>
            </div>
          </div>
        )}

        {item.content_type === 'code' && (
          <div className="flex items-center gap-2 min-w-0">
            <div className="w-5 h-5 rounded-lg neu-inset flex items-center justify-center shrink-0">
              <Code2 className="w-3.5 h-3.5 text-[#EF4444]" />
            </div>
            <div className="flex flex-col min-w-0">
              <span className="text-[10px] text-white/50 font-medium leading-none">
                Código ({item.meta_info})
              </span>
              <span className="text-xs font-mono text-white/90 truncate">
                {item.preview || 'Snippet copiado'}
              </span>
            </div>
          </div>
        )}

        {item.content_type === 'url' && (
          <div className="flex items-center gap-2 min-w-0">
            <div className="w-5 h-5 rounded-lg neu-inset flex items-center justify-center shrink-0">
              <Globe className="w-3.5 h-3.5 text-[#EF4444]" />
            </div>
            <div className="flex flex-col min-w-0">
              <span className="text-[10px] text-white/50 font-medium leading-none">
                Enlace ({item.meta_info})
              </span>
              <span className="text-xs text-white/90 truncate font-mono">
                {item.preview}
              </span>
            </div>
          </div>
        )}

        {item.content_type === 'image' && (
          <div className="flex items-center gap-2 min-w-0">
            <div className="w-5 h-5 rounded-lg neu-inset flex items-center justify-center shrink-0">
              <ImageIcon className="w-3.5 h-3.5 text-[#EF4444]" />
            </div>
            <div className="flex flex-col min-w-0">
              <span className="text-[10px] text-white/50 font-medium leading-none">
                Imagen
              </span>
              <span className="text-xs text-white/90 truncate">
                {item.meta_info}
              </span>
            </div>
          </div>
        )}

        {item.content_type === 'text' && (
          <div className="flex items-center gap-2 min-w-0">
            <div className="w-5 h-5 rounded-lg bg-[var(--accent-color)]/20 border border-[var(--accent-border)]/40 flex items-center justify-center shrink-0">
              <Clipboard className="w-3.5 h-3.5 text-[var(--accent-color)]" />
            </div>
            <div className="flex flex-col min-w-0">
              <span className="text-[10px] text-[var(--accent-highlight)] font-medium leading-none">
                Copiado ({item.meta_info})
              </span>
              <span className="text-xs text-white/90 truncate">
                {item.preview}
              </span>
            </div>
          </div>
        )}
      </div>

      {/* Botones de acción derecha */}
      <div className="flex items-center gap-1.5 shrink-0">
        <button
          onClick={(e) => {
            e.stopPropagation();
            onOpenHistory();
          }}
          className="flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-medium bg-white/10 hover:bg-[var(--accent-color)]/25 border border-white/10 hover:border-[var(--accent-border)]/50 text-white/80 hover:text-white transition-all shadow-sm"
          title="Ver Historial del Portapapeles"
        >
          <History className="w-2.5 h-2.5" />
          <span>Historial</span>
        </button>

        <button
          onClick={(e) => {
            e.stopPropagation();
            onDismiss();
          }}
          className="w-5 h-5 rounded-full flex items-center justify-center text-white/40 hover:text-white hover:bg-white/10 transition-colors"
          title="Cerrar notificación"
        >
          <X className="w-3 h-3" />
        </button>
      </div>

      {/* Micro-barra de progreso sutil de 3 segundos (se pausa al pasar el ratón) */}
      <motion.div
        initial={{ scaleX: 1 }}
        animate={{ scaleX: isPaused ? 1 : 0 }}
        transition={isPaused ? { duration: 0.2 } : { duration: 3.0, ease: 'linear' }}
        className={`absolute bottom-0 left-6 right-6 h-[1.5px] rounded-full origin-left pointer-events-none transition-colors duration-200 ${
          isPaused
            ? 'bg-[var(--accent-highlight)] shadow-[0_0_12px_var(--accent-glow)]'
            : 'bg-[var(--accent-color)]/70 shadow-[0_0_8px_var(--accent-glow)]'
        }`}
      />
    </motion.div>
  );
};
