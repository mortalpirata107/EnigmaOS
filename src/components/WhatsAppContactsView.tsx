import React, { useState, useMemo, useRef, useEffect, useCallback } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { invoke } from '@tauri-apps/api/core';
import { WhatsAppContact } from './EnigmaHub';

interface WhatsAppContactsViewProps {
  contacts: WhatsAppContact[];
  onContactsDeleted: (deletedIds: string[]) => void;
  onContactAdded: () => void;
}

export const WhatsAppContactsView: React.FC<WhatsAppContactsViewProps> = ({
  contacts,
  onContactsDeleted,
  onContactAdded,
}) => {
  const [searchQuery, setSearchQuery] = useState('');
  const [filterType, setFilterType] = useState<'all' | 'unnamed' | 'groups' | 'named' | 'selected'>('all');
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [isDeleting, setIsDeleting] = useState(false);
  const [showConfirmModal, setShowConfirmModal] = useState(false);
  const [toastMessage, setToastMessage] = useState<string | null>(null);

  // Formulario para añadir contacto manual
  const [isAdding, setIsAdding] = useState(false);
  const [newName, setNewName] = useState('');
  const [newPhone, setNewPhone] = useState('');

  // Drag-to-select (sweep selection) refs
  const isMouseDownRef = useRef(false);
  const dragModeRef = useRef<'select' | 'deselect'>('select');

  // Cancelar arrastre al soltar el ratón en cualquier parte de la ventana
  useEffect(() => {
    const handleMouseUp = () => {
      isMouseDownRef.current = false;
    };
    window.addEventListener('mouseup', handleMouseUp);
    return () => window.removeEventListener('mouseup', handleMouseUp);
  }, []);

  // Clasificación de contactos
  const isGroupOrWeird = useCallback((c: WhatsAppContact) => {
    const id = c.id.toLowerCase();
    const name = c.name.toLowerCase();
    return id.includes('@g.us') || id.includes('@broadcast') || name.includes('grupo') || name.includes('group');
  }, []);

  const isUnnamed = useCallback((c: WhatsAppContact) => {
    const clean = c.name.trim();
    return /^[+]?[\d\s\-()]+$/.test(clean) || clean.startsWith('+34') || clean.startsWith('34');
  }, []);

  // Filtrado reactivo en tiempo real
  const filteredContacts = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    const queryDigits = query.replace(/\D/g, '');

    return contacts.filter((c) => {
      // Filtros por pestaña
      if (filterType === 'unnamed' && !isUnnamed(c)) return false;
      if (filterType === 'groups' && !isGroupOrWeird(c)) return false;
      if (filterType === 'named' && (isUnnamed(c) || isGroupOrWeird(c))) return false;
      if (filterType === 'selected' && !selectedIds.has(c.id)) return false;

      // Búsqueda por texto o números
      if (query) {
        const nameMatch = c.name.toLowerCase().includes(query);
        const idMatch = c.id.toLowerCase().includes(query);
        const rawPhone = c.id.replace(/\D/g, '');
        const phoneMatch = queryDigits ? rawPhone.includes(queryDigits) : false;
        return nameMatch || idMatch || phoneMatch;
      }

      return true;
    });
  }, [contacts, searchQuery, filterType, selectedIds, isUnnamed, isGroupOrWeird]);

  // Contadores para las etiquetas
  const counts = useMemo(() => {
    let unnamed = 0;
    let groups = 0;
    let named = 0;
    for (const c of contacts) {
      if (isGroupOrWeird(c)) {
        groups++;
      } else if (isUnnamed(c)) {
        unnamed++;
      } else {
        named++;
      }
    }
    return { unnamed, groups, named, total: contacts.length };
  }, [contacts, isGroupOrWeird, isUnnamed]);

  // Drag-to-select: Deslizamiento vertical del ratón sobre filas
  const handleRowMouseDown = (contactId: string, e: React.MouseEvent) => {
    e.preventDefault();
    isMouseDownRef.current = true;
    const isCurrentlySelected = selectedIds.has(contactId);
    dragModeRef.current = isCurrentlySelected ? 'deselect' : 'select';

    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (isCurrentlySelected) {
        next.delete(contactId);
      } else {
        next.add(contactId);
      }
      return next;
    });
  };

  const handleRowMouseEnter = (contactId: string) => {
    if (!isMouseDownRef.current) return;

    setSelectedIds((prev) => {
      if (dragModeRef.current === 'select') {
        if (prev.has(contactId)) return prev;
        const next = new Set(prev);
        next.add(contactId);
        return next;
      } else {
        if (!prev.has(contactId)) return prev;
        const next = new Set(prev);
        next.delete(contactId);
        return next;
      }
    });
  };

  // Acciones en lote
  const selectAllVisible = () => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      filteredContacts.forEach((c) => next.add(c.id));
      return next;
    });
  };

  const deselectAll = () => {
    setSelectedIds(new Set());
  };

  const invertSelectionVisible = () => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      filteredContacts.forEach((c) => {
        if (next.has(c.id)) {
          next.delete(c.id);
        } else {
          next.add(c.id);
        }
      });
      return next;
    });
  };

  // Ejecución de borrado permanente garantizado
  const executePermanentDelete = async (idsToDelete: string[]) => {
    if (idsToDelete.length === 0) return;
    setIsDeleting(true);

    try {
      // 1. Borrar en SQLite y registrar en deleted_whatsapp_contacts
      await invoke('delete_whatsapp_contacts_batch', { ids: idsToDelete });

      // 2. Notificar al microservicio de WhatsApp Web si está encendido
      try {
        await fetch('http://127.0.0.1:3030/contacts/delete-batch', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ids: idsToDelete }),
        });
      } catch (_) {}

      // 3. Actualizar estado local
      onContactsDeleted(idsToDelete);

      setSelectedIds((prev) => {
        const next = new Set(prev);
        idsToDelete.forEach((id) => next.delete(id));
        return next;
      });

      setShowConfirmModal(false);
      setToastMessage(`✓ ${idsToDelete.length} contactos eliminados permanentemente.`);
      setTimeout(() => setToastMessage(null), 3500);
    } catch (err: any) {
      console.error('[WhatsAppContactsView] Error al eliminar:', err);
      setToastMessage(`❌ Error: ${err?.toString() || 'Desconocido'}`);
      setTimeout(() => setToastMessage(null), 4000);
    } finally {
      setIsDeleting(false);
    }
  };

  // Añadir contacto manual
  const handleAddSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newName.trim() || !newPhone.trim()) return;
    try {
      await invoke('add_whatsapp_contact', {
        id: newPhone.trim(),
        name: newName.trim(),
      });
      setNewName('');
      setNewPhone('');
      setIsAdding(false);
      onContactAdded();
      setToastMessage('✓ Contacto guardado correctamente.');
      setTimeout(() => setToastMessage(null), 3000);
    } catch (err: any) {
      console.error('[WhatsAppContactsView] Error al guardar:', err);
    }
  };

  return (
    <div className="w-full flex flex-col space-y-2.5 select-none">
      {/* =========================================================================
          CABECERA DE INFORMACIÓN Y BÚSQUEDA
          ========================================================================= */}
      <div className="flex flex-col gap-2 bg-white/[0.02] border border-white/10 rounded-2xl p-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className="text-sm">👥</span>
            <span className="text-xs font-bold text-white tracking-wide">
              Directorio de Contactos ({contacts.length})
            </span>
            {selectedIds.size > 0 && (
              <span className="px-2 py-0.5 rounded-full bg-[#b82a2a]/20 border border-[#b82a2a]/40 text-[#b82a2a] text-[10px] font-mono font-semibold animate-pulse">
                {selectedIds.size} seleccionados
              </span>
            )}
          </div>

          <button
            type="button"
            onClick={() => setIsAdding(!isAdding)}
            className="text-[10px] font-mono text-white/80 hover:text-[#EF4444] transition-colors cursor-pointer"
          >
            {isAdding ? '✕ Cancelar' : '+ Añadir contacto'}
          </button>
        </div>

        {/* Formulario desplegable para añadir contacto */}
        {isAdding && (
          <form onSubmit={handleAddSubmit} className="flex gap-2 pt-2 border-t border-red-950/40">
            <input
              type="text"
              placeholder="Nombre (ej. Juan)"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              className="flex-1 neu-inset rounded-xl px-2.5 py-1 text-xs text-white placeholder-white/30 focus:outline-none focus:border-[#EF4444]"
            />
            <input
              type="text"
              placeholder="Teléfono (+34...)"
              value={newPhone}
              onChange={(e) => setNewPhone(e.target.value)}
              className="w-32 neu-inset rounded-xl px-2.5 py-1 text-xs text-white placeholder-white/30 focus:outline-none focus:border-[#EF4444] font-mono"
            />
            <button
              type="submit"
              className="px-3 py-1 neu-extruded text-white hover:text-[#EF4444] rounded-xl text-xs font-mono transition-all cursor-pointer font-semibold"
            >
              Guardar
            </button>
          </form>
        )}

        {/* Input de Búsqueda reactivo */}
        <div className="relative w-full">
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Buscar por nombre o número (+34...)..."
            className="w-full neu-inset rounded-xl px-3 py-1.5 pl-8 text-xs text-white placeholder-white/30 focus:outline-none focus:border-[#EF4444] font-mono transition-all"
          />
          <span className="absolute left-2.5 top-1.5 text-white/30 text-xs">🔍</span>
          {searchQuery && (
            <button
              type="button"
              onClick={() => setSearchQuery('')}
              className="absolute right-2.5 top-1.5 text-white/40 hover:text-white text-xs cursor-pointer"
            >
              ✕
            </button>
          )}
        </div>

        {/* Pestañas de Filtro rápido */}
        <div className="flex items-center gap-1.5 overflow-x-auto pb-0.5 scrollbar-none">
          <button
            type="button"
            onClick={() => setFilterType('all')}
            className={`px-2.5 py-1 rounded-lg text-[10px] font-mono transition-all shrink-0 cursor-pointer ${
              filterType === 'all'
                ? 'bg-white/15 text-white border border-white/20 font-semibold'
                : 'bg-white/5 text-white/50 hover:text-white hover:bg-white/10 border border-transparent'
            }`}
          >
            Todos ({counts.total})
          </button>
          <button
            type="button"
            onClick={() => setFilterType('unnamed')}
            className={`px-2.5 py-1 rounded-lg text-[10px] font-mono transition-all shrink-0 cursor-pointer ${
              filterType === 'unnamed'
                ? 'bg-amber-500/20 text-amber-300 border border-amber-500/40 font-semibold'
                : 'bg-white/5 text-white/50 hover:text-white hover:bg-white/10 border border-transparent'
            }`}
            title="Contactos que no tienen nombre guardado (solo número de teléfono)"
          >
            📱 Solo Números ({counts.unnamed})
          </button>
          <button
            type="button"
            onClick={() => setFilterType('groups')}
            className={`px-2.5 py-1 rounded-lg text-[10px] font-mono transition-all shrink-0 cursor-pointer ${
              filterType === 'groups'
                ? 'bg-purple-500/20 text-purple-300 border border-purple-500/40 font-semibold'
                : 'bg-white/5 text-white/50 hover:text-white hover:bg-white/10 border border-transparent'
            }`}
            title="Grupos o canales"
          >
            👥 Grupos ({counts.groups})
          </button>
          <button
            type="button"
            onClick={() => setFilterType('named')}
            className={`px-2.5 py-1 rounded-lg text-[10px] font-mono transition-all shrink-0 cursor-pointer ${
              filterType === 'named'
                ? 'neu-extruded text-[#EF4444] border-[#EF4444] font-semibold'
                : 'neu-inset text-white/60 hover:text-white'
            }`}
          >
            👤 Con Nombre ({counts.named})
          </button>
          {selectedIds.size > 0 && (
            <button
              type="button"
              onClick={() => setFilterType('selected')}
              className={`px-2.5 py-1 rounded-lg text-[10px] font-mono transition-all shrink-0 cursor-pointer ${
                filterType === 'selected'
                  ? 'neu-extruded text-[#EF4444] border-[#EF4444] font-semibold shadow-[0_0_8px_rgba(239,68,68,0.4)]'
                  : 'neu-inset text-white/80 hover:text-white'
              }`}
            >
              ✓ Seleccionados ({selectedIds.size})
            </button>
          )}
        </div>
      </div>

      {/* =========================================================================
          BARRA DE ACCIONES MASIVAS
          ========================================================================= */}
      <div className="flex items-center justify-between gap-2 px-1">
        <div className="flex items-center gap-1.5 text-[10px] font-mono">
          <button
            type="button"
            onClick={selectAllVisible}
            className="px-2 py-0.5 rounded-md neu-extruded text-white/70 hover:text-white transition-colors cursor-pointer"
          >
            Marcar visibles ({filteredContacts.length})
          </button>
          <button
            type="button"
            onClick={invertSelectionVisible}
            className="px-2 py-0.5 rounded-md neu-extruded text-white/70 hover:text-white transition-colors cursor-pointer"
          >
            Invertir
          </button>
          {selectedIds.size > 0 && (
            <button
              type="button"
              onClick={deselectAll}
              className="px-2 py-0.5 rounded-md neu-extruded text-white/50 hover:text-white transition-colors cursor-pointer"
            >
              Desmarcar
            </button>
          )}
        </div>

        {/* Botón de borrado masivo permanente */}
        <button
          type="button"
          disabled={selectedIds.size === 0 || isDeleting}
          onClick={() => setShowConfirmModal(true)}
          className={`px-3 py-1 rounded-xl text-xs font-mono font-bold transition-all flex items-center gap-1.5 shadow-md ${
            selectedIds.size > 0
              ? 'neu-extruded text-[#EF4444] border-[#EF4444] cursor-pointer active:scale-95'
              : 'neu-inset text-white/20 cursor-not-allowed'
          }`}
        >
          <span>🗑️</span>
          <span>
            {isDeleting
              ? 'Borrando...'
              : selectedIds.size > 0
              ? `Eliminar (${selectedIds.size})`
              : 'Borrar'}
          </span>
        </button>
      </div>

      {/* Indicador Toast si existe */}
      {toastMessage && (
        <div className="px-3 py-1.5 rounded-xl neu-inset text-white text-xs font-mono font-medium flex items-center gap-2 animate-in fade-in">
          <span className="w-1.5 h-1.5 rounded-full neu-led-red animate-pulse" />
          <span>{toastMessage}</span>
        </div>
      )}

      {/* =========================================================================
          LISTA VERTICAL (1 CONTACTO / NOMBRE POR LÍNEA STRICTAMENTE)
          ========================================================================= */}
      <div className="flex flex-col gap-1.5 max-h-[380px] overflow-y-auto pr-1 scrollbar-thin scrollbar-thumb-white/10">
        {filteredContacts.length === 0 ? (
          <div className="py-12 flex flex-col items-center justify-center text-center text-white/40">
            <span className="text-2xl mb-1.5">🔍</span>
            <span className="text-xs font-medium text-white/60">No hay contactos con este criterio</span>
            <span className="text-[10px] font-mono text-white/30 mt-0.5">Prueba a cambiar el filtro o limpiar el buscador.</span>
          </div>
        ) : (
          filteredContacts.map((c) => {
            const isSelected = selectedIds.has(c.id);
            const isGroup = isGroupOrWeird(c);
            const unnamed = isUnnamed(c);
            const cleanPhone = c.id.replace('@s.whatsapp.net', '').replace('@c.us', '');

            return (
              <div
                key={c.id}
                onMouseDown={(e) => handleRowMouseDown(c.id, e)}
                onMouseEnter={() => handleRowMouseEnter(c.id)}
                className={`group w-full px-3 py-2 rounded-xl border flex items-center justify-between transition-all select-none cursor-pointer ${
                  isSelected
                    ? 'bg-black border-[#b82a2a]/60 shadow-[0_0_12px_rgba(184,42,42,0.25)] ring-1 ring-[#b82a2a]/40'
                    : 'bg-black border-white/10 hover:border-white/20'
                }`}
              >
                {/* Lado izquierdo: Checkbox + Icono + Nombre */}
                <div className="flex items-center gap-2.5 min-w-0 flex-1">
                  {/* Checkbox táctil */}
                  <div
                    className={`w-4 h-4 rounded-md flex items-center justify-center text-[10px] font-bold transition-all shrink-0 ${
                      isSelected
                        ? 'bg-[#b82a2a] text-white shadow-sm'
                        : 'border border-white/20 bg-black text-transparent group-hover:border-white/40'
                    }`}
                  >
                    ✓
                  </div>

                  {/* Icono de tipo */}
                  <span className="text-xs shrink-0">
                    {isGroup ? '👥' : unnamed ? '📱' : '👤'}
                  </span>

                  {/* Nombre del contacto (1 por línea, claro y visible) */}
                  <div className="min-w-0 flex-1">
                    <div
                      className={`text-xs font-semibold truncate ${
                        isSelected ? 'text-white' : 'text-white/95 group-hover:text-white'
                      }`}
                      title={c.name}
                    >
                      {c.name}
                    </div>
                  </div>
                </div>

                {/* Lado derecho: Teléfono + Etiqueta + Borrado individual */}
                <div className="flex items-center gap-2 shrink-0 ml-3">
                  <span className="text-[10px] font-mono text-white/40">
                    {cleanPhone}
                  </span>

                  <span
                    className={`text-[9px] font-mono px-1.5 py-0.5 rounded-md ${
                      isGroup
                        ? 'bg-purple-500/20 text-purple-300 border border-purple-500/30'
                        : unnamed
                        ? 'bg-amber-500/20 text-amber-300 border border-amber-500/30'
                        : 'bg-white/5 text-white/50 border border-white/10'
                    }`}
                  >
                    {isGroup ? 'Grupo' : unnamed ? 'Número' : 'Contacto'}
                  </span>

                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      executePermanentDelete([c.id]);
                    }}
                    className="text-white/30 hover:text-[#b82a2a] opacity-0 group-hover:opacity-100 transition-opacity p-0.5 cursor-pointer"
                    title="Eliminar permanentemente este contacto"
                  >
                    🗑️
                  </button>
                </div>
              </div>
            );
          })
        )}
      </div>

      {/* Pie con sugerencia de deslizamiento */}
      <div className="flex items-center justify-between px-1 text-[10px] font-mono text-white/40 border-t border-white/5 pt-2">
        <span>💡 Mantén el clic y desliza hacia abajo para seleccionar al vuelo</span>
        <span>{selectedIds.size} de {filteredContacts.length} marcados</span>
      </div>

      {/* =========================================================================
          MODAL DE CONFIRMACIÓN DE BORRADO PERMANENTE
          ========================================================================= */}
      <AnimatePresence>
        {showConfirmModal && (
          <div
            className="fixed inset-0 z-[600] flex items-center justify-center p-4 bg-black/80 backdrop-blur-md"
            onClick={() => setShowConfirmModal(false)}
          >
            <motion.div
              initial={{ opacity: 0, scale: 0.92, y: 10 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.92, y: 10 }}
              className="bg-black border border-[#b82a2a]/40 rounded-2xl p-5 max-w-sm w-full shadow-[0_20px_60px_rgba(0,0,0,0.95)] flex flex-col gap-3 text-white"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="flex items-center gap-2.5">
                <span className="text-xl">⚠️</span>
                <div>
                  <h3 className="text-sm font-bold text-white">¿Borrar permanentemente?</h3>
                  <p className="text-[11px] text-white/50">Esta acción es irreversible.</p>
                </div>
              </div>

              <div className="p-3 rounded-xl bg-black border border-[#b82a2a]/30 text-[11px] font-mono text-white leading-relaxed">
                Se eliminarán <strong className="text-[#b82a2a] font-bold">{selectedIds.size} contactos</strong> de SQLite y se añadirán a la lista negra permanente para que nunca vuelvan a aparecer.
              </div>

              <div className="flex items-center justify-end gap-2 pt-1">
                <button
                  type="button"
                  onClick={() => setShowConfirmModal(false)}
                  disabled={isDeleting}
                  className="px-3 py-1.5 rounded-xl bg-white/5 hover:bg-white/10 text-xs font-mono text-white/70 transition-all cursor-pointer"
                >
                  Cancelar
                </button>
                <button
                  type="button"
                  disabled={isDeleting}
                  onClick={() => executePermanentDelete(Array.from(selectedIds))}
                  className="px-4 py-1.5 rounded-xl bg-[#b82a2a] hover:bg-[#b82a2a]/90 text-xs font-mono font-bold text-white shadow-md transition-all cursor-pointer"
                >
                  {isDeleting ? 'Borrando...' : `Confirmar Borrado (${selectedIds.size})`}
                </button>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>
    </div>
  );
};
