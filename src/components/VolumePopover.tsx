import React from 'react';
import { motion } from 'framer-motion';
import { 
  Volume2, 
  VolumeX, 
  Headphones, 
  Tv, 
  Mic, 
  Music, 
  Video, 
  Sliders,
  CheckCircle2,
  Share2
} from 'lucide-react';
import { useDetailedAudio } from '../hooks/useDetailedAudio';
import type { AudioSinkItem } from '../types';

interface VolumePopoverProps {
  onClose?: () => void;
  onMouseEnter?: () => void;
  onMouseLeave?: () => void;
}

export const VolumePopover: React.FC<VolumePopoverProps> = ({
  onMouseEnter,
  onMouseLeave,
}) => {
  const { 
    audioState, 
    setSinkVol, 
    toggleSinkMute, 
    setDefaultSink, 
    setAppVol, 
    toggleAppMute, 
    moveAppSink 
  } = useDetailedAudio();

  const getSinkIcon = (sink: AudioSinkItem) => {
    const desc = sink.description.toLowerCase();
    if (desc.includes('head') || desc.includes('auricular') || desc.includes('corsair') || desc.includes('void')) {
      return <Headphones className="w-3.5 h-3.5 text-[#b82a2a]" />;
    }
    if (desc.includes('hdmi') || desc.includes('tv') || desc.includes('monitor') || desc.includes('display')) {
      return <Tv className="w-3.5 h-3.5 text-[#b82a2a]" />;
    }
    if (desc.includes('mic')) {
      return <Mic className="w-3.5 h-3.5 text-[#b82a2a]" />;
    }
    return <Volume2 className="w-3.5 h-3.5 text-[#b82a2a]" />;
  };

  return (
    <motion.div
      initial={{ opacity: 0, y: -8, scale: 0.96 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: -8, scale: 0.96 }}
      transition={{ duration: 0.22, ease: [0.4, 0, 0.2, 1] }}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
      className="absolute top-[38px] right-0 w-[380px] max-h-[500px] flex flex-col bg-black border border-[#b82a2a]/40 rounded-2xl shadow-[0_20px_50px_rgba(0,0,0,0.98)] p-3.5 z-50 text-white select-none pointer-events-auto overflow-hidden"
    >
      {/* Header */}
      <div className="flex items-center justify-between pb-2.5 mb-2.5 border-b border-[#b82a2a]/20 shrink-0">
        <div className="flex items-center gap-2">
          <div className="w-7 h-7 rounded-lg bg-black border border-[#b82a2a]/50 flex items-center justify-center text-[#b82a2a] shadow-[0_0_8px_rgba(184,42,42,0.3)]">
            <Sliders className="w-4 h-4 text-[#b82a2a]" />
          </div>
          <div>
            <span className="text-xs font-bold font-mono tracking-wider text-white uppercase block">
              Control de Audio
            </span>
            <span className="text-[10px] text-white/50 block font-mono">
              PipeWire / PulseAudio ({audioState.sinks.length} salidas)
            </span>
          </div>
        </div>

        <span className="text-xs font-mono font-bold text-[#b82a2a] bg-black border border-[#b82a2a]/50 px-2 py-0.5 rounded-full shadow-[0_0_8px_rgba(184,42,42,0.2)]">
          {audioState.master_volume}% Master
        </span>
      </div>

      {/* Contenido con Scroll */}
      <div className="flex-1 overflow-y-auto space-y-4 pr-1 custom-scrollbar min-h-0">
        {/* =========================================================================
            APARTADO 1: CONTROL INDIVIDUAL DE DISPOSITIVOS DE SALIDA (SINKS)
            ========================================================================= */}
        <div>
          <span className="text-[11px] font-mono font-bold text-[#b82a2a] uppercase tracking-wider flex items-center gap-1.5 mb-2 px-1">
            <Volume2 className="w-3 h-3 text-[#b82a2a]" />
            Dispositivos de Salida
          </span>

          <div className="space-y-2">
            {audioState.sinks.map((sink) => (
              <div
                key={sink.id}
                className={`p-2.5 rounded-xl border transition-all ${
                  sink.is_default
                    ? 'bg-black border-[#b82a2a]/60 shadow-[0_0_12px_rgba(184,42,42,0.25)]'
                    : 'bg-black border-white/10 hover:border-[#b82a2a]/40'
                }`}
              >
                {/* Nombre del dispositivo y badge predeterminado */}
                <div className="flex items-center justify-between mb-1.5">
                  <div className="flex items-center gap-2 min-w-0 pr-2">
                    <div className="w-6 h-6 rounded-md bg-black border border-[#b82a2a]/40 flex items-center justify-center shrink-0">
                      {getSinkIcon(sink)}
                    </div>
                    <span 
                      className="text-xs font-semibold text-white truncate block cursor-pointer"
                      title={sink.description}
                      onClick={() => setDefaultSink(sink.id)}
                    >
                      {sink.description}
                    </span>
                  </div>

                  <div className="flex items-center gap-1 shrink-0">
                    {sink.is_default ? (
                      <span className="flex items-center gap-1 text-[9px] font-mono font-bold px-1.5 py-0.5 rounded bg-black border border-[#b82a2a]/60 text-white shadow-[0_0_6px_rgba(184,42,42,0.3)]">
                        <CheckCircle2 className="w-2.5 h-2.5 text-[#b82a2a]" />
                        PREDETERMINADO
                      </span>
                    ) : (
                      <button
                        type="button"
                        onClick={() => setDefaultSink(sink.id)}
                        className="text-[9px] font-mono text-white/50 hover:text-white px-1.5 py-0.5 rounded bg-black border border-white/10 hover:border-[#b82a2a]/40 transition-all cursor-pointer"
                      >
                        Hacer Principal
                      </button>
                    )}
                  </div>
                </div>

                {/* Slider y botón de mute */}
                <div className="flex items-center gap-2.5">
                  <button
                    type="button"
                    onClick={() => toggleSinkMute(sink.id)}
                    className="p-1 rounded-lg bg-black text-[#b82a2a] hover:text-white transition-all cursor-pointer border border-white/10 hover:border-[#b82a2a]/40"
                    title={sink.is_muted ? 'Desactivar silencio' : 'Silenciar'}
                  >
                    {sink.is_muted ? (
                      <VolumeX className="w-3.5 h-3.5 text-[#b82a2a]" />
                    ) : (
                      <Volume2 className="w-3.5 h-3.5 text-[#b82a2a]" />
                    )}
                  </button>

                  <input
                    type="range"
                    min="0"
                    max="100"
                    value={sink.is_muted ? 0 : sink.volume}
                    onChange={(e) => setSinkVol(sink.id, parseInt(e.target.value, 10))}
                    className="flex-1 h-1.5 bg-neutral-900 rounded-lg appearance-none cursor-pointer accent-[#b82a2a]"
                  />

                  <span className="text-[11px] font-mono font-bold text-white w-9 text-right font-mono-num">
                    {sink.is_muted ? 'MUTE' : `${sink.volume}%`}
                  </span>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* =========================================================================
            APARTADO 2: APPS EN REPRODUCCIÓN (ROUTING POR APP Y MULTIMEDIA)
            ========================================================================= */}
        <div>
          <span className="text-[11px] font-mono font-bold text-white/80 uppercase tracking-wider flex items-center gap-1.5 mb-2 px-1">
            <Share2 className="w-3 h-3 text-[#b82a2a]" />
            Apps en Reproducción ({audioState.apps.length})
          </span>

          <div className="space-y-2">
            {audioState.apps.length === 0 ? (
              <div className="px-3 py-3 rounded-xl bg-black border border-white/10 text-center">
                <Music className="w-5 h-5 text-[#b82a2a]/40 mx-auto mb-1" />
                <span className="text-xs text-white/50 font-mono block">
                  No hay aplicaciones reproduciendo audio
                </span>
              </div>
            ) : (
              audioState.apps.map((app) => (
                <div
                  key={app.id}
                  className="p-3 rounded-xl bg-black border border-white/10 hover:border-[#b82a2a]/40 transition-all space-y-2"
                >
                  {/* Fila Superior: Logo/Nombre de App y Selector de Salida (Router de dispositivo) */}
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-2 min-w-0">
                      <div className="w-7 h-7 rounded-lg bg-black border border-[#b82a2a]/40 flex items-center justify-center shrink-0">
                        {app.is_video ? (
                          <Video className="w-3.5 h-3.5 text-[#b82a2a]" />
                        ) : (
                          <Music className="w-3.5 h-3.5 text-[#b82a2a]" />
                        )}
                      </div>
                      <div className="min-w-0">
                        <span className="text-xs font-bold text-white block truncate">
                          {app.app_name}
                        </span>
                        <span className="text-[10px] font-mono text-white/40 block">
                          Stream #{app.id}
                        </span>
                      </div>
                    </div>

                    {/* Selector de Dispositivo de Destino */}
                    <div className="shrink-0">
                      <select
                        value={app.sink_id}
                        onChange={(e) => moveAppSink(app.id, parseInt(e.target.value, 10))}
                        className="bg-black border border-[#b82a2a]/40 text-white text-[10px] font-mono rounded-lg px-2 py-1 focus:outline-none focus:border-[#b82a2a] cursor-pointer max-w-[130px] truncate"
                        title="Selecciona el dispositivo de audio para esta app"
                      >
                        {audioState.sinks.map((s) => (
                          <option key={s.id} value={s.id} className="bg-black text-white">
                            {s.description.slice(0, 22)}...
                          </option>
                        ))}
                      </select>
                    </div>
                  </div>

                  {/* Tarjeta de Contenido Multimedia */}
                  {(app.media_title || app.media_artist) && (
                    <div className="flex items-center gap-2.5 p-2 rounded-lg bg-black border border-[#b82a2a]/30">
                      {app.media_art_url ? (
                        <img
                          src={app.media_art_url}
                          alt="Portada"
                          className="w-9 h-9 rounded-md object-cover border border-[#b82a2a]/40 shrink-0"
                          onError={(e) => {
                            (e.target as HTMLElement).style.display = 'none';
                          }}
                        />
                      ) : (
                        <div className="w-9 h-9 rounded-md bg-black border border-[#b82a2a]/30 flex items-center justify-center shrink-0">
                          {app.is_video ? (
                            <Video className="w-4 h-4 text-[#b82a2a]" />
                          ) : (
                            <Music className="w-4 h-4 text-[#b82a2a]" />
                          )}
                        </div>
                      )}
                      <div className="min-w-0 flex-1">
                        <span className="text-xs font-semibold text-white block truncate">
                          {app.media_title || 'Audio en reproducción'}
                        </span>
                        <span className="text-[10px] text-white/60 block truncate font-mono">
                          {app.media_artist || (app.is_video ? 'Canal de video' : 'Artista')}
                        </span>
                      </div>
                    </div>
                  )}

                  {/* Slider de Volumen para esta App */}
                  <div className="flex items-center gap-2.5 pt-0.5">
                    <button
                      type="button"
                      onClick={() => toggleAppMute(app.id)}
                      className="p-1 rounded bg-black text-[#b82a2a] hover:text-white transition-all cursor-pointer border border-white/10 hover:border-[#b82a2a]/40"
                      title={app.is_muted ? 'Desactivar silencio de app' : 'Silenciar app'}
                    >
                      {app.is_muted ? (
                        <VolumeX className="w-3 h-3 text-[#b82a2a]" />
                      ) : (
                        <Volume2 className="w-3 h-3 text-[#b82a2a]" />
                      )}
                    </button>

                    <input
                      type="range"
                      min="0"
                      max="100"
                      value={app.is_muted ? 0 : app.volume}
                      onChange={(e) => setAppVol(app.id, parseInt(e.target.value, 10))}
                      className="flex-1 h-1.5 bg-neutral-900 rounded-lg appearance-none cursor-pointer accent-[#b82a2a]"
                    />

                    <span className="text-[11px] font-mono font-bold text-white w-9 text-right font-mono-num">
                      {app.is_muted ? 'MUTE' : `${app.volume}%`}
                    </span>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      </div>

      {/* Margen inferior mínimo 5px */}
      <div className="h-1 shrink-0" />
    </motion.div>
  );
};
