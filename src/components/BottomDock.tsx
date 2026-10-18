import React, { useRef, useState, useEffect, useCallback, useMemo } from 'react';
import { motion, AnimatePresence, useMotionValue } from 'framer-motion';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWebview } from '@tauri-apps/api/webview';
import { useOpenWindows, type OpenWindow } from '../hooks/useOpenWindows';
import { useSystemApps } from '../hooks/useSystemApps';
import { useMediaSession } from '../hooks/useMediaSession';
import { useVisualSettings } from '../hooks/useVisualSettings';
import { DockItem, DOCK_ICON_SIZE, DOCK_ICON_GAP } from './DockIcon';
import { EnigmaLauncher } from './EnigmaLauncher';
import { WindowPreviewPopover } from './WindowPreviewPopover';

// =========================================================================
// MODELO DE DATOS
// =========================================================================
export type AppItem = {
  id: string;
  name: string;
  /** Ruta absoluta a SVG/PNG, URL, o clave de marca de IconMapper */
  icon: string;
  /** Comando de terminal */
  exec: string;
  isPinned: boolean;
  isRunning: boolean;
  /** Globo de notificaciones */
  badgeCount?: number;
  /** Animación de lanzamiento activa */
  isBouncing?: boolean;
  /** Nombre del ejecutable para force quit */
  processName?: string;
  /** Ventana KWin asociada (si está abierta) */
  windowId?: string;
  isActive?: boolean;
  /** Lista de ventanas abiertas asociadas a esta app */
  windows?: OpenWindow[];
};

export interface RunningApp {
  window_id: string;
  app_name: string;
  window_class: string;
  icon: string;
  title: string;
  is_active: boolean;
}

type PinnedApp = Pick<AppItem, 'id' | 'name' | 'icon' | 'exec'>;

const DEFAULT_PINNED: PinnedApp[] = [
  { id: 'konsole', name: 'Terminal', icon: 'terminal', exec: 'konsole' },
  { id: 'opera', name: 'Opera', icon: 'opera', exec: 'opera' },
  { id: 'antigravity', name: 'Antigravity IDE', icon: 'antigravity', exec: 'antigravity-ide' },
  { id: 'dolphin', name: 'Archivos', icon: 'dolphin', exec: 'dolphin' },
  { id: 'discord', name: 'Discord', icon: 'discord', exec: 'discord' },
  { id: 'spotify', name: 'Spotify', icon: 'spotify', exec: 'spotify' },
  { id: 'systemsettings', name: 'Ajustes', icon: 'settings', exec: 'systemsettings' },
];

/** Claves para emparejar una app fijada con ventanas abiertas */
function matchKeysFor(app: PinnedApp): string[] {
  const execBin = (app.exec.trim().split(/\s+/)[0] || '').split('/').pop() || '';
  return Array.from(new Set([app.id, app.icon, execBin].map(k => k.toLowerCase()).filter(k => k.length >= 3)));
}

function windowMatches(win: OpenWindow | RunningApp, keys: string[]): boolean {
  const hay = [win.window_class, win.app_name, win.icon].map(s => (s || '').toLowerCase()).filter(Boolean);
  return keys.some(k => hay.some(h => h.includes(k)));
}

function processNameFor(app: Pick<AppItem, 'exec' | 'id' | 'processName'>): string {
  if (app.processName) return app.processName;
  return (app.exec.trim().split(/\s+/)[0] || '').split('/').pop() || app.id;
}

const IDLE_WIDTH = 100;
const IDLE_HEIGHT = 10;
const DOCK_HEIGHT = 68;
const BOTTOM_MARGIN = 12;
const BOUNCE_DURATION_MS = 1000;

