import React, { useState, useEffect, useRef, useCallback } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { invoke, convertFileSrc } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { MediaExpanded, type NotchSection } from './MediaExpanded';
import { NotchSearch } from './NotchSearch';
import { NotchTopLeftEar, NotchTopRightEar } from './NotchEars';
import { syncAllTopBarRegions } from '../utils/syncInputRegions';
import { EnigmaHub } from './EnigmaHub';
import { PersonaSelector, getPersonaMetadata } from './PersonaSelector';
import { VoiceOrb, type VoiceOrbState } from './VoiceOrb';
import { useAudioReactive } from '../hooks/useAudioReactive';
import { useMediaSession } from '../hooks/useMediaSession';
import { SpotifyMiniSpectrum } from './SpotifyMiniSpectrum';
import { AppIcon } from './IconMapper';
import type { DesktopNotification } from '../types';
import { SmartClipboardPill, type ClipboardRecord } from './SmartClipboardPill';
import { ClipboardHistoryModal } from './ClipboardHistoryModal';
import { Eye, Scan, Monitor } from 'lucide-react';

const NotificationIcon: React.FC<{ icon?: string; appName?: string }> = ({ icon, appName }) => {
  const isAbsPath = icon && icon.startsWith('/');
  const isUrl = icon && /^(https?:|data:|asset:)/.test(icon);
  if (isAbsPath || isUrl) {
    return (
      <img
        src={isAbsPath ? convertFileSrc(icon) : icon}
        alt={appName || 'App'}
        draggable={false}
        decoding="async"
        className="w-full h-full object-contain select-none"
      />
    );
  }
  return <AppIcon windowClass={icon || appName} appName={appName} />;
};

interface DynamicNotchProps {
  innerRef?: React.Ref<HTMLDivElement>;
  isExpanded?: boolean;
  onHoverChange?: (expanded: boolean) => void;
  isSearchOpen?: boolean;
  onSearchOpenChange?: (open: boolean) => void;
}

interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  model_used?: string;
  thoughts?: string[];
}



