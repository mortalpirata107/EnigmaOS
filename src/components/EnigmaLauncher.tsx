import React, { useState, useMemo, useEffect, useRef, useCallback } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { convertFileSrc, invoke } from '@tauri-apps/api/core';
import { useSystemApps } from '../hooks/useSystemApps';
import { useSystemTelemetry } from '../hooks/useSystemTelemetry';
import { AppIcon } from './IconMapper';
import type { AppEntry, RecentDocEntry } from '../types';
import { 
  Search, 
  Calculator, 
  Copy, 
  Terminal, 
  ArrowRight, 
  Clock, 
  Cpu, 
  MemoryStick, 
  Power, 
  RotateCcw, 
  Lock, 
  Moon, 
  Folder, 
  File, 
  Sparkles, 
  X,
  LayoutGrid
} from 'lucide-react';

export interface EnigmaLauncherProps {
  isOpen: boolean;
  onClose: () => void;
  onLaunchApp: (app: AppEntry) => void;
}

const LauncherIcon: React.FC<{ icon: string; name: string }> = ({ icon, name }) => {
  const [hasError, setHasError] = useState(false);
  const isAbsPath = icon.startsWith('/');
  const isUrl = /^(https?:|data:|asset:)/.test(icon);
  if (!hasError && (isAbsPath || isUrl)) {
    return (
      <img
        src={isAbsPath ? convertFileSrc(icon) : icon}
        alt={name}
        draggable={false}
        decoding="async"
        onError={() => setHasError(true)}
        className="w-full h-full object-contain select-none drop-shadow-[0_2px_4px_rgba(0,0,0,0.8)]"
      />
    );
  }
  return <AppIcon iconPath={icon} appName={name} />;
};

