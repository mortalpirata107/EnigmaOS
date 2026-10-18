import { useState, useEffect, useCallback } from 'react';
import { invoke } from '@tauri-apps/api/core';

export interface BluetoothDevice {
  mac: string;
  name: string;
  connected: boolean;
}

export interface BluetoothState {
  powered: boolean;
  controller_name: string;
  devices: BluetoothDevice[];
}

const defaultBluetooth: BluetoothState = {
  powered: true,
  controller_name: 'Bluetooth',
  devices: [],
};

export function useBluetooth() {
  const [state, setState] = useState<BluetoothState>(defaultBluetooth);

  const fetchStatus = useCallback(async () => {
    try {
      const data = await invoke<BluetoothState>('get_bluetooth_status');
      if (data) setState(data);
    } catch (err) {
      console.warn('[useBluetooth] Fetch error:', err);
    }
  }, []);

  useEffect(() => {
    fetchStatus();
    const interval = setInterval(fetchStatus, 8000);
    return () => clearInterval(interval);
  }, [fetchStatus]);

  const togglePower = useCallback(async (newPower: boolean) => {
    try {
      const data = await invoke<BluetoothState>('toggle_bluetooth', { power: newPower });
      if (data) setState(data);
    } catch (err) {
      console.warn('[useBluetooth] Toggle power error:', err);
    }
  }, []);

  const connectDevice = useCallback(async (mac: string) => {
    try {
      await invoke('connect_bluetooth_device', { mac });
      fetchStatus();
    } catch (err) {
      console.warn('[useBluetooth] Connect error:', err);
    }
  }, [fetchStatus]);

  return {
    state,
    togglePower,
    connectDevice,
    refreshBluetooth: fetchStatus,
  };
}
