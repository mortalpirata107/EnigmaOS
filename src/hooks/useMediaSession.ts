import { useState, useEffect, useCallback } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';

export interface MediaInfo {
  player: string;
  status: 'Playing' | 'Paused' | 'Stopped';
  title: string;
  artist: string;
  album: string;
  art_url: string;
  position_secs: number;
  duration_secs: number;
}

export const defaultMedia: MediaInfo = {
  player: 'spotify',
  status: 'Paused',
  title: 'Fantasia & Fugue in G Minor, BWV 542',
  artist: 'Johann Sebastian Bach',
  album: 'Bach: Organ Works',
  art_url: '',
  position_secs: 216,
  duration_secs: 357,
};

function sanitizeMedia(info: MediaInfo): MediaInfo {
  const cleanStr = (s?: string) => (s || '').replace(/\\'/g, "'").replace(/\\"/g, '"').replace(/\\/g, '').trim();
  return {
    ...info,
    title: cleanStr(info.title),
    artist: cleanStr(info.artist),
    album: cleanStr(info.album),
  };
}

export function useMediaSession() {
  const [media, setMedia] = useState<MediaInfo>(defaultMedia);

  useEffect(() => {
    let unlisten: (() => void) | undefined;

    // 1. Initial fetch from Rust backend
    invoke<MediaInfo>('get_media_status')
      .then((info) => {
        if (info && info.title) {
          setMedia(sanitizeMedia(info));
        }
      })
      .catch((err) => {
        console.warn('[useMediaSession] Initial get_media_status failed:', err);
      });

    // 2. Real-time background event stream from Rust poller
    listen<MediaInfo>('media_update', (event) => {
      if (event.payload && event.payload.title) {
        setMedia(sanitizeMedia(event.payload));
      }
    })
      .then((unsub) => {
        unlisten = unsub;
      })
      .catch((err) => {
        console.warn('[useMediaSession] listen media_update failed:', err);
      });

    return () => {
      if (unlisten) unlisten();
    };
  }, []);

  const playPause = useCallback(async () => {
    try {
      await invoke('media_control', { action: 'play_pause' });
      setMedia((prev) => ({
        ...prev,
        status: prev.status === 'Playing' ? 'Paused' : 'Playing',
      }));
    } catch (err) {
      console.warn('[useMediaSession] playPause failed:', err);
    }
  }, []);

  const nextTrack = useCallback(async () => {
    try {
      await invoke('media_control', { action: 'next' });
    } catch (err) {
      console.warn('[useMediaSession] nextTrack failed:', err);
    }
  }, []);

  const previousTrack = useCallback(async () => {
    try {
      await invoke('media_control', { action: 'previous' });
    } catch (err) {
      console.warn('[useMediaSession] previousTrack failed:', err);
    }
  }, []);

  const seek = useCallback(async (seconds: number) => {
    try {
      await invoke('media_control', { action: 'seek', value: seconds });
      setMedia((prev) => ({ ...prev, position_secs: seconds }));
    } catch (err) {
      console.warn('[useMediaSession] seek failed:', err);
    }
  }, []);

  return {
    media,
    playPause,
    nextTrack,
    previousTrack,
    seek,
  };
}
