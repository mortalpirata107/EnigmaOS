import React, { useState, useRef, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';

export interface PersonaMeta {
  id: string;
  name: string;
  role: string;
  icon: string;
  color: string;
  glowColor: string;
  description: string;
}

export const getPersonaMetadata = (id: string): PersonaMeta => {
  switch (id.toLowerCase()) {
    case 'enigma_default':
      return {
        id: 'enigma_default',
        name: 'Enigma Core',
        role: 'Gemelo Digital',
        icon: '✨',
        color: 'from-[#b82a2a] to-[#d43b3b]',
        glowColor: 'rgba(184, 42, 42, 0.4)',
        description: 'Asistente de élite nativo, perspicaz y sofisticado.',
      };
    case 'grok':
      return {
        id: 'grok',
        name: 'Grok Mode',
        role: 'Rebelde & Sarcástico',
        icon: '⚡',
        color: 'from-amber-400 to-orange-500',
        glowColor: 'rgba(245, 158, 11, 0.45)',
        description: 'Humor negro, respuestas directas sin filtro y agudeza mordaz.',
      };
    case 'rust_senior':
      return {
        id: 'rust_senior',
        name: 'Rust Architect',
        role: 'Senior Systems',
        icon: '🦀',
        color: 'from-orange-500 to-[#b82a2a]',
        glowColor: 'rgba(234, 88, 12, 0.45)',
        description: 'Zero-cost abstractions, borrow checker estricto y alta performance.',
      };
    case 'maestro_piano':
      return {
        id: 'maestro_piano',
        name: 'Maestro Piano',
        role: 'Virtuoso Clásico',
        icon: '🎹',
        color: 'from-purple-400 to-indigo-600',
        glowColor: 'rgba(168, 85, 247, 0.45)',
        description: 'Técnica concertista, Chopin, Liszt, Beethoven y armonía musical.',
      };
    default: {
      const formatted = id
        .split('_')
        .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
        .join(' ');
      return {
        id,
        name: formatted,
        role: 'Custom Agent',
        icon: '🤖',
        color: 'from-cyan-400 to-blue-600',
        glowColor: 'rgba(6, 182, 212, 0.45)',
        description: 'Directivas personalizadas de comportamiento y utilidades.',
      };
    }
  }
};

interface PersonaSelectorProps {
  availablePersonas: string[];
  activePersona: string;
  onSelectPersona: (persona: string) => void;
  compact?: boolean;
}

export const PersonaSelector: React.FC<PersonaSelectorProps> = ({
  availablePersonas,
  activePersona,
  onSelectPersona,
  compact = false,
}) => {
  const [isOpen, setIsOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const activeMeta = getPersonaMetadata(activePersona);

  // Cerrar al hacer clic fuera del dropdown
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    };

    if (isOpen) {
      document.addEventListener('mousedown', handleClickOutside);
    }
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [isOpen]);

  return (
    <div ref={dropdownRef} className="relative inline-block text-left select-none z-50">
      {/* Botón Disparador Liquid Glass */}
      <motion.button
        type="button"
        whileHover={{ scale: 1.03 }}
        whileTap={{ scale: 0.97 }}
        onClick={() => setIsOpen(!isOpen)}
        className={`flex items-center gap-2 rounded-2xl backdrop-blur-2xl transition-all cursor-pointer ${
          compact
            ? 'px-2.5 py-1 text-xs bg-white/[0.06] hover:bg-white/[0.12] border border-white/15 hover:border-[#b82a2a]/50'
            : 'px-3.5 py-1.5 text-xs bg-white/[0.07] hover:bg-white/[0.12] border border-white/20 hover:border-[#b82a2a]/60 shadow-[0_4px_20px_rgba(0,0,0,0.3)]'
        }`}
        style={{
          boxShadow: isOpen ? `0 0 16px ${activeMeta.glowColor}` : undefined,
        }}
        title="Cambiar Persona / Multi-Agente Activo"
      >
        <span className="text-sm select-none shrink-0 drop-shadow">{activeMeta.icon}</span>
        <div className="flex flex-col text-left">
          <span className="font-semibold text-white/95 leading-tight tracking-wide">
            {activeMeta.name}
          </span>
          {!compact && (
            <span className="text-[10px] text-white/50 font-mono tracking-wider">
              {activeMeta.role}
            </span>
          )}
        </div>
        <motion.span
          animate={{ rotate: isOpen ? 180 : 0 }}
          transition={{ duration: 0.2 }}
          className="text-white/40 text-[10px] ml-1 shrink-0"
        >
          ▼
        </motion.span>
      </motion.button>

      {/* Menú Desplegable Flotante Liquid Glass */}
      <AnimatePresence>
        {isOpen && (
          <motion.div
            initial={{ opacity: 0, y: -8, scale: 0.95 }}
            animate={{ opacity: 1, y: 4, scale: 1 }}
            exit={{ opacity: 0, y: -6, scale: 0.96 }}
            transition={{ type: 'spring', stiffness: 400, damping: 28 }}
            className="absolute left-0 mt-2 w-64 rounded-3xl backdrop-blur-3xl bg-black/95 border border-[#b82a2a]/40 shadow-[0_20px_50px_rgba(0,0,0,0.95),0_0_25px_rgba(184,42,42,0.25)] p-2 z-50 overflow-hidden"
          >
            {/* Header del Menú */}
            <div className="px-3 py-2 border-b border-white/10 flex items-center justify-between">
              <span className="text-[11px] font-mono tracking-wider uppercase text-white/50 font-semibold">
                Multi-Agente / Personas
              </span>
              <span className="text-[10px] text-[#b82a2a] bg-[#b82a2a]/10 px-2 py-0.5 rounded-full border border-[#b82a2a]/30 font-mono">
                {availablePersonas.length} activas
              </span>
            </div>

            {/* Lista de Personas Disponibles */}
            <div className="flex flex-col gap-1 mt-1 max-h-60 overflow-y-auto scrollbar-thin scrollbar-thumb-white/10 scrollbar-track-transparent pr-1">
              {availablePersonas.map((personaId) => {
                const meta = getPersonaMetadata(personaId);
                const isSelected = activePersona.toLowerCase() === personaId.toLowerCase();

                return (
                  <motion.button
                    key={personaId}
                    type="button"
                    whileHover={{ scale: 1.02, x: 2 }}
                    whileTap={{ scale: 0.98 }}
                    onClick={() => {
                      onSelectPersona(personaId);
                      setIsOpen(false);
                    }}
                    className={`flex items-start gap-3 p-2.5 rounded-2xl transition-all cursor-pointer text-left w-full ${
                      isSelected
                        ? 'bg-[#b82a2a]/20 border border-[#b82a2a]/60 shadow-[0_0_15px_rgba(184,42,42,0.25)]'
                        : 'hover:bg-white/[0.08] border border-transparent hover:border-white/10'
                    }`}
                  >
                    <div
                      className={`w-8 h-8 rounded-xl flex items-center justify-center text-base shrink-0 border ${
                        isSelected
                          ? 'bg-gradient-to-br ' + meta.color + ' border-white/40 shadow-[0_0_10px_' + meta.glowColor + ']'
                          : 'bg-white/5 border-white/10'
                      }`}
                    >
                      {meta.icon}
                    </div>

                    <div className="flex flex-col flex-1 min-w-0">
                      <div className="flex items-center justify-between">
                        <span className="font-semibold text-xs text-white tracking-wide truncate">
                          {meta.name}
                        </span>
                        {isSelected && (
                          <span className="w-2 h-2 rounded-full bg-[#b82a2a] shadow-[0_0_8px_rgba(184,42,42,0.9)] animate-pulse shrink-0 ml-1" />
                        )}
                      </div>
                      <span className="text-[10px] text-white/60 font-mono">
                        {meta.role}
                      </span>
                      <p className="text-[10px] text-white/40 line-clamp-1 mt-0.5 leading-tight">
                        {meta.description}
                      </p>
                    </div>
                  </motion.button>
                );
              })}
            </div>

            {/* Footer con tip */}
            <div className="pt-2 mt-1 border-t border-white/10 px-2 flex items-center justify-between text-[10px] text-white/40 font-mono">
              <span>Atajo en input: escribe <span className="text-[#b82a2a] font-bold">@</span></span>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
};
