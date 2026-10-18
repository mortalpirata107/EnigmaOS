import { useState, useEffect, useCallback } from 'react';
import { invoke } from '@tauri-apps/api/core';

export interface AudioState {
  volume: number;
  is_muted: boolean;
  is_mic_muted: boolean;
}

const defaultAudio: AudioState = {
  volume: 50,
  is_muted: false,
  is_mic_muted: false,
};

export function useAudioControl() {
  const [audio, setAudio] = useState<AudioState>(defaultAudio);

  const fetchAudio = useCallback(async () => {
    try {
      const data = await invoke<AudioState>('get_audio_status');
      if (data) setAudio(data);
    } catch (err) {
      console.warn('[useAudioControl] fetch error:', err);
    }
  }, []);

  useEffect(() => {
    fetchAudio();
    const interval = setInterval(fetchAudio, 6000);
    return () => clearInterval(interval);
  }, [fetchAudio]);

  const toggleMute = useCallback(async () => {
    try {
      const updated = await invoke<AudioState>('toggle_audio_mute');
      if (updated) setAudio(updated);
    } catch (err) {
      console.warn('[useAudioControl] toggle mute error:', err);
    }
  }, []);

  const toggleMicMute = useCallback(async () => {
    try {
      const updated = await invoke<AudioState>('toggle_mic_mute');
      if (updated) setAudio(updated);
    } catch (err) {
      console.warn('[useAudioControl] toggle mic mute error:', err);
    }
  }, []);

  const setVolume = useCallback(async (percent: number) => {
    try {
      const updated = await invoke<AudioState>('set_audio_volume', { percent: Math.round(percent) });
      if (updated) setAudio(updated);
    } catch (err) {
      console.warn('[useAudioControl] set volume error:', err);
    }
  }, []);

  return {
    ...audio,
    toggleMute,
    toggleMicMute,
    setVolume,
    refreshAudio: fetchAudio,
  };
}