export const EnigmaLauncher: React.FC<EnigmaLauncherProps> = ({
  isOpen,
  onClose,
  onLaunchApp,
}) => {
  const [searchQuery, setSearchQuery] = useState('');
  const [viewMode, setViewMode] = useState<'dashboard' | 'all_apps'>('dashboard');
  const [recentDocs, setRecentDocs] = useState<RecentDocEntry[]>([]);
  const [usageCounts, setUsageCounts] = useState<Record<string, number>>({});
  const [toastMessage, setToastMessage] = useState<string | null>(null);

  const inputRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const { apps, executeAction } = useSystemApps();
  const telemetry = useSystemTelemetry();

  // Toast temporal para notificaciones
  const showToast = useCallback((msg: string) => {
    setToastMessage(msg);
    setTimeout(() => {
      setToastMessage((prev) => (prev === msg ? null : prev));
    }, 2000);
  }, []);

  // Cargar documentos recientes de Linux (~/.local/share/recently-used.xbel)
  const loadRecentDocs = useCallback(async () => {
    try {
      const docs = await invoke<RecentDocEntry[]>('get_recent_documents');
      setRecentDocs(docs || []);
    } catch (err) {
      console.warn('[EnigmaLauncher] Error cargando documentos recientes:', err);
    }
  }, []);

  // Cargar frecuencias de uso desde ~/.config/enigma_launcher/app_usage.json
  const loadUsageCounts = useCallback(async () => {
    try {
      const counts = await invoke<Record<string, number>>('get_app_usage_counts');
      setUsageCounts(counts || {});
    } catch (err) {
      console.warn('[EnigmaLauncher] Error cargando conteos de uso:', err);
    }
  }, []);

  // Inicialización al abrir
  useEffect(() => {
    if (isOpen) {
      setSearchQuery('');
      setViewMode('dashboard');
      loadRecentDocs();
      loadUsageCounts();
      const t = setTimeout(() => inputRef.current?.focus(), 60);
      return () => clearTimeout(t);
    }
  }, [isOpen, loadRecentDocs, loadUsageCounts]);

  // Cerrar al pulsar Escape
  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown, true);
    return () => window.removeEventListener('keydown', handleKeyDown, true);
  }, [isOpen, onClose]);

  // Evaluador seguro de expresiones matemáticas (Calculadora instantánea)
  const mathResult = useMemo(() => {
    const trimmed = searchQuery.trim();
    if (!trimmed || trimmed.startsWith('>')) return null;
    const mathRegex = /^[\d\s+\-*/().^%,sqrtcbrt]+$/;
    if (mathRegex.test(trimmed) && /[\d]/.test(trimmed) && /[+\-*/^%]/.test(trimmed)) {
      try {
        let sanitized = trimmed
          .replace(/\^/g, '**')
          .replace(/,/g, '.')
          .replace(/sqrt\(([^)]+)\)/g, 'Math.sqrt($1)')
          .replace(/cbrt\(([^)]+)\)/g, 'Math.cbrt($1)');
        // eslint-disable-next-line no-eval
        const res = Function(`"use strict"; return (${sanitized})`)();
        if (typeof res === 'number' && !isNaN(res) && isFinite(res)) {
          return res;
        }
      } catch {
        return null;
      }
    }
    return null;
  }, [searchQuery]);

  // Detección de comandos de terminal "> <cmd>"
  const terminalCommand = useMemo(() => {
    const q = searchQuery.trim();
    if (q.startsWith('>')) {
      const cmd = q.slice(1).trim();
      return cmd.length > 0 ? cmd : null;
    }
    return null;
  }, [searchQuery]);

  // Top 6 Aplicaciones "Más Usadas"
  const topUsedApps = useMemo(() => {
    if (apps.length === 0) return [];
    
    // 1. Apps que realmente han sido lanzadas por el usuario con conteo > 0
    const appsWithUsage = apps
      .filter(a => (usageCounts[a.id] || 0) > 0)
      .sort((a, b) => (usageCounts[b.id] || 0) - (usageCounts[a.id] || 0));

    const top: AppEntry[] = [...appsWithUsage.slice(0, 6)];

    // 2. Si no hay suficientes apps con uso registrado, rellenamos con aplicaciones de escritorio reales
    if (top.length < 6) {
      const priorityKeywords = [
        'spotify',
        'firefox',
        'discord',
        'antigravity',
        'code',
        'dolphin',
        'opera',
        'chrome',
        'konsole',
        'steam',
        'terminal',
        'gimp',
        'blender'
      ];
      for (const kw of priorityKeywords) {
        if (top.length >= 6) break;
        const match = apps.find(a => 
          (a.name.toLowerCase().includes(kw) || a.id.toLowerCase().includes(kw)) &&
          !top.some(t => t.id === a.id) &&
          !a.name.toLowerCase().includes('avahi') &&
          !a.id.toLowerCase().includes('avahi')
        );
        if (match) {
          top.push(match);
        }
      }
    }

    // 3. Fallback final asegurando que NUNCA tome daemons
    if (top.length < 6) {
      for (const a of apps) {
        if (top.length >= 6) break;
        if (!top.some(t => t.id === a.id) && !a.name.toLowerCase().includes('avahi') && !a.id.toLowerCase().includes('avahi')) {
          top.push(a);
        }
      }
    }

    return top.slice(0, 6);
  }, [apps, usageCounts]);

  // Filtrado fuzzy reactivo de aplicaciones
  const filteredApps = useMemo(() => {
    if (!searchQuery.trim() || terminalCommand) return apps;
    const q = searchQuery.toLowerCase().trim();
    return apps.filter(
      (a) =>
        a.name.toLowerCase().includes(q) ||
        (a.comment && a.comment.toLowerCase().includes(q)) ||
        (a.categories && a.categories.toLowerCase().includes(q)) ||
        (a.keywords && a.keywords.toLowerCase().includes(q)) ||
        a.id.toLowerCase().includes(q)
    );
  }, [apps, searchQuery, terminalCommand]);

  // Filtrado reactivo de documentos recientes
  const filteredDocs = useMemo(() => {
    if (!searchQuery.trim() || terminalCommand) return recentDocs.slice(0, 4);
    const q = searchQuery.toLowerCase().trim();
    return recentDocs
      .filter(d => d.name.toLowerCase().includes(q) || d.path.toLowerCase().includes(q))
      .slice(0, 4);
  }, [recentDocs, searchQuery, terminalCommand]);

  // Lanzar aplicación y registrar frecuencia
  const handleLaunch = async (app: AppEntry) => {
    try {
      await invoke('record_app_launch', { desktopId: app.id });
    } catch {
      // Ignorar errores menores de persistencia
    }
    onLaunchApp(app);
    onClose();
  };

  // Abrir archivo nativo
  const handleOpenDoc = async (path: string) => {
    try {
      await invoke('open_native_path', { path });
      showToast('Abriendo archivo...');
      setTimeout(onClose, 300);
    } catch (err) {
      console.warn('[EnigmaLauncher] Error abriendo archivo:', err);
    }
  };

  // Ejecutar comando en terminal
  const handleRunCommand = async (cmd: string) => {
    try {
      await invoke('run_terminal_command', { command: cmd });
      showToast(`Ejecutando: ${cmd}`);
      setTimeout(onClose, 350);
    } catch (err) {
      console.warn('[EnigmaLauncher] Error ejecutando comando:', err);
    }
  };

  // Copiar cálculo al portapapeles
  const handleCopyMath = (val: number) => {
    navigator.clipboard.writeText(val.toString());
    showToast(`Copiado: ${val}`);
    setTimeout(onClose, 400);
  };

  const isSearching = searchQuery.trim().length > 0;

  return (
    <AnimatePresence>
      {isOpen && (
        <motion.div
          id="enigma-launcher"
          ref={containerRef}
          initial={{ opacity: 0, y: 16, scale: 0.95 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: 10, scale: 0.96 }}
          transition={{ type: 'spring', stiffness: 380, damping: 26 }}
          onClick={(e) => e.stopPropagation()}
          className="absolute bottom-full left-0 mb-4 z-[100] w-[720px] h-[500px] neu-chassis rounded-[28px] flex overflow-hidden select-none cursor-default"
        >
          {/* =========================================================================
              PANEL IZQUIERDO / CENTRAL: Omnibox, Top 6 Apps, Recientes y Resultados (68%)
              ========================================================================= */}
          <div className="flex-1 flex flex-col p-4 min-w-0">
            {/* Header: Marca Enigma + Selector de Vista */}
            <div className="flex items-center justify-between mb-3 px-1 shrink-0">
              <div className="flex items-center gap-2.5">
                <div className="w-2.5 h-2.5 rounded-full neu-led-red animate-pulse" />
                <span className="text-xs font-bold tracking-wider text-white uppercase font-sans">
                  Enigma Launcher
                </span>
                <span className="text-[10px] font-mono px-2 py-0.5 rounded-full neu-inset text-white/50">
                  OS-NATIVE
                </span>
              </div>
              <div className="flex items-center gap-1">
                <button
                  type="button"
                  onClick={() => setViewMode(viewMode === 'dashboard' ? 'all_apps' : 'dashboard')}
                  className={`flex items-center gap-2 px-3 py-1.5 rounded-xl text-[11px] font-mono transition-all cursor-pointer active:scale-95 neu-extruded ${
                    viewMode === 'all_apps'
                      ? 'border-[#EF4444] text-white shadow-[0_0_12px_rgba(239,68,68,0.3)]'
                      : 'text-white/80 hover:text-white'
                  }`}
                >
                  <LayoutGrid className="w-3.5 h-3.5 text-[#EF4444]" />
                  <span>{viewMode === 'all_apps' ? 'Dashboard' : 'Todas las Apps'}</span>
                </button>
              </div>
            </div>

            {/* Barra de Búsqueda Inteligente (Omnibox) - Pozo Inset Neumórfico */}
            <div className="relative mb-3.5 shrink-0 neu-inset rounded-2xl px-3.5 py-2.5 flex items-center gap-3 w-full">
              <div className="flex items-center pointer-events-none shrink-0">
                {terminalCommand ? (
                  <Terminal className="w-4 h-4 text-[#EF4444] animate-pulse" />
                ) : mathResult !== null ? (
                  <Calculator className="w-4 h-4 text-white animate-pulse" />
                ) : (
                  <Search className="w-4 h-4 text-[#EF4444]" />
                )}
              </div>
              <input
                ref={inputRef}
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Buscar apps, archivos, calcular o escribir > comando..."
                className="w-full flex-1 min-w-0 pr-4 bg-transparent outline-none text-white text-[13px] placeholder-white/35 font-light"
              />
              {searchQuery && (
                <button
                  type="button"
                  onClick={() => {
                    setSearchQuery('');
                    inputRef.current?.focus();
                  }}
                  className="p-1 rounded-md text-white/40 hover:text-white hover:bg-white/10 transition-colors shrink-0"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              )}
            </div>

            {/* CUERPO DEL CONTENIDO */}
            <div className="flex-1 overflow-y-auto pr-1 custom-scrollbar min-h-0 space-y-3">
              {/* Tarjeta de Calculadora Instantánea si aplica */}
              {mathResult !== null && (
                <motion.div
                  initial={{ opacity: 0, y: -4 }}
                  animate={{ opacity: 1, y: 0 }}
                  onClick={() => handleCopyMath(mathResult)}
                  className="flex items-center justify-between p-3 rounded-2xl neu-extruded cursor-pointer hover:border-[#EF4444]/60 transition-all"
                >
                  <div className="flex items-center gap-3">
                    <div className="w-8 h-8 rounded-xl neu-inset flex items-center justify-center text-[#EF4444]">
                      <Calculator className="w-4 h-4" />
                    </div>
                    <div>
                      <span className="text-[10px] font-mono text-[#EF4444] uppercase font-bold block">
                        Cálculo Instantáneo
                      </span>
                      <span className="text-base font-mono font-bold text-white">
                        = {mathResult.toLocaleString('es-ES')}
                      </span>
                    </div>
                  </div>
                  <div className="flex items-center gap-1.5 text-xs text-white/80 font-mono">
                    <span>Copiar</span>
                    <Copy className="w-3.5 h-3.5 text-[#EF4444]" />
                  </div>
                </motion.div>
              )}

              {/* Tarjeta de Comando Terminal si aplica */}
              {terminalCommand && (
                <motion.div
                  initial={{ opacity: 0, y: -4 }}
                  animate={{ opacity: 1, y: 0 }}
                  onClick={() => handleRunCommand(terminalCommand)}
                  className="flex items-center justify-between p-3 rounded-2xl neu-extruded cursor-pointer hover:border-[#EF4444]/60 transition-all"
                >
                  <div className="flex items-center gap-3 min-w-0">
                    <div className="w-8 h-8 rounded-xl neu-inset flex items-center justify-center text-[#EF4444] shrink-0">
                      <Terminal className="w-4 h-4" />
                    </div>
                    <div className="min-w-0">
                      <span className="text-[10px] font-mono text-[#EF4444] uppercase font-bold block">
                        Ejecutar en Konsole
                      </span>
                      <span className="text-sm font-mono font-bold text-white truncate block">
                        {terminalCommand}
                      </span>
                    </div>
                  </div>
                  <div className="flex items-center gap-1 text-xs text-white/80 font-mono shrink-0">
                    <span>Ejecutar</span>
                    <ArrowRight className="w-3.5 h-3.5 text-[#EF4444]" />
                  </div>
                </motion.div>
              )}

              {/* MODO BÚSQUEDA ACTIVA */}
              {isSearching && !terminalCommand && (
                <div className="space-y-2">
                  <div className="flex items-center justify-between text-[11px] font-mono text-white/50 px-1">
                    <span>RESULTADOS ({filteredApps.length + filteredDocs.length})</span>
                  </div>

                  {/* Apps coincidentes */}
                  {filteredApps.slice(0, 8).map((app) => (
                    <div
                      key={app.id}
                      onClick={() => handleLaunch(app)}
                      className="flex items-center justify-between p-2.5 rounded-2xl neu-extruded hover:border-[#EF4444]/50 transition-all cursor-pointer group"
                    >
                      <div className="flex items-center gap-3 min-w-0">
                        <div className="w-8 h-8 rounded-xl neu-inset flex items-center justify-center p-1.5 shrink-0">
                          <LauncherIcon icon={app.icon || app.id} name={app.name} />
                        </div>
                        <div className="min-w-0">
                          <span className="text-xs font-semibold text-white truncate block group-hover:text-white">
                            {app.name}
                          </span>
                          <span className="text-[10px] text-white/40 truncate block font-mono">
                            {app.comment || app.exec}
                          </span>
                        </div>
                      </div>
                      <ArrowRight className="w-3.5 h-3.5 text-white/30 group-hover:text-[#EF4444] transition-colors shrink-0 ml-2" />
                    </div>
                  ))}

                  {/* Archivos coincidentes */}
                  {filteredDocs.map((doc) => (
                    <div
                      key={doc.path}
                      onClick={() => handleOpenDoc(doc.path)}
                      className="flex items-center justify-between p-2.5 rounded-2xl neu-extruded hover:border-[#EF4444]/50 transition-all cursor-pointer group"
                    >
                      <div className="flex items-center gap-3 min-w-0">
                        <div className="w-8 h-8 rounded-xl neu-inset flex items-center justify-center text-[#EF4444] shrink-0">
                          {doc.is_dir ? <Folder className="w-4 h-4" /> : <File className="w-4 h-4" />}
                        </div>
                        <div className="min-w-0">
                          <span className="text-xs font-semibold text-white truncate block">
                            {doc.name}
                          </span>
                          <span className="text-[10px] text-white/40 truncate block font-mono">
                            {doc.path.replace(/^\/home\/[^\/]+/, '~')}
                          </span>
                        </div>
                      </div>
                      <ArrowRight className="w-3.5 h-3.5 text-white/30 group-hover:text-[#EF4444] transition-colors shrink-0 ml-2" />
                    </div>
                  ))}

                  {filteredApps.length === 0 && filteredDocs.length === 0 && (
                    <div className="py-12 text-center text-white/40 text-xs font-mono">
                      No se encontraron coincidencias para "{searchQuery}"
                    </div>
                  )}
                </div>
              )}

              {/* MODO DASHBOARD PRINCIPAL (SIN BÚSQUEDA ACTIVA) */}
              {!isSearching && viewMode === 'dashboard' && (
                <>
                  {/* SECCIÓN 1: MÁS USADAS (TOP 6 APLICACIONES) */}
                  <div className="space-y-2">
                    <div className="flex items-center justify-between text-[11px] font-mono text-white/60 px-1">
                      <span className="flex items-center gap-1.5 font-bold tracking-wider uppercase text-white/80">
                        <Sparkles className="w-3.5 h-3.5 text-[#EF4444]" />
                        MÁS USADAS
                      </span>
                      <span className="text-[9px] text-white/40">Frecuencia dinámica</span>
                    </div>

                    <div className="grid grid-cols-6 gap-2">
                      {topUsedApps.map((app) => (
                        <button
                          key={app.id}
                          type="button"
                          onClick={() => handleLaunch(app)}
                          className="flex flex-col items-center p-2 rounded-2xl neu-extruded hover:border-[#EF4444]/60 hover:shadow-[0_0_12px_rgba(239,68,68,0.25)] active:scale-95 transition-all cursor-pointer group text-center"
                          title={app.name}
                        >
                          <div className="w-11 h-11 rounded-xl neu-inset flex items-center justify-center p-2 mb-1.5 transition-transform group-hover:scale-105">
                            <LauncherIcon icon={app.icon || app.id} name={app.name} />
                          </div>
                          <span className="text-[10px] font-medium text-white/85 group-hover:text-white truncate max-w-full leading-tight">
                            {app.name}
                          </span>
                        </button>
                      ))}
                    </div>
                  </div>

                  {/* SECCIÓN 2: ARCHIVOS RECIENTES (FREEDESKTOP) */}
                  <div className="space-y-2 pt-1.5">
                    <div className="flex items-center justify-between text-[11px] font-mono text-white/60 px-1">
                      <span className="flex items-center gap-1.5 font-bold tracking-wider uppercase text-white/80">
                        <Clock className="w-3.5 h-3.5 text-[#EF4444]" />
                        DOCUMENTOS RECIENTES
                      </span>
                      <span className="text-[9px] text-white/40">~/.local/share/recently-used.xbel</span>
                    </div>

                    <div className="grid grid-cols-2 gap-2">
                      {recentDocs.slice(0, 4).map((doc) => (
                        <div
                          key={doc.path}
                          onClick={() => handleOpenDoc(doc.path)}
                          className="flex items-center gap-2.5 p-2.5 rounded-2xl neu-extruded hover:border-[#EF4444]/50 transition-all cursor-pointer group min-w-0"
                          title={doc.path}
                        >
                          <div className="w-8 h-8 rounded-xl neu-inset flex items-center justify-center text-[#EF4444] shrink-0">
                            {doc.is_dir ? <Folder className="w-4 h-4" /> : <File className="w-4 h-4" />}
                          </div>
                          <div className="min-w-0 flex-1">
                            <span className="text-xs font-semibold text-white/95 group-hover:text-white truncate block">
                              {doc.name}
                            </span>
                            <span className="text-[10px] font-mono text-white/40 truncate block">
                              {doc.path.replace(/^\/home\/[^\/]+/, '~')}
                            </span>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>

                  {/* SECCIÓN 3: VISTA PREVIA DE TODAS LAS APLICACIONES */}
                  <div className="space-y-2 pt-1.5">
                    <div className="flex items-center justify-between text-[11px] font-mono text-white/60 px-1">
                      <span className="font-bold tracking-wider uppercase text-white/80">
                        SISTEMA ({apps.length} APPS)
                      </span>
                    </div>
                    <div className="grid grid-cols-5 gap-2 content-start">
                      {apps.slice(0, 10).map((app) => (
                        <button
                          key={app.id}
                          type="button"
                          onClick={() => handleLaunch(app)}
                          className="flex flex-col items-center p-1.5 rounded-xl hover:bg-white/[0.04] active:scale-95 transition-all cursor-pointer group text-center"
                          title={app.name}
                        >
                          <div className="w-9 h-9 rounded-xl neu-inset flex items-center justify-center p-1.5 mb-1 group-hover:scale-105 transition-transform">
                            <LauncherIcon icon={app.icon || app.id} name={app.name} />
                          </div>
                          <span className="text-[10px] text-white/70 group-hover:text-white truncate max-w-full">
                            {app.name}
                          </span>
                        </button>
                      ))}
                    </div>
                  </div>
                </>
              )}

              {/* MODO TODAS LAS APLICACIONES (GRID COMPLETO) */}
              {!isSearching && viewMode === 'all_apps' && (
                <div className="grid grid-cols-5 gap-2.5 content-start">
                  {apps.map((app) => (
                    <button
                      key={app.id}
                      type="button"
                      onClick={() => handleLaunch(app)}
                      className="flex flex-col items-center p-2 rounded-2xl neu-extruded hover:border-[#EF4444]/60 active:scale-95 transition-all cursor-pointer group text-center"
                      title={app.comment || app.name}
                    >
                      <div className="w-10 h-10 rounded-xl neu-inset flex items-center justify-center p-1.5 mb-1.5 group-hover:scale-105 transition-transform">
                        <LauncherIcon icon={app.icon || app.id} name={app.name} />
                      </div>
                      <span className="text-[10px] text-white/80 group-hover:text-white font-medium truncate max-w-full leading-tight">
                        {app.name}
                      </span>
                    </button>
                  ))}
                </div>
              )}
            </div>

            {/* Footer Minimalista */}
            <div className="mt-2 pt-2 border-t border-red-950/40 flex items-center justify-between text-[10px] font-mono text-white/50 shrink-0">
              <span className="flex items-center gap-1.5">
                <span className="w-1.5 h-1.5 rounded-full neu-led-red animate-pulse" />
                {toastMessage || 'Listo'}
              </span>
              <div className="flex items-center gap-2 text-white/40">
                <span>&gt; Terminal</span>
                <span>·</span>
                <span>ESC Salir</span>
              </div>
            </div>
          </div>

          {/* =========================================================================
              SEPARADOR VERTICAL LUMINOSO NEUMÓRFICO EN ROJO
              ========================================================================= */}
          <div className="w-[2px] self-stretch bg-gradient-to-b from-transparent via-[#EF4444]/60 to-transparent shadow-[0_0_8px_rgba(239,68,68,0.4)] my-3 shrink-0" />

          {/* =========================================================================
              PANEL DERECHO: SIDEBAR DE TELEMETRÍA SYSINFO Y ACCIONES DE ENERGÍA (32%)
              ========================================================================= */}
          <div className="w-[235px] p-3.5 flex flex-col justify-between shrink-0 bg-transparent">
            {/* 1. Widgets de Telemetría Real (sysinfo) */}
            <div className="space-y-2.5">
              <div className="text-[10px] font-mono font-bold tracking-wider text-white/80 uppercase flex items-center gap-1.5">
                <Cpu className="w-3.5 h-3.5 text-[#EF4444]" />
                <span>MONITOR DEL SISTEMA</span>
              </div>

              {/* Tarjeta CPU */}
              <div className="p-3 rounded-2xl neu-extruded space-y-1.5">
                <div className="flex items-center justify-between text-[11px] font-mono">
                  <span className="text-white/70">CPU ({telemetry.cpu_cores} núcleos)</span>
                  <span className="font-bold text-white">{telemetry.cpu_temp.toFixed(0)}°C</span>
                </div>
                <div className="flex items-end justify-between">
                  <span className="text-lg font-bold font-mono text-white leading-none">
                    {telemetry.cpu_usage.toFixed(1)}%
                  </span>
                  <span className="text-[9px] font-mono text-white/40 truncate max-w-[105px]">
                    {telemetry.cpu_brand.replace('AMD ', '').replace('Intel ', '')}
                  </span>
                </div>
                <div className="w-full h-2 rounded-full neu-inset overflow-hidden mt-1.5">
                  <motion.div
                    className="h-full neu-led-red rounded-full"
                    style={{ width: `${Math.min(100, Math.max(0, telemetry.cpu_usage))}%` }}
                  />
                </div>
              </div>

              {/* Tarjeta RAM */}
              <div className="p-3 rounded-2xl neu-extruded space-y-1.5">
                <div className="flex items-center justify-between text-[11px] font-mono">
                  <div className="flex items-center gap-1.5 text-white/70">
                    <MemoryStick className="w-3.5 h-3.5 text-[#EF4444]" />
                    <span>RAM DDR5</span>
                  </div>
                  <span className="font-bold text-white font-mono">
                    {telemetry.ram_used_gb.toFixed(1)} GB
                  </span>
                </div>
                <div className="flex items-end justify-between">
                  <span className="text-lg font-bold font-mono text-white leading-none">
                    {telemetry.ram_usage.toFixed(1)}%
                  </span>
                  <span className="text-[9px] font-mono text-white/40">
                    de {telemetry.ram_total_gb.toFixed(0)} GB
                  </span>
                </div>
                <div className="w-full h-2 rounded-full neu-inset overflow-hidden mt-1.5">
                  <motion.div
                    className="h-full neu-led-red rounded-full"
                    style={{ width: `${Math.min(100, Math.max(0, telemetry.ram_usage))}%` }}
                  />
                </div>
              </div>

              {/* Estatus de Red */}
              <div className="px-3 py-2 rounded-xl neu-extruded flex items-center justify-between text-[11px] font-mono text-white/70">
                <span>Red</span>
                <span className="flex items-center gap-1.5 text-white font-medium">
                  <span className="w-1.5 h-1.5 rounded-full neu-led-red animate-pulse" />
                  Conectado
                </span>
              </div>
            </div>

            {/* 2. Acciones Rápidas de Energía / Sesión */}
            <div className="space-y-2 pt-2 border-t border-red-950/40">
              <span className="text-[10px] font-mono font-bold tracking-wider text-white/60 uppercase block">
                SESIÓN Y ENERGÍA
              </span>
              <div className="grid grid-cols-2 gap-2">
                <button
                  type="button"
                  onClick={() => executeAction('poweroff')}
                  className="flex items-center gap-2 p-2.5 rounded-2xl neu-extruded text-[#EF4444] transition-all cursor-pointer text-left active:scale-95 group"
                  title="Apagar el sistema"
                >
                  <Power className="w-3.5 h-3.5 text-[#EF4444] shrink-0" />
                  <span className="text-[11px] font-mono font-bold text-[#EF4444]">Apagar</span>
                </button>

                <button
                  type="button"
                  onClick={() => executeAction('reboot')}
                  className="flex items-center gap-2 p-2.5 rounded-2xl neu-extruded text-white transition-all cursor-pointer text-left active:scale-95 group"
                  title="Reiniciar el sistema"
                >
                  <RotateCcw className="w-3.5 h-3.5 text-[#EF4444] shrink-0" />
                  <span className="text-[11px] font-mono font-bold text-white">Reiniciar</span>
                </button>

                <button
                  type="button"
                  onClick={() => executeAction('lock')}
                  className="flex items-center gap-2 p-2.5 rounded-2xl neu-extruded text-white transition-all cursor-pointer text-left active:scale-95 group"
                  title="Bloquear sesión KDE"
                >
                  <Lock className="w-3.5 h-3.5 text-[#EF4444] shrink-0" />
                  <span className="text-[11px] font-mono font-bold text-white">Bloquear</span>
                </button>

                <button
                  type="button"
                  onClick={() => executeAction('suspend')}
                  className="flex items-center gap-2 p-2.5 rounded-2xl neu-extruded text-white transition-all cursor-pointer text-left active:scale-95 group"
                  title="Suspender equipo"
                >
                  <Moon className="w-3.5 h-3.5 text-[#EF4444] shrink-0" />
                  <span className="text-[11px] font-mono font-bold text-white">Suspender</span>
                </button>
              </div>
            </div>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
};
