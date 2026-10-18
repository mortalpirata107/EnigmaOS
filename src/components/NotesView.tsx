import React, { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';

export interface NoteRecord {
  id: number;
  title: string;
  content: string;
  timestamp: string;
}

export const NotesView: React.FC = () => {
  const [notes, setNotes] = useState<NoteRecord[]>([]);
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [telegramNotice, setTelegramNotice] = useState<string | null>(null);

  const fetchNotes = async () => {
    try {
      const records = await invoke<NoteRecord[]>('get_notes');
      setNotes(records);
    } catch (err) {
      console.error('[NotesView] Error fetching notes:', err);
    }
  };

  useEffect(() => {
    fetchNotes();

    let unlisten: (() => void) | undefined;
    listen('refresh-notes', () => {
      fetchNotes();
    })
      .then((unsub) => {
        unlisten = unsub;
      })
      .catch((err) => console.error('[NotesView] Error listening to refresh-notes:', err));

    return () => {
      if (unlisten) unlisten();
    };
  }, []);

  const handleCreateNote = async (e: React.FormEvent, sendToTelegram = false) => {
    e.preventDefault();
    const cleanContent = content.trim();
    if (!cleanContent || isSubmitting) return;

    const cleanTitle = title.trim() || cleanContent.slice(0, 32);

    setIsSubmitting(true);
    try {
      await invoke('add_note', {
        title: cleanTitle,
        content: cleanContent,
      });

      if (sendToTelegram) {
        await invoke('send_telegram_notification', {
          message: `📝 *${cleanTitle}*\n\n${cleanContent}`,
        });
        showTelegramNotice('¡Nota enviada a tu Telegram!');
      }

      setTitle('');
      setContent('');
      await fetchNotes();
    } catch (err) {
      console.error('[NotesView] Error creating note:', err);
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleDeleteNote = async (id: number, e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      await invoke('delete_note', { id });
      await fetchNotes();
    } catch (err) {
      console.error('[NotesView] Error deleting note:', err);
    }
  };

  const handleSendToTelegram = async (note: NoteRecord, e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      await invoke('send_telegram_notification', {
        message: `📌 *${note.title}*\n\n${note.content}`,
      });
      showTelegramNotice(`Alerta enviada a Telegram: "${note.title}"`);
    } catch (err) {
      console.error('[NotesView] Error sending note to Telegram:', err);
    }
  };

  const showTelegramNotice = (msg: string) => {
    setTelegramNotice(msg);
    setTimeout(() => {
      setTelegramNotice(null);
    }, 3500);
  };

  const filteredNotes = notes.filter(
    (n) =>
      n.title.toLowerCase().includes(searchQuery.toLowerCase()) ||
      n.content.toLowerCase().includes(searchQuery.toLowerCase())
  );

  return (
    <motion.div
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -6 }}
      transition={{ duration: 0.15 }}
      className="w-full flex flex-col max-h-[400px] overflow-y-auto scrollbar-thin scrollbar-thumb-white/10 pr-1 space-y-3"
    >
      {/* Toast Feedback de Telegram */}
      <AnimatePresence>
        {telegramNotice && (
          <motion.div
            initial={{ opacity: 0, y: -8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            className="flex items-center gap-2 neu-inset text-white text-xs px-3 py-1.5 rounded-xl shadow-lg"
          >
            <span className="w-1.5 h-1.5 rounded-full neu-led-red animate-pulse" />
            <span>{telegramNotice}</span>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Formulario de Creación de Nota Rápida (Estilo Liquid Glass) */}
      <form
        onSubmit={(e) => handleCreateNote(e, false)}
        className="bg-black border border-white/10 focus-within:border-[#b82a2a]/40 rounded-2xl p-3 flex flex-col gap-2.5 backdrop-blur-md shadow-[0_4px_20px_rgba(0,0,0,0.8)] shrink-0 transition-colors"
      >
        <div className="flex items-center justify-between gap-2">
          <input
            type="text"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Título (opcional)..."
            className="flex-1 bg-transparent border-b border-white/10 focus:border-[#b82a2a]/60 pb-1 text-xs text-white placeholder-white/30 outline-none font-medium"
          />
          <span className="text-[10px] font-mono text-white/40">Notas Rápidas</span>
        </div>

        <textarea
          rows={2}
          value={content}
          onChange={(e) => setContent(e.target.value)}
          placeholder="Escribe una idea, pendiente o recordatorio rápido..."
          className="w-full bg-black/60 border border-white/10 rounded-xl p-2 text-xs text-white placeholder-white/30 outline-none resize-none focus:border-[#b82a2a]/60 leading-relaxed font-sans"
        />

        <div className="flex items-center justify-between pt-1">
          <div className="text-[11px] text-white/40">
            {notes.length} nota{notes.length === 1 ? '' : 's'} guardada{notes.length === 1 ? '' : 's'}
          </div>

          <div className="flex items-center gap-2">
            <button
              type="button"
              disabled={!content.trim() || isSubmitting}
              onClick={(e) => handleCreateNote(e, true)}
              title="Guardar y notificar en mi teléfono móvil vía Telegram"
              className="flex items-center gap-1.5 bg-blue-500/10 hover:bg-blue-500/20 text-blue-300 hover:text-white border border-blue-500/30 px-2.5 py-1 rounded-xl text-xs font-medium transition-all disabled:opacity-30 cursor-pointer backdrop-blur-md"
            >
              <span>📱</span>
              <span className="text-[11px]">Guardar + Telegram</span>
            </button>

            <button
              type="submit"
              disabled={!content.trim() || isSubmitting}
              className="flex items-center gap-1.5 bg-[#b82a2a] hover:bg-[#b82a2a]/90 text-white px-3 py-1 rounded-xl text-xs font-medium transition-all disabled:opacity-30 cursor-pointer shadow-[0_0_12px_rgba(184,42,42,0.4)]"
            >
              <span>+</span>
              <span>Guardar</span>
            </button>
          </div>
        </div>
      </form>

      {/* Buscador de notas */}
      {notes.length > 2 && (
        <div className="relative shrink-0">
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Buscar en tus notas..."
            className="w-full bg-black/60 border border-white/10 rounded-xl px-3 py-1 text-xs text-white placeholder-white/30 outline-none focus:border-[#b82a2a]/60"
          />
        </div>
      )}

      {/* Lista de Tarjetas de Notas */}
      <div className="space-y-2">
        {filteredNotes.length === 0 ? (
          <div className="text-center py-8 text-xs text-white/40 border border-dashed border-white/10 rounded-2xl">
            {searchQuery ? 'No se encontraron notas coincidentes.' : 'No tienes notas rápidas. ¡Crea la primera arriba o pídela a Enigma!'}
          </div>
        ) : (
          filteredNotes.map((note) => (
            <div
              key={note.id}
              className="group relative bg-black border border-white/10 hover:border-[#b82a2a]/40 rounded-2xl p-3 backdrop-blur-md transition-all flex flex-col justify-between gap-1.5"
            >
              <div className="flex items-start justify-between gap-2">
                <div className="flex items-center gap-2 min-w-0">
                  <span className="text-[#b82a2a] text-xs">📝</span>
                  <h4 className="text-xs font-semibold text-white truncate">{note.title}</h4>
                </div>

                <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                  <button
                    type="button"
                    onClick={(e) => handleSendToTelegram(note, e)}
                    title="Reenviar como alerta a Telegram en tu móvil"
                    className="p-1 text-white/40 hover:text-blue-400 hover:bg-blue-500/10 rounded-lg transition-colors cursor-pointer"
                  >
                    <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={2}
                        d="M12 18h.01M8 21h8a2 2 0 002-2V5a2 2 0 00-2-2H8a2 2 0 00-2 2v14a2 2 0 002 2z"
                      />
                    </svg>
                  </button>

                  <button
                    type="button"
                    onClick={(e) => handleDeleteNote(note.id, e)}
                    title="Eliminar nota"
                    className="p-1 text-white/40 hover:text-[#b82a2a] hover:bg-[#b82a2a]/10 rounded-lg transition-colors cursor-pointer"
                  >
                    <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={2}
                        d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"
                      />
                    </svg>
                  </button>
                </div>
              </div>

              <p className="text-xs text-white/80 whitespace-pre-wrap leading-relaxed font-sans">{note.content}</p>

              <div className="flex items-center justify-between pt-1 border-t border-white/5 text-[10px] text-white/30 font-mono">
                <span>{note.timestamp}</span>
                <span className="opacity-0 group-hover:opacity-100 transition-opacity text-white/40">ID: #{note.id}</span>
              </div>
            </div>
          ))
        )}
      </div>
    </motion.div>
  );
};
