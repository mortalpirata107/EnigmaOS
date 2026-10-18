import { useState, useEffect, useCallback } from 'react';
import { invoke } from '@tauri-apps/api/core';

export interface VirtualDesktopItem {
  id: string;
  index: number;
  name: string;
  is_current: boolean;
}

export interface DesktopsState {
  current_id: string;
  current_index: number;
  desktops: VirtualDesktopItem[];
}

const defaultDesktops: DesktopsState = {
  current_id: '0',
  current_index: 0,
  desktops: [
    { id: '0', index: 0, name: '01', is_current: true },
    { id: '1', index: 1, name: '02', is_current: false },
    { id: '2', index: 2, name: '03', is_current: false },
    { id: '3', index: 3, name: '04', is_current: false },
  ],
};

export function useVirtualDesktops() {
  const [state, setState] = useState<DesktopsState>(defaultDesktops);

  const fetchDesktops = useCallback(async () => {
    try {
      const data = await invoke<DesktopsState>('get_virtual_desktops');
      if (data && data.desktops && data.desktops.length > 0) {
        setState(data);
      }
    } catch (err) {
      console.warn('[useVirtualDesktops] Error fetching desktops:', err);
    }
  }, []);

  useEffect(() => {
    fetchDesktops();
    const interval = setInterval(fetchDesktops, 4000);
    return () => clearInterval(interval);
  }, [fetchDesktops]);

  const switchDesktop = useCallback(async (target: string | number) => {
    try {
      const newState = await invoke<DesktopsState>('switch_virtual_desktop', {
        target: target.toString(),
      });
      if (newState) {
        setState(newState);
      }
    } catch (err) {
      console.warn('[useVirtualDesktops] Error switching desktop:', err);
    }
  }, []);

  return {
    state,
    switchDesktop,
    refreshDesktops: fetchDesktops,
  };
}
