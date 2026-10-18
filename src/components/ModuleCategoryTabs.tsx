import React, { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';

export interface CategoryItem {
  id: number;
  name: string;
  module_type: 'tasks' | 'schedules' | 'calendars';
}

interface ModuleCategoryTabsProps {
  moduleType: 'tasks' | 'schedules' | 'calendars';
  selectedCategoryId: number | null;
  onSelectCategory: (categoryId: number | null) => void;
  accentColor?: string;
}

export const ModuleCategoryTabs: React.FC<ModuleCategoryTabsProps> = ({
  moduleType,
  selectedCategoryId,
  onSelectCategory,
}) => {
  const [categories, setCategories] = useState<CategoryItem[]>([]);
  const [isAdding, setIsAdding] = useState(false);
  const [newCatName, setNewCatName] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);

  const fetchCategories = async () => {
    try {
      const items = await invoke<CategoryItem[]>('get_categories_by_module', {
        moduleType,
      });
      setCategories(items);
    } catch (err) {
      console.error(`[ModuleCategoryTabs] Error al cargar categorías de ${moduleType}:`, err);
    }
  };

  useEffect(() => {
    fetchCategories();

    let unlisten: (() => void) | undefined;
    listen<string>('refresh-categories', (event) => {
      if (!event.payload || event.payload === moduleType) {
        fetchCategories();
      }
    })
      .then((unsub) => {
        unlisten = unsub;
      })
      .catch((err) => console.error('[ModuleCategoryTabs] Error escuchando refresh-categories:', err));

    return () => {
      if (unlisten) unlisten();
    };
  }, [moduleType]);

  const handleCreateCategory = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = newCatName.trim();
    if (!trimmed || isSubmitting) return;

    setIsSubmitting(true);
    try {
      const newId = await invoke<number>('add_category', {
        name: trimmed,
        moduleType,
      });
      setNewCatName('');
      setIsAdding(false);
      await fetchCategories();
      onSelectCategory(newId);
    } catch (err) {
      console.error('[ModuleCategoryTabs] Error al crear categoría:', err);
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleDeleteCategory = async (id: number, e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      await invoke('delete_category', { id });
      if (selectedCategoryId === id) {
        onSelectCategory(null);
      }
      await fetchCategories();
    } catch (err) {
      console.error('[ModuleCategoryTabs] Error al eliminar categoría:', err);
    }
  };

  return (
    <div className="flex items-center gap-1.5 overflow-x-auto scrollbar-none py-1 px-0.5 select-none shrink-0">
      {/* Pestaña 'Todas' */}
      <button
        type="button"
        onClick={() => onSelectCategory(null)}
        className={`relative px-3 py-1 rounded-xl text-xs font-medium transition-all cursor-pointer shrink-0 ${
          selectedCategoryId === null
            ? 'bg-[#b82a2a]/20 text-white border border-[#b82a2a]/60 shadow-[0_0_12px_rgba(184,42,42,0.3)]'
            : 'bg-white/[0.03] hover:bg-white/[0.08] text-white/50 hover:text-white/80 border border-white/10'
        }`}
      >
        Todas
      </button>

      {/* Mapeo dinámico de subcategorías de la base de datos */}
      {categories.map((cat) => {
        const isSelected = selectedCategoryId === cat.id;
        return (
          <div
            key={cat.id}
            onClick={() => onSelectCategory(cat.id)}
            className={`group relative flex items-center gap-1.5 px-3 py-1 rounded-xl text-xs font-medium transition-all cursor-pointer shrink-0 ${
              isSelected
                ? 'bg-[#b82a2a]/20 text-white border border-[#b82a2a]/60 shadow-[0_0_12px_rgba(184,42,42,0.3)]'
                : 'bg-white/[0.03] hover:bg-white/[0.08] text-white/50 hover:text-white/80 border border-white/10'
            }`}
          >
            <span className="truncate max-w-[110px]">{cat.name}</span>

            {/* Botón discreto para borrar subcategoría personalizada */}
            <button
              type="button"
              onClick={(e) => handleDeleteCategory(cat.id, e)}
              title={`Eliminar carpeta ${cat.name}`}
              className="opacity-0 group-hover:opacity-100 hover:text-[#b82a2a] p-0.5 transition-opacity text-[10px]"
            >
              ×
            </button>
          </div>
        );
      })}

      {/* Creación Manual en UI con Botón Liquid Glass '+' */}
      <AnimatePresence>
        {isAdding ? (
          <motion.form
            initial={{ opacity: 0, scale: 0.95, width: 0 }}
            animate={{ opacity: 1, scale: 1, width: 'auto' }}
            exit={{ opacity: 0, scale: 0.95, width: 0 }}
            transition={{ duration: 0.15 }}
            onSubmit={handleCreateCategory}
            className="flex items-center gap-1 bg-black border border-[#b82a2a]/50 rounded-xl px-2 py-0.5 shadow-lg shrink-0"
          >
            <input
              autoFocus
              type="text"
              value={newCatName}
              onChange={(e) => setNewCatName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') setIsAdding(false);
              }}
              placeholder="Nueva carpeta..."
              className="bg-transparent text-xs text-white placeholder-white/30 outline-none w-28 px-1 py-0.5"
            />
            <button
              type="submit"
              disabled={!newCatName.trim() || isSubmitting}
              className="text-[#EF4444] hover:text-[#DC2626] p-0.5 cursor-pointer disabled:opacity-30 transition-colors"
              title="Guardar"
            >
              <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 13l4 4L19 7" />
              </svg>
            </button>
            <button
              type="button"
              onClick={() => setIsAdding(false)}
              className="text-white/40 hover:text-white p-0.5 cursor-pointer transition-colors"
              title="Cancelar"
            >
              <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </motion.form>
        ) : (
          <button
            type="button"
            onClick={() => setIsAdding(true)}
            title="Crear nueva subcategoría"
            className="flex items-center gap-1 px-2.5 py-1 rounded-xl text-xs font-medium border border-white/10 bg-black hover:border-[#b82a2a]/40 text-white/50 hover:text-white backdrop-blur-md shadow-sm transition-all cursor-pointer shrink-0 group"
          >
            <span className="text-[#b82a2a] group-hover:scale-110 transition-transform font-bold">+</span>
            <span className="text-[11px] opacity-80 group-hover:opacity-100">Carpeta</span>
          </button>
        )}
      </AnimatePresence>
    </div>
  );
};
