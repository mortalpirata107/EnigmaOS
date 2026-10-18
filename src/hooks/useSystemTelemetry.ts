import { useState, useEffect } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';

export interface TelemetryData {
  cpu_usage: number;
  cpu_temp: number;
  cpu_brand: string;
  cpu_cores: number;
  ram_used_gb: number;
  ram_total_gb: number;
  ram_usage: number;
  wifi_ssid: string;
  wifi_enabled: boolean;
}

const defaultTelemetry: TelemetryData = {
  cpu_usage: 18.5,
  cpu_temp: 42.0,
  cpu_brand: 'AMD Ryzen 9',
  cpu_cores: 16,
  ram_used_gb: 12.4,
  ram_total_gb: 32.0,
  ram_usage: 38.7,
  wifi_ssid: 'Fibra_5G_Pro',
  wifi_enabled: true,
};

export function useSystemTelemetry() {
  const [telemetry, setTelemetry] = useState<TelemetryData>(defaultTelemetry);

  useEffect(() => {
    let unlisten: (() => void) | undefined;

    // 1. Initial fetch from Rust
    invoke<TelemetryData>('get_system_telemetry')
      .then((data) => {
        if (data) setTelemetry(data);
      })
      .catch((err) => {
        console.warn('[useSystemTelemetry] Initial fetch error:', err);
      });

    // 2. Real-time background event stream
    listen<TelemetryData>('telemetry_update', (event) => {
      if (event.payload) {
        setTelemetry(event.payload);
      }
    })
      .then((unsub) => {
        unlisten = unsub;
      })
      .catch((err) => {
        console.warn('[useSystemTelemetry] Listen error:', err);
      });

    return () => {
      if (unlisten) unlisten();
    };
  }, []);

  return telemetry;
}