export const BottomDock: React.FC = () => {
  const dockRef = useRef<HTMLDivElement>(null);
  const [isHovered, setIsHovered] = useState(false);
  const isHoveredRef = useRef(false);
  const [hoveredAppId, setHoveredAppId] = useState<string | null>(null);

  // Estado del Enigma Launcher (Menú de Inicio Propio)
  const [isLauncherOpen, setIsLauncherOpen] = useState(false);
  const isLauncherOpenRef = useRef(false);
  isLauncherOpenRef.current = isLauncherOpen;

  const leaveTimerRef = useRef<number | null>(null);
  const collapseTimerRef = useRef<number | null>(null);
  const lastDockRegionsKeyRef = useRef<string>('');

  const { windows, refreshWindows } = useOpenWindows();
  const { apps, launchApp } = useSystemApps();
  const { media, playPause, nextTrack } = useMediaSession();
  const { settings: visualSettings } = useVisualSettings();

  // Posición X del ratón para el efecto lupa (Infinity = sin lupa)
  const mouseX = useMotionValue(Infinity);

  // Menú contextual activo por id de aplicación
  const [contextMenuAppId, setContextMenuAppId] = useState<string | null>(null);
  const contextMenuAppIdRef = useRef<string | null>(null);
  contextMenuAppIdRef.current = contextMenuAppId;

  // Previsualizaciones flotantes translúcidas de ventanas por id de aplicación
  const [activePreviewAppId, setActivePreviewAppId] = useState<string | null>(null);
  const activePreviewAppIdRef = useRef<string | null>(null);
  activePreviewAppIdRef.current = activePreviewAppId;
  const previewTimerRef = useRef<number | null>(null);
  const previewLeaveTimerRef = useRef<number | null>(null);

  // Estado volátil por app: rebotes, badges y cierres forzados
  const [bouncingIds, setBouncingIds] = useState<Set<string>>(() => new Set());
  const [badges, setBadges] = useState<Record<string, number>>({});
  const [quitIds, setQuitIds] = useState<Set<string>>(() => new Set());
  const bounceTimersRef = useRef<Record<string, number>>({});

  // Badges: eventos emitidos desde el backend
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    listen<{ id: string; count: number }>('dock_badge', (e) => {
      const { id, count } = e.payload;
      setBadges(prev => ({ ...prev, [id]: Math.max(0, count | 0) }));
    }).then(u => { unlisten = u; }).catch(() => {});
    return () => { if (unlisten) unlisten(); };
  }, []);

  // =========================================================================
  // MONITOR DE PROCESOS Y APLICACIONES DINÁMICAS (Rust Backend)
  // =========================================================================
  const [runningProcesses, setRunningProcesses] = useState<string[]>([]);
  const [runningAppsFromRust, setRunningAppsFromRust] = useState<RunningApp[]>([]);

  useEffect(() => {
    let unlistenProcs: (() => void) | undefined;
    let unlistenApps: (() => void) | undefined;

    listen<string[]>('running-processes-update', (e) => {
      if (Array.isArray(e.payload)) {
        setRunningProcesses(e.payload);
      }
    }).then(u => { unlistenProcs = u; }).catch(() => {});

    listen<RunningApp[]>('running-apps-update', (e) => {
      if (Array.isArray(e.payload)) {
        setRunningAppsFromRust(e.payload);
      }
    }).then(u => { unlistenApps = u; }).catch(() => {});

    return () => {
      if (unlistenProcs) unlistenProcs();
      if (unlistenApps) unlistenApps();
    };
  }, []);

  // =========================================================================
  // ESTADO: APPS FIJADAS (persistidas en ~/.config/enigmaos/dock.json)
  // =========================================================================
  const [pinned, setPinned] = useState<PinnedApp[]>(DEFAULT_PINNED);

  useEffect(() => {
    invoke<{ pinned: PinnedApp[] } | null>('load_dock_config')
      .then(cfg => {
        if (cfg && Array.isArray(cfg.pinned)) setPinned(cfg.pinned);
      })
      .catch(() => {});
  }, []);

  const persistPinned = useCallback((next: PinnedApp[]) => {
    setPinned(next);
    invoke('save_dock_config', { config: { pinned: next } }).catch(err =>
      console.warn('[BottomDock] Error guardando configuración:', err)
    );
  }, []);

  // =========================================================================
  // SECTORIZACIÓN DINÁMICA 100% REAL (SIN MOCK DATA)
  // Pinned Apps vs Running Unpinned Apps
  // =========================================================================
  const { pinnedApps, runningUnpinnedApps } = useMemo(() => {
    const claimedWindowIds = new Set<string>();
    const claimedClasses = new Set<string>();

    // 1. Sector de Pinned Apps
    const pinnedList: AppItem[] = pinned.map(p => {
      const keys = matchKeysFor(p);
      const wins = windows.filter(w => windowMatches(w, keys));
      wins.forEach(w => {
        claimedWindowIds.add(w.id);
        if (w.window_class) claimedClasses.add(w.window_class.toLowerCase());
      });

      const active = wins.find(w => w.is_active);
      const procName = processNameFor(p);

      const execLower = p.exec.toLowerCase();
      const execBin = (p.exec.trim().split(/\s+/)[0] || '').split('/').pop()?.toLowerCase() || '';
      const nameLower = p.name.toLowerCase();

      // Detección Inteligente de Procesos (Fuzzy Matching con includes)
      const isProcessRunning = runningProcesses.some(process => {
        const procLower = process.toLowerCase();
        return (
          procLower.includes(execLower) ||
          execLower.includes(procLower) ||
          (execBin && (procLower.includes(execBin) || execBin.includes(procLower))) ||
          (nameLower && (procLower.includes(nameLower) || nameLower.includes(procLower)))
        );
      });

      const isRunning = isProcessRunning || wins.length > 0;

      return {
        ...p,
        processName: procName,
        isPinned: true,
        isRunning,
        windowId: (active ?? wins[0])?.id,
        isActive: Boolean(active),
        badgeCount: badges[p.id] ?? 0,
        isBouncing: bouncingIds.has(p.id),
        windows: wins,
      };
    });

    // 2. Sector de Running Unpinned Apps (100% Dinámico, sin datos quemados)
    // Combina las ventanas de KWin y la lista emitida por Rust
    const sourceApps = runningAppsFromRust.length > 0 ? runningAppsFromRust : windows;
    const seenDynamicClasses = new Set<string>();
    const unpinnedList: AppItem[] = [];

    for (const w of sourceApps) {
      const wid = 'id' in w ? w.id : w.window_id;
      if (claimedWindowIds.has(wid)) continue;

      const cls = (w.window_class || w.app_name || wid).toLowerCase();
      if (claimedClasses.has(cls) || seenDynamicClasses.has(cls)) continue;
      seenDynamicClasses.add(cls);

      // Intentar vincular con .desktop del sistema para el comando Exec
      const desktop = apps.find(a =>
        a.id.toLowerCase().includes(cls) ||
        a.name.toLowerCase() === (w.app_name || '').toLowerCase()
      );

      const sameClassWins = windows.filter(x => (x.window_class || x.app_name || x.id).toLowerCase() === cls);
      const active = sameClassWins.find(x => x.is_active);

      unpinnedList.push({
        id: cls,
        name: w.app_name || desktop?.name || w.title,
        icon: w.window_class || w.icon || cls,
        exec: desktop?.exec || cls,
        isPinned: false,
        isRunning: true,
        windowId: (active ?? sameClassWins[0])?.id || wid,
        isActive: Boolean(active),
        badgeCount: badges[cls] ?? 0,
        isBouncing: bouncingIds.has(cls),
        windows: sameClassWins,
      });
    }

    const filteredPinned = pinnedList.map(a =>
      quitIds.has(a.id) ? { ...a, isRunning: false, isActive: false, windowId: undefined } : a
    );

    const filteredUnpinned = unpinnedList
      .map(a => (quitIds.has(a.id) ? { ...a, isRunning: false, isActive: false, windowId: undefined } : a))
      .filter(a => a.isRunning);

    return {
      pinnedApps: filteredPinned,
      runningUnpinnedApps: filteredUnpinned,
    };
  }, [pinned, windows, runningAppsFromRust, apps, quitIds, badges, bouncingIds, runningProcesses]);

  const allApps = useMemo(() => [...pinnedApps, ...runningUnpinnedApps], [pinnedApps, runningUnpinnedApps]);

  // Anchura calculada de la Command Center sectorizada:
  // [Start Button (dinámico)] + [Sep 1 (18px)] + [Pinned Apps] + [Divider (10px si hay unpinned)] + [Unpinned Apps] + [Sep 2 (18px)] + [Music Widget (190px)] + Paddings
  const expandedWidth = useMemo(() => {
    const totalApps = pinnedApps.length + runningUnpinnedApps.length;
    const currentIconSize = visualSettings.dock_size || DOCK_ICON_SIZE;
    const appsWidth = totalApps * currentIconSize + Math.max(0, totalApps - 1) * DOCK_ICON_GAP;
    const startWidth = currentIconSize;
    const sepWidth = 2 * 18;
    const dividerWidth = runningUnpinnedApps.length > 0 ? 12 : 0;
    const musicWidth = 190;
    const paddingAndGaps = 32 + 32;

    return Math.max(680, startWidth + sepWidth + appsWidth + dividerWidth + musicWidth + paddingAndGaps);
  }, [pinnedApps.length, runningUnpinnedApps.length, visualSettings.dock_size]);

  // =========================================================================
  // HITBOX DINÁMICA DE WAYLAND LAYER SHELL (CAIRO/GDK)
  // Calculada limpiamente por estado objetivo (Cero spam por frame)
  // =========================================================================
  const updateHardwareRegions = useCallback(() => {
    try {
      const dpr = window.devicePixelRatio || 1;
      const screenW = window.innerWidth || 2560;
      const screenH = window.innerHeight || 600;
      const centerX = screenW / 2;

      let regions: [number, number, number, number][] = [];

      // Modo reposo: pastilla mini dock (hitbox milimétrica al borde inferior de la pantalla)
      // Decisión basada SOLO en estado (refs), nunca en nodos DOM que siguen montados durante animaciones de salida
      // Modo reposo: pastilla mini dock (hitbox milimétrica al borde inferior de la pantalla)
      // Si el cursor no está sobre el dock y el launcher no está abierto,
      // el dock ESTÁ EN REPOSO: la hitbox DEBE SER ESTRICTAMENTE la pastilla mini dock.
      const launcherOpen = isLauncherOpenRef.current;
      const menuOpen = !!contextMenuAppIdRef.current;
      if (!isHoveredRef.current && !launcherOpen && !menuOpen) {
        const idleX = centerX - IDLE_WIDTH / 2;
        const idleY = screenH - BOTTOM_MARGIN - IDLE_HEIGHT;
        const x = Math.round(idleX * dpr);
        const y = Math.round(idleY * dpr);
        const w = Math.round(IDLE_WIDTH * dpr);
        const h = Math.round((screenH - idleY) * dpr);
        regions = [[x, y, w, h]];
      } else {
        // Modo expandido: calcular caja contenedora del Dock y Launcher / Menú / Previews
        const previewOpen = !!activePreviewAppIdRef.current;
        let minLeft = centerX - expandedWidth / 2;
        let maxRight = centerX + expandedWidth / 2;
        let minTop = screenH - BOTTOM_MARGIN - DOCK_HEIGHT - 30;
        let maxBottom = screenH;

        if (launcherOpen) {
          minTop = Math.min(minTop, screenH - BOTTOM_MARGIN - DOCK_HEIGHT - 560);
          maxRight = Math.max(maxRight, minLeft + 720);
        }

        if (menuOpen) {
          minTop = Math.min(minTop, screenH - BOTTOM_MARGIN - DOCK_HEIGHT - 480);
        }

        if (previewOpen) {
          minTop = Math.min(minTop, screenH - BOTTOM_MARGIN - DOCK_HEIGHT - 380);
          minLeft = Math.min(minLeft, centerX - 560);
          maxRight = Math.max(maxRight, centerX + 560);
        }

        const x = Math.max(0, Math.round((minLeft - 30) * dpr));
        const y = Math.max(0, Math.round((minTop - 20) * dpr));
        const w = Math.round((maxRight - minLeft + 60) * dpr);
        const h = Math.round((maxBottom - minTop + 25) * dpr);
        regions = [[x, y, w, h]];
      }

      const key = JSON.stringify(regions);
      if (lastDockRegionsKeyRef.current === key) {
        return;
      }
      lastDockRegionsKeyRef.current = key;

      invoke('update_custom_input_regions', { regions }).catch(() => {
        lastDockRegionsKeyRef.current = '';
      });
    } catch (err) {
      console.warn('[BottomDock] Error applying hardware input regions:', err);
    }
  }, [expandedWidth]);

  // Sincronización limpia en cambios de estado y resize (sin observadores por frame)
  useEffect(() => {
    updateHardwareRegions();
    // Re-sincronizar tras las animaciones de salida (AnimatePresence / spring) por seguridad
    const t1 = window.setTimeout(updateHardwareRegions, 150);
    const t2 = window.setTimeout(updateHardwareRegions, 350);
    window.addEventListener('resize', updateHardwareRegions);
    return () => {
      window.clearTimeout(t1);
      window.clearTimeout(t2);
      window.removeEventListener('resize', updateHardwareRegions);
    };
  }, [updateHardwareRegions, isHovered, isLauncherOpen, contextMenuAppId, activePreviewAppId]);

  // Modo interactivo de teclado exclusivo al abrir el Launcher
  useEffect(() => {
    if (isLauncherOpen) {
      invoke('set_keyboard_interactivity', { enabled: true, reason: 'enigma_launcher' }).catch(() => {});
    } else {
      invoke('set_keyboard_interactivity', { enabled: false, reason: 'enigma_launcher_closed' }).catch(() => {});
    }
  }, [isLauncherOpen]);

  // =========================================================================
  // HOVER & EXPANSION CONTROL
  // =========================================================================
  const handleMouseEnter = useCallback(() => {
    if (leaveTimerRef.current) {
      window.clearTimeout(leaveTimerRef.current);
      leaveTimerRef.current = null;
    }
    if (collapseTimerRef.current) {
      window.clearTimeout(collapseTimerRef.current);
      collapseTimerRef.current = null;
    }

    isHoveredRef.current = true;
    setIsHovered(true);
    updateHardwareRegions();
  }, [updateHardwareRegions]);

  const handleMouseLeave = useCallback(() => {
    if (previewTimerRef.current) {
      window.clearTimeout(previewTimerRef.current);
      previewTimerRef.current = null;
    }
    if (previewLeaveTimerRef.current) {
      window.clearTimeout(previewLeaveTimerRef.current);
      previewLeaveTimerRef.current = null;
    }
    // Al salir del dock, cerrar vistas previas inmediatamente en refs y en estado
    activePreviewAppIdRef.current = null;
    setActivePreviewAppId(null);

    // Si el launcher está abierto, no auto-ocultar el dock
    if (isLauncherOpenRef.current) return;

    if (leaveTimerRef.current) {
      window.clearTimeout(leaveTimerRef.current);
    }

    leaveTimerRef.current = window.setTimeout(() => {
      if (isLauncherOpenRef.current) return;
      isHoveredRef.current = false;
      contextMenuAppIdRef.current = null;
      activePreviewAppIdRef.current = null;
      setIsHovered(false);
      setHoveredAppId(null);
      setContextMenuAppId(null);
      setActivePreviewAppId(null);
      mouseX.set(Infinity);

      // Inmediatamente restaurar el hitbox al modo reposo para que no bloquee clics en ventanas detrás
      updateHardwareRegions();
    }, Math.max(180, visualSettings.autohide_delay_ms || 180));
  }, [updateHardwareRegions, mouseX, visualSettings.autohide_delay_ms]);

  // Escuchar cuando el puntero sale de la ventana a nivel de hardware (GTK Wayland) con ventana de gracia
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    listen('dock_pointer_leave', () => {
      handleMouseLeave();
    }).then((fn) => {
      unlisten = fn;
    });

    return () => {
      if (unlisten) unlisten();
    };
  }, [handleMouseLeave]);

  // Cerrar menú con clic fuera o Escape
  useEffect(() => {
    if (!contextMenuAppId) return;
    const onDown = (e: PointerEvent) => {
      if (!(e.target as HTMLElement).closest('#dock-context-menu')) {
        contextMenuAppIdRef.current = null;
        setContextMenuAppId(null);
        updateHardwareRegions();
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        contextMenuAppIdRef.current = null;
        setContextMenuAppId(null);
        updateHardwareRegions();
      }
    };
    document.addEventListener('pointerdown', onDown, true);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDown, true);
      document.removeEventListener('keydown', onKey);
    };
  }, [contextMenuAppId, updateHardwareRegions]);

  // Cerrar el launcher al hacer clic fuera del launcher y del botón start
  useEffect(() => {
    if (!isLauncherOpen) return;
    const onDown = (e: PointerEvent) => {
      const target = e.target as HTMLElement;
      if (!target.closest('#enigma-launcher') && !target.closest('#enigma-start-btn')) {
        isLauncherOpenRef.current = false;
        setIsLauncherOpen(false);
        updateHardwareRegions();
      }
    };
    document.addEventListener('pointerdown', onDown, true);
    return () => {
      document.removeEventListener('pointerdown', onDown, true);
    };
  }, [isLauncherOpen, updateHardwareRegions]);

  // =========================================================================
  // ACCIONES Y TASK MANAGEMENT
  // =========================================================================
  const launch = useCallback((app: AppItem) => {
    invoke('launch_app', { execCommand: app.exec }).catch(err =>
      console.warn('[BottomDock] launch_app falló:', err)
    );
  }, []);

  const stopBounce = useCallback((id: string) => {
    if (bounceTimersRef.current[id]) {
      window.clearTimeout(bounceTimersRef.current[id]);
      delete bounceTimersRef.current[id];
    }
    setBouncingIds(prev => {
      if (!prev.has(id)) return prev;
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
  }, []);

  const startBounce = useCallback((id: string) => {
    setBouncingIds(prev => new Set(prev).add(id));
    if (bounceTimersRef.current[id]) window.clearTimeout(bounceTimersRef.current[id]);
    bounceTimersRef.current[id] = window.setTimeout(() => stopBounce(id), BOUNCE_DURATION_MS);
  }, [stopBounce]);

  useEffect(() => {
    allApps.forEach(a => { if (a.isBouncing && a.isRunning) stopBounce(a.id); });
  }, [allApps, stopBounce]);

  useEffect(() => () => {
    Object.values(bounceTimersRef.current).forEach(t => window.clearTimeout(t));
  }, []);

  // Clic en Start Button: Conmuta el Enigma Launcher interno (Sin llamadas a KDE)
  const handleStartClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    setIsLauncherOpen((prev) => !prev);
  }, []);

  // Task Switching (Cambio de Tareas):
  // Si isRunning es true -> focus_window({ appName: app.name }); si no -> lanzar con rebote
  const handleItemClick = useCallback((app: AppItem) => {
    setContextMenuAppId(null);
    if (app.isRunning) {
      invoke('focus_window', { appName: app.name }).catch(err => {
        console.warn('[BottomDock] focus_window falló:', err);
      });
    } else {
      startBounce(app.id);
      launch(app);
    }
  }, [launch, startBounce]);

  // Gestión de Previsualizaciones de Ventanas Flotantes
  const handleFocusWindow = useCallback((windowId: string) => {
    setActivePreviewAppId(null);
    invoke('focus_window', { id: windowId }).catch(() => {});
  }, []);

  const handleCloseWindow = useCallback((windowId: string) => {
    invoke('close_window_cleanly', { id: windowId })
      .then(() => {
        refreshWindows();
      })
      .catch(err => {
        console.warn('[BottomDock] Error cerrando ventana:', err);
      });
  }, [refreshWindows]);

  const handleAppHover = useCallback((app: AppItem) => {
    setHoveredAppId(app.id);

    if (previewLeaveTimerRef.current) {
      window.clearTimeout(previewLeaveTimerRef.current);
      previewLeaveTimerRef.current = null;
    }

    const delay = activePreviewAppId ? 50 : 150;
    if (app.windows && app.windows.length > 0 && !contextMenuAppId) {
      if (activePreviewAppId !== app.id) {
        if (previewTimerRef.current) window.clearTimeout(previewTimerRef.current);
        previewTimerRef.current = window.setTimeout(() => {
          setActivePreviewAppId(app.id);
          updateHardwareRegions();
        }, delay);
      }
    } else {
      if (previewTimerRef.current) window.clearTimeout(previewTimerRef.current);
      setActivePreviewAppId(null);
    }
  }, [contextMenuAppId, activePreviewAppId, updateHardwareRegions]);

  // Reordenación y Drag & Drop interno de aplicaciones ancladas
  const [draggedPinnedIndex, setDraggedPinnedIndex] = useState<number | null>(null);
  const [dragOverPinnedIndex, setDragOverPinnedIndex] = useState<number | null>(null);

  const movePinned = useCallback((fromIndex: number, toIndex: number) => {
    if (fromIndex < 0 || fromIndex >= pinned.length || toIndex < 0 || toIndex >= pinned.length || fromIndex === toIndex) return;
    const next = [...pinned];
    const [moved] = next.splice(fromIndex, 1);
    next.splice(toIndex, 0, moved);
    persistPinned(next);
  }, [pinned, persistPinned]);

  const handleDragStartPinned = (index: number, e: React.DragEvent<HTMLDivElement>) => {
    e.dataTransfer.setData('text/x-dock-index', String(index));
    e.dataTransfer.effectAllowed = 'move';
    setDraggedPinnedIndex(index);
    setContextMenuAppId(null);
  };

  const handleDragOverPinned = (index: number, e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    if (draggedPinnedIndex !== null && draggedPinnedIndex !== index) {
      setDragOverPinnedIndex(index);
    }
  };

  const handleDragLeavePinned = (index: number) => {
    if (dragOverPinnedIndex === index) {
      setDragOverPinnedIndex(null);
    }
  };

  const handleDropPinned = (toIndex: number, e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    const rawFrom = e.dataTransfer.getData('text/x-dock-index');
    const fromIndex = parseInt(rawFrom, 10);
    if (!isNaN(fromIndex) && fromIndex !== toIndex) {
      movePinned(fromIndex, toIndex);
    }
    setDraggedPinnedIndex(null);
    setDragOverPinnedIndex(null);
  };

  const handleDragEndPinned = () => {
    setDraggedPinnedIndex(null);
    setDragOverPinnedIndex(null);
  };

  // Controles de ventana nativos Wayland vía KWin D-Bus
  const minimizeWindow = useCallback((app: AppItem) => {
    setContextMenuAppId(null);
    const targetId = app.windowId || app.id;
    invoke('minimize_window', { id: targetId })
      .then(() => setTimeout(refreshWindows, 350))
      .catch(err => console.warn('[BottomDock] minimize_window falló:', err));
  }, [refreshWindows]);

  const maximizeWindow = useCallback((app: AppItem) => {
    setContextMenuAppId(null);
    const targetId = app.windowId || app.id;
    invoke('maximize_window', { id: targetId })
      .then(() => setTimeout(refreshWindows, 350))
      .catch(err => console.warn('[BottomDock] maximize_window falló:', err));
  }, [refreshWindows]);

  const closeWindow = useCallback((app: AppItem) => {
    setContextMenuAppId(null);
    const targetId = app.windowId || app.id;
    invoke('close_window_cleanly', { id: targetId })
      .then(() => {
        setTimeout(refreshWindows, 400);
      })
      .catch(err => {
        console.warn('[BottomDock] close_window_cleanly falló:', err);
        forceQuit(app);
      });
  }, [refreshWindows]);

  const newWindow = useCallback((app: AppItem) => {
    setContextMenuAppId(null);
    startBounce(app.id);
    launch(app);
  }, [launch, startBounce]);

  const forceQuit = useCallback((app: AppItem) => {
    setContextMenuAppId(null);
    const procName = processNameFor(app);
    invoke<boolean>('force_quit', { processName: procName })
      .then(killed => {
        if (!killed) return;
        setQuitIds(prev => new Set(prev).add(app.id));
        window.setTimeout(() => {
          setQuitIds(prev => { const n = new Set(prev); n.delete(app.id); return n; });
          refreshWindows();
        }, 3000);
      })
      .catch(err => console.warn('[BottomDock] force_quit falló:', err));
  }, [refreshWindows]);

  const togglePin = useCallback((app: AppItem) => {
    if (app.isPinned) {
      persistPinned(pinned.filter(p => p.id !== app.id));
    } else {
      persistPinned([...pinned, { id: app.id, name: app.name, icon: app.icon, exec: app.exec }]);
    }
    setContextMenuAppId(null);
  }, [pinned, persistPinned]);

  // Arrastrar y Soltar (Drag & Drop de Archivos)
  const handleDropFile = useCallback((app: AppItem, filePath: string) => {
    if (!filePath) return;
    if (!app.isRunning) startBounce(app.id);
    invoke('open_file', { exec: app.exec, path: filePath }).catch(err => {
      console.warn('[BottomDock] open_file falló:', err);
    });
  }, [startBounce]);

  // Soporte de Tauri Native Drag & Drop
  const allAppsRef = useRef(allApps);
  allAppsRef.current = allApps;
  const dndHandlersRef = useRef({ handleMouseEnter, handleMouseLeave, handleDropFile });
  dndHandlersRef.current = { handleMouseEnter, handleMouseLeave, handleDropFile };

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    getCurrentWebview().onDragDropEvent((event) => {
      const h = dndHandlersRef.current;
      const dpr = window.devicePixelRatio || 1;
      const p = event.payload;

      if (p.type === 'enter') {
        h.handleMouseEnter();
        return;
      }
      if (p.type === 'over') {
        const x = p.position.x / dpr;
        mouseX.set(x);
        return;
      }
      if (p.type === 'drop') {
        const x = p.position.x / dpr;
        const y = p.position.y / dpr;
        const nodes = document.querySelectorAll<HTMLElement>('[data-dock-app-id]');
        let targetId: string | null = null;
        for (const node of nodes) {
          const r = node.getBoundingClientRect();
          if (x >= r.left - DOCK_ICON_GAP / 2 && x <= r.right + DOCK_ICON_GAP / 2 && y >= r.top - 40 && y <= r.bottom + 12) {
            targetId = node.dataset.dockAppId ?? null;
            break;
          }
        }
        if (targetId && p.paths && p.paths.length > 0) {
          const targetApp = allAppsRef.current.find(a => a.id === targetId);
          if (targetApp) {
            p.paths.forEach(filePath => h.handleDropFile(targetApp, filePath));
          }
        }
      }

      mouseX.set(Infinity);
      setHoveredAppId(null);
      h.handleMouseLeave();
    }).then(u => { unlisten = u; }).catch(() => {});
    return () => { if (unlisten) unlisten(); };
  }, [mouseX]);

  // =========================================================================
  // RENDER: MENÚ CONTEXTUAL AISLADO (Obsidiana + Carmesí #b82a2a)
  // =========================================================================
  const renderContextMenu = (app: AppItem, pinnedIdx: number) => (
    <div
      id="dock-context-menu"
      className="absolute bottom-full mb-3.5 left-1/2 -translate-x-1/2 neu-chassis rounded-2xl p-2 z-[100] text-xs text-white min-w-[195px] flex flex-col gap-0.5 select-none"
      onClick={(e) => e.stopPropagation()}
      onPointerDown={(e) => e.stopPropagation()}
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
      }}
    >
      {/* Título de la app */}
      <div className="px-2.5 py-1 text-[10px] font-semibold tracking-wider text-white/50 uppercase truncate border-b border-red-950/40 mb-0.5">
        {app.name}
      </div>

      {/* Abrir o Traer al frente */}
      <button
        type="button"
        onClick={() => {
          setContextMenuAppId(null);
          if (app.isRunning) {
            invoke('focus_window', { appName: app.name, id: app.windowId }).catch(() => {});
          } else {
            startBounce(app.id);
            launch(app);
          }
        }}
        className="flex items-center gap-2.5 hover:bg-white/10 rounded-lg px-2.5 py-1.5 text-left transition-colors font-medium text-white/90"
      >
        <svg className="w-3.5 h-3.5 text-white/70" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <polyline points="15 3 21 3 21 9" />
          <line x1="10" y1="14" x2="21" y2="3" />
          <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
        </svg>
        <span>{app.isRunning ? 'Traer al Frente' : 'Abrir'}</span>
      </button>

      {/* Acciones de ventana cuando está corriendo */}
      {app.isRunning && (
        <>
          <button
            type="button"
            onClick={() => minimizeWindow(app)}
            className="flex items-center gap-2.5 hover:bg-white/10 rounded-lg px-2.5 py-1.5 text-left transition-colors text-white/80"
          >
            <svg className="w-3.5 h-3.5 text-white/70" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <line x1="5" y1="12" x2="19" y2="12" />
            </svg>
            <span>Minimizar</span>
          </button>

          <button
            type="button"
            onClick={() => maximizeWindow(app)}
            className="flex items-center gap-2.5 hover:bg-white/10 rounded-lg px-2.5 py-1.5 text-left transition-colors text-white/80"
          >
            <svg className="w-3.5 h-3.5 text-white/70" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <rect x="3" y="3" width="18" height="18" rx="2" />
            </svg>
            <span>Maximizar / Restaurar</span>
          </button>

          <button
            type="button"
            onClick={() => newWindow(app)}
            className="flex items-center gap-2.5 hover:bg-white/10 rounded-lg px-2.5 py-1.5 text-left transition-colors text-white/80"
          >
            <svg className="w-3.5 h-3.5 text-white/70" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <line x1="12" y1="5" x2="12" y2="19" />
              <line x1="5" y1="12" x2="19" y2="12" />
            </svg>
            <span>Nueva Ventana</span>
          </button>
        </>
      )}

      {/* Organización del Dock (Mover y Anclar) */}
      <div className="h-px my-1 bg-red-950/40" />

      {app.isPinned && pinnedIdx >= 0 && (
        <>
          {pinnedIdx > 0 && (
            <button
              type="button"
              onClick={() => {
                setContextMenuAppId(null);
                movePinned(pinnedIdx, pinnedIdx - 1);
              }}
              className="flex items-center gap-2.5 hover:bg-white/5 rounded-lg px-2.5 py-1.5 text-left transition-colors text-white/80"
            >
              <svg className="w-3.5 h-3.5 text-white/70" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <polyline points="15 18 9 12 15 6" />
              </svg>
              <span>Mover a la Izquierda</span>
            </button>
          )}

          {pinnedIdx < pinned.length - 1 && (
            <button
              type="button"
              onClick={() => {
                setContextMenuAppId(null);
                movePinned(pinnedIdx, pinnedIdx + 1);
              }}
              className="flex items-center gap-2.5 hover:bg-white/5 rounded-lg px-2.5 py-1.5 text-left transition-colors text-white/80"
            >
              <svg className="w-3.5 h-3.5 text-white/70" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <polyline points="9 18 15 12 9 6" />
              </svg>
              <span>Mover a la Derecha</span>
            </button>
          )}
        </>
      )}

      <button
        type="button"
        onClick={() => togglePin(app)}
        className="flex items-center gap-2.5 hover:bg-white/5 rounded-lg px-2.5 py-1.5 text-left transition-colors text-white/80"
      >
        <svg className="w-3.5 h-3.5 text-white/70" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          {app.isPinned ? (
            <>
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </>
          ) : (
            <>
              <line x1="12" y1="5" x2="12" y2="19" />
              <line x1="5" y1="12" x2="19" y2="12" />
            </>
          )}
        </svg>
        <span>{app.isPinned ? 'Desanclar del Dock' : 'Anclar en el Dock'}</span>
      </button>

      {/* Cierre limpio y forzado si la app está en ejecución */}
      {app.isRunning && (
        <>
          <div className="h-px my-1 bg-red-950/40" />
          <button
            type="button"
            onClick={() => closeWindow(app)}
            className="flex items-center gap-2.5 text-white/80 hover:bg-white/5 rounded-lg px-2.5 py-1.5 text-left transition-colors"
          >
            <svg className="w-3.5 h-3.5 text-white/70" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="12" cy="12" r="10" />
              <line x1="15" y1="9" x2="9" y2="15" />
              <line x1="9" y1="9" x2="15" y2="15" />
            </svg>
            <span>Cerrar Ventana</span>
          </button>
          <button
            type="button"
            onClick={() => forceQuit(app)}
            className="flex items-center gap-2.5 text-[#EF4444] hover:bg-[#EF4444]/15 rounded-lg px-2.5 py-1.5 text-left transition-colors font-medium"
          >
            <svg className="w-3.5 h-3.5 text-[#EF4444]" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M18.36 6.64a9 9 0 1 1-12.73 0" />
              <line x1="12" y1="2" x2="12" y2="12" />
            </svg>
            <span>Forzar Cierre</span>
          </button>
        </>
      )}
    </div>
  );

  const renderItem = (app: AppItem, index: number, isPinnedGroup: boolean) => {
    const isMenuOpen = contextMenuAppId === app.id;
    const isDragOver = isPinnedGroup && draggedPinnedIndex !== null && draggedPinnedIndex !== index && dragOverPinnedIndex === index;

    return (
      <DockItem
        key={app.id}
        appId={app.id}
        name={app.name}
        icon={app.icon}
        isRunning={app.isRunning}
        isActive={app.isActive}
        windowCount={app.windows && app.windows.length > 0 ? app.windows.length : (app.isRunning ? 1 : 0)}
        iconSize={visualSettings.dock_size}
        magnifyMaxScale={visualSettings.magnify_scale}
        badgeCount={app.badgeCount}
        isBouncing={app.isBouncing}
        mouseX={mouseX}
        showTooltip={!isMenuOpen && hoveredAppId === app.id}
        isMenuOpen={isMenuOpen}
        contextMenu={renderContextMenu(app, isPinnedGroup ? index : -1)}
        draggable={isPinnedGroup}
        onDragStartItem={(e) => {
          if (isPinnedGroup) handleDragStartPinned(index, e);
        }}
        onDragOverItem={(e) => {
          if (isPinnedGroup) handleDragOverPinned(index, e);
        }}
        onDragLeaveItem={() => {
          if (isPinnedGroup) handleDragLeavePinned(index);
        }}
        onDropItem={(e) => {
          if (isPinnedGroup) handleDropPinned(index, e);
        }}
        onDragEndItem={handleDragEndPinned}
        isDragOverTarget={isDragOver}
        onHover={() => handleAppHover(app)}
        windowPreviews={
          activePreviewAppId === app.id && app.windows && app.windows.length > 0 ? (
            <WindowPreviewPopover
              windows={app.windows}
              appIcon={app.icon}
              appName={app.name}
              onFocus={handleFocusWindow}
              onClose={handleCloseWindow}
              onMouseEnter={() => {
                if (previewLeaveTimerRef.current) {
                  window.clearTimeout(previewLeaveTimerRef.current);
                  previewLeaveTimerRef.current = null;
                }
              }}
              onMouseLeave={() => {
                if (previewLeaveTimerRef.current) window.clearTimeout(previewLeaveTimerRef.current);
                previewLeaveTimerRef.current = window.setTimeout(() => {
                  setActivePreviewAppId(null);
                  updateHardwareRegions();
                }, 220);
              }}
            />
          ) : undefined
        }
        onClick={() => handleItemClick(app)}
        onContextMenu={(e) => {
          e.preventDefault();
          e.stopPropagation();
          mouseX.set(Infinity);
          setHoveredAppId(null);
          setActivePreviewAppId(null);
          setContextMenuAppId(app.id);
        }}
        onDropFiles={(paths) => {
          paths.forEach(p => handleDropFile(app, p));
        }}
      />
    );
  };

  const isPlaying = media.status === 'Playing';
  const songTitle = media.title || 'Unité';
  const songArtist = media.artist || 'Joshua Kyan Aalampour';

  return (
    <div
      id="dock-canvas"
      className="fixed inset-0 w-screen h-screen flex flex-col justify-end items-center pointer-events-none select-none overflow-visible pb-3"
      style={{ width: '100vw', height: '100vh', margin: 0, padding: 0, paddingBottom: `${BOTTOM_MARGIN}px` }}
    >
      {/* =========================================================================
          CONTENEDOR DEL DOCK ("COMMAND CENTER" SECTORIZADO)
          - Usa layout para transiciones fluidas de dimensiones
          - Fondo de cristal aislado para efecto cristal backdrop-blur general
          ========================================================================= */}
      <motion.div
        ref={dockRef}
        id="bottom-dock-container"
        layout
        onMouseEnter={handleMouseEnter}
        onMouseLeave={handleMouseLeave}
        initial={{
          width: IDLE_WIDTH,
          height: IDLE_HEIGHT,
          borderRadius: 9999,
        }}
        animate={{
          width: isHovered || isLauncherOpen ? expandedWidth : IDLE_WIDTH,
          height: isHovered || isLauncherOpen ? DOCK_HEIGHT : IDLE_HEIGHT,
          borderRadius: isHovered || isLauncherOpen ? 26 : 9999,
        }}
        transition={{
          type: 'spring',
          stiffness: 340,
          damping: 28,
          mass: 0.8,
        }}
        className="pointer-events-auto select-none relative flex items-center justify-center overflow-visible"
      >
        {/* Enigma Launcher Propio (emergente desde la esquina izquierda del dock hacia arriba) */}
        <EnigmaLauncher
          isOpen={isLauncherOpen}
          onClose={() => setIsLauncherOpen(false)}
          onLaunchApp={(app) => {
            launchApp(app);
          }}
        />

        {/* Fondo de chasis sólido neumórfico - CERO transparencias sucias */}
        <div
          className={`absolute inset-0 pointer-events-none transition-all duration-200 -z-10 ${
            isHovered || isLauncherOpen
              ? 'neu-chassis rounded-[26px]'
              : 'neu-chassis rounded-full'
          }`}
        />


        <AnimatePresence mode="wait">
          {!isHovered && !isLauncherOpen ? (
            /* Modo Reposo: Pastilla Mini-Dock */
            <motion.div
              key="mini-dock-pill"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.12 }}
              onClick={handleMouseEnter}
              className="w-full h-full flex items-center justify-center cursor-pointer"
            >
              <div className="w-14 h-1 neu-led-red rounded-full" />
            </motion.div>
          ) : (
            /* Modo Expandido: Command Center Sectorizado */
            <motion.div
              key="dock-command-center"
              initial={{ opacity: 0, scale: 0.96 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.96 }}
              transition={{ duration: 0.16 }}
              onMouseMove={(e) => {
                if (!contextMenuAppId) mouseX.set(e.clientX);
              }}
              onMouseLeave={() => {
                mouseX.set(Infinity);
                setHoveredAppId(null);
              }}
              className="flex items-center gap-2 px-3 overflow-visible"
            >
              {/* =================================================================
                  1. BOTÓN "START" (Extremo Izquierdo)
                  Botón físico extruido con cuadrícula de micro-LEDs en rojo
                  ================================================================= */}
              <button
                id="enigma-start-btn"
                type="button"
                onClick={handleStartClick}
                style={{ width: visualSettings.dock_size, height: visualSettings.dock_size }}
                className={`rounded-2xl flex items-center justify-center transition-all cursor-pointer flex-shrink-0 relative overflow-hidden active:scale-95 ${
                  isLauncherOpen
                    ? 'neu-inset border border-[#EF4444]'
                    : 'neu-extruded'
                }`}
                title="Enigma Launcher (Menú de Inicio)"
              >
                <div className="grid grid-cols-2 gap-1 p-2">
                  <div className="w-2.5 h-2.5 rounded-[2px] neu-led-red" />
                  <div className="w-2.5 h-2.5 rounded-[2px] neu-led-red" />
                  <div className="w-2.5 h-2.5 rounded-[2px] neu-led-red" />
                  <div className="w-2.5 h-2.5 rounded-[2px] neu-led-red" />
                </div>
              </button>

              {/* =================================================================
                  2. SEPARADOR ROJO 1 (Láser Carmesí Neumórfico)
                  ================================================================= */}
              <div className="w-[2px] h-7 bg-[#EF4444]/60 shadow-[0_0_8px_rgba(239,68,68,0.5)] rounded-full mx-1.5 flex-shrink-0" />

              {/* =================================================================
                  3. SECTORIZACIÓN DE APPS (Fijadas vs Abiertas)
                  ================================================================= */}
              <div className="flex items-end overflow-visible" style={{ gap: DOCK_ICON_GAP }}>
                {/* 3.1 Apps Fijadas */}
                {pinnedApps.map((app, index) => renderItem(app, index, true))}

                {/* Separador sutil solo si hay aplicaciones abiertas no fijadas */}
                {runningUnpinnedApps.length > 0 && (
                  <div className="w-[1.5px] h-6 bg-[#EF4444]/40 shadow-[0_0_4px_rgba(239,68,68,0.3)] mx-1 self-center rounded-full flex-shrink-0 pointer-events-none" />
                )}

                {/* 3.2 Apps Abiertas No Fijadas (100% dinámicas de KWin/Rust) */}
                {runningUnpinnedApps.map((app, index) => renderItem(app, index, false))}
              </div>

              {/* =================================================================
                  4. SEPARADOR ROJO 2 (Láser Carmesí Neumórfico)
                  ================================================================= */}
              <div className="w-[2px] h-7 bg-[#EF4444]/60 shadow-[0_0_8px_rgba(239,68,68,0.5)] rounded-full mx-1.5 flex-shrink-0" />

              {/* =================================================================
                  5. WIDGET DE SPOTIFY / MÚSICA (Cápsula Neumórfica Hundida "Inset")
                  ================================================================= */}
              <div
                onClick={() => {
                  invoke('focus_window', { appName: 'spotify' }).catch(() => {
                    invoke('launch_app', { execCommand: 'spotify' }).catch(() => {});
                  });
                }}
                className="group neu-inset rounded-2xl flex items-center gap-2.5 px-3 py-1.5 min-w-[170px] max-w-[220px] transition-all cursor-pointer flex-shrink-0 relative overflow-hidden select-none hover:border-[#EF4444]/50"
                title="Reproductor Multimedia (Clic para enfocar Spotify)"
              >
                {/* Mini disco rojo o carátula de álbum */}
                <div className="w-7 h-7 rounded-lg neu-inset flex items-center justify-center relative flex-shrink-0 overflow-hidden">
                  {media.art_url ? (
                    <img src={media.art_url} alt={songTitle} className="w-full h-full object-cover" />
                  ) : (
                    <div className="w-5 h-5 rounded-full border border-[#EF4444]/70 flex items-center justify-center">
                      <div className="w-2 h-2 rounded-full neu-led-red" />
                    </div>
                  )}
                </div>

                {/* Título y artista truncados en Blanco y Blanco tenue */}
                <div className="flex flex-col min-w-0 flex-1">
                  <span className="truncate text-xs font-semibold text-white leading-tight">{songTitle}</span>
                  <span className="truncate text-[10px] text-white/50 leading-tight">{songArtist}</span>
                </div>

                {/* Controles en Blanco Puro con botones físicos extruidos */}
                <div className="flex items-center gap-1.5 flex-shrink-0">
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      playPause();
                    }}
                    className="p-1.5 rounded-full text-white hover:text-[#EF4444] neu-extruded active:scale-90 transition-all cursor-pointer"
                    title={isPlaying ? 'Pausar' : 'Reproducir'}
                  >
                    {isPlaying ? (
                      <svg className="w-3 h-3 fill-current" viewBox="0 0 24 24">
                        <rect x="6" y="4" width="4" height="16" rx="1" />
                        <rect x="14" y="4" width="4" height="16" rx="1" />
                      </svg>
                    ) : (
                      <svg className="w-3 h-3 fill-current ml-0.5" viewBox="0 0 24 24">
                        <path d="M8 5v14l11-7z" />
                      </svg>
                    )}
                  </button>

                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      nextTrack();
                    }}
                    className="p-1.5 rounded-full text-white hover:text-[#EF4444] neu-extruded active:scale-90 transition-all cursor-pointer"
                    title="Siguiente pista"
                  >
                    <svg className="w-3 h-3 fill-current" viewBox="0 0 24 24">
                      <path d="M6 18l8.5-6L6 6v12zM16 6v12h2V6h-2z" />
                    </svg>
                  </button>
                </div>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </motion.div>
    </div>
  );
};
