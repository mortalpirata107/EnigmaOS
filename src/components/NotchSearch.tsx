import React, { useState, useMemo, useEffect, useRef, useCallback } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { 
  Search, 
  Calculator, 
  Power, 
  RotateCcw, 
  Lock, 
  Moon, 
  Sparkles, 
  ArrowRight,
  Copy,
  Check,
  FileText,
  MessageCircle,
  Mail,
  Calendar,
  Mic,
  Send,
  Zap,
  Bot,
  Eye,
  Scan,
  Terminal,
  Folder,
  File,
  LayoutGrid,
  Clipboard
} from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { useSystemApps } from '../hooks/useSystemApps';
import { useOpenWindows, type OpenWindow } from '../hooks/useOpenWindows';
import { evaluateQuickCalculation, type CalculatorResult } from '../utils/calculatorEngine';
import { AppIcon } from './IconMapper';
import type { AppEntry, RecentDocEntry } from '../types';

export interface NoteRecord {
  id: number;
  title: string;
  content: string;
  timestamp: string;
}

export interface WhatsAppContact {
  id: string;
  name: string;
}

interface NotchSearchProps {
  onClose: () => void;
  onUserActivity?: () => void;
  onAskEnigma?: (prompt: string, autoSubmit?: boolean) => void;
  onOpenClipboard?: () => void;
}

interface SystemAction {
  id: string;
  name: string;
  description: string;
  action: string;
  icon: React.ComponentType<{ className?: string }>;
}

const SYSTEM_ACTIONS: SystemAction[] = [
  { id: 'clipboard', name: 'Historial de Portapapeles', description: 'Abrir portapapeles inteligente con vista previa de imágenes y código', action: 'clipboard', icon: Clipboard },
  { id: 'poweroff', name: 'Apagar el Equipo', description: 'Apagar el sistema de forma segura', action: 'poweroff', icon: Power },
  { id: 'reboot', name: 'Reiniciar el Equipo', description: 'Reiniciar el sistema operativo', action: 'reboot', icon: RotateCcw },
  { id: 'lock', name: 'Bloquear Pantalla', description: 'Bloquear la sesión actual de KDE', action: 'lock', icon: Lock },
  { id: 'suspend', name: 'Suspender', description: 'Poner el equipo en modo de bajo consumo', action: 'suspend', icon: Moon },
];

interface EnigmaQuickCommand {
  id: string;
  name: string;
  description: string;
  prompt: string;
  icon: React.ComponentType<{ className?: string }>;
  badge: string;
  actionType: 'prompt' | 'stt';
}

const ENIGMA_QUICK_COMMANDS: EnigmaQuickCommand[] = [
  {
    id: 'vision_screen',
    name: 'Enigma Vision: Analizar Pantalla',
    description: 'Capturar pantalla completa y analizar con IA multimodal',
    prompt: 'Analiza mi pantalla actual, describe qué ves y asísteme con lo que estoy haciendo.',
    icon: Eye,
    badge: 'VISION',
    actionType: 'prompt',
  },
  {
    id: 'vision_window',
    name: 'Enigma Vision: Analizar Ventana Activa',
    description: 'Inspeccionar código, errores o app en foco',
    prompt: 'Analiza minuciosamente la ventana activa que tengo abierta y ayúdame con lo que estoy programando.',
    icon: Scan,
    badge: 'VENTANA',
    actionType: 'prompt',
  },
  {
    id: 'gmail',
    name: 'Revisar correos en Gmail',
    description: 'Resumen inteligente de correos recientes no leídos',
    prompt: 'Revisa mis correos no leídos de Gmail y hazme un resumen conciso.',
    icon: Mail,
    badge: 'GMAIL',
    actionType: 'prompt',
  },
  {
    id: 'agenda',
    name: 'Agenda y eventos de hoy',
    description: 'Consultar reuniones y tareas programadas en calendario',
    prompt: '¿Qué eventos, citas o reuniones tengo programadas para hoy?',
    icon: Calendar,
    badge: 'AGENDA',
    actionType: 'prompt',
  },
  {
    id: 'stt_voice',
    name: 'Activar dictado por voz',
    description: 'Iniciar transcriptor Vosk STT en tiempo real',
    prompt: '',
    icon: Mic,
    badge: 'VOZ STT',
    actionType: 'stt',
  },
  {
    id: 'clean_sys',
    name: 'Optimizar y limpiar memoria',
    description: 'Liberar memoria RAM y analizar telemetría del sistema',
    prompt: 'Realiza una comprobación del sistema, optimiza la memoria y resume el estado.',
    icon: Sparkles,
    badge: 'OPTIMIZAR',
    actionType: 'prompt',
  },
];

type CategoryFilter = 'all' | 'apps' | 'files' | 'enigma' | 'notes' | 'whatsapp';

// Tipo unificado para cada ítem seleccionable del Spotlight
export type SpotlightItem =
  | { type: 'terminal'; command: string }
  | { type: 'calc'; calc: CalculatorResult }
  | { type: 'math'; value: number }
  | { type: 'create_note'; content: string }
  | { type: 'send_whatsapp_quick'; contact: WhatsAppContact; message: string }
  | { type: 'app'; app: AppEntry; activeWindow?: OpenWindow }
  | { type: 'doc'; doc: RecentDocEntry }
  | { type: 'action'; action: SystemAction }
  | { type: 'note'; note: NoteRecord }
  | { type: 'whatsapp'; contact: WhatsAppContact }
  | { type: 'enigma_query'; query: string }
  | { type: 'enigma_cmd'; cmd: EnigmaQuickCommand };

