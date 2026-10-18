export type NotchMode = 'idle' | 'multimedia' | 'performance' | 'quicksettings' | 'search' | 'enigma';

export type InputRegion = [number, number, number, number]; // [x, y, width, height]

export interface VirtualDesktop {
  id: number;
  label: string;
  active: boolean;
}

export interface AppShortcut {
  id: string;
  name: string;
  icon: string;
  command: string;
}

export interface MusicTrack {
  title: string;
  artist: string;
  album: string;
  duration: number; // in seconds
  position: number; // in seconds
  isPlaying: boolean;
  coverUrl: string;
}

export interface SystemMetrics {
  cpuUsage: number; // 0 - 100%
  cpuTemp: number; // °C
  ramUsage: number; // 0 - 100%
  ramUsedGb: number;
  ramTotalGb: number;
  gpuUsage: number; // 0 - 100%
  gpuTemp: number; // °C
  netDownKbps: number;
  netUpKbps: number;
}

export interface QuickSettings {
  wifi: boolean;
  bluetooth: boolean;
  dnd: boolean; // Do Not Disturb
  volume: number; // 0 - 100
  microphone: boolean;
}

export interface AppEntry {
  id: string;
  name: string;
  exec: string;
  icon: string;
  comment: string;
  categories?: string;
  keywords?: string;
}

export interface RecentDocEntry {
  name: string;
  path: string;
  is_dir: boolean;
}

export interface BluetoothDevice {
  mac: string;
  name: string;
  connected: boolean;
}

export interface DetailedBluetoothState {
  powered: boolean;
  connected_devices: BluetoothDevice[];
  paired_devices: BluetoothDevice[];
  available_devices: BluetoothDevice[];
}

export interface WifiNetworkItem {
  in_use: boolean;
  ssid: string;
  signal: number;
  security: string;
}

export interface NetworkDetails {
  conn_type: 'ethernet' | 'wifi' | 'none';
  state: 'connected' | 'disconnected';
  device: string;
  name: string;
  speed_label: string;
  ip_address: string;
  wifi_networks: WifiNetworkItem[];
}

export interface AudioSinkItem {
  id: number;
  name: string;
  description: string;
  volume: number;
  is_muted: boolean;
  is_default: boolean;
}

export interface AudioAppStream {
  id: number;
  sink_id: number;
  app_name: string;
  icon_name: string;
  volume: number;
  is_muted: boolean;
  media_title: string;
  media_artist: string;
  media_art_url: string;
  is_video: boolean;
}

export interface DetailedAudioState {
  master_volume: number;
  is_master_muted: boolean;
  is_mic_muted: boolean;
  sinks: AudioSinkItem[];
  apps: AudioAppStream[];
}

export interface DesktopNotification {
  id: number;
  app_name: string;
  app_icon: string;
  summary: string;
  body: string;
  actions: string[];
  expire_timeout: number;
  received_at?: number;
  image_path?: string;
  origin_name?: string;
  desktop_entry?: string;
}

