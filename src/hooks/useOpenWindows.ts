import { useState, useEffect, useCallback } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';

export interface OpenWindow {
  id: string;
  uuid: string;
  title: string;
  app_name: string;
  window_class: string;
  icon: string;
  is_active: boolean;
}

export function useOpenWindows() {
  const [windows, setWindows] = useState<OpenWindow[]>([]);
  const [loading, setLoading] = useState<boolean>(true);

  const fetchWindows = useCallback(async () => {
    try {
      const data = await invoke<OpenWindow[]>('get_open_windows');
      setWindows(data);
    } catch (err) {
      console.warn('[useOpenWindows] Error fetching windows:', err);
    } finally {
      setLoading(false);
    }
  }, []);

  const focusWindow = useCallback(async (id: string) => {
    try {
      await invoke('focus_window', { id });
      // Optimistically update active state
      setWindows(prev => prev.map(w => ({
        ...w,
        is_active: w.id === id,
      })));
    } catch (err) {
      console.warn('[useOpenWindows] Error focusing window:', err);
    }
  }, []);

  useEffect(() => {
    fetchWindows();

    let unlisten: (() => void) | undefined;
    listen<OpenWindow[]>('open_windows_changed', (event) => {
      setWindows(event.payload);
    }).then(unsub => {
      unlisten = unsub;
    }).catch(() => {});

    // Periodic safety poll every 8 seconds (real-time updates come via events)
    const interval = setInterval(fetchWindows, 8000);

    return () => {
      if (unlisten) unlisten();
      clearInterval(interval);
    };
  }, [fetchWindows]);

  return { windows, focusWindow, refreshWindows: fetchWindows, loading };
}
