import { useState, useEffect, useCallback } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';

export type ThemeId = 'crimson' | 'cyan' | 'amethyst' | 'gold';

export interface ThemeConfig {
  id: ThemeId;
  name: string;
  badge: string;
  primary: string;
  highlight: string;
  glow: string;
  border: string;
  dim: string;
}

export const THEMES: Record<ThemeId, ThemeConfig> = {
  crimson: {
    id: 'crimson',
    name: 'Carmesí Obsidiana',
    badge: 'Crimson',
    primary: '#b82a2a',
    highlight: '#ff4d4d',
    glow: 'rgba(184, 42, 42, 0.85)',
    border: 'rgba(184, 42, 42, 0.45)',
    dim: 'rgba(184, 42, 42, 0.15)',
  },
  cyan: {
    id: 'cyan',
    name: 'Cian Neón',
    badge: 'Neon Cyan',
    primary: '#00d4ff',
    highlight: '#67e8f9',
    glow: 'rgba(0, 212, 255, 0.85)',
    border: 'rgba(0, 212, 255, 0.45)',
    dim: 'rgba(0, 212, 255, 0.15)',
  },
  amethyst: {
    id: 'amethyst',
    name: 'Amatista Cuántico',
    badge: 'Amethyst',
    primary: '#a855f7',
    highlight: '#c084fc',
    glow: 'rgba(168, 85, 247, 0.85)',
    border: 'rgba(168, 85, 247, 0.45)',
    dim: 'rgba(168, 85, 247, 0.15)',
  },
  gold: {
    id: 'gold',
    name: 'Oro Mate',
    badge: 'Matte Gold',
    primary: '#eab308',
    highlight: '#fde047',
    glow: 'rgba(234, 179, 8, 0.85)',
    border: 'rgba(234, 179, 8, 0.45)',
    dim: 'rgba(234, 179, 8, 0.15)',
  },
};

export interface VisualSettings {
  theme: ThemeId;
  dock_size: number;
  magnify_scale: number;
  autohide_delay_ms: number;
}

export const DEFAULT_VISUAL_SETTINGS: VisualSettings = {
  theme: 'crimson',
  dock_size: 48,
  magnify_scale: 1.45,
  autohide_delay_ms: 180,
};

function applyThemeVariables(themeId: ThemeId) {
  const theme = THEMES[themeId] || THEMES.crimson;
  const root = document.documentElement;
  root.style.setProperty('--accent-color', theme.primary);
  root.style.setProperty('--accent-highlight', theme.highlight);
  root.style.setProperty('--accent-glow', theme.glow);
  root.style.setProperty('--accent-border', theme.border);
  root.style.setProperty('--accent-dim', theme.dim);
}

export function useVisualSettings() {
  const [settings, setSettings] = useState<VisualSettings>(DEFAULT_VISUAL_SETTINGS);

  // 1. Carga inicial desde Rust / localStorage
  useEffect(() => {
    invoke<VisualSettings>('load_visual_settings')
      .then((loaded) => {
        if (loaded && loaded.theme) {
          setSettings(loaded);
          applyThemeVariables(loaded.theme);
        }
      })
      .catch((err) => {
        console.warn('[useVisualSettings] Error al cargar ajustes:', err);
      });
  }, []);

  // 2. Escucha de sincronización en tiempo real emitida por cualquier ventana de Tauri
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    listen<VisualSettings>('visual_settings_updated', (event) => {
      if (event.payload && event.payload.theme) {
        setSettings(event.payload);
        applyThemeVariables(event.payload.theme);
      }
    })
      .then((unsub) => {
        unlisten = unsub;
      })
      .catch(() => {});

    return () => {
      if (unlisten) unlisten();
    };
  }, []);

  // 3. Modificación y persistencia
  const updateSettings = useCallback(
    (updates: Partial<VisualSettings>) => {
      setSettings((prev) => {
        const next: VisualSettings = { ...prev, ...updates };
        applyThemeVariables(next.theme);
        invoke('save_visual_settings', { settings: next }).catch((err) => {
          console.warn('[useVisualSettings] Error al guardar ajustes:', err);
        });
        return next;
      });
    },
    []
  );

  return {
    settings,
    theme: THEMES[settings.theme] || THEMES.crimson,
    updateSettings,
  };
}