export const NotchSearch: React.FC<NotchSearchProps> = ({ 
  onClose, 
  onUserActivity,
  onAskEnigma,
  onOpenClipboard,
}) => {
  const { apps, launchApp, executeAction } = useSystemApps();
  const { windows, focusWindow } = useOpenWindows();
  const [query, setQuery] = useState<string>('');
  const [activeFilter, setActiveFilter] = useState<CategoryFilter>('all');
  const [selectedIndex, setSelectedIndex] = useState<number>(0);

  // Estados de datos externos (SQLite, Documentos Recientes, WhatsApp)
  const [notes, setNotes] = useState<NoteRecord[]>([]);
  const [recentDocs, setRecentDocs] = useState<RecentDocEntry[]>([]);
  const [whatsappContacts, setWhatsappContacts] = useState<WhatsAppContact[]>([]);
  const [toastMessage, setToastMessage] = useState<string | null>(null);

  const inputRef = useRef<HTMLInputElement>(null);
  const listContainerRef = useRef<HTMLDivElement>(null);

  // Mostrar mensaje toast temporal
  const showToast = useCallback((msg: string) => {
    setToastMessage(msg);
    setTimeout(() => {
      setToastMessage((prev) => (prev === msg ? null : prev));
    }, 2200);
  }, []);

  // Cargar notas desde SQLite
  const loadNotes = useCallback(async () => {
    try {
      const records = await invoke<NoteRecord[]>('get_notes');
      setNotes(records || []);
    } catch (err) {
      console.warn('[NotchSearch] Error cargando notas de SQLite:', err);
    }
  }, []);

  // Cargar documentos recientes del sistema nativo de Linux
  const loadRecentDocs = useCallback(async () => {
    try {
      const list = await invoke<RecentDocEntry[]>('get_recent_documents');
      setRecentDocs(list || []);
    } catch (err) {
      console.warn('[NotchSearch] Error cargando documentos recientes:', err);
    }
  }, []);

  // Cargar contactos de WhatsApp desde SQLite
  const loadWhatsAppContacts = useCallback(async () => {
    try {
      const list = await invoke<WhatsAppContact[]>('get_whatsapp_contacts');
      setWhatsappContacts(list || []);
    } catch (err) {
      console.warn('[NotchSearch] Error cargando contactos de WhatsApp:', err);
    }
  }, []);

  // Carga inicial y listeners para sincronización en tiempo real
  useEffect(() => {
    // Retardo suave de 60ms para no competir con el resorte de apertura del Notch
    const loadTimer = setTimeout(() => {
      loadNotes();
      loadRecentDocs();
      loadWhatsAppContacts();
    }, 60);

    let unlistenNotes: (() => void) | undefined;
    let unlistenWhatsApp: (() => void) | undefined;

    listen('refresh-notes', () => {
      loadNotes();
    }).then((unsub) => {
      unlistenNotes = unsub;
    }).catch(() => {});

    listen('refresh-whatsapp-contacts', () => {
      loadWhatsAppContacts();
    }).then((unsub) => {
      unlistenWhatsApp = unsub;
    }).catch(() => {});

    return () => {
      clearTimeout(loadTimer);
      if (unlistenNotes) unlistenNotes();
      if (unlistenWhatsApp) unlistenWhatsApp();
    };
  }, [loadNotes, loadRecentDocs, loadWhatsAppContacts]);

  // Autofoco garantizado con múltiples delays para compositor Wayland
  useEffect(() => {
    const focusInput = () => {
      if (inputRef.current) {
        inputRef.current.focus();
      }
    };
    focusInput();
    const t1 = setTimeout(focusInput, 30);
    const t2 = setTimeout(focusInput, 100);
    const t3 = setTimeout(focusInput, 250);
    return () => {
      clearTimeout(t1);
      clearTimeout(t2);
      clearTimeout(t3);
    };
  }, []);

  // Reiniciar índice seleccionado al cambiar de query o filtro
  useEffect(() => {
    setSelectedIndex(0);
  }, [query, activeFilter]);

  // Detector de comando de Terminal: "> comando" o ">comando"
  const quickTerminalCmd = useMemo(() => {
    const q = query.trim();
    if (q.startsWith('>')) {
      const cmd = q.slice(1).trim();
      return cmd.length > 0 ? cmd : null;
    }
    return null;
  }, [query]);

  // Mapa indexado de ventanas abiertas para emparejamiento ultra rápido O(1)
  const openWindowsMap = useMemo(() => {
    const map = new Map<string, OpenWindow>();
    if (!windows) return map;
    for (const w of windows) {
      if (w.window_class) map.set(w.window_class.toLowerCase(), w);
      if (w.app_name) map.set(w.app_name.toLowerCase(), w);
    }
    return map;
  }, [windows]);

  // Helper para emparejar aplicaciones con ventanas abiertas activas en KWin
  const getActiveWindowForApp = useCallback((app: AppEntry): OpenWindow | undefined => {
    if (!windows || windows.length === 0) return undefined;
    const idLower = app.id.toLowerCase();
    const nameLower = app.name.toLowerCase();
    const execBin = (app.exec.trim().split(/\s+/)[0] || '').split('/').pop()?.toLowerCase() || '';

    if (execBin && openWindowsMap.has(execBin)) return openWindowsMap.get(execBin);
    if (idLower && openWindowsMap.has(idLower)) return openWindowsMap.get(idLower);
    if (nameLower && openWindowsMap.has(nameLower)) return openWindowsMap.get(nameLower);

    return windows.find(w => {
      const wClass = (w.window_class || '').toLowerCase();
      const wName = (w.app_name || '').toLowerCase();
      return (
        (execBin && (wClass.includes(execBin) || execBin.includes(wClass))) ||
        (idLower && (wClass.includes(idLower) || idLower.includes(wClass))) ||
        (nameLower.length >= 3 && (wClass.includes(nameLower) || wName.includes(nameLower)))
      );
    });
  }, [windows, openWindowsMap]);

  // Evaluador instantáneo de expresiones matemáticas, porcentajes, divisas y unidades
  const calculatorResult = useMemo(() => {
    return evaluateQuickCalculation(query);
  }, [query]);

  // Detector de comando especial: "nota: <texto>" o "/nota <texto>"
  const quickNoteCreateText = useMemo(() => {
    const q = query.trim();
    if (q.startsWith('/nota ') || q.startsWith('nota: ') || q.startsWith('recordar ')) {
      const text = q.replace(/^(\/nota|nota:|recordar)\s+/i, '').trim();
      return text.length > 0 ? text : null;
    }
    return null;
  }, [query]);

  // Detector de comando especial: "wa <contacto> <mensaje>" o "/wa <contacto> <mensaje>"
  const quickWhatsAppSend = useMemo(() => {
    const q = query.trim();
    if (q.startsWith('/wa ') || q.startsWith('wa ')) {
      const parts = q.replace(/^(\/wa|wa)\s+/i, '').trim().split(/\s+/);
      if (parts.length >= 2) {
        const targetName = parts[0].toLowerCase();
        const message = parts.slice(1).join(' ');
        const matched = whatsappContacts.find(c => c.name.toLowerCase().includes(targetName));
        if (matched && message) {
          return { contact: matched, message };
        }
      }
    }
    return null;
  }, [query, whatsappContacts]);

  // Aplicaciones de sistema filtradas por nombre, comentario, categorías y keywords nativas de FreeDesktop
  const matchingApps = useMemo(() => {
    if (activeFilter !== 'all' && activeFilter !== 'apps') return [];
    if (quickTerminalCmd) return [];
    const q = query.toLowerCase().trim();
    if (!q) {
      // Estado inicial vacío: muestra las principales aplicaciones del usuario
      return apps.slice(0, activeFilter === 'apps' ? 30 : 8);
    }
    return apps
      .filter(app => 
        app.name.toLowerCase().includes(q) || 
        (app.comment && app.comment.toLowerCase().includes(q)) || 
        (app.keywords && app.keywords.toLowerCase().includes(q)) ||
        (app.categories && app.categories.toLowerCase().includes(q)) ||
        app.id.toLowerCase().includes(q) ||
        (app.exec && app.exec.toLowerCase().includes(q))
      )
      .slice(0, activeFilter === 'apps' ? 40 : 10);
  }, [apps, query, activeFilter, quickTerminalCmd]);

  // Documentos recientes filtrados desde ~/.local/share/recently-used.xbel
  const matchingDocs = useMemo(() => {
    if (activeFilter !== 'all' && activeFilter !== 'files') return [];
    if (quickTerminalCmd) return [];
    const q = query.toLowerCase().trim();
    if (!q) {
      return activeFilter === 'files' ? recentDocs.slice(0, 20) : recentDocs.slice(0, 4);
    }
    return recentDocs
      .filter(doc => 
        doc.name.toLowerCase().includes(q) || 
        doc.path.toLowerCase().includes(q)
      )
      .slice(0, activeFilter === 'files' ? 25 : 5);
  }, [recentDocs, query, activeFilter, quickTerminalCmd]);

  // Acciones de sistema filtradas (Apagar, reiniciar, suspender, bloquear)
  const matchingActions = useMemo(() => {
    if (activeFilter !== 'all') return [];
    if (quickTerminalCmd) return [];
    const q = query.toLowerCase().trim();
    if (!q) {
      return SYSTEM_ACTIONS;
    }
    return SYSTEM_ACTIONS.filter(a => 
      a.name.toLowerCase().includes(q) || 
      a.id.toLowerCase().includes(q) ||
      ((q.includes('porta') || q.includes('clip') || q.includes('copia')) && a.id === 'clipboard') ||
      (q.includes('apag') && a.id === 'poweroff') ||
      (q.includes('rein') && a.id === 'reboot') ||
      (q.includes('bloq') && a.id === 'lock') ||
      (q.includes('susp') && a.id === 'suspend')
    );
  }, [query, activeFilter, quickTerminalCmd]);

  // Notas de SQLite filtradas
  const matchingNotes = useMemo(() => {
    if (activeFilter !== 'all' && activeFilter !== 'notes') return [];
    if (quickTerminalCmd) return [];
    const q = query.toLowerCase().trim();
    if (!q) {
      return activeFilter === 'notes' ? notes.slice(0, 15) : notes.slice(0, 3);
    }
    return notes
      .filter(n => 
        n.title.toLowerCase().includes(q) || 
        n.content.toLowerCase().includes(q)
      )
      .slice(0, activeFilter === 'notes' ? 20 : 4);
  }, [notes, query, activeFilter, quickTerminalCmd]);

  // Contactos de WhatsApp filtrados
  const matchingContacts = useMemo(() => {
    if (activeFilter !== 'all' && activeFilter !== 'whatsapp') return [];
    if (quickTerminalCmd) return [];
    const q = query.toLowerCase().trim();
    if (!q) {
      return activeFilter === 'whatsapp' ? whatsappContacts.slice(0, 15) : whatsappContacts.slice(0, 3);
    }
    return whatsappContacts
      .filter(c => 
        c.name.toLowerCase().includes(q) || 
        c.id.toLowerCase().includes(q)
      )
      .slice(0, activeFilter === 'whatsapp' ? 20 : 4);
  }, [whatsappContacts, query, activeFilter, quickTerminalCmd]);

  // Comandos de Enigma IA filtrados
  const matchingEnigmaCommands = useMemo(() => {
    if (activeFilter !== 'all' && activeFilter !== 'enigma') return [];
    if (quickTerminalCmd) return [];
    const q = query.toLowerCase().trim();
    if (!q || q === '/' || q === 'enigma' || q === 'ia') {
      return activeFilter === 'enigma' ? ENIGMA_QUICK_COMMANDS : ENIGMA_QUICK_COMMANDS.slice(0, 3);
    }
    return ENIGMA_QUICK_COMMANDS.filter(cmd => 
      cmd.name.toLowerCase().includes(q) ||
      cmd.description.toLowerCase().includes(q) ||
      cmd.id.toLowerCase().includes(q) ||
      cmd.badge.toLowerCase().includes(q)
    );
  }, [query, activeFilter, quickTerminalCmd]);

  // Lista unificada plana ordenada con prioridad OS nativa
  const totalItems = useMemo(() => {
    const list: SpotlightItem[] = [];
    const trimmed = query.trim();

    // 1. Ejecución de comandos en Terminal Linux (> htop, > pacman, etc.)
    if (quickTerminalCmd) {
      list.push({ type: 'terminal', command: quickTerminalCmd });
      return list;
    }

    // 2. Calculadora y conversor en vivo (Matemáticas, Divisas, Unidades)
    if (calculatorResult !== null && activeFilter === 'all') {
      list.push({ type: 'calc', calc: calculatorResult });
    }

    // 3. Acción especial de creación de nota rápida
    if (quickNoteCreateText && (activeFilter === 'all' || activeFilter === 'notes')) {
      list.push({ type: 'create_note', content: quickNoteCreateText });
    }

    // 4. Acción especial de envío rápido de WhatsApp
    if (quickWhatsAppSend && (activeFilter === 'all' || activeFilter === 'whatsapp')) {
      list.push({ 
        type: 'send_whatsapp_quick', 
        contact: quickWhatsAppSend.contact, 
        message: quickWhatsAppSend.message 
      });
    }

    // 5. APLICACIONES NATIVAS DE LINUX (Con detección de ventanas activas)
    matchingApps.forEach(app => {
      const activeWindow = getActiveWindowForApp(app);
      list.push({ type: 'app', app, activeWindow });
    });

    // 6. DOCUMENTOS Y ARCHIVOS RECIENTES (Nativo Linux)
    matchingDocs.forEach(doc => list.push({ type: 'doc', doc }));

    // 7. Acciones de Sistema (Apagar, reiniciar, etc.)
    matchingActions.forEach(action => list.push({ type: 'action', action }));

    // 8. Notas de SQLite
    matchingNotes.forEach(note => list.push({ type: 'note', note }));

    // 9. Contactos de WhatsApp
    matchingContacts.forEach(contact => list.push({ type: 'whatsapp', contact }));

    // 10. Consulta directa o comandos rápidos a Enigma IA
    if (trimmed.length > 0 && calculatorResult === null && !quickNoteCreateText && (activeFilter === 'all' || activeFilter === 'enigma')) {
      list.push({ type: 'enigma_query', query: trimmed });
    }

    if (activeFilter === 'all' || activeFilter === 'enigma') {
      matchingEnigmaCommands.forEach(cmd => list.push({ type: 'enigma_cmd', cmd }));
    }

    return list;
  }, [
    query, 
    quickTerminalCmd, 
    calculatorResult, 
    quickNoteCreateText, 
    quickWhatsAppSend, 
    activeFilter, 
    matchingApps, 
    getActiveWindowForApp, 
    matchingDocs, 
    matchingActions, 
    matchingNotes, 
    matchingContacts, 
    matchingEnigmaCommands
  ]);

  // Formato limpio de número de WhatsApp / JID
  const formatWhatsAppJid = (jid: string) => {
    if (jid.endsWith('@g.us')) return 'Grupo';
    const num = jid.split('@')[0];
    if (num.startsWith('34') && num.length === 11) {
      return `+34 ${num.slice(2, 5)} ${num.slice(5, 8)} ${num.slice(8)}`;
    }
    return `+${num}`;
  };

  // Formato legible de fecha de nota SQLite
  const formatNoteTimestamp = (ts: string) => {
    try {
      const d = new Date(ts);
      if (isNaN(d.getTime())) return ts;
      return d.toLocaleDateString('es-ES', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
    } catch {
      return ts;
    }
  };

  // Ejecución de la acción seleccionada
  const handleSelect = async (index: number) => {
    const selected = totalItems[index];
    if (!selected) return;

    if (selected.type === 'terminal') {
      try {
        await invoke('run_terminal_command', { command: selected.command });
        showToast(`Ejecutando: ${selected.command}`);
      } catch (err) {
        console.error('[NotchSearch] Error ejecutando comando:', err);
        showToast('Error al ejecutar comando');
      }
      onClose();
    } else if (selected.type === 'doc') {
      try {
        await invoke('open_native_path', { path: selected.doc.path });
        showToast(`Abriendo ${selected.doc.name}`);
      } catch (err) {
        console.error('[NotchSearch] Error abriendo archivo:', err);
        showToast('Error al abrir archivo');
      }
      onClose();
    } else if (selected.type === 'calc') {
      const cleanVal = selected.calc.result.replace(/^[€$£¥₿ΞC$A$R$]\s*/, '');
      navigator.clipboard.writeText(cleanVal);
      showToast(`Resultado copiado: ${cleanVal}`);
      setTimeout(() => {
        onClose();
      }, 450);
    } else if (selected.type === 'app') {
      if (selected.activeWindow) {
        focusWindow(selected.activeWindow.id);
        showToast(`Cambiando a ${selected.app.name}`);
      } else {
        launchApp(selected.app);
      }
      onClose();
    } else if (selected.type === 'action') {
      if (selected.action.action === 'clipboard') {
        onOpenClipboard?.();
      } else {
        executeAction(selected.action.action);
      }
      onClose();
    } else if (selected.type === 'math') {
      navigator.clipboard.writeText(selected.value.toString());
      showToast(`Copiado: ${selected.value}`);
      setTimeout(() => {
        onClose();
      }, 450);
    } else if (selected.type === 'create_note') {
      try {
        const title = selected.content.length > 28 ? selected.content.slice(0, 28) + '...' : selected.content;
        await invoke('add_note', { title, content: selected.content });
        showToast('Nota guardada en SQLite');
        setQuery('');
        await loadNotes();
      } catch (err) {
        console.error('[NotchSearch] Error guardando nota:', err);
        showToast('Error al guardar nota');
      }
    } else if (selected.type === 'send_whatsapp_quick') {
      const prompt = `Enviar un WhatsApp a ${selected.contact.name}: ${selected.message}`;
      onAskEnigma?.(prompt, true);
      onClose();
    } else if (selected.type === 'enigma_query') {
      onAskEnigma?.(selected.query, true);
      onClose();
    } else if (selected.type === 'enigma_cmd') {
      if (selected.cmd.actionType === 'stt') {
        try {
          await invoke('start_stt');
          showToast('Dictado por voz activado');
        } catch (e) {
          console.warn('[NotchSearch] Error al iniciar STT:', e);
        }
        onClose();
      } else {
        onAskEnigma?.(selected.cmd.prompt, true);
        onClose();
      }
    } else if (selected.type === 'note') {
      navigator.clipboard.writeText(selected.note.content);
      showToast(`Nota "${selected.note.title}" copiada`);
      setTimeout(() => {
        onClose();
      }, 450);
    } else if (selected.type === 'whatsapp') {
      const draftPrompt = `Enviar un WhatsApp a ${selected.contact.name}: `;
      onAskEnigma?.(draftPrompt, false);
      onClose();
    }
  };

  // Manejo de eventos de teclado (Navegación, Tab, Escape, Enter)
  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    onUserActivity?.();

    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSelectedIndex(prev => (prev + 1) % Math.max(1, totalItems.length));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSelectedIndex(prev => (prev - 1 + totalItems.length) % Math.max(1, totalItems.length));
    } else if (e.key === 'Tab') {
      e.preventDefault();
      const selected = totalItems[selectedIndex];
      if (selected && selected.type === 'app' && selected.activeWindow) {
        focusWindow(selected.activeWindow.id);
        showToast(`Cambiando a ${selected.app.name}`);
        onClose();
        return;
      }
      const filters: CategoryFilter[] = ['all', 'apps', 'files', 'enigma', 'notes', 'whatsapp'];
      const nextIdx = (filters.indexOf(activeFilter) + (e.shiftKey ? -1 : 1) + filters.length) % filters.length;
      setActiveFilter(filters[nextIdx]);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      handleSelect(selectedIndex);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      if (query) {
        setQuery('');
      } else {
        onClose();
      }
    }
  };

  // Auto-scroll suave para que el ítem seleccionado siempre esté en vista
  useEffect(() => {
    const activeEl = listContainerRef.current?.querySelector(`[data-spotlight-index="${selectedIndex}"]`);
    if (activeEl) {
      activeEl.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
  }, [selectedIndex]);

  return (
    <div 
      className="w-full h-full flex flex-col px-4 pt-3 pb-2.5 bg-[#0B0B0E] text-white select-none pointer-events-auto"
      onMouseMove={onUserActivity}
    >
      {/* 1. Barra de Búsqueda Omnibox KRunner/Spotlight */}
      <div 
        onClick={() => inputRef.current?.focus()}
        className="relative flex items-center w-full mb-2 shrink-0 cursor-text"
      >
        <div className="absolute left-3.5 flex items-center pointer-events-none">
          {quickTerminalCmd ? (
            <Terminal className="w-4 h-4 text-[#EF4444] animate-pulse" />
          ) : (
            <Search className="w-4 h-4 text-[#EF4444] animate-pulse" />
          )}
        </div>
        <input
          ref={inputRef}
          type="text"
          autoFocus
          spellCheck={false}
          autoComplete="off"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            onUserActivity?.();
          }}
          onKeyDown={handleKeyDown}
          onClick={(e) => {
            e.stopPropagation();
            inputRef.current?.focus();
            onUserActivity?.();
          }}
          placeholder="Buscar apps, archivos, escribir > comando o preguntar a Enigma..."
          className="w-full h-11 pl-11 pr-24 rounded-2xl bg-white/[0.04] border border-white/10 text-white placeholder-white/35 text-sm font-sans focus:outline-none focus:border-[#b82a2a]/80 focus:bg-white/[0.07] focus:shadow-[0_0_20px_rgba(184,42,42,0.3)] transition-all font-medium select-text cursor-text"
        />
        <div className="absolute right-3 flex items-center gap-1.5 pointer-events-none">
          <span className="text-[10px] font-mono px-1.5 py-0.5 rounded-md bg-white/[0.06] border border-white/10 text-white/50">
            TAB
          </span>
          <span className="text-[10px] font-mono px-1.5 py-0.5 rounded-md bg-white/[0.06] border border-white/10 text-white/50">
            ↵
          </span>
        </div>
      </div>

      {/* 2. Filtros de Categoría (Pill Bar) */}
      <div className="flex items-center gap-1.5 mb-2.5 pb-1 overflow-x-auto scrollbar-none shrink-0 select-none">
        {(
          [
            { id: 'all', label: 'Todos', icon: Sparkles },
            { id: 'apps', label: 'Apps', icon: LayoutGrid, count: matchingApps.length },
            { id: 'files', label: 'Archivos', icon: Folder, count: matchingDocs.length },
            { id: 'enigma', label: 'Enigma IA', icon: Bot, count: matchingEnigmaCommands.length + (query ? 1 : 0) },
            { id: 'notes', label: 'Notas', icon: FileText, count: matchingNotes.length },
            { id: 'whatsapp', label: 'WhatsApp', icon: MessageCircle, count: matchingContacts.length },
          ] as const
        ).map((tab) => {
          const isActive = activeFilter === tab.id;
          const Icon = tab.icon;
          return (
            <button
              key={tab.id}
              type="button"
              onClick={() => {
                setActiveFilter(tab.id);
                inputRef.current?.focus();
              }}
              className={`flex items-center gap-1.5 px-3 py-1 rounded-xl text-xs font-medium transition-all cursor-pointer border ${
                isActive
                  ? 'bg-gradient-to-r from-[#b82a2a]/30 to-[#b82a2a]/15 border-[#b82a2a] text-white shadow-[0_0_12px_rgba(184,42,42,0.35)] font-semibold'
                  : 'bg-white/[0.03] border-white/10 text-white/60 hover:text-white hover:border-white/20 hover:bg-white/[0.06]'
              }`}
            >
              <Icon className={`w-3.5 h-3.5 ${isActive ? 'text-[#b82a2a]' : 'text-white/40'}`} />
              <span>{tab.label}</span>
              {tab.id !== 'all' && query.trim().length > 0 && tab.count !== undefined && (
                <span className={`text-[10px] font-mono px-1.5 py-0.2 rounded-md ${isActive ? 'bg-[#b82a2a] text-white' : 'bg-white/10 text-white/60'}`}>
                  {tab.count}
                </span>
              )}
            </button>
          );
        })}
      </div>

      {/* 3. Lista de Resultados Unificada con Scroll Suave */}
      <div 
        ref={listContainerRef}
        className="flex-1 overflow-y-auto space-y-1.5 pr-1 custom-scrollbar min-h-0"
      >
        <AnimatePresence mode="popLayout">
          {totalItems.map((item, idx) => {
            const isSelected = selectedIndex === idx;

            // 1. Comando Terminal Linux
            if (item.type === 'terminal') {
              return (
                <motion.div
                  key={`cmd-${item.command}`}
                  data-spotlight-index={idx}
                  initial={{ opacity: 0, y: -4 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, scale: 0.95 }}
                  onClick={() => handleSelect(idx)}
                  className={`flex items-center justify-between px-3.5 py-2.5 rounded-xl cursor-pointer transition-all duration-150 border ${
                    isSelected
                      ? 'bg-white/[0.09] border-[#b82a2a]/60 shadow-[0_0_16px_rgba(184,42,42,0.25)]'
                      : 'bg-white/[0.02] border-white/5 hover:bg-white/[0.05] hover:border-white/10'
                  }`}
                >
                  <div className="flex items-center gap-3 min-w-0">
                    <div className="w-9 h-9 rounded-xl neu-inset flex items-center justify-center shrink-0">
                      <Terminal className="w-4 h-4 text-[#EF4444]" />
                    </div>
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-bold text-white font-mono truncate">
                          {item.command}
                        </span>
                        <span className="text-[9px] font-mono px-1.5 py-0.2 rounded-md neu-inset text-[#EF4444] uppercase font-bold">
                          Terminal
                        </span>
                      </div>
                      <span className="text-xs text-white/40 block truncate">
                        Ejecutar en Konsole o shell interactiva de Linux
                      </span>
                    </div>
                  </div>
                  <div className="flex items-center gap-1.5 shrink-0 ml-3">
                    <span className="text-[10px] font-mono text-[#EF4444] uppercase font-bold">Ejecutar</span>
                    <ArrowRight className="w-3.5 h-3.5 text-[#EF4444]" />
                  </div>
                </motion.div>
              );
            }

            // 2. Calculadora inteligente / Conversor en vivo
            if (item.type === 'calc') {
              return (
                <motion.div
                  key="spotlight-calc"
                  data-spotlight-index={idx}
                  initial={{ opacity: 0, y: -4 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, scale: 0.95 }}
                  onClick={() => handleSelect(idx)}
                  className={`flex items-center justify-between px-3.5 py-2.5 rounded-xl cursor-pointer transition-all duration-150 border ${
                    isSelected
                      ? 'bg-white/[0.09] border-[#b82a2a]/60 shadow-[0_0_16px_rgba(184,42,42,0.25)]'
                      : 'bg-white/[0.02] border-white/5 hover:bg-white/[0.05] hover:border-white/10'
                  }`}
                >
                  <div className="flex items-center gap-3 min-w-0">
                    <div className="w-9 h-9 rounded-xl bg-amber-500/10 border border-amber-500/30 flex items-center justify-center text-amber-400 shrink-0">
                      <Calculator className="w-4 h-4" />
                    </div>
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="text-[10px] text-amber-400 font-bold font-mono uppercase tracking-wider">
                          {item.calc.category === 'currency' ? 'Conversor de Divisas' : item.calc.category === 'unit' ? 'Conversor de Unidades' : 'Cálculo Rápido'}
                        </span>
                        <span className="text-[9px] font-mono px-1.5 py-0.2 rounded-md bg-amber-500/15 text-amber-300 border border-amber-500/20">
                          {item.calc.detail}
                        </span>
                      </div>
                      <div className="text-base font-bold font-mono text-white tracking-wide truncate">
                        = {item.calc.result}
                      </div>
                    </div>
                  </div>
                  <div className="flex items-center gap-1.5 shrink-0 ml-3">
                    <span className="text-[10px] font-mono text-amber-400 uppercase font-bold">Copiar</span>
                    <Copy className="w-3.5 h-3.5 text-amber-400" />
                  </div>
                </motion.div>
              );
            }

            // 3. Crear nota rápida
            if (item.type === 'create_note') {
              return (
                <motion.div
                  key="spotlight-create-note"
                  data-spotlight-index={idx}
                  initial={{ opacity: 0, y: -4 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, scale: 0.95 }}
                  onClick={() => handleSelect(idx)}
                  className={`flex items-center justify-between px-3.5 py-2.5 rounded-xl cursor-pointer transition-all duration-150 border ${
                    isSelected
                      ? 'bg-white/[0.09] border-[#b82a2a]/60 shadow-[0_0_16px_rgba(184,42,42,0.25)]'
                      : 'bg-white/[0.02] border-white/5 hover:bg-white/[0.05] hover:border-white/10'
                  }`}
                >
                  <div className="flex items-center gap-3 min-w-0">
                    <div className="w-9 h-9 rounded-xl bg-amber-500/10 border border-amber-500/30 flex items-center justify-center shrink-0">
                      <FileText className="w-4 h-4 text-amber-400" />
                    </div>
                    <div className="min-w-0">
                      <span className="text-[10px] font-mono font-bold text-amber-400 uppercase tracking-wider block">
                        Nueva Nota en SQLite
                      </span>
                      <span className="text-sm font-semibold text-white block truncate">
                        "{item.content}"
                      </span>
                    </div>
                  </div>
                  <div className="flex items-center gap-1 shrink-0 ml-2">
                    <span className="text-[10px] font-mono text-amber-400 uppercase font-bold">Guardar</span>
                    <ArrowRight className="w-3.5 h-3.5 text-amber-400" />
                  </div>
                </motion.div>
              );
            }

            // 4. Enviar WhatsApp rápido
            if (item.type === 'send_whatsapp_quick') {
              return (
                <motion.div
                  key="spotlight-send-wa"
                  data-spotlight-index={idx}
                  initial={{ opacity: 0, y: -4 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, scale: 0.95 }}
                  onClick={() => handleSelect(idx)}
                  className={`flex items-center justify-between px-3.5 py-2.5 rounded-xl cursor-pointer transition-all duration-150 border ${
                    isSelected
                      ? 'bg-white/[0.09] border-[#b82a2a]/60 shadow-[0_0_16px_rgba(184,42,42,0.25)]'
                      : 'bg-white/[0.02] border-white/5 hover:bg-white/[0.05] hover:border-white/10'
                  }`}
                >
                  <div className="flex items-center gap-3 min-w-0">
                    <div className="w-9 h-9 rounded-xl neu-inset flex items-center justify-center shrink-0">
                      <MessageCircle className="w-4 h-4 text-[#EF4444]" />
                    </div>
                    <div className="min-w-0">
                      <span className="text-[10px] font-mono font-bold text-[#EF4444] uppercase tracking-wider block">
                        WhatsApp a {item.contact.name}
                      </span>
                      <span className="text-sm font-semibold text-white block truncate">
                        "{item.message}"
                      </span>
                    </div>
                  </div>
                  <div className="flex items-center gap-1 shrink-0 ml-2">
                    <span className="text-[10px] font-mono text-[#EF4444] uppercase font-bold">Enviar</span>
                    <Send className="w-3.5 h-3.5 text-[#EF4444]" />
                  </div>
                </motion.div>
              );
            }

            // 5. APLICACIÓN DE LINUX (Con icono nativo y detección de ventana activa)
            if (item.type === 'app') {
              const isActive = !!item.activeWindow;
              return (
                <motion.div
                  key={`app-${item.app.id}`}
                  data-spotlight-index={idx}
                  initial={{ opacity: 0, y: -4 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, scale: 0.95 }}
                  onClick={() => handleSelect(idx)}
                  className={`flex items-center justify-between px-3.5 py-2 rounded-xl cursor-pointer transition-all duration-150 border ${
                    isSelected
                      ? 'bg-white/[0.09] border-[#b82a2a]/60 shadow-[0_0_16px_rgba(184,42,42,0.25)]'
                      : 'bg-white/[0.02] border-white/5 hover:bg-white/[0.05] hover:border-white/10'
                  }`}
                >
                  <div className="flex items-center gap-3 min-w-0">
                    <div className="relative w-9 h-9 rounded-xl bg-black/40 border border-white/10 flex items-center justify-center shrink-0 p-1 shadow-sm">
                      <AppIcon iconPath={item.app.icon} appName={item.app.name} className="w-7 h-7" />
                      {isActive && (
                        <span className="absolute -bottom-0.5 -right-0.5 w-2.5 h-2.5 rounded-full neu-led-red border border-black shadow-[0_0_8px_#ef4444]" />
                      )}
                    </div>
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-semibold text-white truncate">
                          {item.app.name}
                        </span>
                        {isActive ? (
                          <span className="text-[9px] font-mono px-1.5 py-0.5 rounded-md neu-inset text-white font-semibold flex items-center gap-1">
                            <span className="w-1.5 h-1.5 rounded-full neu-led-red animate-pulse" />
                            Activa
                          </span>
                        ) : item.app.categories ? (
                          <span className="text-[9px] font-mono px-1.5 py-0.2 rounded-md bg-white/[0.06] text-white/50 border border-white/5 uppercase">
                            {item.app.categories.split(';')[0]}
                          </span>
                        ) : null}
                      </div>
                      <span className="text-xs text-white/40 block truncate">
                        {isActive ? `Ventana: ${item.activeWindow?.title || item.app.name}` : (item.app.comment || item.app.exec)}
                      </span>
                    </div>
                  </div>
                  <div className="flex items-center gap-1.5 shrink-0 ml-3">
                    {isActive ? (
                      <div className="flex items-center gap-1.5">
                        <span className="text-[10px] font-mono px-1.5 py-0.5 rounded neu-inset text-white font-bold">
                          Tab
                        </span>
                        <span className="text-[10px] font-mono text-[#EF4444] uppercase font-bold">Cambiar</span>
                        <ArrowRight className="w-3.5 h-3.5 text-[#EF4444]" />
                      </div>
                    ) : (
                      <>
                        <span className="text-[10px] font-mono text-white/40 group-hover:text-white/70 uppercase">Abrir</span>
                        <ArrowRight className={`w-3.5 h-3.5 ${isSelected ? 'text-[#b82a2a]' : 'text-white/40'}`} />
                      </>
                    )}
                  </div>
                </motion.div>
              );
            }

            // 6. DOCUMENTO RECIENTE DE LINUX (~/.local/share/recently-used.xbel)
            if (item.type === 'doc') {
              return (
                <motion.div
                  key={`doc-${item.doc.path}`}
                  data-spotlight-index={idx}
                  initial={{ opacity: 0, y: -4 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, scale: 0.95 }}
                  onClick={() => handleSelect(idx)}
                  className={`flex items-center justify-between px-3.5 py-2 rounded-xl cursor-pointer transition-all duration-150 border ${
                    isSelected
                      ? 'bg-white/[0.09] border-[#b82a2a]/60 shadow-[0_0_16px_rgba(184,42,42,0.25)]'
                      : 'bg-white/[0.02] border-white/5 hover:bg-white/[0.05] hover:border-white/10'
                  }`}
                >
                  <div className="flex items-center gap-3 min-w-0">
                    <div className="w-9 h-9 rounded-xl bg-blue-500/10 border border-blue-500/30 flex items-center justify-center shrink-0">
                      {item.doc.is_dir ? <Folder className="w-4 h-4 text-blue-400" /> : <File className="w-4 h-4 text-blue-300" />}
                    </div>
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-semibold text-white truncate">
                          {item.doc.name}
                        </span>
                        <span className="text-[9px] font-mono px-1.5 py-0.2 rounded-md bg-blue-500/15 text-blue-400 border border-blue-500/30 uppercase font-semibold">
                          {item.doc.is_dir ? 'Carpeta' : 'Archivo'}
                        </span>
                      </div>
                      <span className="text-xs text-white/40 block truncate font-mono">
                        {item.doc.path.replace(/^\/home\/[^\/]+/, '~')}
                      </span>
                    </div>
                  </div>
                  <div className="flex items-center gap-1.5 shrink-0 ml-3">
                    <span className="text-[10px] font-mono text-white/40 uppercase">Abrir</span>
                    <ArrowRight className={`w-3.5 h-3.5 ${isSelected ? 'text-[#b82a2a]' : 'text-white/40'}`} />
                  </div>
                </motion.div>
              );
            }

            // 7. Acciones de Sistema
            if (item.type === 'action') {
              const Icon = item.action.icon;
              return (
                <motion.div
                  key={`act-${item.action.id}`}
                  data-spotlight-index={idx}
                  initial={{ opacity: 0, y: -4 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, scale: 0.95 }}
                  onClick={() => handleSelect(idx)}
                  className={`flex items-center justify-between px-3.5 py-2.5 rounded-xl cursor-pointer transition-all duration-150 border ${
                    isSelected
                      ? 'bg-white/[0.09] border-[#b82a2a]/60 shadow-[0_0_16px_rgba(184,42,42,0.25)]'
                      : 'bg-white/[0.02] border-white/5 hover:bg-white/[0.05] hover:border-white/10'
                  }`}
                >
                  <div className="flex items-center gap-3">
                    <div className="w-9 h-9 rounded-xl bg-red-500/10 border border-red-500/30 flex items-center justify-center text-[#d43b3b]">
                      <Icon className="w-4 h-4 text-[#d43b3b]" />
                    </div>
                    <div>
                      <div className="flex items-center gap-1.5">
                        <span className="text-[10px] font-mono font-bold text-[#d43b3b] uppercase">Sistema</span>
                      </div>
                      <span className="text-sm font-semibold text-white block">{item.action.name}</span>
                      <span className="text-xs text-white/40 block">{item.action.description}</span>
                    </div>
                  </div>
                  <ArrowRight className="w-3.5 h-3.5 text-[#b82a2a]" />
                </motion.div>
              );
            }

            // 8. Notas de SQLite
            if (item.type === 'note') {
              return (
                <motion.div
                  key={`note-${item.note.id}`}
                  data-spotlight-index={idx}
                  initial={{ opacity: 0, y: -4 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, scale: 0.95 }}
                  onClick={() => handleSelect(idx)}
                  className={`flex items-center justify-between px-3.5 py-2.5 rounded-xl cursor-pointer transition-all duration-150 border ${
                    isSelected
                      ? 'bg-white/[0.09] border-[#b82a2a]/60 shadow-[0_0_16px_rgba(184,42,42,0.25)]'
                      : 'bg-white/[0.02] border-white/5 hover:bg-white/[0.05] hover:border-white/10'
                  }`}
                >
                  <div className="flex items-center gap-3 min-w-0">
                    <div className="w-9 h-9 rounded-xl bg-amber-500/10 border border-amber-500/30 flex items-center justify-center shrink-0">
                      <FileText className="w-4 h-4 text-amber-400" />
                    </div>
                    <div className="min-w-0">
                      <div className="flex items-center gap-1.5">
                        <span className="text-[10px] font-mono font-bold text-amber-400 uppercase">Nota SQLite</span>
                        <span className="text-white/30 text-[10px]">·</span>
                        <span className="text-[10px] text-white/50 font-mono">{formatNoteTimestamp(item.note.timestamp)}</span>
                      </div>
                      <span className="text-sm font-semibold text-white block truncate">
                        {item.note.title}
                      </span>
                      <span className="text-xs text-white/40 block truncate">
                        {item.note.content}
                      </span>
                    </div>
                  </div>
                  <div className="flex items-center gap-1 shrink-0 ml-2">
                    <span className="text-[10px] font-mono text-white/50 uppercase">Copiar</span>
                    <Copy className="w-3.5 h-3.5 text-amber-400" />
                  </div>
                </motion.div>
              );
            }

            // 9. Contacto de WhatsApp
            if (item.type === 'whatsapp') {
              return (
                <motion.div
                  key={`wa-${item.contact.id}`}
                  data-spotlight-index={idx}
                  initial={{ opacity: 0, y: -4 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, scale: 0.95 }}
                  onClick={() => handleSelect(idx)}
                  className={`flex items-center justify-between px-3.5 py-2.5 rounded-xl cursor-pointer transition-all duration-150 border ${
                    isSelected
                      ? 'bg-white/[0.09] border-[#b82a2a]/60 shadow-[0_0_16px_rgba(184,42,42,0.25)]'
                      : 'bg-white/[0.02] border-white/5 hover:bg-white/[0.05] hover:border-white/10'
                  }`}
                >
                  <div className="flex items-center gap-3 min-w-0">
                    <div className="w-9 h-9 rounded-xl neu-inset flex items-center justify-center shrink-0">
                      <MessageCircle className="w-4 h-4 text-[#EF4444]" />
                    </div>
                    <div className="min-w-0">
                      <div className="flex items-center gap-1.5">
                        <span className="text-[10px] font-mono font-bold text-[#EF4444] uppercase">WhatsApp</span>
                        <span className="text-white/30 text-[10px]">·</span>
                        <span className="text-[10px] text-white/50 font-mono">{formatWhatsAppJid(item.contact.id)}</span>
                      </div>
                      <span className="text-sm font-semibold text-white block truncate">
                        {item.contact.name}
                      </span>
                    </div>
                  </div>
                  <div className="flex items-center gap-1 shrink-0 ml-2">
                    <span className="text-[10px] font-mono text-[#EF4444] uppercase font-bold">Escribir</span>
                    <ArrowRight className="w-3.5 h-3.5 text-[#EF4444]" />
                  </div>
                </motion.div>
              );
            }

            // 10. Pregunta directa a Enigma IA
            if (item.type === 'enigma_query') {
              return (
                <motion.div
                  key="spotlight-enigma-query"
                  data-spotlight-index={idx}
                  initial={{ opacity: 0, y: -4 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, scale: 0.95 }}
                  onClick={() => handleSelect(idx)}
                  className={`flex items-center justify-between px-3.5 py-2.5 rounded-xl cursor-pointer transition-all duration-150 border ${
                    isSelected
                      ? 'bg-white/[0.09] border-[#b82a2a]/60 shadow-[0_0_16px_rgba(184,42,42,0.25)]'
                      : 'bg-white/[0.02] border-white/5 hover:bg-white/[0.05] hover:border-white/10'
                  }`}
                >
                  <div className="flex items-center gap-3 min-w-0">
                    <div className="w-9 h-9 rounded-xl bg-[#b82a2a]/15 border border-[#b82a2a]/30 flex items-center justify-center text-[#b82a2a] shrink-0">
                      <Zap className="w-4 h-4 text-[#b82a2a]" />
                    </div>
                    <div className="min-w-0">
                      <span className="text-[10px] font-mono font-bold text-[#d43b3b] uppercase tracking-wider block">
                        Preguntar a Enigma IA
                      </span>
                      <span className="text-sm font-semibold text-white block truncate">
                        "{item.query}"
                      </span>
                    </div>
                  </div>
                  <div className="flex items-center gap-1 shrink-0 ml-2">
                    <span className="text-[10px] font-mono text-white/50 uppercase">Consultar</span>
                    <ArrowRight className="w-3.5 h-3.5 text-[#b82a2a]" />
                  </div>
                </motion.div>
              );
            }

            // 11. Comando Rápido Enigma
            if (item.type === 'enigma_cmd') {
              const Icon = item.cmd.icon;
              return (
                <motion.div
                  key={`cmd-${item.cmd.id}`}
                  data-spotlight-index={idx}
                  initial={{ opacity: 0, y: -4 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, scale: 0.95 }}
                  onClick={() => handleSelect(idx)}
                  className={`flex items-center justify-between px-3.5 py-2.5 rounded-xl cursor-pointer transition-all duration-150 border ${
                    isSelected
                      ? 'bg-white/[0.09] border-[#b82a2a]/60 shadow-[0_0_16px_rgba(184,42,42,0.25)]'
                      : 'bg-white/[0.02] border-white/5 hover:bg-white/[0.05] hover:border-white/10'
                  }`}
                >
                  <div className="flex items-center gap-3 min-w-0">
                    <div className="w-9 h-9 rounded-xl bg-[#b82a2a]/10 border border-[#b82a2a]/30 flex items-center justify-center text-[#b82a2a] shrink-0">
                      <Icon className="w-4 h-4 text-[#b82a2a]" />
                    </div>
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="text-[10px] font-mono font-bold text-[#d43b3b] uppercase">Enigma Acción</span>
                        <span className="text-white/30 text-[10px]">·</span>
                        <span className="text-[10px] text-white/50 font-mono">{item.cmd.badge}</span>
                      </div>
                      <span className="text-sm font-semibold text-white block truncate">{item.cmd.name}</span>
                      <span className="text-xs text-white/40 block truncate">{item.cmd.description}</span>
                    </div>
                  </div>
                  <div className="flex items-center gap-1.5 shrink-0 ml-2">
                    <span className="text-[10px] font-mono text-white/50 uppercase">Ejecutar</span>
                    <ArrowRight className="w-3.5 h-3.5 text-[#b82a2a]" />
                  </div>
                </motion.div>
              );
            }

            return null;
          })}

          {totalItems.length === 0 && (
            <div className="text-center py-8">
              <Search className="w-8 h-8 text-[#b82a2a]/40 mx-auto mb-2" />
              <p className="text-sm text-white/60">No se encontraron resultados para "{query}"</p>
              <p className="text-xs text-white/40 mt-1 font-mono">
                Prueba con apps, archivos, escribe `&gt; comando` o consulta a Enigma
              </p>
            </div>
          )}
        </AnimatePresence>
      </div>

      {/* 4. Footer con Notificaciones Toast o Atajos de Teclado */}
      <div className="pt-2 border-t border-white/10 flex items-center justify-between text-[10px] font-mono text-white/50 shrink-0">
        <div className="flex items-center gap-2">
          {toastMessage ? (
            <span className="text-white font-bold flex items-center gap-1 animate-pulse">
              <Check className="w-3 h-3 text-[#EF4444]" />
              {toastMessage}
            </span>
          ) : (
            <span className="flex items-center gap-1.5 text-white/70">
              <span className="w-1.5 h-1.5 rounded-full bg-[#b82a2a]" />
              <span>Spotlight Linux & Enigma Hub</span>
            </span>
          )}
        </div>
        <div className="flex items-center gap-2 text-white/40">
          <span>↑↓ Mover</span>
          <span>·</span>
          <span>↵ Ejecutar</span>
          <span>·</span>
          <span>Tab Filtro</span>
          <span>·</span>
          <span>&gt; Terminal</span>
          <span>·</span>
          <span>Esc Salir</span>
        </div>
      </div>
    </div>
  );
};
