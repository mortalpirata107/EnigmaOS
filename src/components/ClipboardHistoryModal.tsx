import React, { useState, useEffect, useMemo, useRef } from 'react';
import { motion } from 'framer-motion';
import { invoke } from '@tauri-apps/api/core';
import {
  Search,
  Copy,
  Check,
  Trash2,
  X,
  Code2,
  Globe,
  Image as ImageIcon,
  Clipboard,
  Clock,
  Sparkles,
  ExternalLink,
} from 'lucide-react';
import { ClipboardRecord } from './SmartClipboardPill';

interface ClipboardHistoryModalProps {
  isOpen: boolean;
  onClose: () => void;
}

type ContentFilter = 'all' | 'image' | 'code' | 'url' | 'text' | 'color';

// Palabras clave para resaltado de sintaxis ligero
const CODE_KEYWORDS = new Set([
  'const', 'let', 'var', 'function', 'return', 'import', 'export', 'from',
  'class', 'extends', 'if', 'else', 'for', 'while', 'switch', 'case', 'break',
  'try', 'catch', 'finally', 'async', 'await', 'fn', 'def', 'pub', 'struct',
  'enum', 'impl', 'mut', 'match', 'type', 'interface', 'true', 'false', 'null',
  'undefined', 'self', 'Self', 'None', 'Some', 'Ok', 'Err', 'echo', 'sudo'
]);

