import { useState, useEffect, useCallback } from 'react';
import { invoke } from '@tauri-apps/api/core';
import type { NetworkDetails } from '../types';

const defaultNetwork: NetworkDetails = {
  conn_type: 'ethernet',
  state: 'connected',
  device: 'enp4s0',
  name: 'Conexión cableada 1',
  speed_label: '1.0 Gbps',
  ip_address: '',
  wifi_networks: [],
};

export function useDetailedNetwork() {
  const [network, setNetwork] = useState<NetworkDetails>(defaultNetwork);
  const [isLoading, setIsLoading] = useState<boolean>(false);

  const fetchNetwork = useCallback(async () => {
    try {
      const res = await invoke<NetworkDetails>('get_detailed_network_status');
      setNetwork(res);
    } catch (err) {
      console.warn('[useDetailedNetwork] Error fetching network status:', err);
    }
  }, []);

  const connectWifi = useCallback(async (ssid: string, password?: string) => {
    setIsLoading(true);
    try {
      await invoke('connect_wifi_network', { ssid, password: password || null });
      await fetchNetwork();
    } catch (err) {
      console.warn('[useDetailedNetwork] Error connecting wifi:', err);
    } finally {
      setIsLoading(false);
    }
  }, [fetchNetwork]);

  const disconnectCurrent = useCallback(async () => {
    if (!network.device) return;
    setIsLoading(true);
    try {
      await invoke('disconnect_network', { device: network.device });
      await fetchNetwork();
    } catch (err) {
      console.warn('[useDetailedNetwork] Error disconnecting network:', err);
    } finally {
      setIsLoading(false);
    }
  }, [network.device, fetchNetwork]);

  useEffect(() => {
    fetchNetwork();
    const interval = setInterval(fetchNetwork, 6000);
    return () => clearInterval(interval);
  }, [fetchNetwork]);

  return {
    network,
    isLoading,
    fetchNetwork,
    connectWifi,
    disconnectCurrent,
  };
}
