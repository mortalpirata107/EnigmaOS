import React, { useEffect, useRef } from 'react';
import {
  motion,
  AnimatePresence,
  useSpring,
  useTransform,
  useVelocity,
  type MotionValue,
} from 'framer-motion';
import { convertFileSrc } from '@tauri-apps/api/core';
import { AppIcon } from './IconMapper';

/** Geometría base (debe coincidir con el cálculo de anchura de BottomDock) */
export const DOCK_ICON_SIZE = 48;
export const DOCK_ICON_GAP = 10;

/** Efecto lupa: distancia de influencia y escala máxima por defecto */
const MAGNIFY_RANGE = 140;
export const DEFAULT_MAGNIFY_MAX_SCALE = 1.45;
const MAGNIFY_LIFT = -8;

export interface DockIconProps {
  /** Id estable para hit-testing (drag & drop nativo de Tauri) */
  appId: string;
  name: string;
  icon: string;
  isRunning: boolean;
  isActive?: boolean;
  badgeCount?: number;
  isBouncing?: boolean;
  /** Posición X global del ratón (Infinity = fuera del dock) */
  mouseX: MotionValue<number>;
  showTooltip: boolean;
  onHover: () => void;
  onClick: () => void;
  onContextMenu: (e: React.MouseEvent<HTMLDivElement>) => void;
  /** Rutas absolutas soltadas sobre este icono */
  onDropFiles?: (paths: string[]) => void;
  isMenuOpen?: boolean;
  contextMenu?: React.ReactNode;
  /** Popover flotante translúcido de previsualizaciones de ventanas */
  windowPreviews?: React.ReactNode;
  /** Cantidad de ventanas abiertas de la app para indicadores multi-LED */
  windowCount?: number;
  /** Tamaño base del icono (36 a 64px, default 48) */
  iconSize?: number;
  /** Escala máxima de la lupa (1.0 a 1.8x, default 1.45) */
  magnifyMaxScale?: number;
  /** Drag & Drop interno para reordenar iconos en el dock */
  draggable?: boolean;
  onDragStartItem?: (e: React.DragEvent<HTMLDivElement>) => void;
  onDragOverItem?: (e: React.DragEvent<HTMLDivElement>) => void;
  onDragLeaveItem?: (e: React.DragEvent<HTMLDivElement>) => void;
  onDropItem?: (e: React.DragEvent<HTMLDivElement>) => void;
  onDragEndItem?: (e: React.DragEvent<HTMLDivElement>) => void;
  isDragOverTarget?: boolean;
}

export type DockItemProps = DockIconProps;

/** Extrae rutas locales de un drop HTML5 (text/uri-list de Dolphin/Nautilus) */
function pathsFromDataTransfer(dt: DataTransfer): string[] {
  const uriList = dt.getData('text/uri-list') || '';
  return uriList
    .split(/\r?\n/)
    .map(l => l.trim())
    .filter(l => l && !l.startsWith('#') && l.startsWith('file://'))
    .map(l => {
      try {
        return decodeURIComponent(new URL(l).pathname);
      } catch {
        return '';
      }
    })
    .filter(Boolean);
}

/**
 * Icono: ruta absoluta (SVG/PNG) vía protocolo asset de Tauri, URL, o clave de marca
 * (SVG vectorial nítido de IconMapper) como fallback.
 */
const IconGlyph: React.FC<{ icon: string; name: string }> = ({ icon, name }) => {
  const [hasError, setHasError] = React.useState(false);
  const isAbsPath = icon.startsWith('/');
  const isUrl = /^(https?:|data:|asset:)/.test(icon);
  if (!hasError && (isAbsPath || isUrl)) {
    return (
      <img
        src={isAbsPath ? convertFileSrc(icon) : icon}
        alt={name}
        draggable={false}
        decoding="async"
        onError={() => setHasError(true)}
        className="w-full h-full object-contain select-none"
      />
    );
  }
  return <AppIcon windowClass={icon} appName={name} />;
};

