import { useState, useEffect, useCallback } from 'react';
import { invoke } from '@tauri-apps/api/core';
import type { DetailedBluetoothState } from '../types';

const defaultBtState: DetailedBluetoothState = {
  powered: true,
  connected_devices: [],
  paired_devices: [],
  available_devices: [],
};

export function useDetailedBluetooth() {
  const [state, setState] = useState<DetailedBluetoothState>(defaultBtState);
  const [isLoading, setIsLoading] = useState<boolean>(false);

  const fetchStatus = useCallback(async () => {
    try {
      const res = await invoke<DetailedBluetoothState>('get_detailed_bluetooth_status');
      setState(res);
    } catch (err) {
      console.warn('[useDetailedBluetooth] Error fetching bluetooth status:', err);
    }
  }, []);

  const disconnectDevice = useCallback(async (mac: string) => {
    setIsLoading(true);
    try {
      await invoke('bluetooth_disconnect_device', { mac });
      await fetchStatus();
    } catch (err) {
      console.warn('[useDetailedBluetooth] Error disconnecting device:', err);
    } finally {
      setIsLoading(false);
    }
  }, [fetchStatus]);

  const unpairDevice = useCallback(async (mac: string) => {
    setIsLoading(true);
    try {
      await invoke('bluetooth_unpair_device', { mac });
      await fetchStatus();
    } catch (err) {
      console.warn('[useDetailedBluetooth] Error unpairing device:', err);
    } finally {
      setIsLoading(false);
    }
  }, [fetchStatus]);

  const pairDevice = useCallback(async (mac: string) => {
    setIsLoading(true);
    try {
      await invoke('bluetooth_pair_device', { mac });
      await fetchStatus();
    } catch (err) {
      console.warn('[useDetailedBluetooth] Error pairing device:', err);
    } finally {
      setIsLoading(false);
    }
  }, [fetchStatus]);

  const togglePower = useCallback(async (power: boolean) => {
    try {
      await invoke('toggle_bluetooth', { power });
      await fetchStatus();
    } catch (err) {
      console.warn('[useDetailedBluetooth] Error toggling bluetooth:', err);
    }
  }, [fetchStatus]);

  useEffect(() => {
    fetchStatus();
  }, [fetchStatus]);

  return {
    state,
    isLoading,
    fetchStatus,
    disconnectDevice,
    unpairDevice,
    pairDevice,
    togglePower,
  };
}
