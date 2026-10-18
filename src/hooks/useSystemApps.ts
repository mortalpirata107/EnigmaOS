import { useState, useEffect, useCallback } from 'react';
import { invoke } from '@tauri-apps/api/core';
import type { AppEntry } from '../types';

let memoryAppsCache: AppEntry[] = [];
let hasFetchedOnce = false;

export function useSystemApps() {
  const [apps, setApps] = useState<AppEntry[]>(memoryAppsCache);
  const [isLoading, setIsLoading] = useState<boolean>(memoryAppsCache.length === 0);

  const fetchApps = useCallback(async (force = false) => {
    if (!force && memoryAppsCache.length > 0 && hasFetchedOnce) {
      return;
    }
    if (memoryAppsCache.length === 0) setIsLoading(true);
    try {
      const res = await invoke<AppEntry[]>('get_system_apps');
      if (res && res.length > 0) {
        memoryAppsCache = res;
        setApps(res);
      }
    } catch (err) {
      console.warn('[useSystemApps] Error fetching system apps:', err);
    } finally {
      hasFetchedOnce = true;
      setIsLoading(false);
    }
  }, []);

  const launchApp = useCallback(async (app: AppEntry) => {
    try {
      await invoke('launch_system_app', { desktopId: app.id, exec: app.exec });
    } catch (err) {
      console.warn('[useSystemApps] Error launching app:', err);
    }
  }, []);

  const executeAction = useCallback(async (action: string) => {
    try {
      await invoke('execute_system_action', { action });
    } catch (err) {
      console.warn('[useSystemApps] Error executing system action:', err);
    }
  }, []);

  useEffect(() => {
    fetchApps();
  }, [fetchApps]);

  return {
    apps,
    isLoading,
    fetchApps,
    launchApp,
    executeAction,
  };
}
