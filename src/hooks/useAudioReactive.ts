import { useState, useEffect, useRef, useCallback } from 'react';
import { listen } from '@tauri-apps/api/event';
import { convertFileSrc } from '@tauri-apps/api/core';

export interface AudioReactiveState {
  audioLevels: { bass: number; treble: number };
  bands: [number, number, number]; // [bass, mid, treble]
  onset: number;
  speechEnv: number;
  isSpeaking: boolean;
}

export function useAudioReactive(enabled = false): AudioReactiveState {
  const [audioState, setAudioState] = useState<AudioReactiveState>({
    audioLevels: { bass: 0, treble: 0 },
    bands: [0, 0, 0],
    onset: 0,
    speechEnv: 0,
    isSpeaking: false,
  });

  const audioCtxRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const audioElRef = useRef<HTMLAudioElement | null>(null);
  const sourceNodeRef = useRef<MediaElementAudioSourceNode | null>(null);
  const animFrameRef = useRef<number | null>(null);

  const prevEnergyRef = useRef<number>(0);
  const isSpeakingRef = useRef<boolean>(false);
  const micLevelsRef = useRef<{ bass: number; treble: number }>({ bass: 0, treble: 0 });

  // 1. Inicialización lazy del contexto de audio
  const getAudioContext = useCallback(() => {
    if (!audioCtxRef.current) {
      const AudioCtx =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      if (AudioCtx) {
        try {
          const ctx = new AudioCtx();
          const analyser = ctx.createAnalyser();
          analyser.fftSize = 512;
          analyser.smoothingTimeConstant = 0.72;
          audioCtxRef.current = ctx;
          analyserRef.current = analyser;
        } catch (e) {
          console.warn('[useAudioReactive] Error inicializando AudioContext:', e);
        }
      }
    }
    if (audioCtxRef.current && audioCtxRef.current.state === 'suspended') {
      audioCtxRef.current.resume().catch(() => {});
    }
    return { ctx: audioCtxRef.current, analyser: analyserRef.current };
  }, []);

  // 2. Escucha de eventos de habla nativos de Rust y de Piper TTS
  useEffect(() => {
    if (!enabled) return;
    let unlistenAudioEvent: (() => void) | undefined;
    let unlistenSpeakStart: (() => void) | undefined;
    let unlistenSpeakEnd: (() => void) | undefined;

    // Escuchar inicio de habla nativa (spd-say / pw-play en Rust)
    listen<{ text?: string }>('enigma-speaking-start', () => {
      isSpeakingRef.current = true;
      setAudioState((prev) => ({ ...prev, isSpeaking: true }));
    }).then((unsub) => {
      unlistenSpeakStart = unsub;
    });

    // Escuchar fin de habla nativa
    listen('enigma-speaking-end', () => {
      isSpeakingRef.current = false;
      setAudioState((prev) => ({ ...prev, isSpeaking: false }));
    }).then((unsub) => {
      unlistenSpeakEnd = unsub;
    });

    listen<{ filePath: string; text?: string }>('enigma-play-audio', async (event) => {
      try {
        const { filePath } = event.payload;
        if (!filePath) return;

        const { ctx, analyser } = getAudioContext();
        if (!ctx || !analyser) return;

        // Crear o reutilizar elemento de audio HTML5
        if (!audioElRef.current) {
          const audio = new Audio();
          audio.crossOrigin = 'anonymous';
          audioElRef.current = audio;

          try {
            const source = ctx.createMediaElementSource(audio);
            source.connect(analyser);
            analyser.connect(ctx.destination);
            sourceNodeRef.current = source;
          } catch (e) {
            console.warn('[useAudioReactive] createMediaElementSource warning:', e);
          }
        }

        const audio = audioElRef.current;
        const srcUrl = convertFileSrc(filePath);
        audio.src = srcUrl;

        isSpeakingRef.current = true;
        setAudioState((prev) => ({ ...prev, isSpeaking: true }));

        audio.onended = () => {
          isSpeakingRef.current = false;
          setAudioState((prev) => ({ ...prev, isSpeaking: false }));
        };

        audio.onerror = (e) => {
          console.warn('[useAudioReactive] Error en elemento audio:', e);
          isSpeakingRef.current = false;
          setAudioState((prev) => ({ ...prev, isSpeaking: false }));
        };

        await audio.play();
      } catch (err) {
        console.warn('[useAudioReactive] Error reproduciendo síntesis:', err);
        isSpeakingRef.current = false;
        setAudioState((prev) => ({ ...prev, isSpeaking: false }));
      }
    }).then((unsub) => {
      unlistenAudioEvent = unsub;
    });

    return () => {
      if (unlistenAudioEvent) unlistenAudioEvent();
      if (unlistenSpeakStart) unlistenSpeakStart();
      if (unlistenSpeakEnd) unlistenSpeakEnd();
    };
  }, [enabled, getAudioContext]);

  // 3. Escucha de los niveles del micrófono emitidos por wake_word.rs
  useEffect(() => {
    if (!enabled) return;
    let unlistenMic: (() => void) | undefined;

    listen<{ bass: number; treble: number }>('audio-levels', (event) => {
      if (event.payload && typeof event.payload.bass === 'number') {
        micLevelsRef.current = event.payload;
      }
    }).then((unsub) => {
      unlistenMic = unsub;
    });

    return () => {
      if (unlistenMic) unlistenMic();
    };
  }, [enabled]);

  // 4. Bucle FFT a 60 FPS (sólo si el reactor está activo)
  useEffect(() => {
    if (!enabled) return;
    const freqData = new Uint8Array(256);

    const updateLoop = () => {
      const analyser = analyserRef.current;
      const isSpeaking = isSpeakingRef.current;

      let bass = 0;
      let mid = 0;
      let treble = 0;
      let onset = 0;
      let speechEnv = 0;

      if (isSpeaking) {
        if (analyser) {
          analyser.getByteFrequencyData(freqData);

          // Subgraves y Graves (bins 1 a 14: ~43 Hz a 600 Hz)
          let bassSum = 0;
          const bassCount = 14;
          for (let i = 1; i <= bassCount; i++) {
            bassSum += freqData[i];
          }
          bass = Math.min(1.0, (bassSum / bassCount / 255) * 1.85);

          // Medios vocales y formantes (bins 15 a 65: ~600 Hz a ~2.8 kHz)
          let midSum = 0;
          const midCount = 51;
          for (let i = 15; i <= 65; i++) {
            midSum += freqData[i];
          }
          mid = Math.min(1.0, (midSum / midCount / 255) * 1.65);

          // Agudos, consonantes y sibilantes (bins 66 a 180: ~2.8 kHz a ~8 kHz)
          let trebleSum = 0;
          const trebleCount = 115;
          for (let i = 66; i <= 180; i++) {
            trebleSum += freqData[i];
          }
          treble = Math.min(1.0, (trebleSum / trebleCount / 255) * 1.95);
        }

        // Si la locución es nativa en Rust (spd-say / pw-play) o el audio HTML5 aún no carga bins,
        // generar modulación orgánica de cadencia vocal para que el VoiceOrb vibre con ondas volumétricas
        if (bass < 0.05 && mid < 0.05 && treble < 0.05) {
          const t = performance.now() * 0.007;
          bass = 0.42 + 0.32 * Math.sin(t * 1.9);
          mid = 0.58 + 0.35 * Math.cos(t * 2.5);
          treble = 0.38 + 0.28 * Math.sin(t * 3.3);
        }

        // Envolvente y ataque (Onset)
        const currentEnergy = bass * 0.5 + mid * 0.35 + treble * 0.15;
        const delta = Math.max(0, currentEnergy - prevEnergyRef.current);
        prevEnergyRef.current = currentEnergy;

        onset = Math.min(1.0, delta * 3.8);
        speechEnv = Math.min(1.0, currentEnergy * 1.45);
      } else {
        // Reactividad con el micrófono del usuario
        const mic = micLevelsRef.current;
        bass = Math.min(1.0, mic.bass * 1.5);
        treble = Math.min(1.0, mic.treble * 1.5);
        mid = (bass + treble) * 0.5;

        const micEnergy = bass * 0.55 + treble * 0.45;
        const delta = Math.max(0, micEnergy - prevEnergyRef.current);
        prevEnergyRef.current = micEnergy;
        onset = Math.min(1.0, delta * 3.2);
        speechEnv = Math.min(1.0, micEnergy * 1.2);
      }

      setAudioState({
        audioLevels: { bass, treble },
        bands: [bass, mid, treble],
        onset,
        speechEnv,
        isSpeaking,
      });

      animFrameRef.current = requestAnimationFrame(updateLoop);
    };

    animFrameRef.current = requestAnimationFrame(updateLoop);

    return () => {
      if (animFrameRef.current) cancelAnimationFrame(animFrameRef.current);
    };
  }, [enabled]);

  return audioState;
}
