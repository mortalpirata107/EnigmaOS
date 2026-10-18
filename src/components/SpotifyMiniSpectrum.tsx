import React, { useEffect, useRef } from 'react';

interface SpotifyMiniSpectrumProps {
  isPlaying: boolean;
  barCount?: number;
  className?: string;
}

/**
 * Mini Visualizador Espectral de Barras de Onda para Spotify
 * Renderiza 5-7 micro-barras en degradado carmesí #b82a2a con resplandor líquido,
 * pulsando a 60/144 FPS sincronizado por hardware mediante requestAnimationFrame
 * con amortiguación lerp ultra-suave.
 */
export const SpotifyMiniSpectrum: React.FC<SpotifyMiniSpectrumProps> = ({
  isPlaying,
  barCount = 6,
  className = '',
}) => {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const bars = Array.from(container.children) as HTMLElement[];
    if (bars.length === 0) return;

    let animId: number;
    let time = 0;
    // Current scale values for lerp smoothing
    const currentScales = new Float32Array(bars.length).fill(0.18);

    // Frecuencias base y fases aleatorizadas para cada barra (simula sub-bass, mid, agudos)
    const phases = bars.map((_, i) => ({
      freq1: 2.8 + i * 1.15,
      freq2: 1.6 + (bars.length - i) * 0.95,
      phase: (i * Math.PI) / (bars.length / 2),
      baseWeight: 0.4 + 0.6 * Math.sin(((i + 1) / (bars.length + 1)) * Math.PI),
    }));

    if (!isPlaying) {
      bars.forEach((bar) => {
        bar.style.transform = 'scaleY(0.18)';
        bar.style.opacity = '0.35';
      });
      return;
    }

    let lastTimestamp = performance.now();

    const loop = (timestamp: number) => {
      const dt = Math.min(0.05, (timestamp - lastTimestamp) / 1000);
      lastTimestamp = timestamp;
      time += dt * 3.2;

      bars.forEach((bar, i) => {
        const p = phases[i];
        const w1 = Math.sin(time * p.freq1 + p.phase);
        const w2 = Math.cos(time * p.freq2 - p.phase * 0.5);
        const beatDrop = Math.pow(Math.max(0, Math.sin(time * 1.8)), 3.0) * 0.45;
        const rawNorm = (w1 * 0.45 + w2 * 0.35 + beatDrop + 0.7) * 0.5;
        const targetScale = Math.max(0.18, Math.min(1.0, rawNorm * p.baseWeight * 1.25));

        // Smooth lerp easing
        currentScales[i] += (targetScale - currentScales[i]) * 0.22;
        const s = currentScales[i];

        bar.style.transform = `scaleY(${s.toFixed(3)})`;
        bar.style.opacity = `${(0.55 + s * 0.45).toFixed(2)}`;
      });

      animId = requestAnimationFrame(loop);
    };

    animId = requestAnimationFrame(loop);

    return () => {
      cancelAnimationFrame(animId);
    };
  }, [isPlaying, barCount]);

  return (
    <div
      ref={containerRef}
      className={`flex items-end justify-center gap-[2.5px] h-4 pointer-events-none select-none ${className}`}
      aria-label="Spotify Spectral Visualizer"
    >
      {Array.from({ length: barCount }).map((_, i) => (
        <span
          key={i}
          className="w-[2.5px] h-4 rounded-full bg-gradient-to-t from-[#8b1c1c] via-[#b82a2a] to-[#ff4d4d] shadow-[0_0_8px_rgba(184,42,42,0.9)] origin-bottom will-change-transform"
          style={{ transform: 'scaleY(0.18)', opacity: 0.35 }}
        />
      ))}
    </div>
  );
};
