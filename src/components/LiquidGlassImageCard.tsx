import React, { useState, useEffect } from 'react';
import { Sparkles, Copy, Check, ExternalLink, Maximize2, X, Image as ImageIcon, Eye } from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';
import { convertFileSrc } from '@tauri-apps/api/core';

interface LiquidGlassImageCardProps {
  imagePath: string;
  altText?: string;
  caption?: string;
}

export const LiquidGlassImageCard: React.FC<LiquidGlassImageCardProps> = ({
  imagePath,
  altText = 'Imagen generada por Stable Diffusion',
  caption,
}) => {
  // Limpiar esquema file:// o espacios
  const cleanPath = imagePath.trim().replace(/^file:\/\//, '');
  const isDataUrl = cleanPath.startsWith('data:');
  const isRemoteUrl = cleanPath.startsWith('http://') || cleanPath.startsWith('https://');
  const isDirectUrl = isDataUrl || isRemoteUrl;

  const [displaySrc, setDisplaySrc] = useState<string>(() => {
    if (isDirectUrl) return cleanPath;
    if (cleanPath) {
      try {
        return convertFileSrc(cleanPath);
      } catch {
        return '';
      }
    }
    return '';
  });
  const [isLoading, setIsLoading] = useState<boolean>(!isDirectUrl);
  const [hasError, setHasError] = useState<boolean>(false);
  const [copied, setCopied] = useState<boolean>(false);
  const [isModalOpen, setIsModalOpen] = useState<boolean>(false);

  const isVision =
    cleanPath.includes('enigma_vision') ||
    altText.toLowerCase().includes('vision') ||
    altText.toLowerCase().includes('captura') ||
    cleanPath.startsWith('data:image/');

  useEffect(() => {
    let isMounted = true;
    setHasError(false);

    if (isDirectUrl) {
      setDisplaySrc(cleanPath);
      setIsLoading(false);
      return;
    }

    if (!cleanPath) {
      setIsLoading(false);
      setHasError(true);
      return;
    }

    setIsLoading(true);

    // Intentar primero convertir con convertFileSrc de Tauri
    try {
      const assetUrl = convertFileSrc(cleanPath);
      setDisplaySrc(assetUrl);
    } catch {
      // Ignorar fallo inicial y probar invocando el backend
    }

    // Invocación de respaldo a load_image_asset para obtener Base64 puro
    invoke<string>('load_image_asset', { filePath: cleanPath })
      .then((dataUrl) => {
        if (isMounted && dataUrl) {
          setDisplaySrc(dataUrl);
          setIsLoading(false);
        }
      })
      .catch((_err) => {
        if (isMounted) {
          // El propio <img> manejará onError si la URL de asset no carga
        }
      });

    return () => {
      isMounted = false;
    };
  }, [cleanPath, isDirectUrl]);

  const handleCopyPath = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (isDataUrl) {
      navigator.clipboard.writeText('data:image/jpeg;base64,...');
    } else {
      navigator.clipboard.writeText(cleanPath);
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleOpenExternal = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (isDataUrl) return;
    invoke('open_url', { url: `file://${cleanPath}` }).catch(() => {
      // Fallback a terminal si open_url falla
      invoke('run_terminal', { command: `xdg-open "${cleanPath}"` }).catch(() => {});
    });
  };

  const fileName = isDataUrl
    ? 'captura_vision.jpg'
    : (cleanPath.split('/').pop() || 'enigma_creative.png');

  return (
    <>
      <div className="w-full my-3 group relative select-none">
        {/* Contenedor Exterior con Estética Liquid Glass */}
        <div className="relative overflow-hidden rounded-2xl bg-gradient-to-b from-white/[0.09] via-white/[0.04] to-black/60 p-2.5 backdrop-blur-2xl border border-white/15 shadow-[0_12px_40px_rgba(0,0,0,0.45),inset_0_1px_1px_rgba(255,255,255,0.25)] transition-all duration-300 hover:border-white/30 hover:shadow-[0_16px_48px_rgba(184,42,42,0.15),inset_0_1px_2px_rgba(255,255,255,0.35)]">
          {/* Brillo especular superior ("Liquid Glass Sheen") */}
          <div className="pointer-events-none absolute inset-x-0 top-0 h-16 bg-gradient-to-b from-white/[0.12] to-transparent opacity-80" />

          {/* Barra de cabecera de la tarjeta */}
          <div className="flex items-center justify-between px-2 py-1.5 mb-2 border-b border-white/[0.08]">
            <div className="flex items-center gap-2 min-w-0">
              <div className="w-6 h-6 rounded-lg bg-[#b82a2a]/20 border border-[#b82a2a]/40 flex items-center justify-center text-[#d43b3b] shadow-inner shrink-0">
                {isVision ? (
                  <Eye className="w-3.5 h-3.5" />
                ) : (
                  <Sparkles className="w-3.5 h-3.5 animate-pulse" />
                )}
              </div>
              <div className="flex flex-col min-w-0">
                <span className="text-[11px] font-semibold text-white tracking-wide truncate flex items-center gap-1.5">
                  {isVision ? 'Enigma Vision' : 'Enigma Creative'}
                  <span className="text-[9px] font-mono text-[#d43b3b] bg-[#b82a2a]/15 px-1.5 py-0.2 rounded border border-[#b82a2a]/30">
                    {isVision ? 'Multimodal Wayland' : 'Stable Diffusion'}
                  </span>
                </span>
                <span className="text-[10px] text-white/40 font-mono truncate">
                  {isVision ? (altText || 'Captura de pantalla') : fileName}
                </span>
              </div>
            </div>

            {/* Acciones de la tarjeta */}
            <div className="flex items-center gap-1 shrink-0">
              <button
                type="button"
                onClick={handleCopyPath}
                title="Copiar ruta del archivo"
                className="p-1.5 rounded-lg text-white/50 hover:text-white hover:bg-white/10 transition-colors cursor-pointer"
              >
                {copied ? (
                  <Check className="w-3.5 h-3.5 text-[#EF4444]" />
                ) : (
                  <Copy className="w-3.5 h-3.5" />
                )}
              </button>
              <button
                type="button"
                onClick={handleOpenExternal}
                title="Abrir con visor de imágenes del sistema"
                className="p-1.5 rounded-lg text-white/50 hover:text-white hover:bg-white/10 transition-colors cursor-pointer"
              >
                <ExternalLink className="w-3.5 h-3.5" />
              </button>
              <button
                type="button"
                onClick={() => setIsModalOpen(true)}
                title="Ver a pantalla completa"
                className="p-1.5 rounded-lg text-white/50 hover:text-white hover:bg-white/10 transition-colors cursor-pointer"
              >
                <Maximize2 className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>

          {/* Área de la imagen con marco de vidrio */}
          <div
            onClick={() => setIsModalOpen(true)}
            className="relative overflow-hidden rounded-xl bg-black/40 border border-white/10 flex items-center justify-center cursor-zoom-in min-h-[180px] max-h-[380px]"
          >
            {/* Esqueleto shimmer de carga */}
            {isLoading && !hasError && (
              <div className="absolute inset-0 flex flex-col items-center justify-center bg-white/[0.03] animate-pulse">
                <ImageIcon className="w-8 h-8 text-white/20 mb-2" />
                <span className="text-xs text-white/40 font-mono">Cargando render local...</span>
              </div>
            )}

            {hasError ? (
              <div className="p-6 text-center flex flex-col items-center justify-center">
                <span className="text-[#b82a2a] text-xs font-mono mb-1">⚠️ Error al cargar vista previa</span>
                <span className="text-white/40 text-[11px] font-mono select-text truncate max-w-xs">{cleanPath}</span>
              </div>
            ) : (
              <img
                src={displaySrc || (isDirectUrl ? cleanPath : (cleanPath ? convertFileSrc(cleanPath) : ''))}
                alt={altText}
                onLoad={() => setIsLoading(false)}
                onError={() => {
                  if (isDirectUrl) {
                    setHasError(true);
                    setIsLoading(false);
                    return;
                  }
                  // Reintentar vía backend si aún no cargó
                  invoke<string>('load_image_asset', { filePath: cleanPath })
                    .then((b64) => {
                      if (b64) {
                        setDisplaySrc(b64);
                        setIsLoading(false);
                      } else {
                        setHasError(true);
                        setIsLoading(false);
                      }
                    })
                    .catch(() => {
                      setHasError(true);
                      setIsLoading(false);
                    });
                }}
                className={`w-full max-h-[380px] object-contain transition-all duration-300 group-hover:scale-[1.01] ${
                  isLoading ? 'opacity-0' : 'opacity-100'
                }`}
              />
            )}

            {/* Overlay sutil al pasar el cursor */}
            <div className="pointer-events-none absolute inset-0 bg-gradient-to-t from-black/40 via-transparent to-transparent opacity-0 group-hover:opacity-100 transition-opacity flex items-end p-2.5">
              <span className="text-[11px] text-white/90 font-medium drop-shadow-md">
                Click para ampliar
              </span>
            </div>
          </div>

          {/* Pie de foto / Prompt descriptivo si existe */}
          {caption && (
            <div className="mt-2 px-2 py-1 text-xs text-white/80 font-light leading-relaxed select-text border-t border-white/[0.05]">
              <span className="text-[#b82a2a] font-mono text-[10px] mr-1.5 uppercase tracking-wider font-semibold">Prompt:</span>
              <span>{caption}</span>
            </div>
          )}
        </div>
      </div>

      {/* Modal / Lightbox de pantalla completa con estilo Liquid Glass */}
      {isModalOpen && (
        <div
          onClick={() => setIsModalOpen(false)}
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-xl p-4 animate-in fade-in duration-200"
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="relative max-w-4xl max-h-[90vh] overflow-hidden rounded-3xl bg-black/70 border border-white/20 p-3 shadow-2xl backdrop-blur-2xl flex flex-col"
          >
            <div className="flex items-center justify-between px-3 py-2 border-b border-white/10 mb-2">
              <div className="flex items-center gap-2">
                <Sparkles className="w-4 h-4 text-[#b82a2a]" />
                <span className="text-sm font-semibold text-white">{fileName}</span>
              </div>
              <button
                type="button"
                onClick={() => setIsModalOpen(false)}
                className="p-1 rounded-full text-white/50 hover:text-white hover:bg-white/10 transition-colors"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="overflow-auto flex items-center justify-center max-h-[75vh]">
              <img
                src={displaySrc || (isDirectUrl ? cleanPath : (cleanPath ? convertFileSrc(cleanPath) : ''))}
                alt={altText}
                className="max-h-[75vh] w-auto object-contain rounded-xl shadow-2xl"
              />
            </div>

            {caption && (
              <div className="mt-2.5 px-3 py-1.5 text-xs text-white/80 font-light border-t border-white/10">
                <span className="text-[#b82a2a] font-mono text-[11px] mr-1 font-semibold">Prompt:</span>
                <span>{caption}</span>
              </div>
            )}
          </div>
        </div>
      )}
    </>
  );
};

export default LiquidGlassImageCard;