export const DynamicNotch: React.FC<DynamicNotchProps> = ({
  innerRef,
  isExpanded: controlledExpanded = false,
  onHoverChange,
  isSearchOpen: controlledSearchOpen = false,
  onSearchOpenChange,
}) => {
  const [isHovered, setIsHovered] = useState<boolean>(false);
  const [internalSearchOpen, setInternalSearchOpen] = useState<boolean>(false);
  const [activeSection, setActiveSection] = useState<NotchSection>('media');
  const [currentTime, setCurrentTime] = useState<Date>(new Date());

  // Sesión multimedia activa de Spotify / MPRIS
  const { media } = useMediaSession();
  const isSpotifyPlaying = media.status === 'Playing';

  // Sincronización de hitbox al cambiar el estado de reproducción de música
  useEffect(() => {
    syncAllTopBarRegions();
    const t = setTimeout(syncAllTopBarRegions, 60);
    return () => clearTimeout(t);
  }, [isSpotifyPlaying]);

  // =========================================================================
  // MÁQUINA DE ESTADOS: ENIGMA AI MODULE
  // 'hidden' -> 'corrupting' (500ms) -> 'active' (3 Módulos Flotantes)
  // Atajo global nativo Tauri 2: ALT + 3
  // =========================================================================
  const [enigmaState, setEnigmaState] = useState<'hidden' | 'corrupting' | 'active'>('hidden');

  // Estado del chat con DeepSeek-R1 (14B)
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [inputValue, setInputValue] = useState<string>('');
  const [isStreaming, setIsStreaming] = useState<boolean>(false);
  const [routingStatus, setRoutingStatus] = useState<string | null>(null);
  const [isListeningSTT, setIsListeningSTT] = useState<boolean>(false);
  const [voiceEnabled, setVoiceEnabled] = useState<boolean>(true);
  const audioReactive = useAudioReactive(enigmaState === 'active');
  const [isDoneState, setIsDoneState] = useState<boolean>(false);
  const [isAlertState, setIsAlertState] = useState<boolean>(false);
  const wasStreamingRef = useRef<boolean>(false);

  // Sistema de Personas (Multi-Agente / Custom GPTs)
  const [availablePersonas, setAvailablePersonas] = useState<string[]>([
    'enigma_default',
    'grok',
    'rust_senior',
    'maestro_piano',
  ]);
  const [activePersona, setActivePersona] = useState<string>('enigma_default');
  const [showMentionMenu, setShowMentionMenu] = useState<boolean>(false);
  const [showVisionMenu, setShowVisionMenu] = useState<boolean>(false);
  const [isCapturingVision, setIsCapturingVision] = useState<boolean>(false);

  // =========================================================================
  // NOTIFICACIONES NATIVAS DEL SISTEMA (org.freedesktop.Notifications / D-Bus)
  // Expande el Notch en píldora fluida (Dynamic Island) al recibir alertas.
  // =========================================================================
  const [activeNotification, setActiveNotification] = useState<DesktopNotification | null>(null);
  const [notificationQueue, setNotificationQueue] = useState<DesktopNotification[]>([]);
  const notificationTimerRef = useRef<number | null>(null);
  const isNotificationHoveredRef = useRef<boolean>(false);

  // Sincronización continua de la hitbox de la barra superior al recibir notificaciones
  useEffect(() => {
    syncAllTopBarRegions();
    const t = setTimeout(syncAllTopBarRegions, 60);
    return () => clearTimeout(t);
  }, [activeNotification]);

  // =========================================================================
  // SMART CLIPBOARD PILL & HISTORIAL
  // Expande el Notch al copiar texto, código, color o imágenes (Ctrl + C)
  // =========================================================================
  const [activeClipboardPill, setActiveClipboardPill] = useState<ClipboardRecord | null>(null);
  const [isClipboardHistoryOpen, setIsClipboardHistoryOpen] = useState(false);
  const [isPillHovered, setIsPillHovered] = useState(false);
  const clipboardTimerRef = useRef<number | null>(null);
  const failsafeTimerRef = useRef<number | null>(null);
  const isClipboardHoveredRef = useRef<boolean>(false);

  const dismissClipboardPill = useCallback(() => {
    if (clipboardTimerRef.current) {
      window.clearTimeout(clipboardTimerRef.current);
      clipboardTimerRef.current = null;
    }
    if (failsafeTimerRef.current) {
      window.clearTimeout(failsafeTimerRef.current);
      failsafeTimerRef.current = null;
    }
    isClipboardHoveredRef.current = false;
    setIsPillHovered(false);
    setActiveClipboardPill(null);
    setTimeout(syncAllTopBarRegions, 40);
  }, []);

  const scheduleClipboardDismiss = useCallback((ms: number) => {
    if (clipboardTimerRef.current) {
      window.clearTimeout(clipboardTimerRef.current);
    }
    clipboardTimerRef.current = window.setTimeout(() => {
      if (!isClipboardHoveredRef.current) {
        dismissClipboardPill();
      }
    }, ms);
  }, [dismissClipboardPill]);

  const handleClipboardMouseEnter = useCallback(() => {
    isClipboardHoveredRef.current = true;
    setIsPillHovered(true);
    if (clipboardTimerRef.current) {
      window.clearTimeout(clipboardTimerRef.current);
      clipboardTimerRef.current = null;
    }
  }, []);

  const handleClipboardMouseLeave = useCallback(() => {
    isClipboardHoveredRef.current = false;
    setIsPillHovered(false);
    scheduleClipboardDismiss(1200);
  }, [scheduleClipboardDismiss]);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    listen<ClipboardRecord>('clipboard_copied', (event) => {
      if (!event.payload) return;
      const record = event.payload;

      // Si el modal de historial ya está abierto, no estorbar
      if (isClipboardHistoryOpen) return;

      // Cancelar cualquier estado previo de expansión o hover del Notch
      setIsHovered(false);
      onHoverChange?.(false);
      isClipboardHoveredRef.current = false;
      setIsPillHovered(false);

      setActiveClipboardPill(record);
      scheduleClipboardDismiss(3000); // 3 segundos completos

      // Temporizador failsafe absoluto: máximo 6 segundos de vida pase lo que pase
      if (failsafeTimerRef.current) window.clearTimeout(failsafeTimerRef.current);
      failsafeTimerRef.current = window.setTimeout(() => {
        dismissClipboardPill();
      }, 6000);

      setTimeout(syncAllTopBarRegions, 30);
    }).then((unsub) => {
      unlisten = unsub;
    });

    return () => {
      if (unlisten) unlisten();
      if (clipboardTimerRef.current) window.clearTimeout(clipboardTimerRef.current);
      if (failsafeTimerRef.current) window.clearTimeout(failsafeTimerRef.current);
    };
  }, [scheduleClipboardDismiss, dismissClipboardPill, isClipboardHistoryOpen, onHoverChange]);



  useEffect(() => {
    syncAllTopBarRegions();
    const t = setTimeout(syncAllTopBarRegions, 60);
    return () => clearTimeout(t);
  }, [activeClipboardPill, isClipboardHistoryOpen]);


  const dismissNotification = useCallback(() => {
    if (notificationTimerRef.current) {
      window.clearTimeout(notificationTimerRef.current);
      notificationTimerRef.current = null;
    }
    setActiveNotification(null);
    setTimeout(syncAllTopBarRegions, 30);

    setNotificationQueue((prevQueue) => {
      if (prevQueue.length > 0) {
        const [next, ...rest] = prevQueue;
        setTimeout(() => {
          setActiveNotification(next);
          setTimeout(syncAllTopBarRegions, 30);
        }, 120);
        return rest;
      }
      return prevQueue;
    });
  }, []);

  const handleNotificationClick = useCallback((notif: DesktopNotification) => {
    invoke('invoke_desktop_notification_action', { id: notif.id, action: 'default' }).catch(() => { });
    const target = notif.origin_name || notif.app_name || notif.desktop_entry;
    if (target) {
      invoke('focus_app_or_window', { query: target }).catch(() => { });
    }
    dismissNotification();
  }, [dismissNotification]);

  const handleNotificationCloseBtn = useCallback((e: React.MouseEvent, notif: DesktopNotification) => {
    e.stopPropagation();
    invoke('close_desktop_notification', { id: notif.id }).catch(() => { });
    dismissNotification();
  }, [dismissNotification]);

  const scheduleNotificationDismiss = useCallback((durationMs: number) => {
    if (notificationTimerRef.current) {
      window.clearTimeout(notificationTimerRef.current);
      notificationTimerRef.current = null;
    }
    notificationTimerRef.current = window.setTimeout(() => {
      if (!isNotificationHoveredRef.current) {
        dismissNotification();
      }
    }, Math.max(durationMs, 4500));
  }, [dismissNotification]);

  const handleNotificationMouseEnter = useCallback(() => {
    isNotificationHoveredRef.current = true;
    if (notificationTimerRef.current) {
      window.clearTimeout(notificationTimerRef.current);
      notificationTimerRef.current = null;
    }
  }, []);

  const handleNotificationMouseLeave = useCallback(() => {
    isNotificationHoveredRef.current = false;
    scheduleNotificationDismiss(2500);
  }, [scheduleNotificationDismiss]);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    listen<DesktopNotification>('desktop-notification', (event) => {
      if (!event.payload) return;
      const notif = event.payload;

      setActiveNotification((current) => {
        if (!current) {
          scheduleNotificationDismiss(notif.expire_timeout > 0 ? notif.expire_timeout : 4500);
          setTimeout(syncAllTopBarRegions, 40);
          return notif;
        } else {
          setNotificationQueue((q) => [...q, notif]);
          return current;
        }
      });
    }).then((unsub) => {
      unlisten = unsub;
    });

    return () => {
      if (unlisten) unlisten();
      if (notificationTimerRef.current) clearTimeout(notificationTimerRef.current);
    };
  }, [scheduleNotificationDismiss]);

  const forcefieldRef = useRef<HTMLDivElement>(null);
  const notchRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Cargar personas disponibles desde Rust al iniciar la app
  useEffect(() => {
    invoke<string[]>('get_available_personas')
      .then((personas) => {
        if (personas && personas.length > 0) {
          setAvailablePersonas(personas);
        }
      })
      .catch((err) => console.error('[DynamicNotch] Error cargando personas disponibles:', err));
  }, []);

  // Escuchar eventos en tiempo real de transparencia de procesos multi-agente
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    listen<{ phase: number; status: string; model?: string }>('enigma-status', (event) => {
      const statusText = event.payload?.status;
      if (statusText) {
        setRoutingStatus(statusText);
        setMessages((prev) => {
          const lastIdx = prev.length - 1;
          if (lastIdx >= 0 && prev[lastIdx].role === 'assistant') {
            const currentThoughts = prev[lastIdx].thoughts || [];
            if (!currentThoughts.includes(statusText)) {
              const updated = [...prev];
              updated[lastIdx] = {
                ...prev[lastIdx],
                thoughts: [...currentThoughts, statusText],
              };
              return updated;
            }
          }
          return prev;
        });
      }
    }).then((unsub) => {
      unlisten = unsub;
    });

    return () => {
      if (unlisten) unlisten();
    };
  }, []);

  // Limpiar banner flotante cuando finaliza la respuesta
  useEffect(() => {
    if (!isStreaming) {
      const timer = setTimeout(() => setRoutingStatus(null), 1000);
      return () => clearTimeout(timer);
    }
  }, [isStreaming]);

  // Transición automática a modo 'done' (sello con checkmark ✓) cuando concluye la respuesta de la IA
  useEffect(() => {
    if (wasStreamingRef.current && !isStreaming) {
      setIsDoneState(true);
      const timer = setTimeout(() => setIsDoneState(false), 2700);
      return () => clearTimeout(timer);
    }
    wasStreamingRef.current = isStreaming;
  }, [isStreaming]);

  // Transición del Glitch a Activo (300ms)
  useEffect(() => {
    if (enigmaState === 'corrupting') {
      const timer = setTimeout(() => setEnigmaState('active'), 300);
      return () => clearTimeout(timer);
    }
  }, [enigmaState]);

  // Consulta inicial de voz habilitada en Rust
  useEffect(() => {
    invoke<boolean>('get_enigma_voice_enabled')
      .then((val) => setVoiceEnabled(val))
      .catch(() => { });
  }, []);

  // Listener del atajo global nativo emitido desde Rust (Alt + 3)
  useEffect(() => {
    let lastToggle = 0;
    const unlisten = listen('toggle-enigma', () => {
      const now = Date.now();
      if (now - lastToggle < 300) return;
      lastToggle = now;
      setEnigmaState((prev) => (prev === 'hidden' ? 'corrupting' : 'hidden'));
    });
    return () => {
      unlisten.then((f) => f());
    };
  }, []);

  // Listeners de streaming de Ollama desde Rust (enigma-token, enigma-done, enigma-error)
  useEffect(() => {
    let unlistenToken: (() => void) | undefined;
    let unlistenDone: (() => void) | undefined;
    let unlistenError: (() => void) | undefined;
    let isCancelled = false;

    listen<string>('enigma-token', (event) => {
      const token = event.payload;
      setMessages((prev) => {
        if (prev.length === 0) {
          return [{ id: 'msg-' + Date.now(), role: 'assistant', content: token }];
        }
        const lastIdx = prev.length - 1;
        const lastMsg = prev[lastIdx];
        if (lastMsg.role === 'assistant') {
          const updated = [...prev];
          updated[lastIdx] = {
            ...lastMsg,
            content: lastMsg.content + token,
          };
          return updated;
        } else {
          return [...prev, { id: 'msg-' + Date.now(), role: 'assistant', content: token }];
        }
      });
    }).then((unsub) => {
      if (isCancelled) unsub();
      else unlistenToken = unsub;
    });

    listen('enigma-done', () => {
      setIsStreaming(false);
    }).then((unsub) => {
      if (isCancelled) unsub();
      else unlistenDone = unsub;
    });

    listen<string>('enigma-error', (event) => {
      setIsStreaming(false);
      setMessages((prev) => [
        ...prev,
        {
          id: 'err-' + Date.now(),
          role: 'assistant',
          content: `<think>Error de comunicación con Ollama.</think>[ERROR]: ${event.payload || 'Ocurrió un error al procesar la respuesta.'}`,
        },
      ]);
    }).then((unsub) => {
      if (isCancelled) unsub();
      else unlistenError = unsub;
    });

    return () => {
      isCancelled = true;
      if (unlistenToken) unlistenToken();
      if (unlistenDone) unlistenDone();
      if (unlistenError) unlistenError();
    };
  }, []);

  // Auto-focus en el input al desplegar Enigma (con reintentos suaves para Wayland/KWin)
  useEffect(() => {
    if (enigmaState === 'active') {
      const focusInput = () => {
        if (inputRef.current) {
          inputRef.current.focus();
        }
      };
      focusInput();
      const t1 = setTimeout(focusInput, 40);
      const t2 = setTimeout(focusInput, 120);
      const t3 = setTimeout(focusInput, 260);
      return () => {
        clearTimeout(t1);
        clearTimeout(t2);
        clearTimeout(t3);
      };
    }
  }, [enigmaState]);

  // Sincronizar regions físicas al conmutar Enigma
  useEffect(() => {
    if (enigmaState === 'hidden') {
      setIsHovered(false);
      onHoverChange?.(false);
    }
    syncAllTopBarRegions();
    const t1 = setTimeout(syncAllTopBarRegions, 50);
    const t2 = setTimeout(syncAllTopBarRegions, 200);
    return () => {
      clearTimeout(t1);
      clearTimeout(t2);
    };
  }, [enigmaState, onHoverChange]);

  const searchOpen = controlledSearchOpen || internalSearchOpen;
  const searchGraceTimerRef = useRef<number | null>(null);
  const hasHoveredSearchRef = useRef<boolean>(false);
  const searchOpenedAtRef = useRef<number>(0);
  const notchLeaveTimerRef = useRef<number | null>(null);

  const setCombinedRef = useCallback((node: HTMLDivElement | null) => {
    (notchRef as React.MutableRefObject<HTMLDivElement | null>).current = node;
    if (typeof innerRef === 'function') {
      innerRef(node);
    } else if (innerRef) {
      (innerRef as React.MutableRefObject<HTMLDivElement | null>).current = node;
    }
  }, [innerRef]);

  // =========================================================================
  // 3. EL CAMPO DE FUERZA INVISIBLE (HITBOX & AUTO-CIERRE):
  // El ResizeObserver mide el contenedor padre completo (#enigma-forcefield-container)
  // y el Notch para enviar las dimensiones exactas a update_custom_input_regions en Rust.
  // =========================================================================
  useEffect(() => {
    let debounceTimer: number | null = null;
    const observer = new ResizeObserver(() => {
      syncAllTopBarRegions();
      if (debounceTimer) window.clearTimeout(debounceTimer);
      debounceTimer = window.setTimeout(() => {
        syncAllTopBarRegions();
      }, 80);
    });

    if (forcefieldRef.current) observer.observe(forcefieldRef.current);
    const notchNode = document.getElementById('dynamic-notch');
    if (notchNode) observer.observe(notchNode);

    return () => {
      observer.disconnect();
      if (debounceTimer) window.clearTimeout(debounceTimer);
    };
  }, [enigmaState]);


  // Sincronizar dinámicamente el modo de teclado de Wayland (para la barra de búsqueda, portapapeles y Enigma AI)
  useEffect(() => {
    const isInteractive = searchOpen || enigmaState !== 'hidden' || isClipboardHistoryOpen;
    if (searchOpen) {
      searchOpenedAtRef.current = Date.now();
    }
    invoke('set_keyboard_interactivity', {
      enabled: isInteractive,
      reason: searchOpen
        ? 'search_open_effect'
        : (enigmaState !== 'hidden' ? 'enigma_active_effect' : (isClipboardHistoryOpen ? 'clipboard_history_effect' : 'idle_close_effect'))
    }).catch((err) => {
      console.warn('[EnigmaOS] Failed to set keyboard interactivity:', err);
    });

    return () => {
      if (isInteractive) {
        invoke('set_keyboard_interactivity', { enabled: false, reason: 'unmount_cleanup' }).catch(() => { });
      }
    };
  }, [searchOpen, enigmaState, isClipboardHistoryOpen]);

  // Actualizador de reloj cada segundo
  useEffect(() => {
    const timer = setInterval(() => setCurrentTime(new Date()), 1000);
    return () => clearInterval(timer);
  }, []);

  const closeSearch = useCallback((reason = 'manual') => {
    if (searchGraceTimerRef.current) {
      window.clearTimeout(searchGraceTimerRef.current);
      searchGraceTimerRef.current = null;
    }
    hasHoveredSearchRef.current = false;
    setInternalSearchOpen(false);
    onSearchOpenChange?.(false);
    if (!isHovered && enigmaState === 'hidden') {
      onHoverChange?.(false);
    }
    if (enigmaState === 'hidden') {
      invoke('set_keyboard_interactivity', { enabled: false, reason: `closeSearch_${reason}` }).catch(() => { });
    }
  }, [isHovered, enigmaState, onSearchOpenChange, onHoverChange]);

  // Si la ventana pierde el foco, limpiar la píldora y cerrar el historial o búsqueda para liberar foco
  useEffect(() => {
    const handleBlur = () => {
      if (searchOpen) {
        closeSearch('window_blur');
      }
      if (isClipboardHistoryOpen) {
        setIsClipboardHistoryOpen(false);
        setIsHovered(false);
        onHoverChange?.(false);
        setTimeout(syncAllTopBarRegions, 30);
      }
      if (activeClipboardPill) {
        dismissClipboardPill();
      }
    };
    window.addEventListener('blur', handleBlur);
    return () => window.removeEventListener('blur', handleBlur);
  }, [searchOpen, isClipboardHistoryOpen, activeClipboardPill, closeSearch, dismissClipboardPill, onHoverChange]);

  const openSearch = useCallback((source: 'button' | 'shortcut') => {
    hasHoveredSearchRef.current = false;
    searchOpenedAtRef.current = Date.now();
    setInternalSearchOpen(true);
    onSearchOpenChange?.(true);
    onHoverChange?.(true);
    invoke('set_keyboard_interactivity', { enabled: true, reason: `openSearch_${source}` }).catch(() => { });

    if (searchGraceTimerRef.current) {
      window.clearTimeout(searchGraceTimerRef.current);
      searchGraceTimerRef.current = null;
    }

    if (!isHovered) {
      searchGraceTimerRef.current = window.setTimeout(() => {
        if (!hasHoveredSearchRef.current) {
          closeSearch('inactivity_timeout');
        }
      }, 8000);
    }
  }, [isHovered, onSearchOpenChange, onHoverChange, closeSearch]);

  const handleSearchActivity = useCallback(() => {
    if (searchGraceTimerRef.current) {
      window.clearTimeout(searchGraceTimerRef.current);
      searchGraceTimerRef.current = null;
    }
    hasHoveredSearchRef.current = true;
  }, []);

  // Atajo global ALT + Espacio y eventos de búsqueda con debounce de 350ms
  const lastSearchToggleTimeRef = useRef<number>(0);

  const toggleSearchDebounced = useCallback((source: string) => {
    const now = Date.now();
    if (now - lastSearchToggleTimeRef.current < 350) return;
    lastSearchToggleTimeRef.current = now;

    if (searchOpen) {
      closeSearch(source);
    } else {
      openSearch('shortcut');
    }
  }, [searchOpen, closeSearch, openSearch]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.altKey && (e.code === 'Space' || e.key === ' ')) {
        e.preventDefault();
        e.stopPropagation();
        toggleSearchDebounced('alt_space_key');
      } else if (e.altKey && (e.code === 'KeyV' || e.key === 'v' || e.key === 'V')) {
        e.preventDefault();
        e.stopPropagation();
        closeSearch('open_clipboard_history');
        setIsHovered(false);
        onHoverChange?.(false);
        setIsClipboardHistoryOpen((prev) => !prev);
        setActiveClipboardPill(null);
        setTimeout(syncAllTopBarRegions, 40);
      } else if (e.key === 'Escape' && isClipboardHistoryOpen) {
        setIsClipboardHistoryOpen(false);
        setTimeout(syncAllTopBarRegions, 40);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [toggleSearchDebounced, closeSearch, isClipboardHistoryOpen, onHoverChange]);

  // Listener global para eventos 'open-search', 'close-search', 'toggle-search', 'open-clipboard-history' desde socket o evdev
  useEffect(() => {
    let unlistenOpen: (() => void) | undefined;
    let unlistenClose: (() => void) | undefined;
    let unlistenToggle: (() => void) | undefined;
    let unlistenTrigger: (() => void) | undefined;
    let unlistenClipboard: (() => void) | undefined;

    listen('open-search', () => {
      openSearch('shortcut');
    }).then((unsub) => { unlistenOpen = unsub; });

    listen('close-search', () => {
      closeSearch('socket');
    }).then((unsub) => { unlistenClose = unsub; });

    listen('toggle-search', () => {
      toggleSearchDebounced('socket_toggle');
    }).then((unsub) => { unlistenToggle = unsub; });

    listen('trigger-search', () => {
      toggleSearchDebounced('trigger_event');
    }).then((unsub) => { unlistenTrigger = unsub; });

    listen('open-clipboard-history', () => {
      closeSearch('open_clipboard_history');
      setIsHovered(false);
      onHoverChange?.(false);
      setIsClipboardHistoryOpen((prev) => !prev);
      setActiveClipboardPill(null);
      setTimeout(syncAllTopBarRegions, 40);
    }).then((unsub) => { unlistenClipboard = unsub; });

    return () => {
      if (unlistenOpen) unlistenOpen();
      if (unlistenClose) unlistenClose();
      if (unlistenToggle) unlistenToggle();
      if (unlistenTrigger) unlistenTrigger();
      if (unlistenClipboard) unlistenClipboard();
    };
  }, [toggleSearchDebounced, openSearch, closeSearch, onHoverChange]);

  // Envío del prompt a Ollama a través de invoke_enigma en Rust
  const sendPrompt = useCallback(async (promptText: string) => {
    const prompt = promptText.trim();
    if (!prompt || isStreaming) return;

    setInputValue('');
    const userMsg: ChatMessage = {
      id: 'usr-' + Date.now(),
      role: 'user',
      content: prompt,
    };
    const emptyAssistant: ChatMessage = {
      id: 'ast-' + Date.now(),
      role: 'assistant',
      content: '',
    };

    setMessages((prev) => [...prev, userMsg, emptyAssistant]);
    setIsStreaming(true);

    try {
      const res = await invoke<{ content: string; model_used: string }>('process_enigma_message', {
        userInput: prompt,
        activePersona: activePersona,
      });
      setIsStreaming(false);
      setMessages((prev) => {
        const lastIdx = prev.length - 1;
        if (lastIdx >= 0 && prev[lastIdx].role === 'assistant') {
          const updated = [...prev];
          const existingThoughts = prev[lastIdx].thoughts;
          updated[lastIdx] = {
            ...prev[lastIdx],
            content: res.content,
            model_used: res.model_used,
            thoughts:
              existingThoughts && existingThoughts.length > 0
                ? existingThoughts
                : ['Orquestador analizando intención...', `Enrutado a ${res.model_used}`, 'Respuesta generada con éxito'],
          };
          return updated;
        }
        return [
          ...prev,
          {
            id: 'ast-' + Date.now(),
            role: 'assistant',
            content: res.content,
            model_used: res.model_used,
            thoughts: ['Orquestador analizando intención...', `Enrutado a ${res.model_used}`, 'Respuesta generada con éxito'],
          },
        ];
      });
    } catch (err: any) {
      setIsStreaming(false);
      setIsAlertState(true);
      setTimeout(() => setIsAlertState(false), 3000);
      setMessages((prev) => {
        const lastIdx = prev.length - 1;
        if (lastIdx >= 0 && prev[lastIdx].role === 'assistant' && !prev[lastIdx].content) {
          const updated = [...prev];
          updated[lastIdx] = {
            ...prev[lastIdx],
            content: `<think>Error de conexión con Ollama.</think>[ERROR]: ${String(err)}`,
          };
          return updated;
        }
        return [
          ...prev,
          {
            id: 'err-' + Date.now(),
            role: 'assistant',
            content: `<think>Error de conexión con Ollama.</think>[ERROR]: ${String(err)}`,
          },
        ];
      });
    }
  }, [isStreaming, activePersona]);

  const handleCaptureAreaVision = useCallback(async () => {
    if (isStreaming) return;
    const userMsg: ChatMessage = {
      id: 'usr-' + Date.now(),
      role: 'user',
      content: '📸 Captura de área de pantalla (Visión)',
    };
    const emptyAssistant: ChatMessage = {
      id: 'ast-' + Date.now(),
      role: 'assistant',
      content: 'Analizando área seleccionada...',
      thoughts: ['Activando retícula de selección rectangular...', 'Enviando imagen al modelo multimodal...'],
    };

    setMessages((prev) => [...prev, userMsg, emptyAssistant]);
    setIsStreaming(true);

    try {
      const res = await invoke<{
        analysis: string;
        model_used: string;
        target_mode: string;
      }>('analyze_current_screen', {
        prompt: 'Analiza con detalle el contenido de este recorte de pantalla y dime qué contiene y cómo me asistes.',
        mode: 'region',
      });

      setIsStreaming(false);
      setMessages((prev) => {
        const lastIdx = prev.length - 1;
        const updated = [...prev];
        if (lastIdx >= 0 && prev[lastIdx].role === 'assistant') {
          updated[lastIdx] = {
            ...prev[lastIdx],
            content: res.analysis,
            model_used: res.model_used,
            thoughts: [
              `Captura de área (${res.target_mode || 'región'}) completada`,
              `Modelo multimodal: ${res.model_used}`,
              'Análisis generado con éxito',
            ],
          };
        }
        return updated;
      });
    } catch (err: any) {
      setIsStreaming(false);
      setIsAlertState(true);
      setTimeout(() => setIsAlertState(false), 3000);
      setMessages((prev) => {
        const lastIdx = prev.length - 1;
        const updated = [...prev];
        if (lastIdx >= 0 && prev[lastIdx].role === 'assistant') {
          updated[lastIdx] = {
            ...prev[lastIdx],
            content: typeof err === 'string' ? err : 'Error al analizar área de pantalla con Spectacle y Ollama.',
            thoughts: ['Fallo en la captura de área o modelo multimodal inaccesible'],
          };
        }
        return updated;
      });
    }
  }, [isStreaming]);

  // Callback de activación rápida de Enigma desde Spotlight (NotchSearch)
  const handleAskEnigmaFromSearch = useCallback((prompt: string, autoSubmit = true) => {
    closeSearch('ask_enigma');
    setEnigmaState('active');
    invoke('set_keyboard_interactivity', { enabled: true, reason: 'ask_enigma_from_search' }).catch(() => { });
    if (autoSubmit && prompt.trim()) {
      sendPrompt(prompt.trim());
    } else {
      setInputValue(prompt);
    }
  }, [closeSearch, sendPrompt]);

  // Callback de captura y análisis visual con Enigma Vision
  const triggerVisionCapture = useCallback((mode: 'active_window' | 'screen') => {
    setShowVisionMenu(false);
    setIsCapturingVision(true);
    const customPrompt = inputValue.trim();
    const promptText = customPrompt.length > 0
      ? (mode === 'active_window'
        ? `${customPrompt} (Analiza detalladamente la ventana activa en foco)`
        : `${customPrompt} (Analiza detalladamente la pantalla actual)`)
      : (mode === 'active_window'
        ? 'Analiza minuciosamente mi ventana activa en foco y ayúdame con lo que estoy programando o viendo.'
        : 'Analiza mi pantalla actual completa, describe qué ves y asísteme con lo que estoy haciendo.');
    setInputValue('');
    sendPrompt(promptText);
    setTimeout(() => setIsCapturingVision(false), 2500);
  }, [inputValue, sendPrompt]);

  // Listener para ejecutar prompts desde CLI (ej. enigmaos --enigma-prompt "hola")
  useEffect(() => {
    const unlisten = listen<string>('trigger-enigma-prompt', (event) => {
      setEnigmaState('active');
      invoke('set_keyboard_interactivity', { enabled: true, reason: 'trigger_enigma_prompt' }).catch(() => { });
      if (event.payload) {
        const prompt = event.payload.trim();
        sendPrompt(prompt);
      }
    });
    return () => {
      unlisten.then((f) => f());
    };
  }, [sendPrompt]);

  // Listener del Dictado de Voz STT (Vosk en Rust)
  useEffect(() => {
    let unlistenTranscript: (() => void) | undefined;
    let unlistenStatus: (() => void) | undefined;
    let unlistenFinal: (() => void) | undefined;
    let isCancelled = false;

    // Rellena la caja de input automáticamente con lo que vas hablando en tiempo real
    listen<string>('stt-transcript', (event) => {
      if (event.payload !== undefined) {
        setEnigmaState((prev) => (prev === 'hidden' ? 'active' : prev));
        setInputValue(event.payload);
      }
    }).then((unsub) => {
      if (isCancelled) unsub();
      else unlistenTranscript = unsub;
    });

    // Estado del reconocedor (escuchando vs inactivo)
    listen<string>('stt-status', (event) => {
      if (event.payload === 'listening') {
        setIsListeningSTT(true);
        setEnigmaState((prev) => (prev === 'hidden' ? 'active' : prev));
      } else {
        setIsListeningSTT(false);
      }
    }).then((unsub) => {
      if (isCancelled) unsub();
      else unlistenStatus = unsub;
    });

    // Al finalizar la oración por silencio en Vosk, auto-envía la consulta a Ollama
    listen<string>('stt-final', (event) => {
      if (event.payload && event.payload.trim()) {
        const query = event.payload.trim();
        setInputValue(query);
        sendPrompt(query);
      }
    }).then((unsub) => {
      if (isCancelled) unsub();
      else unlistenFinal = unsub;
    });

    return () => {
      isCancelled = true;
      if (unlistenTranscript) unlistenTranscript();
      if (unlistenStatus) unlistenStatus();
      if (unlistenFinal) unlistenFinal();
    };
  }, [sendPrompt]);

  const handleCommandSubmit = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    await sendPrompt(inputValue);
  };

  // Hover handlers sobre el Notch (modo reposo) con gracia de 180ms para transiciones y micro-movimientos
  const handleNotchMouseEnter = useCallback(() => {
    if (notchLeaveTimerRef.current) {
      window.clearTimeout(notchLeaveTimerRef.current);
      notchLeaveTimerRef.current = null;
    }
    if (enigmaState === 'active') return;
    if (isClipboardHistoryOpen) return;
    if (activeClipboardPill) {
      handleClipboardMouseEnter();
      return;
    }
    if (activeNotification) {
      handleNotificationMouseEnter();
      return;
    }
    setIsHovered(true);
    if (searchOpen) {
      hasHoveredSearchRef.current = true;
      if (searchGraceTimerRef.current) {
        window.clearTimeout(searchGraceTimerRef.current);
        searchGraceTimerRef.current = null;
      }
    }
    onHoverChange?.(true);
    syncAllTopBarRegions();
    setTimeout(syncAllTopBarRegions, 60);
    setTimeout(syncAllTopBarRegions, 200);
    setTimeout(syncAllTopBarRegions, 360);
  }, [enigmaState, isClipboardHistoryOpen, activeClipboardPill, activeNotification, handleClipboardMouseEnter, handleNotificationMouseEnter, searchOpen, onHoverChange]);

  const handleNotchMouseLeave = useCallback(() => {
    if (enigmaState === 'active') return;
    if (isClipboardHistoryOpen) return;
    if (activeClipboardPill) {
      handleClipboardMouseLeave();
      return;
    }
    if (activeNotification) {
      handleNotificationMouseLeave();
      return;
    }

    if (notchLeaveTimerRef.current) {
      window.clearTimeout(notchLeaveTimerRef.current);
    }

    notchLeaveTimerRef.current = window.setTimeout(() => {
      notchLeaveTimerRef.current = null;
      setIsHovered(false);
      if (searchOpen) {
        if (hasHoveredSearchRef.current) {
          closeSearch();
          return;
        }
      } else {
        onHoverChange?.(false);
      }
      syncAllTopBarRegions();
      setTimeout(syncAllTopBarRegions, 60);
      setTimeout(syncAllTopBarRegions, 200);
      setTimeout(syncAllTopBarRegions, 360);
    }, 180);
  }, [enigmaState, isClipboardHistoryOpen, activeClipboardPill, activeNotification, handleClipboardMouseLeave, handleNotificationMouseLeave, searchOpen, closeSearch, onHoverChange]);

  // Escuchar salida del puntero a nivel de hardware (GTK Wayland) con la misma ventana de gracia
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    listen('hardware_pointer_leave', () => {
      handleNotchMouseLeave();
    }).then((unsub) => {
      unlisten = unsub;
    });

    return () => {
      if (unlisten) unlisten();
      if (notchLeaveTimerRef.current) {
        window.clearTimeout(notchLeaveTimerRef.current);
      }
    };
  }, [handleNotchMouseLeave]);

  // =========================================================================
  // AUTO-CIERRE DEL CAMPO DE FUERZA INVISIBLE:
  // Al salir del contenedor padre invisible completo, Enigma se cierra.
  // =========================================================================
  const handleForcefieldMouseLeave = () => {
    // Si hay un modal masivo abierto (ej. gestor de contactos), no cerrar Enigma
    if (document.body.dataset.modalOpen === 'true') {
      return;
    }
    if (enigmaState === 'active') {
      setEnigmaState('hidden');
    }
    setIsHovered(false);
    if (searchOpen) {
      if (hasHoveredSearchRef.current) {
        closeSearch();
      }
    } else {
      onHoverChange?.(false);
    }
    syncAllTopBarRegions();
    setTimeout(syncAllTopBarRegions, 60);
    setTimeout(syncAllTopBarRegions, 200);
    setTimeout(syncAllTopBarRegions, 360);
  };

  const isExpanded = !activeClipboardPill && !isClipboardHistoryOpen && (controlledExpanded || isHovered || searchOpen || enigmaState === 'active');

  // Sincronizar inmediatamente las regiones físicas al expandir/contraer
  useEffect(() => {
    syncAllTopBarRegions();
    const t1 = setTimeout(syncAllTopBarRegions, 50);
    const t2 = setTimeout(syncAllTopBarRegions, 200);
    return () => {
      clearTimeout(t1);
      clearTimeout(t2);
    };
  }, [isExpanded, activeSection, searchOpen]);

  // Formato Reloj y Fecha
  const hours = currentTime.getHours().toString().padStart(2, '0');
  const minutes = currentTime.getMinutes().toString().padStart(2, '0');
  const seconds = currentTime.getSeconds().toString().padStart(2, '0');

  const formattedDate = currentTime.toLocaleDateString('es-ES', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
  });

  // Altura dinámica del Notch superior
  const getNotchHeight = () => {
    if (isClipboardHistoryOpen) return 480;
    if (activeClipboardPill && enigmaState === 'hidden' && !searchOpen && !activeNotification) return 44;
    if (activeNotification && enigmaState === 'hidden' && !searchOpen) return 60;
    if (enigmaState === 'corrupting') return 34;
    if (enigmaState === 'active') return 295; // Reactor ampliado y limpio sin barra inferior
    if (!isExpanded) return 34;
    if (searchOpen) return 430;
    switch (activeSection) {
      case 'media':
        return 280;
      case 'telemetry':
        return 200;
      case 'settings':
        return 355;
    }
  };

  const getNotchWidth = () => {
    if (isClipboardHistoryOpen) return 560;
    if (activeClipboardPill && enigmaState === 'hidden' && !searchOpen && !activeNotification) return 350;
    if (activeNotification && enigmaState === 'hidden' && !searchOpen) return 460;
    if (enigmaState === 'corrupting') return 255;
    if (enigmaState === 'active') return 295; // Proporción áurea cuadrada limpia para el Voice Orb
    if (searchOpen) return 560;
    if (isExpanded) return 520;
    if (isSpotifyPlaying) return 340;
    return 280;
  };

  // Detección de estado expandido para sintonía dinámica del resorte
  const isExpanding = isExpanded || searchOpen || enigmaState === 'active' || !!activeNotification || isClipboardHistoryOpen;

  // Física de resorte líquida estilo Apple Dynamic Island (bouncy & snappy)
  const notchSpringTransition = {
    type: 'spring' as const,
    stiffness: isExpanding ? 340 : 420,
    damping: isExpanding ? 26 : 32,
    mass: 0.75,
  };

  // Radio de esquinas fluido y orgánico
  const notchBorderRadius =
    isExpanded || searchOpen || enigmaState === 'active' || isClipboardHistoryOpen
      ? 32
      : activeNotification
        ? 24
        : activeClipboardPill
          ? 22
          : 16;

  return (
    <>
      {/* =========================================================================
         1. EL CAMPO DE FUERZA INVISIBLE (HITBOX & AUTO-CIERRE):
       - Contenedor padre absoluto e invisible: absolute top-0 left-1/2 -translate-x-1/2 flex flex-col items-center gap-4 pb-8
       - onMouseLeave={() => setEnigmaState('hidden')}
       - TODO (Notch, Cápsula de Input y Panel de Salida) va dentro de este contenedor.
       ========================================================================= */}
      <div
        ref={forcefieldRef}
        id="enigma-forcefield-container"
        onMouseLeave={handleForcefieldMouseLeave}
        className={`absolute top-0 left-1/2 -translate-x-1/2 flex flex-col items-center pointer-events-auto select-none m-0 z-40 ${enigmaState === 'active' ? 'gap-2.5 pb-6' : 'gap-0 pb-0'
          }`}
        style={{ top: 0, margin: 0 }}
      >
        {/* =========================================================================
          2.A. EL NOTCH (ARRIBA):
          - Mantiene su diseño de píldora de cristal oscuro.
          - Orbe WebGL central acelerado por GPU (VoiceOrb) en rojo carmesí #b82a2a
          ========================================================================= */}
        <motion.div
          ref={setCombinedRef}
          id="dynamic-notch"
          data-input-region="true"
          data-expanded={isExpanded || isClipboardHistoryOpen ? 'true' : 'false'}
          data-clipboard={isClipboardHistoryOpen ? 'true' : 'false'}
          data-section={activeSection}
          data-search={searchOpen ? 'true' : 'false'}
          onMouseEnter={handleNotchMouseEnter}
          onMouseLeave={handleNotchMouseLeave}
          onClick={() => {
            if (!isExpanded && enigmaState === 'hidden' && !searchOpen) {
              if (isSpotifyPlaying) {
                setActiveSection('media');
                onHoverChange?.(true);
              } else {
                setEnigmaState('corrupting');
              }
            }
          }}
          initial={{ opacity: 0.99, width: getNotchWidth(), height: getNotchHeight() }}
          animate={{
            opacity: 1,
            width: getNotchWidth(),
            height: getNotchHeight(),
            borderBottomLeftRadius: notchBorderRadius,
            borderBottomRightRadius: notchBorderRadius,
            ...(enigmaState === 'corrupting'
              ? {
                x: [-3, 3, -3, 2, -1, 1, 0],
                y: [0, -1, 1, -1, 0],
                filter: [
                  'hue-rotate(0deg) contrast(1)',
                  'hue-rotate(180deg) contrast(2)',
                  'hue-rotate(0deg) contrast(1.2)',
                  'hue-rotate(270deg) contrast(2)',
                  'hue-rotate(0deg) contrast(1)',
                ],
              }
              : {
                x: 0,
                y: 0,
                filter: 'hue-rotate(0deg) contrast(1)',
              }),
          }}
          transition={
            enigmaState === 'corrupting'
              ? {
                x: { duration: 0.3, ease: 'linear' },
                y: { duration: 0.3, ease: 'linear' },
                filter: { duration: 0.3, ease: 'linear' },
              }
              : notchSpringTransition
          }
          style={{ top: 0, margin: 0, minWidth: 280, minHeight: 34, willChange: 'width, height, transform, opacity', transform: 'translateZ(0)' }}
          className={`relative z-30 pointer-events-auto select-none will-change-[width,height] neu-chassis ${enigmaState === 'corrupting'
              ? 'border-[#EF4444] shadow-[0_0_25px_rgba(239,68,68,0.8)]'
              : enigmaState === 'active'
                ? 'border-[#EF4444]/60 shadow-[0_16px_45px_rgba(239,68,68,0.35)]'
                : ''
            }`}
        >
          {/* Alas cóncavas suaves que preservan la curvatura original del Notch */}
          <motion.div
            animate={{
              scale: isExpanded || searchOpen ? 1.14 : 1,
            }}
            transition={notchSpringTransition}
            className="absolute top-0 -left-[16px] w-[18px] h-[16px] origin-top-right pointer-events-none select-none z-20"
          >
            <NotchTopLeftEar />
            {isSpotifyPlaying && (
              <div className="absolute -inset-1 bg-[#b82a2a]/20 blur-sm rounded-full pointer-events-none -z-10 animate-pulse" />
            )}
          </motion.div>

          <motion.div
            animate={{
              scale: isExpanded || searchOpen ? 1.14 : 1,
            }}
            transition={notchSpringTransition}
            className="absolute top-0 -right-[16px] w-[18px] h-[16px] origin-top-left pointer-events-none select-none z-20"
          >
            <NotchTopRightEar />
            {isSpotifyPlaying && (
              <div className="absolute -inset-1 bg-[#b82a2a]/20 blur-sm rounded-full pointer-events-none -z-10 animate-pulse" />
            )}
          </motion.div>

          {/* Contenedor de Contenido Interno del Notch */}
          <motion.div
            animate={{
              borderBottomLeftRadius: notchBorderRadius,
              borderBottomRightRadius: notchBorderRadius,
            }}
            transition={notchSpringTransition}
            className="w-full h-full relative overflow-hidden flex items-center justify-center bg-transparent pointer-events-auto"
          >
            <AnimatePresence initial={false} mode="popLayout">
              {/* ================= CONTENIDO ENIGMA ACTIVE: VOICE ORB WEBGL DENTRO DEL NOTCH ================= */}
              {enigmaState === 'active' && (() => {
                const isSearching = Boolean(routingStatus && /buscand|search|tavily|duckduckgo|web|navegando|investigando|herramient/i.test(routingStatus));
                const isThinking = (isStreaming && Boolean(messages[messages.length - 1]?.content.includes('<think>') && !messages[messages.length - 1]?.content.includes('</think>'))) || Boolean(routingStatus && /orquestad|pensand|razonand|analizand/i.test(routingStatus));

                const autoCalculatedState: VoiceOrbState = isAlertState
                  ? 'alert'
                  : isDoneState
                    ? 'done'
                    : isListeningSTT
                      ? 'listening'
                      : isSearching
                        ? 'searching'
                        : isThinking
                          ? 'thinking'
                          : (isStreaming || audioReactive.isSpeaking)
                            ? 'speaking'
                            : 'idle';

                const currentOrbState: VoiceOrbState = autoCalculatedState;

                return (
                  <motion.div
                    key="notch-enigma-active-reactor"
                    initial={{ opacity: 0, scale: 0.90 }}
                    animate={{ opacity: 1, scale: 1 }}
                    exit={{ opacity: 0, scale: 0.90 }}
                    transition={{ type: 'spring', stiffness: 140, damping: 22 }}
                    className="w-full h-full flex items-center justify-center relative overflow-hidden pointer-events-auto p-0"
                  >
                    {/* Gran Orbe WebGL 2.0 (270px) Centrado, con Margen Limpio y Reactividad FFT de Audio */}
                    <VoiceOrb
                      state={currentOrbState}
                      audioLevels={audioReactive.audioLevels}
                      bands={audioReactive.bands}
                      onset={audioReactive.onset}
                      speechEnv={audioReactive.speechEnv}
                      size={270}
                      className="z-10"
                    />
                  </motion.div>
                );
              })()}

              {/* ================= CONTENIDO GLITCH: DESGARRO EN CURSO ('CORRUPTING') ================= */}
              {enigmaState === 'corrupting' && (
                <motion.div
                  key="notch-enigma-corrupting"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  transition={{ duration: 0.08 }}
                  className="absolute inset-0 flex items-center justify-center h-[34px] px-2 pointer-events-auto overflow-hidden bg-[#0B0B0E]"
                >
                  <span className="text-[#b82a2a] text-xs font-mono tracking-widest font-bold animate-pulse z-10">
                    ENIGMA CONNECTING...
                  </span>
                </motion.div>
              )}

              {/* ================= CONTENIDO NOTIFICACIÓN NATIVA: DYNAMIC ISLAND PILL ================= */}
              {enigmaState === 'hidden' && !searchOpen && activeNotification && (
                <motion.div
                  key={`notification-${activeNotification.id}`}
                  initial={{ opacity: 0, scale: 0.92, filter: 'blur(6px)' }}
                  animate={{ opacity: 1, scale: 1, filter: 'blur(0px)' }}
                  exit={{ opacity: 0, scale: 0.92, filter: 'blur(6px)' }}
                  transition={notchSpringTransition}
                  onMouseEnter={handleNotificationMouseEnter}
                  onMouseLeave={handleNotificationMouseLeave}
                  onClick={() => handleNotificationClick(activeNotification)}
                  className="absolute inset-0 w-full h-[60px] px-4 py-2 flex items-center justify-between gap-3.5 select-none cursor-pointer group bg-[#0B0B0E]"
                  title="Clic para abrir y responder en la aplicación"
                >
                  {/* 1. Icono o Avatar de la Notificación */}
                  <div className="relative w-9 h-9 rounded-xl flex items-center justify-center p-0.5 bg-white/[0.05] border border-white/10 shrink-0 shadow-[0_2px_10px_rgba(0,0,0,0.5)] overflow-hidden">
                    {activeNotification.image_path ? (
                      <img
                        src={convertFileSrc(activeNotification.image_path)}
                        alt={activeNotification.summary}
                        draggable={false}
                        decoding="async"
                        className="w-full h-full object-cover rounded-lg select-none"
                      />
                    ) : (
                      <NotificationIcon icon={activeNotification.app_icon} appName={activeNotification.app_name} />
                    )}
                    <span className="absolute -top-0.5 -right-0.5 w-2 h-2 rounded-full bg-[#b82a2a] shadow-[0_0_8px_rgba(184,42,42,0.9)] animate-pulse" />
                  </div>

                  {/* 2. Textos: App Name / Origin + Summary + Body */}
                  <div className="flex-1 flex flex-col justify-center min-w-0 pr-1 text-left">
                    <div className="flex items-center gap-1.5 min-w-0">
                      <span className="text-[10px] font-mono font-bold tracking-wider uppercase text-[#d43b3b] truncate">
                        {activeNotification.origin_name || activeNotification.app_name || 'Sistema'}
                      </span>
                      <span className="text-white/20 text-[10px]">·</span>
                      <span className="text-xs font-semibold text-white tracking-wide truncate">
                        {activeNotification.summary || 'Notificación'}
                      </span>
                    </div>
                    {activeNotification.body && (
                      <p className="text-[11px] text-white/80 line-clamp-1 font-light leading-snug truncate mt-0.5">
                        {activeNotification.body}
                      </p>
                    )}
                  </div>

                  {/* 3. Indicador de Cola y Botón de Descarte */}
                  <div className="flex items-center gap-2 shrink-0">
                    {notificationQueue.length > 0 && (
                      <span className="text-[10px] font-mono px-2 py-0.5 rounded-full bg-[#b82a2a]/20 border border-[#b82a2a]/40 text-[#d43b3b] font-bold shadow-sm">
                        +{notificationQueue.length}
                      </span>
                    )}
                    <button
                      type="button"
                      onClick={(e) => handleNotificationCloseBtn(e, activeNotification)}
                      className="p-1 rounded-lg text-white/30 hover:text-white hover:bg-white/10 transition-colors cursor-pointer"
                      title="Cerrar notificación"
                    >
                      <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                      </svg>
                    </button>
                  </div>
                </motion.div>
              )}


              {/* ================= CONTENIDO HISTORIAL DEL PORTAPAPELES ================= */}
              {isClipboardHistoryOpen && (
                <ClipboardHistoryModal
                  isOpen={isClipboardHistoryOpen}
                  onClose={() => {
                    setIsClipboardHistoryOpen(false);
                    setIsHovered(false);
                    onHoverChange?.(false);
                    setTimeout(syncAllTopBarRegions, 40);
                  }}
                />
              )}

              {/* ================= CONTENIDO SMART CLIPBOARD PILL: DYNAMIC NOTCH ================= */}
              {enigmaState === 'hidden' &&
                !searchOpen &&
                !activeNotification &&
                !isClipboardHistoryOpen &&
                activeClipboardPill && (
                  <SmartClipboardPill
                    item={activeClipboardPill}
                    isPaused={isPillHovered}
                    onOpenHistory={() => {
                      setIsHovered(false);
                      onHoverChange?.(false);
                      setIsClipboardHistoryOpen(true);
                      setActiveClipboardPill(null);
                      setTimeout(syncAllTopBarRegions, 40);
                    }}
                    onDismiss={dismissClipboardPill}
                    onMouseEnter={handleClipboardMouseEnter}
                    onMouseLeave={handleClipboardMouseLeave}
                  />
                )}

              {/* ================= CONTENIDO 1: MODO REPOSO (SPOTIFY AUDIOVISUAL O RELOJ CLÁSICO) ================= */}
              {enigmaState === 'hidden' && !isExpanded && !activeNotification && !activeClipboardPill && !isClipboardHistoryOpen && (
                <motion.div
                  key={isSpotifyPlaying ? 'notch-spotify-idle' : 'notch-clock-idle'}
                  initial={{ opacity: 0, filter: 'blur(6px)', scale: 0.95 }}
                  animate={{ opacity: 1, filter: 'blur(0px)', scale: 1 }}
                  exit={{ opacity: 0, filter: 'blur(6px)', scale: 0.95 }}
                  transition={notchSpringTransition}
                  className="absolute inset-0 flex items-center justify-between h-[34px] px-3 pointer-events-auto bg-[#0B0B0E] select-none"
                >

                  {isSpotifyPlaying ? (
                    <div className="relative z-10 w-full flex items-center justify-between gap-2.5 h-full">
                      {/* Alita Izquierda: Micro Carátula con Pulso Rítmico o Icono Spotify */}
                      <div
                        onClick={() => {
                          setActiveSection('media');
                          onHoverChange?.(true);
                        }}
                        className="flex items-center gap-2 cursor-pointer group shrink-0"
                        title="Abrir reproductor multimedia"
                      >
                        <div className="relative w-5 h-5 rounded-md overflow-hidden bg-black/80 border border-[#b82a2a]/40 shadow-[0_0_8px_rgba(184,42,42,0.6)] flex items-center justify-center shrink-0">
                          {media.art_url ? (
                            <img
                              src={media.art_url}
                              alt={media.title}
                              className="w-full h-full object-cover rounded-[5px]"
                            />
                          ) : (
                            <div className="w-2.5 h-2.5 rounded-full bg-[#b82a2a] animate-pulse" />
                          )}
                          <span className="absolute inset-0 rounded-md ring-1 ring-inset ring-white/10" />
                        </div>
                      </div>

                      {/* Centro: Título de la pista y Artista */}
                      <div
                        onClick={() => {
                          setActiveSection('media');
                          onHoverChange?.(true);
                        }}
                        className="flex-1 min-w-0 flex items-center justify-center gap-1.5 cursor-pointer px-1"
                        title={`${media.title} • ${media.artist}`}
                      >
                        <span className="text-[11px] font-semibold text-white truncate max-w-[170px] tracking-wide">
                          {media.title || 'Spotify'}
                        </span>
                        <span className="text-white/30 text-[10px]">·</span>
                        <span className="text-[10px] font-mono text-[#e05656] truncate max-w-[80px]">
                          {media.artist || 'Música'}
                        </span>
                      </div>

                      {/* Alita Derecha: Mini Visualizador Espectral de Barras de Onda */}
                      <div
                        onClick={() => {
                          setActiveSection('media');
                          onHoverChange?.(true);
                        }}
                        className="flex items-center gap-1 cursor-pointer shrink-0 pl-1"
                        title="Mini Visualizador Espectral Carmesí"
                      >
                        <SpotifyMiniSpectrum isPlaying={true} barCount={6} />
                      </div>
                    </div>
                  ) : (
                    /* Modo Reloj Clásico cuando Spotify está en pausa o cerrado */
                    <div
                      onClick={() => setEnigmaState('corrupting')}
                      title="Haz clic o pulsa Alt + 3 para activar Enigma"
                      className="relative z-10 w-full flex items-center justify-center h-full px-2 py-0.5 cursor-pointer whitespace-nowrap"
                    >
                      <div className="flex items-center justify-center gap-2 px-3 py-1 rounded-xl neu-inset border border-red-950/40 whitespace-nowrap">
                        <div className="flex items-center font-mono font-bold text-xs text-white tracking-widest font-mono-num whitespace-nowrap">
                          <span>{hours}</span>
                          <span className="text-[#EF4444] mx-0.5 animate-pulse font-bold">:</span>
                          <span>{minutes}</span>
                          <span className="text-[#EF4444] mx-0.5 animate-pulse font-bold">:</span>
                          <span>{seconds}</span>
                        </div>

                        <span className="text-[#EF4444] font-bold text-xs leading-none">·</span>

                        <span className="font-mono text-xs font-semibold text-white capitalize whitespace-nowrap">
                          {formattedDate}
                        </span>

                        {/* Micro-orbe rubí en reposo */}
                        <span className="w-2 h-2 rounded-full neu-led-red animate-pulse ml-0.5 shrink-0" />
                      </div>
                    </div>
                  )}
                </motion.div>
              )}

              {/* ================= CONTENIDO 2: APARTADO DE BÚSQUEDA (KRUNNER) ================= */}
              {enigmaState === 'hidden' && searchOpen && (
                <motion.div
                  key="notch-search-mode"
                  initial={{ opacity: 0, filter: 'blur(8px)', scale: 0.96 }}
                  animate={{ opacity: 1, filter: 'blur(0px)', scale: 1 }}
                  exit={{ opacity: 0, filter: 'blur(8px)', scale: 0.96 }}
                  transition={notchSpringTransition}
                  className="absolute top-0 left-0 w-full h-full pointer-events-auto z-40 bg-[#0B0B0E]"
                >
                  <NotchSearch
                    onClose={closeSearch}
                    onUserActivity={handleSearchActivity}
                    onAskEnigma={handleAskEnigmaFromSearch}
                    onOpenClipboard={() => {
                      closeSearch('open_clipboard_from_search');
                      setIsHovered(false);
                      onHoverChange?.(false);
                      setIsClipboardHistoryOpen(true);
                      setActiveClipboardPill(null);
                      setTimeout(syncAllTopBarRegions, 40);
                    }}
                  />
                </motion.div>
              )}

              {/* ================= CONTENIDO 3: SECCIONES MULTIMEDIA / RENDIMIENTO / AJUSTES ================= */}
              {enigmaState === 'hidden' && !searchOpen && isExpanded && !activeNotification && !activeClipboardPill && !isClipboardHistoryOpen && (
                <motion.div
                  key="notch-expanded-content"
                  initial={{ opacity: 0, filter: 'blur(8px)', scale: 0.96 }}
                  animate={{ opacity: 1, filter: 'blur(0px)', scale: 1 }}
                  exit={{ opacity: 0, filter: 'blur(8px)', scale: 0.96 }}
                  transition={notchSpringTransition}
                  className="absolute top-0 left-0 w-[520px] h-full pointer-events-auto z-30 bg-[#0B0B0E]"
                >
                  <MediaExpanded
                    activeTab={activeSection}
                    onTabChange={setActiveSection}
                  />
                </motion.div>
              )}
            </AnimatePresence>
          </motion.div>
        </motion.div>

        {/* =========================================================================
          2.B. LA CÁPSULA DE INPUT (MEDIO):
          - Desprendimiento vertical suave y pausado (opacity + y, sin scaleY)
          - Retraso secuencial (delay: 0.15)
          ========================================================================= */}
        <AnimatePresence>
          {enigmaState === 'active' && (
            <div className="flex flex-col items-center z-40">
              {/* Banner flotante en tiempo real: Liquid Glass Multi-Agente Status */}
              <AnimatePresence>
                {isStreaming && routingStatus && (
                  <motion.div
                    initial={{ opacity: 0, y: 10, scale: 0.95 }}
                    animate={{ opacity: 1, y: 0, scale: 1 }}
                    exit={{ opacity: 0, y: 6, scale: 0.95 }}
                    transition={{ duration: 0.2 }}
                    className="mb-2 px-4 py-1.5 rounded-full bg-[#0B0B0E] border border-[rgba(239,68,68,0.18)] shadow-[0_8px_32px_rgba(0,0,0,0.85)] flex items-center gap-2.5 text-xs text-white/95 select-none z-50 pointer-events-none"
                  >
                    <span className="relative flex h-2 w-2">
                      <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-[#b82a2a] opacity-75" />
                      <span className="relative inline-flex rounded-full h-2 w-2 bg-[#b82a2a] shadow-[0_0_8px_rgba(184,42,42,0.9)]" />
                    </span>
                    <span className="font-mono tracking-wide font-medium text-white">
                      {routingStatus}
                    </span>
                  </motion.div>
                )}
              </AnimatePresence>

              {/* Menú flotante atajo @ para cambiar de Persona / Bot al instante */}
              <AnimatePresence>
                {showMentionMenu && (
                  <motion.div
                    initial={{ opacity: 0, y: 10, scale: 0.95 }}
                    animate={{ opacity: 1, y: 0, scale: 1 }}
                    exit={{ opacity: 0, y: 10, scale: 0.95 }}
                    transition={{ type: 'spring', stiffness: 350, damping: 25 }}
                    className="mb-2.5 w-[560px] rounded-3xl bg-[#0B0B0E] border border-[rgba(239,68,68,0.18)] shadow-[0_20px_50px_rgba(0,0,0,0.95)] p-3 z-50 select-none"
                  >
                    <div className="flex items-center justify-between px-3 pb-2 border-b border-white/10 text-xs font-mono text-white/50">
                      <span className="flex items-center gap-1.5 text-[#b82a2a] font-semibold">
                        <span className="text-sm">@</span> Seleccionar Persona / Multi-Agente
                      </span>
                      <span className="text-[10px] text-white/40">Haz clic o pulsa Esc</span>
                    </div>
                    <div className="grid grid-cols-2 gap-2 mt-2">
                      {availablePersonas.map((pId) => {
                        const meta = getPersonaMetadata(pId);
                        const isSelected = activePersona === pId;
                        return (
                          <button
                            key={pId}
                            type="button"
                            onClick={() => {
                              setActivePersona(pId);
                              setShowMentionMenu(false);
                              setInputValue((prev) => prev.replace(/@\w*$/, '').trim());
                              inputRef.current?.focus();
                            }}
                            className={`flex items-center gap-2.5 p-2 rounded-2xl border text-left transition-all cursor-pointer ${isSelected
                                ? 'bg-[#b82a2a]/20 border-[#b82a2a]/60 shadow-[0_0_15px_rgba(184,42,42,0.25)]'
                                : 'bg-white/5 border-white/10 hover:bg-white/10 hover:border-[#b82a2a]/40'
                              }`}
                          >
                            <span className="text-base p-1 rounded-xl bg-white/5 border border-white/10 shrink-0">
                              {meta.icon}
                            </span>
                            <div className="flex flex-col min-w-0">
                              <span className="text-xs font-semibold text-white truncate">{meta.name}</span>
                              <span className="text-[10px] text-white/50 font-mono truncate">{meta.role}</span>
                            </div>
                          </button>
                        );
                      })}
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>

              <motion.form
                id="enigma-input-capsule"
                data-input-region="true"
                initial={{ opacity: 0, y: -20 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -20 }}
                transition={{ type: 'spring', stiffness: 120, damping: 25, delay: 0.15 }}
                onSubmit={handleCommandSubmit}
                onClick={() => {
                  inputRef.current?.focus();
                }}
                className={`min-w-[620px] w-[640px] max-w-[660px] bg-[#070709] border ${isListeningSTT
                    ? 'border-[#EF4444] shadow-[inset_3px_3px_6px_#020203,inset_-2px_-2px_5px_#14141B,0_0_20px_rgba(239,68,68,0.5)]'
                    : 'border-red-950/60 shadow-[inset_3px_3px_6px_#020203,inset_-2px_-2px_5px_#14141B,0_1px_0_rgba(255,255,255,0.03)]'
                  } rounded-full px-5 py-2.5 flex items-center transition-all focus-within:border-[#EF4444]/80 focus-within:shadow-[inset_3px_3px_6px_#020203,inset_-2px_-2px_5px_#14141B,0_0_15px_rgba(239,68,68,0.25)] m-0 z-40`}
              >
                {/* Selector Liquid Glass compacto de Persona Activa dentro de la cápsula */}
                <div className="shrink-0 mr-2">
                  <PersonaSelector
                    availablePersonas={availablePersonas}
                    activePersona={activePersona}
                    onSelectPersona={setActivePersona}
                    compact
                  />
                </div>

                <input
                  ref={inputRef}
                  type="text"
                  value={inputValue}
                  onClick={(e) => {
                    e.stopPropagation();
                    inputRef.current?.focus();
                  }}
                  onChange={(e) => {
                    const val = e.target.value;
                    setInputValue(val);
                    if (val.endsWith('@') || (val.includes('@') && !val.includes(' '))) {
                      setShowMentionMenu(true);
                    } else if (!val.includes('@')) {
                      setShowMentionMenu(false);
                    }
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Escape') {
                      if (showMentionMenu) {
                        setShowMentionMenu(false);
                      } else {
                        setEnigmaState('hidden');
                      }
                    }
                  }}
                  disabled={isStreaming}
                  placeholder={isListeningSTT ? 'Escuchando tu voz...' : 'Pregunta o pide lo que quieras a Enigma...'}
                  className="flex-1 min-w-0 text-white text-base font-light outline-none placeholder-white/35 bg-transparent select-text cursor-text"
                  autoFocus
                />

                {/* Botón de Portapapeles (Inserta lo que tienes copiado en Linux) */}
                <button
                  type="button"
                  onClick={async () => {
                    try {
                      const clip = await invoke<string>('get_clipboard_content');
                      if (clip && clip.trim()) {
                        setInputValue((prev) => (prev ? `${prev} ${clip.trim()}` : clip.trim()));
                        if (inputRef.current) inputRef.current.focus();
                      }
                    } catch (e) {
                      console.error('Failed to read clipboard:', e);
                    }
                  }}
                  className="p-1.5 rounded-full transition-all ml-1 shrink-0 text-[#EF4444] hover:text-white hover:bg-white/5"
                  title="Pegar lo copiado en el portapapeles de Linux"
                >
                  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" />
                  </svg>
                </button>

                {/* Botón de Enigma Vision & Percepción Multimodal */}
                <div className="relative inline-flex items-center">
                  <button
                    type="button"
                    onClick={() => {
                      if (inputValue.trim()) {
                        triggerVisionCapture('active_window');
                      } else {
                        setShowVisionMenu((prev) => !prev);
                      }
                    }}
                    className={`p-1.5 rounded-full transition-all ml-0.5 shrink-0 cursor-pointer ${showVisionMenu || isCapturingVision
                        ? 'text-white bg-[#EF4444] shadow-[0_0_12px_rgba(239,68,68,0.85)] animate-pulse'
                        : 'text-[#EF4444] hover:text-white hover:bg-white/5'
                      }`}
                    title="👁️ Enigma Vision: Capturar y analizar pantalla o ventana activa"
                  >
                    <Eye className="w-4 h-4" />
                  </button>

                  {/* Menú flotante de selección de objetivo para Enigma Vision */}
                  <AnimatePresence>
                    {showVisionMenu && (
                      <motion.div
                        initial={{ opacity: 0, y: 10, scale: 0.94 }}
                        animate={{ opacity: 1, y: 0, scale: 1 }}
                        exit={{ opacity: 0, y: 10, scale: 0.94 }}
                        transition={{ duration: 0.15 }}
                        className="absolute bottom-full right-0 mb-3 w-60 bg-[#0B0B0E] border border-red-950/60 rounded-2xl p-1.5 shadow-[7px_7px_15px_#040406,-5px_-5px_13px_#15151C] z-50 flex flex-col space-y-1 select-none"
                      >
                        <div className="px-2.5 py-1 text-[10px] font-mono font-semibold text-[#EF4444] uppercase tracking-wider flex items-center justify-between border-b border-white/5">
                          <div className="flex items-center gap-1.5">
                            <Eye className="w-3 h-3" />
                            <span>Enigma Vision</span>
                          </div>
                          <span className="text-[9px] text-white/40 font-mono">Wayland</span>
                        </div>

                        <button
                          type="button"
                          onClick={() => triggerVisionCapture('active_window')}
                          className="w-full flex items-center gap-2.5 px-2.5 py-2 text-xs text-white/90 hover:text-white hover:bg-white/5 rounded-xl transition-colors text-left cursor-pointer group"
                        >
                          <Scan className="w-4 h-4 text-[#EF4444] group-hover:scale-110 transition-transform shrink-0" />
                          <div className="flex flex-col min-w-0">
                            <span className="font-medium text-white">Ventana Activa</span>
                            <span className="text-[10px] text-white/45 truncate">Analizar IDE, código o app en foco</span>
                          </div>
                        </button>

                        <button
                          type="button"
                          onClick={() => triggerVisionCapture('screen')}
                          className="w-full flex items-center gap-2.5 px-2.5 py-2 text-xs text-white/90 hover:text-white hover:bg-white/5 rounded-xl transition-colors text-left cursor-pointer group"
                        >
                          <Monitor className="w-4 h-4 text-[#EF4444] group-hover:scale-110 transition-transform shrink-0" />
                          <div className="flex flex-col min-w-0">
                            <span className="font-medium text-white">Pantalla Completa</span>
                            <span className="text-[10px] text-white/45 truncate">Capturar todo el monitor actual</span>
                          </div>
                        </button>
                      </motion.div>
                    )}
                  </AnimatePresence>
                </div>

                {/* Botón de activación / desactivación de voz Piper TTS */}
                <button
                  type="button"
                  onClick={async () => {
                    try {
                      const newState = await invoke<boolean>('toggle_enigma_voice');
                      setVoiceEnabled(newState);
                    } catch (e) {
                      console.error('Failed to toggle voice:', e);
                    }
                  }}
                  className={`p-1.5 rounded-full transition-all ml-1 shrink-0 ${voiceEnabled
                      ? 'text-[#EF4444] hover:text-white hover:bg-white/5'
                      : 'text-neutral-500 hover:text-neutral-400 hover:bg-white/5'
                    }`}
                  title={voiceEnabled ? 'Voz de Enigma activada (clic para silenciar)' : 'Voz de Enigma silenciada (clic para activar)'}
                >
                  {voiceEnabled ? (
                    <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.536 8.464a5 5 0 010 7.072m2.828-9.9a9 9 0 010 12.728M5.586 15H4a1 1 0 01-1-1v-4a1 1 0 011-1h1.586l4.707-4.707C10.923 3.663 12 4.109 12 5v14c0 .891-1.077 1.337-1.707.707L5.586 15z" />
                    </svg>
                  ) : (
                    <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5.586 15H4a1 1 0 01-1-1v-4a1 1 0 011-1h1.586l4.707-4.707C10.923 3.663 12 4.109 12 5v14c0 .891-1.077 1.337-1.707.707L5.586 15z" />
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 14l2-2m0 0l2-2m-2 2l-2-2m2 2l2 2" />
                    </svg>
                  )}
                </button>

                {/* Botón de micrófono interactivo / indicador de escucha STT */}
                <button
                  type="button"
                  onClick={() => {
                    if (isListeningSTT) {
                      invoke('stop_stt').catch(() => { });
                    } else {
                      invoke('start_stt').catch(() => { });
                    }
                  }}
                  className={`p-1.5 rounded-full transition-all ml-1 shrink-0 ${isListeningSTT
                      ? 'text-white bg-[#EF4444] animate-pulse shadow-[0_0_12px_rgba(239,68,68,0.8)]'
                      : 'text-[#EF4444] hover:text-white hover:bg-white/5'
                    }`}
                  title={isListeningSTT ? 'Detener dictado' : 'Iniciar dictado de voz'}
                >
                  <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 003-3V5a3 3 0 00-6 0v6a3 3 0 003 3z"
                    />
                  </svg>
                </button>
                {isStreaming ? (
                  <span className="w-2.5 h-2.5 rounded-full bg-[#EF4444] shadow-[0_0_10px_rgba(239,68,68,0.9)] animate-ping ml-3 shrink-0" />
                ) : (
                  <button
                    type="submit"
                    disabled={!inputValue.trim()}
                    className="text-[#EF4444] hover:text-white transition-colors ml-3 shrink-0 disabled:opacity-30 disabled:cursor-not-allowed cursor-pointer"
                    title="Enviar comando"
                  >
                    <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M14 5l7 7m0 0l-7 7m7-7H3" />
                    </svg>
                  </button>
                )}
              </motion.form>
            </div>
          )}
        </AnimatePresence>

        {/* =========================================================================
          2.C. EL PANEL DE SALIDA / CHAT (ABAJO):
          - Desprendimiento vertical independiente y pausado (opacity + y, sin scaleY)
          - Retraso secuencial (delay: 0.3)
          ========================================================================= */}
        <AnimatePresence>
          {enigmaState === 'active' && (
            <motion.div
              id="enigma-output-panel"
              data-input-region="true"
              layout
              initial={{ opacity: 0, y: -20 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -20 }}
              transition={{ type: 'spring', stiffness: 300, damping: 25, delay: 0.15 }}
              className="min-w-[620px] w-[640px] max-w-[660px] max-h-[520px] bg-[#0B0B0E] border border-red-950/60 rounded-3xl p-5 shadow-[0_25px_50px_rgba(0,0,0,0.98),0_0_25px_rgba(184,42,42,0.15)] flex flex-col z-30 select-text relative overflow-hidden"
            >
              <EnigmaHub
                messages={messages}
                isStreaming={isStreaming}
                voiceEnabled={voiceEnabled}
                onToggleVoice={async () => {
                  try {
                    const newState = await invoke<boolean>('toggle_enigma_voice');
                    setVoiceEnabled(newState);
                  } catch (e) {
                    console.error('Failed to toggle voice:', e);
                  }
                }}
                isListeningSTT={isListeningSTT}
                onToggleSTT={() => {
                  if (isListeningSTT) {
                    invoke('stop_stt').catch(() => { });
                  } else {
                    invoke('start_stt').catch(() => { });
                  }
                }}
                onSelectPrompt={(prompt) => {
                  setInputValue(prompt);
                  sendPrompt(prompt);
                }}
                onCaptureAreaVision={handleCaptureAreaVision}
                onClearChat={() => {
                  setMessages([]);
                }}
                availablePersonas={availablePersonas}
                activePersona={activePersona}
                onSelectPersona={setActivePersona}
              />
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </>
  );
};

export default DynamicNotch;