export const DockIcon: React.FC<DockIconProps> = ({
  appId,
  name,
  icon,
  isRunning,
  isActive = false,
  badgeCount = 0,
  isBouncing = false,
  mouseX,
  showTooltip,
  isMenuOpen = false,
  contextMenu,
  windowPreviews,
  windowCount,
  iconSize = 48,
  magnifyMaxScale = DEFAULT_MAGNIFY_MAX_SCALE,
  onHover,
  onClick,
  onContextMenu,
  onDropFiles,
  draggable = false,
  onDragStartItem,
  onDragOverItem,
  onDragLeaveItem,
  onDropItem,
  onDragEndItem,
  isDragOverTarget = false,
}) => {
  const ref = useRef<HTMLDivElement>(null);

  // ---------------- Lupa e Inercia Elástica de Cursor (ligadas a mouseX) ----------------
  const mouseVelocity = useVelocity(mouseX);
  const distance = useTransform(mouseX, (x) => {
    const rect = ref.current?.getBoundingClientRect();
    if (!rect || !Number.isFinite(x)) return MAGNIFY_RANGE;
    return x - (rect.left + rect.width / 2);
  });
  const scaleTarget = useTransform(distance, [-MAGNIFY_RANGE, 0, MAGNIFY_RANGE], [1, magnifyMaxScale, 1]);
  const liftTarget = useTransform(distance, [-MAGNIFY_RANGE, 0, MAGNIFY_RANGE], [0, MAGNIFY_LIFT, 0]);

  // Resortes elásticos orgánicos para ampliación y elevación
  const scale = useSpring(scaleTarget, { mass: 0.12, stiffness: 220, damping: 15 });
  const lift = useSpring(liftTarget, { mass: 0.12, stiffness: 220, damping: 15 });

  // Inercia dinámica: inclinación elástica cuando el cursor pasa a gran velocidad
  const rawTilt = useTransform(mouseVelocity, [-2500, 0, 2500], [-7, 0, 7]);
  const proximity = useTransform(distance, [-MAGNIFY_RANGE, 0, MAGNIFY_RANGE], [0, 1, 0]);
  const tiltTarget = useTransform([rawTilt, proximity], ([t, p]) => (t as number) * Math.max(0, p as number));
  const tilt = useSpring(tiltTarget, { mass: 0.14, stiffness: 260, damping: 18 });

  // ---------------- Rebote de lanzamiento orgánico estilo macOS (Squash & Stretch) ----------------
  const bounceY = useSpring(0, { stiffness: 460, damping: 15, mass: 0.5 });
  const bounceScaleY = useSpring(1, { stiffness: 500, damping: 16, mass: 0.4 });
  const bounceScaleX = useSpring(1, { stiffness: 500, damping: 16, mass: 0.4 });

  useEffect(() => {
    if (!isBouncing) {
      bounceY.set(0);
      bounceScaleY.set(1);
      bounceScaleX.set(1);
      return;
    }
    const timeouts: number[] = [];
    const kick = () => {
      // Fase 1: Despegue elástico vertical con estiramiento
      bounceY.set(-22);
      bounceScaleY.set(1.12);
      bounceScaleX.set(0.92);

      // Fase 2: Apex de desaceleración gravitatoria
      timeouts.push(window.setTimeout(() => {
        bounceScaleY.set(1.0);
        bounceScaleX.set(1.0);
      }, 160));

      // Fase 3: Aterrizaje y compresión (squash) en el suelo
      timeouts.push(window.setTimeout(() => {
        bounceY.set(0);
        bounceScaleY.set(0.88);
        bounceScaleX.set(1.12);
      }, 300));

      // Fase 4: Recuperación elástica neutra
      timeouts.push(window.setTimeout(() => {
        bounceScaleY.set(1);
        bounceScaleX.set(1);
      }, 420));
    };

    kick();
    const interval = window.setInterval(kick, 520);
    return () => {
      window.clearInterval(interval);
      timeouts.forEach(t => window.clearTimeout(t));
      bounceY.set(0);
      bounceScaleY.set(1);
      bounceScaleX.set(1);
    };
  }, [isBouncing, bounceY, bounceScaleY, bounceScaleX]);

  const displayName = name.length > 28 ? name.slice(0, 26) + '…' : name;
  const badgeText = badgeCount > 99 ? '99+' : String(badgeCount);

  return (
    <div
      ref={ref}
      data-dock-app-id={appId}
      draggable={draggable}
      onDragStart={onDragStartItem}
      onDragOver={(e) => {
        e.preventDefault();
        onDragOverItem?.(e);
      }}
      onDragLeave={onDragLeaveItem}
      onDragEnd={onDragEndItem}
      onPointerEnter={onHover}
      onClick={onClick}
      onContextMenu={onContextMenu}
      onDrop={(e) => {
        e.preventDefault();
        if (e.dataTransfer.types.includes('text/x-dock-index')) {
          onDropItem?.(e);
          return;
        }
        const paths = pathsFromDataTransfer(e.dataTransfer);
        if (paths.length) {
          onDropFiles?.(paths);
        } else {
          let filePath = '';
          if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
            filePath = (e.dataTransfer.files[0] as any).path || '';
          }
          if (!filePath) {
            const text = e.dataTransfer.getData('text/plain') || '';
            if (text.startsWith('file://')) {
              try { filePath = decodeURIComponent(new URL(text).pathname); } catch {}
            } else if (text.startsWith('/')) {
              filePath = text.trim();
            }
          }
          if (filePath) onDropFiles?.([filePath]);
        }
      }}
      className="relative flex flex-col items-center justify-end select-none cursor-pointer"
      style={{ width: iconSize, height: iconSize + 8 }}
    >
      {/* Indicador de destino Drag & Drop interno */}
      {isDragOverTarget && (
        <div className="absolute -left-1.5 top-1 bottom-3 w-1 bg-[var(--accent-color)] rounded-full shadow-[0_0_8px_var(--accent-glow)] z-40 pointer-events-none animate-pulse" />
      )}

      {/* Popover flotante translúcido de previsualizaciones de ventanas */}
      <AnimatePresence>
        {!isMenuOpen && windowPreviews}
      </AnimatePresence>

      {/* Tooltip OS X para apps cerradas/sin ventanas */}
      <AnimatePresence>
        {showTooltip && !isMenuOpen && !windowPreviews && (
          <motion.div
            initial={{ opacity: 0, y: 4, x: '-50%' }}
            animate={{ opacity: 1, y: 0, x: '-50%' }}
            exit={{ opacity: 0, y: 2, x: '-50%' }}
            transition={{ duration: 0.12 }}
            style={{ left: '50%', top: -50 }}
            className="absolute bg-neutral-900/95 text-white text-[11px] font-medium tracking-wide px-3 py-1 rounded-md border border-white/20 shadow-xl whitespace-nowrap pointer-events-none z-50"
          >
            {displayName}
          </motion.div>
        )}
      </AnimatePresence>

      {/* Menú contextual aislado en z-[100] */}
      {isMenuOpen && contextMenu}

      {/* Capa de rebote inercial orgánico con inclinación dinámica */}
      <motion.div
        style={{
          y: bounceY,
          scaleY: bounceScaleY,
          scaleX: bounceScaleX,
          rotate: tilt,
          transformOrigin: '50% 100%',
        }}
        className="relative pointer-events-none"
      >
        {/* Capa de lupa: el badge va dentro para escalar junto al icono, con respuesta táctil al clic */}
        <motion.div
          whileTap={{ scale: 0.88, y: 2 }}
          transition={{ type: 'spring', stiffness: 500, damping: 25 }}
          style={{ scale, y: lift, width: Math.max(28, iconSize - 4), height: Math.max(28, iconSize - 4), transformOrigin: '50% 100%' }}
          className="relative flex items-center justify-center will-change-transform pointer-events-auto"
        >
          <IconGlyph icon={icon} name={name} />

          <AnimatePresence>
            {badgeCount > 0 && (
              <motion.span
                key="badge"
                initial={{ scale: 0 }}
                animate={{ scale: 1 }}
                exit={{ scale: 0 }}
                transition={{ type: 'spring', stiffness: 500, damping: 22 }}
                className="absolute -top-1 -right-1 bg-[var(--accent-color)] text-white text-[10px] font-semibold leading-4 min-w-4 text-center rounded-full px-1.5 shadow-md ring-1 ring-black/30 pointer-events-none"
              >
                {badgeText}
              </motion.span>
            )}
          </AnimatePresence>
        </motion.div>
      </motion.div>

      {/* Indicadores de ejecución y Foco Vivo en la app activa de KWin */}
      <div className="h-2 mt-1 flex items-center justify-center pointer-events-none select-none">
        {isRunning && (() => {
          const count = windowCount !== undefined ? windowCount : 1;
          if (count <= 0) return null;

          if (isActive) {
            // APP CON FOCO ACTIVO: Barra LED viva que respira suavemente (Rojo Carmesí y Blanco)
            return (
              <div className="flex items-center justify-center gap-1.5">
                <motion.div
                  animate={{
                    opacity: [0.85, 1, 0.85],
                    scaleX: [0.94, 1.08, 0.94],
                    boxShadow: [
                      '0 0 8px 2px rgba(239,68,68,0.7), 0 0 3px rgba(255,255,255,0.9)',
                      '0 0 14px 4px rgba(239,68,68,0.95), 0 0 5px rgba(255,255,255,1)',
                      '0 0 8px 2px rgba(239,68,68,0.7), 0 0 3px rgba(255,255,255,0.9)',
                    ],
                  }}
                  transition={{
                    duration: 2.2,
                    repeat: Infinity,
                    ease: 'easeInOut',
                  }}
                  className="w-5 h-[3px] rounded-full bg-gradient-to-r from-[#EF4444] via-white to-[#EF4444]"
                />
                {count > 1 && (
                  <div className="flex items-center gap-1">
                    {Array.from({ length: Math.min(count - 1, 2) }).map((_, i) => (
                      <div
                        key={i}
                        className="w-[3px] h-[3px] rounded-full bg-white/45 shadow-[0_0_2px_rgba(255,255,255,0.3)]"
                      />
                    ))}
                    {count > 3 && (
                      <span className="text-[7px] text-white/40 font-bold leading-none select-none">
                        +
                      </span>
                    )}
                  </div>
                )}
              </div>
            );
          }

          // APPS EN SEGUNDO PLANO (SIN FOCO): Puntos discretos y nítidos
          const dotSize =
            count === 1
              ? 'w-1 h-1'
              : count === 2
              ? 'w-[3.5px] h-[3.5px]'
              : 'w-[3px] h-[3px]';
          const gap = count === 1 ? 'gap-0' : count === 2 ? 'gap-1.5' : 'gap-1';
          const displayDots = Math.min(count, 3);

          return (
            <div className={`flex items-center justify-center ${gap}`}>
              {Array.from({ length: displayDots }).map((_, i) => (
                <div
                  key={i}
                  className={`rounded-full transition-all duration-200 ${dotSize} bg-white/70 shadow-[0_0_3px_rgba(255,255,255,0.4)]`}
                />
              ))}
              {count > 3 && (
                <span className="text-[7.5px] text-white/40 font-bold leading-none select-none -ml-0.5">
                  +
                </span>
              )}
            </div>
          );
        })()}
      </div>
    </div>
  );
};

export const DockItem = DockIcon;