function tokenizeCodeChunk(text: string): React.ReactNode[] {
  const regex = /("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`|\b\d+(?:\.\d+)?\b|\b[A-Za-z_$][A-Za-z0-9_$]*\b|[^\sA-Za-z0-9_$"'`]+|\s+)/g;
  const parts: React.ReactNode[] = [];
  let match;
  let key = 0;

  while ((match = regex.exec(text)) !== null) {
    const val = match[0];
    if (val.startsWith('"') || val.startsWith("'") || val.startsWith('`')) {
      parts.push(<span key={key++} className="text-emerald-300 font-mono">{val}</span>);
    } else if (CODE_KEYWORDS.has(val)) {
      parts.push(<span key={key++} className="text-purple-400 font-semibold font-mono">{val}</span>);
    } else if (/^\d+(\.\d+)?$/.test(val)) {
      parts.push(<span key={key++} className="text-amber-300 font-mono">{val}</span>);
    } else if (/^[A-Z][A-Za-z0-9_$]*$/.test(val)) {
      parts.push(<span key={key++} className="text-cyan-300 font-mono">{val}</span>);
    } else {
      parts.push(<span key={key++} className="text-white/90 font-mono">{val}</span>);
    }
  }
  return parts.length > 0 ? parts : [<span key="empty">{text}</span>];
}

function renderSyntaxCode(code: string): React.ReactNode {
  const normalized = code.replace(/\\r\\n/g, '\n').replace(/\\n/g, '\n').replace(/\\t/g, '  ');
  const lines = normalized.slice(0, 600).split('\n');
  const previewLines = lines.slice(0, 5);

  return (
    <div className="flex flex-col space-y-1 font-mono text-[11px] leading-relaxed select-text">
      {previewLines.map((line, idx) => {
        const commentIdx = line.indexOf('//');
        const hashIdx = line.indexOf('#');
        const firstComment = commentIdx !== -1 && hashIdx !== -1
          ? Math.min(commentIdx, hashIdx)
          : (commentIdx !== -1 ? commentIdx : hashIdx);

        let nodes: React.ReactNode[];
        if (firstComment !== -1) {
          const before = line.slice(0, firstComment);
          const comment = line.slice(firstComment);
          nodes = [
            ...tokenizeCodeChunk(before),
            <span key="comment" className="text-white/40 italic font-mono">{comment}</span>
          ];
        } else {
          nodes = tokenizeCodeChunk(line);
        }

        return (
          <div key={idx} className="flex items-start gap-2.5">
            <span className="w-5 text-right text-white/25 select-none text-[10px] shrink-0 font-mono pt-[1px]">
              {idx + 1}
            </span>
            <span className="flex-1 break-all whitespace-pre-wrap">
              {nodes}
            </span>
          </div>
        );
      })}
      {lines.length > 5 && (
        <span className="text-[10px] text-white/35 italic pl-7 pt-1">
          +{lines.length - 5} líneas más...
        </span>
      )}
    </div>
  );
}

export const ClipboardHistoryModal: React.FC<ClipboardHistoryModalProps> = ({ isOpen, onClose }) => {
  const [history, setHistory] = useState<ClipboardRecord[]>([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [activeTab, setActiveTab] = useState<ContentFilter>('all');
  const [copiedId, setCopiedId] = useState<number | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  const fetchHistory = async () => {
    setIsLoading(true);
    try {
      const records = await invoke<ClipboardRecord[]>('get_clipboard_history', { limit: 30 });
      setHistory(records || []);
    } catch (err) {
      console.error('[ClipboardHistory] Error fetching records:', err);
    } finally {
      setIsLoading(false);
    }
  };

  const modalRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (isOpen) {
      fetchHistory();
    }
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) return;

    const handlePointerDown = (e: MouseEvent | TouchEvent) => {
      if (modalRef.current && !modalRef.current.contains(e.target as Node)) {
        onClose();
      }
    };

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' || (e.metaKey && (e.key === 'v' || e.key === 'V'))) {
        onClose();
      }
    };

    document.addEventListener('pointerdown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [isOpen, onClose]);

  const counts = useMemo(() => {
    const c: Record<ContentFilter, number> = {
      all: history.length,
      image: 0,
      code: 0,
      url: 0,
      text: 0,
      color: 0,
    };
    for (const item of history) {
      if (item.content_type in c) {
        c[item.content_type]++;
      }
    }
    return c;
  }, [history]);

  const filteredHistory = useMemo(() => {
    let list = history;
    if (activeTab !== 'all') {
      list = list.filter((item) => item.content_type === activeTab);
    }
    const q = searchQuery.toLowerCase().trim();
    if (!q) return list;
    return list.filter((item) => {
      const isImg = item.content_type === 'image';
      return (
        item.preview.toLowerCase().includes(q) ||
        item.meta_info.toLowerCase().includes(q) ||
        (!isImg && item.full_content.toLowerCase().includes(q))
      );
    });
  }, [history, activeTab, searchQuery]);

  const handleCopyAgain = async (item: ClipboardRecord) => {
    try {
      await invoke('copy_clipboard_item', { id: item.id });
      setCopiedId(item.id);
      setTimeout(() => setCopiedId(null), 1500);
    } catch {
      // Fallback a copy_to_clipboard
      try {
        await invoke('copy_to_clipboard', { text: item.full_content });
        setCopiedId(item.id);
        setTimeout(() => setCopiedId(null), 1500);
      } catch (err) {
        console.error('[ClipboardHistory] Error copying to clipboard:', err);
      }
    }
  };

  const handleDeleteItem = async (id: number, e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      await invoke('delete_clipboard_item', { id });
      setHistory((prev) => prev.filter((item) => item.id !== id));
    } catch (err) {
      console.error('[ClipboardHistory] Error deleting item:', err);
    }
  };

  const handleClearAll = async () => {
    try {
      await invoke('clear_clipboard_history');
      setHistory([]);
    } catch (err) {
      console.error('[ClipboardHistory] Error clearing history:', err);
    }
  };

  const formatTimestamp = (ts: number) => {
    const diffMs = Date.now() - ts;
    const diffSec = Math.floor(diffMs / 1000);
    if (diffSec < 60) return 'Hace un momento';
    const diffMin = Math.floor(diffSec / 60);
    if (diffMin < 60) return `Hace ${diffMin} min`;
    const diffHours = Math.floor(diffMin / 60);
    if (diffHours < 24) return `Hace ${diffHours} h`;
    return new Date(ts).toLocaleDateString([], { month: 'short', day: 'numeric' });
  };

  if (!isOpen) return null;

  return (
    <motion.div
      ref={modalRef}
      initial={{ opacity: 0, scale: 0.97 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={{ opacity: 0, scale: 0.97 }}
      transition={{ duration: 0.18 }}
      className="w-full h-full flex flex-col p-4 text-white select-none overflow-hidden bg-[#0B0B0E]"
    >
      {/* 1. Header con Título, Botón de Vaciar y Cerrar */}
      <div className="flex items-center justify-between pb-2.5 border-b border-white/10 shrink-0">
        <div className="flex items-center gap-2.5">
          <div className="w-7 h-7 rounded-lg bg-[var(--accent-color)]/20 border border-[var(--accent-border)]/40 flex items-center justify-center shadow-inner">
            <Clipboard className="w-4 h-4 text-[var(--accent-color)]" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h2 className="text-sm font-semibold tracking-wide text-white">Portapapeles Inteligente</h2>
              <span className="text-[10px] px-2 py-0.5 rounded-full bg-white/10 text-white/70 font-mono font-medium">
                {history.length} elementos
              </span>
            </div>
          </div>
        </div>

        <div className="flex items-center gap-2">
          {history.length > 0 && (
            <button
              onClick={handleClearAll}
              className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-[10px] text-white/50 hover:text-red-400 hover:bg-red-500/10 border border-transparent hover:border-red-500/20 transition-all font-medium"
              title="Vaciar todo el historial"
            >
              <Trash2 className="w-3 h-3" />
              <span>Vaciar</span>
            </button>
          )}

          <button
            onClick={onClose}
            className="w-7 h-7 rounded-lg flex items-center justify-center text-white/50 hover:text-white hover:bg-white/10 border border-transparent hover:border-white/10 transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* 2. Barra de Búsqueda y Filtros de Categoría */}
      <div className="flex flex-col gap-2 my-2.5 shrink-0">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-white/40" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Buscar en el portapapeles (código, imágenes, texto, urls)..."
            className="w-full bg-white/5 border border-white/10 rounded-xl pl-9 pr-3 py-1.5 text-xs text-white placeholder-white/40 focus:outline-none focus:border-[var(--accent-color)]/50 focus:bg-white/10 transition-all font-mono"
            autoFocus
          />
        </div>

        {/* Category Pills */}
        <div className="flex items-center gap-1.5 overflow-x-auto no-scrollbar py-0.5">
          <button
            onClick={() => setActiveTab('all')}
            className={`px-2.5 py-1 rounded-lg text-[10px] font-medium transition-all ${
              activeTab === 'all'
                ? 'bg-white/20 text-white border border-white/20 shadow-sm'
                : 'bg-white/5 text-white/60 hover:text-white hover:bg-white/10 border border-transparent'
            }`}
          >
            Todos ({counts.all})
          </button>
          {counts.code > 0 && (
            <button
              onClick={() => setActiveTab('code')}
              className={`flex items-center gap-1 px-2.5 py-1 rounded-lg text-[10px] font-medium transition-all ${
                activeTab === 'code'
                  ? 'neu-extruded text-[#EF4444] border-[#EF4444] shadow-sm'
                  : 'neu-inset text-white/60 hover:text-white'
              }`}
            >
              <Code2 className="w-3 h-3 text-[#EF4444]" />
              <span>Código ({counts.code})</span>
            </button>
          )}
          {counts.image > 0 && (
            <button
              onClick={() => setActiveTab('image')}
              className={`flex items-center gap-1 px-2.5 py-1 rounded-lg text-[10px] font-medium transition-all ${
                activeTab === 'image'
                  ? 'bg-purple-500/25 text-purple-300 border border-purple-500/40 shadow-sm'
                  : 'bg-white/5 text-white/60 hover:text-purple-300 hover:bg-white/10 border border-transparent'
              }`}
            >
              <ImageIcon className="w-3 h-3 text-purple-400" />
              <span>Imágenes ({counts.image})</span>
            </button>
          )}
          {counts.url > 0 && (
            <button
              onClick={() => setActiveTab('url')}
              className={`flex items-center gap-1 px-2.5 py-1 rounded-lg text-[10px] font-medium transition-all ${
                activeTab === 'url'
                  ? 'bg-cyan-500/25 text-cyan-300 border border-cyan-500/40 shadow-sm'
                  : 'bg-white/5 text-white/60 hover:text-cyan-300 hover:bg-white/10 border border-transparent'
              }`}
            >
              <Globe className="w-3 h-3 text-cyan-400" />
              <span>Enlaces ({counts.url})</span>
            </button>
          )}
          {counts.color > 0 && (
            <button
              onClick={() => setActiveTab('color')}
              className={`flex items-center gap-1 px-2.5 py-1 rounded-lg text-[10px] font-medium transition-all ${
                activeTab === 'color'
                  ? 'bg-pink-500/25 text-pink-300 border border-pink-500/40 shadow-sm'
                  : 'bg-white/5 text-white/60 hover:text-pink-300 hover:bg-white/10 border border-transparent'
              }`}
            >
              <Sparkles className="w-3 h-3 text-pink-400" />
              <span>Colores ({counts.color})</span>
            </button>
          )}
          {counts.text > 0 && (
            <button
              onClick={() => setActiveTab('text')}
              className={`flex items-center gap-1 px-2.5 py-1 rounded-lg text-[10px] font-medium transition-all ${
                activeTab === 'text'
                  ? 'bg-amber-500/25 text-amber-300 border border-amber-500/40 shadow-sm'
                  : 'bg-white/5 text-white/60 hover:text-amber-300 hover:bg-white/10 border border-transparent'
              }`}
            >
              <Clipboard className="w-3 h-3 text-amber-400" />
              <span>Texto ({counts.text})</span>
            </button>
          )}
        </div>
      </div>

      {/* 3. Lista Scrollable Enriquecida */}
      <div className="flex-1 overflow-y-auto space-y-2.5 pr-1.5 custom-scrollbar min-h-0">
        {isLoading ? (
          <div className="h-48 flex items-center justify-center text-xs text-white/40 font-mono">
            Cargando historial del portapapeles...
          </div>
        ) : filteredHistory.length === 0 ? (
          <div className="h-48 flex flex-col items-center justify-center text-center p-4">
            <Clipboard className="w-10 h-10 text-white/15 mb-2" />
            <p className="text-xs text-white/50 font-medium">
              {searchQuery ? 'No se encontraron resultados para la búsqueda' : 'El portapapeles está vacío'}
            </p>
          </div>
        ) : (
          <div className="flex flex-col space-y-2.5">
            {filteredHistory.map((item) => {
              const isCopied = copiedId === item.id;
              const isImage = item.content_type === 'image';
              const isCode = item.content_type === 'code';
              const isColor = item.content_type === 'color';
              const isUrl = item.content_type === 'url';

              return (
                <div
                  key={item.id}
                  onClick={() => handleCopyAgain(item)}
                  className={`group relative flex flex-col p-3 rounded-2xl transition-all cursor-pointer ${
                    isCopied
                      ? 'neu-extruded border-[#EF4444]/60 shadow-[0_0_15px_rgba(239,68,68,0.25)]'
                      : 'neu-extruded hover:border-[#EF4444]/40'
                  }`}
                >
                  {/* Top Bar de la Card: Icono + Categoría + Meta + Timestamp + Botones */}
                  <div className="flex items-center justify-between gap-2 mb-2">
                    <div className="flex items-center gap-2 min-w-0">
                      {isColor && (
                        <div
                          className="w-5 h-5 rounded-full border border-white/40 shadow-sm shrink-0"
                          style={{ backgroundColor: item.preview }}
                        />
                      )}
                      {isCode && (
                        <div className="w-5 h-5 rounded-lg neu-inset flex items-center justify-center shrink-0">
                          <Code2 className="w-3 h-3 text-[#EF4444]" />
                        </div>
                      )}
                      {isUrl && (
                        <div className="w-5 h-5 rounded-lg neu-inset flex items-center justify-center shrink-0">
                          <Globe className="w-3 h-3 text-[#EF4444]" />
                        </div>
                      )}
                      {isImage && (
                        <div className="w-5 h-5 rounded-lg neu-inset flex items-center justify-center shrink-0">
                          <ImageIcon className="w-3 h-3 text-[#EF4444]" />
                        </div>
                      )}
                      {!isColor && !isCode && !isUrl && !isImage && (
                        <div className="w-5 h-5 rounded-lg neu-inset flex items-center justify-center shrink-0">
                          <Clipboard className="w-3 h-3 text-[#EF4444]" />
                        </div>
                      )}

                      <span className="text-[10px] font-mono font-bold uppercase tracking-wider text-white/60">
                        {isColor
                          ? 'Color'
                          : isCode
                          ? 'Código'
                          : isUrl
                          ? 'Enlace'
                          : isImage
                          ? 'Imagen'
                          : 'Texto'}
                      </span>

                      <span className="text-[10px] text-white/30">•</span>

                      <span className="text-[10px] text-white/50 font-mono truncate max-w-[200px]">
                        {item.meta_info}
                      </span>

                      <span className="text-[10px] text-white/30">•</span>

                      <span className="flex items-center gap-1 text-[10px] text-white/40 font-mono shrink-0">
                        <Clock className="w-2.5 h-2.5" />
                        {formatTimestamp(item.timestamp)}
                      </span>
                    </div>

                    {/* Acciones flotantes */}
                    <div className="flex items-center gap-1.5 shrink-0">
                      {/* Botón de copiar en un clic */}
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          handleCopyAgain(item);
                        }}
                        className={`flex items-center gap-1 px-2.5 py-1 rounded-lg text-[10px] font-mono font-semibold transition-all ${
                          isCopied
                            ? 'neu-extruded text-[#EF4444] border-[#EF4444]'
                            : 'neu-inset text-white/80 hover:text-white'
                        }`}
                        title="Copiar en un clic"
                      >
                        {isCopied ? (
                          <>
                            <Check className="w-3 h-3 text-[#EF4444]" />
                            <span>¡Copiado!</span>
                          </>
                        ) : (
                          <>
                            <Copy className="w-3 h-3 text-white/70" />
                            <span>Copiar</span>
                          </>
                        )}
                      </button>

                      {/* Botón de eliminar */}
                      <button
                        onClick={(e) => handleDeleteItem(item.id, e)}
                        className="p-1 rounded-lg bg-white/5 hover:bg-red-500/20 border border-white/5 hover:border-red-500/30 text-white/40 hover:text-red-400 transition-all"
                        title="Eliminar de historial"
                      >
                        <Trash2 className="w-3 h-3" />
                      </button>
                    </div>
                  </div>

                  {/* Cuerpo enriquecido del item */}
                  {isImage ? (
                    /* Vista previa de Imagen real */
                    <div className="mt-1 flex flex-col gap-2">
                      <div className="relative w-full min-h-[60px] max-h-56 rounded-xl overflow-hidden border border-white/10 bg-black/60 p-2 flex items-center justify-center group/img">
                        <img
                          src={item.full_content.startsWith('data:') ? item.full_content : item.preview}
                          alt="Vista previa de portapapeles"
                          className="max-h-52 max-w-full rounded-lg object-contain shadow-md"
                          style={{ minHeight: '36px', minWidth: '36px' }}
                          loading="lazy"
                        />
                        <div className="absolute bottom-2 left-2 px-2 py-0.5 rounded-md bg-black/80 backdrop-blur-md border border-white/15 text-[10px] font-mono text-white/90">
                          {item.meta_info || 'PNG'}
                        </div>
                      </div>
                    </div>
                  ) : isCode ? (
                    /* Vista enriquecida de Código con Resaltado de Sintaxis */
                    <div className="mt-1 rounded-xl bg-[#0d1117]/90 border border-white/10 p-2.5 overflow-hidden">
                      {renderSyntaxCode(item.full_content)}
                    </div>
                  ) : isUrl ? (
                    /* Vista de Enlace */
                    <div className="mt-1 flex items-center justify-between gap-3 p-2 rounded-xl bg-cyan-500/10 border border-cyan-500/20 text-cyan-200">
                      <span className="text-xs font-mono truncate select-text">
                        {item.full_content}
                      </span>
                      <ExternalLink className="w-3.5 h-3.5 text-cyan-400 shrink-0" />
                    </div>
                  ) : isColor ? (
                    /* Vista de Color */
                    <div className="mt-1 flex items-center gap-3 p-2 rounded-xl bg-white/5 border border-white/10">
                      <div
                        className="w-10 h-10 rounded-lg border border-white/30 shadow-md shrink-0"
                        style={{ backgroundColor: item.preview }}
                      />
                      <div className="flex flex-col">
                        <span className="text-sm font-mono font-bold text-white select-text">
                          {item.full_content}
                        </span>
                        <span className="text-[10px] text-white/40 font-mono">
                          Color hexadecimal detectado
                        </span>
                      </div>
                    </div>
                  ) : (
                    /* Vista de Texto plano */
                    <p className="mt-0.5 text-xs text-white/80 line-clamp-3 select-text font-sans leading-relaxed break-words">
                      {item.full_content}
                    </p>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </motion.div>
  );
};
