import { useState, useEffect, useCallback } from 'react';
import { invoke } from '@tauri-apps/api/core';
import type { DetailedAudioState } from '../types';

const defaultAudio: DetailedAudioState = {
  master_volume: 50,
  is_master_muted: false,
  is_mic_muted: false,
  sinks: [],
  apps: [],
};

export function useDetailedAudio() {
  const [audioState, setAudioState] = useState<DetailedAudioState>(defaultAudio);

  const fetchAudio = useCallback(async () => {
    try {
      const res = await invoke<DetailedAudioState>('get_detailed_audio_status');
      setAudioState(res);
    } catch (err) {
      console.warn('[useDetailedAudio] Error fetching audio status:', err);
    }
  }, []);

  const setSinkVol = useCallback(async (sinkId: number, volume: number) => {
    setAudioState((prev) => ({
      ...prev,
      sinks: prev.sinks.map((s) => (s.id === sinkId ? { ...s, volume } : s)),
    }));
    try {
      await invoke('set_sink_volume', { sinkId, volume });
    } catch (err) {
      console.warn('[useDetailedAudio] Error setting sink volume:', err);
    }
  }, []);

  const toggleSinkMute = useCallback(async (sinkId: number) => {
    setAudioState((prev) => ({
      ...prev,
      sinks: prev.sinks.map((s) => (s.id === sinkId ? { ...s, is_muted: !s.is_muted } : s)),
    }));
    try {
      await invoke('toggle_sink_mute', { sinkId });
      await fetchAudio();
    } catch (err) {
      console.warn('[useDetailedAudio] Error toggling sink mute:', err);
    }
  }, [fetchAudio]);

  const setDefaultSink = useCallback(async (sinkId: number) => {
    setAudioState((prev) => ({
      ...prev,
      sinks: prev.sinks.map((s) => ({ ...s, is_default: s.id === sinkId })),
    }));
    try {
      await invoke('set_default_sink', { sinkId });
      await fetchAudio();
    } catch (err) {
      console.warn('[useDetailedAudio] Error setting default sink:', err);
    }
  }, [fetchAudio]);

  const setAppVol = useCallback(async (inputId: number, volume: number) => {
    setAudioState((prev) => ({
      ...prev,
      apps: prev.apps.map((a) => (a.id === inputId ? { ...a, volume } : a)),
    }));
    try {
      await invoke('set_app_volume', { inputId, volume });
    } catch (err) {
      console.warn('[useDetailedAudio] Error setting app volume:', err);
    }
  }, []);

  const toggleAppMute = useCallback(async (inputId: number) => {
    setAudioState((prev) => ({
      ...prev,
      apps: prev.apps.map((a) => (a.id === inputId ? { ...a, is_muted: !a.is_muted } : a)),
    }));
    try {
      await invoke('toggle_app_mute', { inputId });
      await fetchAudio();
    } catch (err) {
      console.warn('[useDetailedAudio] Error toggling app mute:', err);
    }
  }, [fetchAudio]);

  const moveAppSink = useCallback(async (inputId: number, sinkId: number) => {
    setAudioState((prev) => ({
      ...prev,
      apps: prev.apps.map((a) => (a.id === inputId ? { ...a, sink_id: sinkId } : a)),
    }));
    try {
      await invoke('move_app_to_sink', { inputId, sinkId });
      await fetchAudio();
    } catch (err) {
      console.warn('[useDetailedAudio] Error moving app to sink:', err);
    }
  }, [fetchAudio]);

  useEffect(() => {
    fetchAudio();
    const interval = setInterval(fetchAudio, 5000);
    return () => clearInterval(interval);
  }, [fetchAudio]);

  return {
    audioState,
    fetchAudio,
    setSinkVol,
    toggleSinkMute,
    setDefaultSink,
    setAppVol,
    toggleAppMute,
    moveAppSink,
  };
}
