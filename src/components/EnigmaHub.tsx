import React, { useState, useEffect, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { WhatsAppContactsView } from './WhatsAppContactsView';
import { RichMessageText } from './RichMessageText';
import { ModuleCategoryTabs } from './ModuleCategoryTabs';
import { NotesView, NoteRecord } from './NotesView';
import { PersonaSelector, getPersonaMetadata } from './PersonaSelector';

export type EnigmaView = 'menu' | 'chat' | 'calendar' | 'tasks' | 'schedule' | 'notes' | 'settings' | 'extensions' | 'contacts';

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'enigma';
  content: string;
  model_used?: string;
  thoughts?: string[];
}

export interface EnigmaStatusPayload {
  phase: number;
  status: string;
  model?: string;
}

export interface CalendarEvent {
  id: number;
  title: string;
  event_date: string; // ISO 8601 YYYY-MM-DD
  event_time: string; // HH:MM
  notify_before_mins: number;
  notified: number;
  category_id?: number | null;
}

export interface TaskRecord {
  id: number;
  title: string;
  status: string; // 'pending' | 'completed'
  category_id?: number | null;
}

export interface ScheduleBlock {
  id: number;
  day_of_week: string;
  block_name: string;
  start_time: string;
  end_time: string;
  category_id?: number | null;
}

export interface ExtensionRecord {
  id: number;
  service_name: string;
  auth_token?: string | null;
  status: string;
}

export interface WhatsAppContact {
  id: string;
  name: string;
}

interface EnigmaHubProps {
  messages: ChatMessage[];
  isStreaming: boolean;
  voiceEnabled: boolean;
  onToggleVoice: () => Promise<void>;
  isListeningSTT: boolean;
  onToggleSTT: () => void;
  onSelectPrompt?: (prompt: string) => void;
  onCaptureAreaVision?: () => void;
  onClearChat?: () => void;
  availablePersonas?: string[];
  activePersona?: string;
  onSelectPersona?: (persona: string) => void;
}

export const EnigmaHub: React.FC<EnigmaHubProps> = ({
  messages,
  isStreaming,
  voiceEnabled,
  onToggleVoice,
  isListeningSTT,
  onToggleSTT,
  onClearChat,
  onSelectPrompt,
  onCaptureAreaVision,
  availablePersonas,
  activePersona,
  onSelectPersona,
}) => {
  const [activeView, setActiveView] = useState<EnigmaView>('menu');
  const [enigmaStatus, setEnigmaStatus] = useState<EnigmaStatusPayload | null>(null);

  // Listener en tiempo real de transparencia de procesos multi-agente
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    listen<EnigmaStatusPayload>('enigma-status', (event) => {
      setEnigmaStatus(event.payload);
    }).then((unsub) => {
      unlisten = unsub;
    });

    return () => {
      if (unlisten) unlisten();
    };
  }, []);

  // Limpiar estado visual al finalizar el streaming
  useEffect(() => {
    if (!isStreaming) {
      const timer = setTimeout(() => setEnigmaStatus(null), 1200);
      return () => clearTimeout(timer);
    }
  }, [isStreaming]);

  // Si llegan mensajes nuevos y estamos en el menú, cambiar automáticamente a la vista de chat
  useEffect(() => {
    if (messages.length > 0 && activeView === 'menu') {
      setActiveView('chat');
    } else if (messages.length === 0 && activeView === 'chat') {
      setActiveView('menu');
    }
  }, [messages.length]);

  // ==========================================
  // ESTADO REAL: CALENDARIO (SQLITE EN RUST)
  // ==========================================
  const today = new Date();
  const formatIsoDate = (d: Date) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

  const todayStr = formatIsoDate(today);
  const [currentMonthDate, setCurrentMonthDate] = useState<Date>(new Date());
  const [selectedDate, setSelectedDate] = useState<string>(todayStr);
  const [calendarEvents, setCalendarEvents] = useState<CalendarEvent[]>([]);
  const [selectedCalendarCategory, setSelectedCalendarCategory] = useState<number | null>(null);
  const [manualTitle, setManualTitle] = useState('');
  const [manualTime, setManualTime] = useState('10:00');
  const [isAddingEvent, setIsAddingEvent] = useState(false);

  const fetchCalendarEvents = async () => {
    try {
      const events = await invoke<CalendarEvent[]>('get_calendar_events');
      setCalendarEvents(events);
    } catch (err) {
      console.error('[EnigmaHub] Error fetching calendar events:', err);
    }
  };

  useEffect(() => {
    fetchCalendarEvents();

    let unlisten: (() => void) | undefined;
    listen('refresh-calendar', () => {
      fetchCalendarEvents();
    })
      .then((u) => {
        unlisten = u;
      })
      .catch((err) => {
        console.error('[EnigmaHub] Error listening to refresh-calendar:', err);
      });

    let unlistenView: (() => void) | undefined;
    listen<string>('set-enigma-view', (e) => {
      setActiveView(e.payload as EnigmaView);
    })
      .then((u) => {
        unlistenView = u;
      })
      .catch(() => {});

    return () => {
      if (unlisten) unlisten();
      if (unlistenView) unlistenView();
    };
  }, []);

  const handleManualAddEvent = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!manualTitle.trim()) return;
    try {
      await invoke('add_calendar_event', {
        title: manualTitle.trim(),
        eventDate: selectedDate,
        eventTime: manualTime || '10:00',
        notifyBeforeMins: 15,
        categoryId: selectedCalendarCategory,
      });
      setManualTitle('');
      setIsAddingEvent(false);
      await fetchCalendarEvents();
    } catch (err) {
      console.error('[EnigmaHub] Error adding manual event:', err);
    }
  };

  const handleDeleteEvent = async (id: number, e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      await invoke('delete_calendar_event', { id });
      await fetchCalendarEvents();
    } catch (err) {
      console.error('[EnigmaHub] Error deleting event:', err);
    }
  };

  // ==========================================
  // ESTADO REAL: TAREAS (SQLITE EN RUST)
  // ==========================================
  const [tasks, setTasks] = useState<TaskRecord[]>([]);
  const [selectedTaskCategory, setSelectedTaskCategory] = useState<number | null>(null);
  const [newTaskInput, setNewTaskInput] = useState('');

  const fetchTasks = async () => {
    try {
      const dbTasks = await invoke<TaskRecord[]>('get_tasks');
      setTasks(dbTasks);
    } catch (err) {
      console.error('[EnigmaHub] Error fetching tasks:', err);
    }
  };

  useEffect(() => {
    fetchTasks();

    let unlistenTasks: (() => void) | undefined;
    listen('refresh-tasks', () => {
      fetchTasks();
    })
      .then((u) => {
        unlistenTasks = u;
      })
      .catch((err) => console.error('[EnigmaHub] Error listening to refresh-tasks:', err));

    return () => {
      if (unlistenTasks) unlistenTasks();
    };
  }, []);

  const handleToggleTask = async (task: TaskRecord) => {
    const isCompleted = task.status === 'completed';
    try {
      await invoke('toggle_task', { id: task.id, completed: !isCompleted });
      await fetchTasks();
    } catch (err) {
      console.error('[EnigmaHub] Error toggling task:', err);
    }
  };

  const handleDeleteTask = async (id: number, e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      await invoke('delete_task', { id });
      await fetchTasks();
    } catch (err) {
      console.error('[EnigmaHub] Error deleting task:', err);
    }
  };

  const handleAddTask = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newTaskInput.trim()) return;
    try {
      await invoke('add_task', {
        title: newTaskInput.trim(),
        categoryId: selectedTaskCategory,
      });
      setNewTaskInput('');
      await fetchTasks();
    } catch (err) {
      console.error('[EnigmaHub] Error adding task:', err);
    }
  };

  // ==========================================
  // ESTADO REAL: NOTAS (SQLITE EN RUST)
  // ==========================================
  const [notes, setNotes] = useState<NoteRecord[]>([]);

  const fetchNotes = async () => {
    try {
      const records = await invoke<NoteRecord[]>('get_notes');
      setNotes(records || []);
    } catch (err) {
      console.error('[EnigmaHub] Error fetching notes:', err);
    }
  };

  useEffect(() => {
    fetchNotes();

    let unlistenNotes: (() => void) | undefined;
    listen('refresh-notes', () => {
      fetchNotes();
    })
      .then((u) => {
        unlistenNotes = u;
      })
      .catch((err) => console.error('[EnigmaHub] Error listening to refresh-notes:', err));

    return () => {
      if (unlistenNotes) unlistenNotes();
    };
  }, []);

  // ==========================================
  // ESTADO REAL: HORARIOS Y EXTENSIONES
  // ==========================================
  const [schedules, setSchedules] = useState<ScheduleBlock[]>([]);
  const [selectedScheduleCategory, setSelectedScheduleCategory] = useState<number | null>(null);
  const [extensions, setExtensions] = useState<ExtensionRecord[]>([]);

  // ==========================================
  // ESTADO REAL: WHATSAPP MICROSERVICIO (BAILEYS)
  // ==========================================
  const [whatsappConnected, setWhatsappConnected] = useState<boolean>(false);
  const [whatsappUser, setWhatsappUser] = useState<string | null>(null);
  const [whatsappQr, setWhatsappQr] = useState<string | null>(null);
  const [whatsappContacts, setWhatsappContacts] = useState<WhatsAppContact[]>([]);
  const [isLoadingQr, setIsLoadingQr] = useState<boolean>(false);

  const fetchWhatsAppStatus = async () => {
    try {
      const res = await invoke<any>('get_whatsapp_status');
      setWhatsappConnected(!!res.connected);
      setWhatsappUser(res.user || null);
      if (res.connected) {
        setWhatsappQr(null);
      }
    } catch (_) {
      setWhatsappConnected(false);
    }
  };

  const fetchWhatsAppQr = async () => {
    setIsLoadingQr(true);
    try {
      const res = await invoke<any>('get_whatsapp_qr');
      if (res.connected) {
        setWhatsappConnected(true);
        setWhatsappQr(null);
        setWhatsappUser(res.user || null);
      } else {
        setWhatsappConnected(false);
        setWhatsappQr(res.qr || res.base64 || null);
      }
    } catch (err) {
      console.error('[EnigmaHub] Error fetching WhatsApp QR:', err);
    } finally {
      setIsLoadingQr(false);
    }
  };

  const fetchWhatsAppContacts = async () => {
    try {
      const list = await invoke<WhatsAppContact[]>('get_whatsapp_contacts');
      setWhatsappContacts(list);
    } catch (e) {
      console.error('[EnigmaHub] Error fetching whatsapp contacts:', e);
    }
  };

  // ==========================================
  // ESTADO REAL: GOOGLE WORKSPACE (GMAIL & CALENDAR)
  // ==========================================
  const [googleConnected, setGoogleConnected] = useState<boolean>(false);
  const [googleClientId, setGoogleClientId] = useState<string>(() => localStorage.getItem('enigma_google_client_id') || '');
  const [googleClientSecret, setGoogleClientSecret] = useState<string>(() => localStorage.getItem('enigma_google_client_secret') || '');
  const [isConnectingGoogle, setIsConnectingGoogle] = useState<boolean>(false);
  const [googleError, setGoogleError] = useState<string | null>(null);
  const [gmailEmails, setGmailEmails] = useState<any[]>([]);
  const [isLoadingEmails, setIsLoadingEmails] = useState<boolean>(false);

  const fetchGoogleStatus = async () => {
    try {
      const res = await invoke<any>('get_google_auth_status');
      setGoogleConnected(!!res.connected);
      const creds = await invoke<any>('get_saved_google_credentials');
      if (creds?.client_id && !googleClientId) setGoogleClientId(creds.client_id);
      if (creds?.client_secret && !googleClientSecret) setGoogleClientSecret(creds.client_secret);
    } catch (e) {
      console.error('[EnigmaHub] Error fetching Google status:', e);
      setGoogleConnected(false);
    }
  };

  const handleConnectGoogle = async () => {
    if (!googleClientId.trim() || !googleClientSecret.trim()) {
      setGoogleError('Por favor introduce Client ID y Client Secret de Google Cloud.');
      return;
    }
    setGoogleError(null);
    setIsConnectingGoogle(true);
    localStorage.setItem('enigma_google_client_id', googleClientId.trim());
    localStorage.setItem('enigma_google_client_secret', googleClientSecret.trim());
    try {
      const res = await invoke<any>('start_google_auth', {
        clientId: googleClientId.trim(),
        clientSecret: googleClientSecret.trim(),
      });
      setGoogleConnected(!!res.connected);
      if (res.connected) {
        handleFetchGmailEmails();
      }
    } catch (err: any) {
      console.error('[EnigmaHub] Error connecting Google:', err);
      setGoogleError(typeof err === 'string' ? err : 'Error al conectar con Google OAuth.');
    } finally {
      setIsConnectingGoogle(false);
    }
  };

  const handleDisconnectGoogle = async () => {
    try {
      await invoke('disconnect_google_auth');
      setGoogleConnected(false);
      setGmailEmails([]);
    } catch (err) {
      console.error('[EnigmaHub] Error disconnecting Google:', err);
    }
  };

  const handleFetchGmailEmails = async () => {
    setIsLoadingEmails(true);
    try {
      const list = await invoke<any[]>('get_gmail_emails', { maxResults: 5 });
      setGmailEmails(list || []);
    } catch (err) {
      console.error('[EnigmaHub] Error fetching Gmail emails:', err);
    } finally {
      setIsLoadingEmails(false);
    }
  };

  // ==========================================
  // ESTADO REAL: BOT PRIVADO TELEGRAM
  // ==========================================
  const [telegramStatus, setTelegramStatus] = useState<{ configured: boolean; chat_id: number | null; active: boolean } | null>(null);
  const [isSendingTelegramTest, setIsSendingTelegramTest] = useState<boolean>(false);
  const [telegramNotice, setTelegramNotice] = useState<string | null>(null);

  const fetchTelegramStatus = async () => {
    try {
      const res = await invoke<any>('get_telegram_status');
      setTelegramStatus(res);
    } catch (e) {
      console.error('[EnigmaHub] Error fetching Telegram status:', e);
    }
  };

  const handleSendTelegramTest = async () => {
    setIsSendingTelegramTest(true);
    setTelegramNotice(null);
    try {
      await invoke('send_telegram_notification', {
        message: '🔔 Test de conexión exitoso desde Enigma Desktop Dynamic TopBar',
      });
      setTelegramNotice('¡Alerta de prueba enviada a tu Telegram con éxito!');
      fetchTelegramStatus();
    } catch (err: any) {
      console.error('[EnigmaHub] Error sending Telegram test:', err);
      setTelegramNotice(typeof err === 'string' ? err : 'Error al enviar alerta a Telegram');
    } finally {
      setIsSendingTelegramTest(false);
      setTimeout(() => setTelegramNotice(null), 5000);
    }
  };

  useEffect(() => {
    invoke<ScheduleBlock[]>('get_schedules')
      .then(setSchedules)
      .catch((e) => console.error('[EnigmaHub] Error fetching schedules:', e));
    invoke<ExtensionRecord[]>('get_extensions')
      .then(setExtensions)
      .catch((e) => console.error('[EnigmaHub] Error fetching extensions:', e));

    fetchWhatsAppStatus();
    fetchWhatsAppContacts();
    fetchGoogleStatus();
    fetchTelegramStatus();

    let unlistenWa: (() => void) | undefined;
    listen('whatsapp-sent', () => {
      fetchWhatsAppStatus();
      fetchWhatsAppContacts();
    }).then((u) => {
      unlistenWa = u;
    });

    let unlistenContacts: (() => void) | undefined;
    listen('refresh-contacts', () => {
      fetchWhatsAppContacts();
    }).then((u) => {
      unlistenContacts = u;
    });

    return () => {
      if (unlistenWa) unlistenWa();
      if (unlistenContacts) unlistenContacts();
    };
  }, []);

  useEffect(() => {
    if (activeView === 'extensions') {
      fetchWhatsAppStatus();
      fetchWhatsAppQr();
      fetchWhatsAppContacts();
      fetchGoogleStatus();
      fetchTelegramStatus();
    }
  }, [activeView]);

  // ==========================================
  // REFERENCIAS PARA AUTO-SCROLL EN CHAT
  // ==========================================
  const chatScrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (activeView === 'chat' && chatScrollRef.current) {
      chatScrollRef.current.scrollTop = chatScrollRef.current.scrollHeight;
    }
  }, [messages, isStreaming, activeView]);

  // Helper para renderizar los mensajes de Enigma a la izquierda sin burbuja
  const renderEnigmaMessage = (content: string, isCurrentStreaming: boolean, modelUsed?: string, thoughts?: string[]) => {
    if (!content && isCurrentStreaming) {
      return (
        <div className="flex flex-col items-start w-full mb-4">
          <div className="flex items-center gap-2 mb-1 select-none">
            <span className="w-1.5 h-1.5 rounded-full bg-[#b82a2a] shadow-[0_0_6px_rgba(184,42,42,0.9)] animate-ping" />
            <span className="text-[#d43b3b] text-xs font-mono tracking-wide font-semibold">Enigma</span>
          </div>
          <div className="text-white/30 text-xs font-mono italic text-left flex items-center gap-1.5 pl-3 border-l-2 border-[#b82a2a]/20">
            <span>Pensando...</span>
            <span className="w-1.5 h-1.5 rounded-full bg-[#b82a2a] animate-pulse" />
          </div>
          {thoughts && thoughts.length > 0 && (
            <div className="w-full mt-2 bg-black/50 border border-white/10 rounded-2xl p-3 backdrop-blur-xl">
              <div className="flex items-center gap-1.5 text-[11px] font-mono text-[#d43b3b] font-semibold mb-2 select-none">
                <span>⚡</span>
                <span>Proceso de Pensamiento y Enrutamiento:</span>
              </div>
              <div className="space-y-1.5 pl-2.5 border-l-2 border-[#b82a2a]/40">
                {thoughts.map((t, idx) => (
                  <div key={idx} className="text-xs text-white/80 font-mono flex items-center gap-2">
                    <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${idx === thoughts.length - 1 ? 'bg-[#b82a2a] animate-pulse' : 'bg-[#d43b3b]'}`} />
                    <span>{t}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      );
    }

    const thinkStart = content.indexOf('<think>');
    const thinkEnd = content.indexOf('</think>');

    let thinkText: string | null = null;
    let responseText: string = content;

    if (thinkStart !== -1) {
      if (thinkEnd !== -1) {
        thinkText = content.substring(thinkStart + 7, thinkEnd).trim();
        responseText = content.substring(thinkEnd + 8).trimStart();
      } else {
        thinkText = content.substring(thinkStart + 7).trimStart();
        responseText = '';
      }
    } else {
      // Detección de marcadores alternativos de pensamiento como ****Respuesta:**** o **Respuesta:**
      const markerMatch = content.match(/(\*{2,4}\s*Respuesta\s*:\s*\*{2,4}|###\s*Respuesta\s*:?)/i);
      if (markerMatch && markerMatch.index !== undefined) {
        thinkText = content.substring(0, markerMatch.index).trim();
        responseText = content.substring(markerMatch.index + markerMatch[0].length).trimStart();
      }
    }

    // Helper para extraer objetos JSON balanceados de herramientas (JARVIS Tool Calling)
    let toolEventData: { title: string; date: string; time?: string; notify_before?: number } | null = null;
    let toolCalendarRead = false;
    let toolWhatsAppData: { contact: string; message: string } | null = null;

    let cleanText = responseText;
    let searchStart = 0;

    // 1. Extraer bloques de código markdown ```json ... ``` completos SOLO SI SON LLAMADAS A HERRAMIENTAS INTERNAS
    while (true) {
      const codeStart = cleanText.indexOf('```', searchStart);
      if (codeStart === -1) break;
      const codeEnd = cleanText.indexOf('```', codeStart + 3);
      if (codeEnd !== -1) {
        const block = cleanText.substring(codeStart, codeEnd + 3);
        let isInternalTool = false;
        try {
          const innerJson = block.replace(/```[a-z]*\s*/gi, '').replace(/```/g, '').trim();
          if (innerJson.startsWith('{') && innerJson.endsWith('}')) {
            const parsed = JSON.parse(innerJson);
            if (parsed.tool === 'add_event' && parsed.args) {
              toolEventData = parsed.args;
              isInternalTool = true;
            } else if (parsed.evento) {
              toolEventData = {
                title: parsed.evento.titulo || parsed.evento.title || 'Evento',
                date: parsed.evento.fecha || parsed.evento.date || '',
                time: parsed.evento.hora || parsed.evento.time || '10:00',
              };
              isInternalTool = true;
            } else if (parsed.tool === 'get_calendar_events') {
              toolCalendarRead = true;
              isInternalTool = true;
            } else if (parsed.tool === 'send_whatsapp' || parsed.name === 'send_whatsapp') {
              const waArgs = parsed.args || parsed.arguments || parsed;
              toolWhatsAppData = {
                contact: waArgs.contact_name || waArgs.contact || waArgs.contacto || waArgs.destinatario || 'Contacto',
                message: waArgs.message || waArgs.mensaje || waArgs.texto || '',
              };
              isInternalTool = true;
            } else if (parsed.tool === 'get_recent_emails') {
              isInternalTool = true;
            }
          }
        } catch {
          // Ignorar fallo de parseo
        }

        if (isInternalTool) {
          cleanText = cleanText.substring(0, codeStart).trimEnd() + ' ' + cleanText.substring(codeEnd + 3).trimStart();
          searchStart = codeStart;
        } else {
          // Mantener bloques JSON de usuario o de correo
          searchStart = codeEnd + 3;
        }
      } else {
        break;
      }
    }

    // 2. Extraer cualquier objeto JSON inline { ... } SOLO si es una llamada a herramienta interna
    searchStart = 0;
    while (true) {
      const toolIdx = cleanText.indexOf('"tool"', searchStart);
      const eventoIdx = cleanText.indexOf('"evento"', searchStart);
      let targetIdx = -1;
      if (toolIdx !== -1 && eventoIdx !== -1) targetIdx = Math.min(toolIdx, eventoIdx);
      else if (toolIdx !== -1) targetIdx = toolIdx;
      else if (eventoIdx !== -1) targetIdx = eventoIdx;

      if (targetIdx === -1) break;

      const openBrace = cleanText.lastIndexOf('{', targetIdx);
      if (openBrace === -1) {
        searchStart = targetIdx + 6;
        continue;
      }

      let depth = 0;
      let closeBrace = -1;
      for (let i = openBrace; i < cleanText.length; i++) {
        if (cleanText[i] === '{') depth++;
        else if (cleanText[i] === '}') {
          depth--;
          if (depth === 0) {
            closeBrace = i;
            break;
          }
        }
      }

      if (closeBrace !== -1) {
        const jsonStr = cleanText.substring(openBrace, closeBrace + 1);
        let isInternalTool = false;
        try {
          const parsed = JSON.parse(jsonStr);
          if (parsed && typeof parsed === 'object') {
            if (parsed.tool === 'add_event' && parsed.args) {
              toolEventData = parsed.args;
              isInternalTool = true;
            } else if (parsed.evento) {
              toolEventData = {
                title: parsed.evento.titulo || parsed.evento.title || 'Evento',
                date: parsed.evento.fecha || parsed.evento.date || '',
                time: parsed.evento.hora || parsed.evento.time || '10:00',
              };
              isInternalTool = true;
            } else if (parsed.tool === 'get_calendar_events') {
              toolCalendarRead = true;
              isInternalTool = true;
            } else if (parsed.tool === 'send_whatsapp' || parsed.name === 'send_whatsapp') {
              const waArgs = parsed.args || parsed.arguments || parsed;
              toolWhatsAppData = {
                contact: waArgs.contact_name || waArgs.contact || waArgs.contacto || waArgs.destinatario || 'Contacto',
                message: waArgs.message || waArgs.mensaje || waArgs.texto || '',
              };
              isInternalTool = true;
            } else if (parsed.tool === 'get_recent_emails') {
              isInternalTool = true;
            }
          }
        } catch {
          // Bloque JSON en progreso
        }

        if (isInternalTool) {
          cleanText = cleanText.substring(0, openBrace).trimEnd() + ' ' + cleanText.substring(closeBrace + 1).trimStart();
          searchStart = openBrace;
        } else {
          searchStart = closeBrace + 1;
        }
      } else {
        break;
      }
    }

    cleanText = cleanText.trim();

    // Si solo quedó puntuación residual sin texto real, limpiar
    if (/^[}\]{}\s,.:;'"-]+$/.test(cleanText)) {
      cleanText = '';
    }

    // Fallback JARVIS: Si la respuesta hablada está vacía pero se ejecutó una herramienta
    if (!cleanText && !isCurrentStreaming) {
      if (toolCalendarRead) {
        cleanText = 'He consultado tu agenda en tiempo real. No tienes ningún evento programado para hoy.';
      } else if (toolEventData) {
        cleanText = `He programado "${toolEventData.title}" en tu calendario para el ${toolEventData.date} a las ${toolEventData.time || '10:00'}.`;
      } else if (toolWhatsAppData) {
        cleanText = `Mensaje de WhatsApp enviado a ${toolWhatsAppData.contact}: "${toolWhatsAppData.message}".`;
      }
    }

    responseText = cleanText;

    return (
      <div className="flex flex-col items-start w-full mb-4 text-left">
        {/* 1. ENCABEZADO SUPERIOR: IDENTIDAD + MODELO ESPECÍFICO QUE EJECUTÓ LA RESPUESTA */}
        <div className="flex items-center justify-between w-full mb-2 select-none border-b border-white/10 pb-1.5">
          <div className="flex items-center gap-2">
            <span className="w-1.5 h-1.5 rounded-full bg-[#b82a2a] shadow-[0_0_8px_rgba(184,42,42,0.9)] animate-pulse" />
            <span className="text-[#d43b3b] text-xs font-mono tracking-wider font-semibold uppercase">Enigma</span>
          </div>

          {modelUsed && (
            <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full bg-white/[0.06] border border-white/15 text-[11px] font-mono text-white/90 shadow-sm backdrop-blur-md">
              <span className="text-[#d43b3b] text-xs">✨</span>
              <span className="text-white/60">Resuelto por:</span>
              <span className="text-[#e05050] font-semibold">{modelUsed}</span>
            </span>
          )}
        </div>

        {/* 2. PROCESO DE PENSAMIENTO Y ENRUTAMIENTO VISIBLE HASTA ARRIBA */}
        {((thoughts && thoughts.length > 0) || (thinkText !== null && thinkText.trim().length > 0)) && (
          <div className="w-full mb-3 bg-black/50 border border-white/10 rounded-2xl p-3 shadow-inner backdrop-blur-xl">
            <div className="flex items-center gap-1.5 text-[11px] font-mono text-[#d43b3b] font-semibold mb-2 select-none">
              <span>⚡</span>
              <span>Proceso de Pensamiento y Enrutamiento:</span>
            </div>
            <div className="space-y-1.5 pl-2.5 border-l-2 border-[#b82a2a]/40">
              {thoughts && thoughts.map((t, idx) => (
                <div key={idx} className="text-xs text-white/80 font-mono flex items-center gap-2">
                  <span className="w-1.5 h-1.5 rounded-full bg-[#d43b3b] shrink-0" />
                  <span>{t}</span>
                </div>
              ))}
              {thinkText && (
                <div className="text-xs text-zinc-300 font-mono italic whitespace-pre-wrap mt-2 bg-black/40 p-2.5 rounded-xl border border-white/5">
                  {thinkText}
                </div>
              )}
            </div>
          </div>
        )}

        {/* Tarjeta de lectura de calendario en SQLite */}
        {toolCalendarRead && (
          <div className="w-full my-2 p-3 rounded-2xl neu-extruded flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="w-8 h-8 rounded-xl neu-inset flex items-center justify-center text-[#EF4444] text-sm font-bold">
                📅
              </div>
              <div>
                <div className="text-xs font-semibold text-white tracking-wide">
                  Consulta de Calendario SQLite
                </div>
                <div className="text-[11px] text-white/50 font-mono">
                  Base de datos local sincronizada
                </div>
              </div>
            </div>
            <span className="text-[10px] font-mono text-white neu-inset px-2.5 py-1 rounded-lg flex items-center gap-1.5">
              <span className="w-1.5 h-1.5 rounded-full bg-[#EF4444] animate-pulse" />
              Sincronizado
            </span>
          </div>
        )}

        {/* Tarjeta de confirmación visual de Tool Calling (Evento agendado en SQLite) */}
        {toolEventData && (
          <div className="w-full my-2 p-3 rounded-2xl neu-extruded flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="w-8 h-8 rounded-xl neu-inset flex items-center justify-center text-[#EF4444] text-sm font-bold">
                📅
              </div>
              <div>
                <div className="text-xs font-semibold text-white tracking-wide">
                  {toolEventData.title}
                </div>
                <div className="text-[11px] text-[#EF4444] font-mono flex items-center gap-1.5 mt-0.5">
                  <span>{toolEventData.date}</span>
                  <span>•</span>
                  <span>{toolEventData.time || '10:00'}</span>
                  <span>•</span>
                  <span className="text-white/40">Notificación -{toolEventData.notify_before || 15}m</span>
                </div>
              </div>
            </div>
            <span className="text-[10px] font-mono text-white neu-inset px-2.5 py-1 rounded-lg flex items-center gap-1.5">
              <span className="w-1.5 h-1.5 rounded-full bg-[#EF4444] animate-pulse" />
              Guardado en SQLite
            </span>
          </div>
        )}

        {/* Tarjeta de confirmación visual de Tool Calling (WhatsApp enviado) */}
        {toolWhatsAppData && (
          <div className="w-full my-2 p-3 rounded-2xl neu-extruded flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="w-8 h-8 rounded-xl neu-inset flex items-center justify-center text-white text-sm font-bold">
                💬
              </div>
              <div>
                <div className="text-xs font-semibold text-white tracking-wide">
                  WhatsApp enviado a {toolWhatsAppData.contact}
                </div>
                <div className="text-[11px] text-white/70 font-mono mt-0.5 select-text">
                  "{toolWhatsAppData.message}"
                </div>
              </div>
            </div>
            <span className="text-[10px] font-mono text-white neu-inset px-2.5 py-1 rounded-lg flex items-center gap-1.5 shrink-0">
              <span className="w-1.5 h-1.5 rounded-full bg-[#EF4444] animate-pulse" />
              Entregado
            </span>
          </div>
        )}

        {/* 3. TEXTO DE LA RESPUESTA FINAL */}
        {responseText && (
          <div className="text-white/95 text-left max-w-[95%] text-[14px] leading-relaxed select-text pl-1 font-light w-full">
            <RichMessageText content={responseText} />
            {isCurrentStreaming && thinkEnd !== -1 && (
              <span className="inline-block w-1.5 h-4 bg-[#EF4444] shadow-[0_0_6px_#EF4444] animate-pulse ml-1 align-middle" />
            )}
          </div>
        )}

        {thinkText !== null && thinkEnd !== -1 && !responseText && isCurrentStreaming && (
          <div className="text-white/30 text-xs font-mono italic text-left flex items-center gap-1.5 mt-1 pl-3">
            <span>Escribiendo respuesta...</span>
            <span className="w-1.5 h-1.5 rounded-full bg-[#EF4444] animate-pulse" />
          </div>
        )}
      </div>
    );
  };

  const filteredTasks = selectedTaskCategory === null
    ? tasks
    : tasks.filter((t) => t.category_id === selectedTaskCategory);

  const completedCount = filteredTasks.filter((t) => t.status === 'completed').length;
  const progressPercent = filteredTasks.length > 0 ? Math.round((completedCount / filteredTasks.length) * 100) : 0;

  // Título de la vista para el botón de retorno
  const getViewTitle = () => {
    switch (activeView) {
      case 'chat':
        return 'Chat';
      case 'calendar':
        return 'Calendario';
      case 'tasks':
        return 'Tareas';
      case 'schedule':
        return 'Horarios';
      case 'notes':
        return 'Notas Rápidas';
      case 'settings':
        return 'Ajustes';
      case 'extensions':
        return 'Extensiones';
      case 'contacts':
        return 'Directorio de WhatsApp';
      default:
        return 'Menú';
    }
  };

  // =========================================================================
  // CÁLCULOS EN VIVO PARA MICRO-WIDGETS HUD (CYBERPUNK HUD)
  // =========================================================================
  const upcomingEventInfo = React.useMemo(() => {
    if (!calendarEvents || calendarEvents.length === 0) {
      return { title: 'Sin eventos próximos', timeText: 'Calendario libre', badge: 'Libre' };
    }
    const now = new Date();
    const nowTimeMs = now.getTime();

    // Ordenar cronológicamente
    const sorted = [...calendarEvents].sort((a, b) => {
      const da = new Date(`${a.event_date}T${a.event_time}:00`).getTime();
      const db = new Date(`${b.event_date}T${b.event_time}:00`).getTime();
      return da - db;
    });

    // Encontrar el evento más próximo desde ahora (incluye los que empezaron hace menos de 20m)
    const upcoming = sorted.find((e) => {
      const eventMs = new Date(`${e.event_date}T${e.event_time}:00`).getTime();
      return eventMs >= nowTimeMs - 20 * 60 * 1000;
    }) || sorted[0];

    const targetMs = new Date(`${upcoming.event_date}T${upcoming.event_time}:00`).getTime();
    const diffMins = Math.round((targetMs - nowTimeMs) / (60 * 1000));

    let timeText = '';
    let badge = '';
    if (diffMins > 0 && diffMins < 60) {
      timeText = `En ${diffMins} min`;
      badge = `${diffMins}m`;
    } else if (diffMins >= 60 && diffMins < 1440) {
      const hours = Math.floor(diffMins / 60);
      const mins = diffMins % 60;
      timeText = `En ${hours}h ${mins > 0 ? `${mins}m` : ''}`;
      badge = `${hours}h`;
    } else if (diffMins >= 1440) {
      const days = Math.floor(diffMins / 1440);
      timeText = `En ${days} día${days > 1 ? 's' : ''}`;
      badge = `${days}d`;
    } else if (diffMins >= -30) {
      timeText = '¡Ahora mismo!';
      badge = 'En curso';
    } else {
      timeText = `Hoy a las ${upcoming.event_time}`;
      badge = upcoming.event_time;
    }

    return {
      title: upcoming.title,
      timeText,
      badge,
    };
  }, [calendarEvents]);

  const tasksProgress = React.useMemo(() => {
    const total = tasks.length;
    const completed = tasks.filter((t) => t.status === 'completed').length;
    const percent = total > 0 ? Math.round((completed / total) * 100) : 0;
    return {
      total,
      completed,
      percent,
      summaryText: total === 0 ? 'Sin tareas pendientes' : `${completed}/${total} hechas (${percent}%)`,
      isAllDone: total > 0 && completed === total,
    };
  }, [tasks]);

  const latestNoteInfo = React.useMemo(() => {
    if (!notes || notes.length === 0) {
      return { title: '0 notas guardadas', snippet: 'Toca para crear tu primera nota' };
    }
    const latest = notes[0];
    const cleanContent = (latest.content || '').replace(/\n/g, ' ').trim();
    return {
      title: latest.title || 'Nota sin título',
      snippet: cleanContent.length > 34 ? cleanContent.slice(0, 34) + '...' : cleanContent || 'Nota vacía',
    };
  }, [notes]);

  // =========================================================================
  // LAS BURBUJAS COMPACTAS (MENU ITEMS PRINCIPALES)
  // =========================================================================
  const menuItems = [
    {
      id: 'chat',
      title: 'Chat',
      action: () => {
        setActiveView('chat');
        const input = document.querySelector<HTMLInputElement>('#enigma-input-capsule input');
        input?.focus();
      },
      icon: (
        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
        </svg>
      ),
    },
    {
      id: 'vision',
      title: 'Visión IA',
      action: () => {
        setActiveView('chat');
        onSelectPrompt?.('Analiza mi pantalla y ventana activa, dime qué estoy programando o viendo y ayúdame.');
      },
      icon: (
        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
        </svg>
      ),
    },
    {
      id: 'calendar',
      title: 'Calendario',
      action: () => {
        fetchCalendarEvents();
        setActiveView('calendar');
      },
      icon: (
        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
        </svg>
      ),
    },
    {
      id: 'tasks',
      title: 'Tareas',
      action: () => {
        fetchTasks();
        setActiveView('tasks');
      },
      icon: (
        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4" />
        </svg>
      ),
    },
    {
      id: 'schedule',
      title: 'Horarios',
      action: () => setActiveView('schedule'),
      icon: (
        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
        </svg>
      ),
    },
    {
      id: 'notes',
      title: 'Notas',
      action: () => {
        fetchNotes();
        setActiveView('notes');
      },
      icon: (
        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 20H5a2 2 0 01-2-2V6a2 2 0 012-2h10a2 2 0 012 2v1m2 13a2 2 0 01-2-2V7m2 13a2 2 0 002-2V9a2 2 0 00-2-2h-2m-4-3H9M7 16h6M7 8h6v4H7V8z" />
        </svg>
      ),
    },
    {
      id: 'settings',
      title: 'Ajustes',
      action: () => setActiveView('settings'),
      icon: (
        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
        </svg>
      ),
    },
    {
      id: 'extensions',
      title: 'Extensiones',
      action: () => setActiveView('extensions'),
      icon: (
        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 4a2 2 0 114 0v1a1 1 0 001 1h3a1 1 0 011 1v3a1 1 0 01-1 1h-1a2 2 0 100 4h1a1 1 0 011 1v3a1 1 0 01-1 1h-3a1 1 0 01-1-1v-1a2 2 0 10-4 0v1a1 1 0 01-1 1H7a1 1 0 01-1-1v-3a1 1 0 00-1-1H4a2 2 0 110-4h1a1 1 0 001-1V7a1 1 0 011-1h3a1 1 0 001-1V4z" />
        </svg>
      ),
    },
  ];

  // Cálculo del mes para la cuadrícula mensual dinámica
  const viewYear = currentMonthDate.getFullYear();
  const viewMonth = currentMonthDate.getMonth();
  const monthNames = [
    'Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio',
    'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'
  ];

  const daysInMonth = new Date(viewYear, viewMonth + 1, 0).getDate();
  const firstDayOfWeek = (new Date(viewYear, viewMonth, 1).getDay() + 6) % 7; // Lunes = 0
  const daysInPrevMonth = new Date(viewYear, viewMonth, 0).getDate();

  const prevDays = Array.from({ length: firstDayOfWeek }, (_, i) => daysInPrevMonth - firstDayOfWeek + 1 + i);
  const currentDays = Array.from({ length: daysInMonth }, (_, i) => i + 1);
  const totalGridCells = firstDayOfWeek + daysInMonth;
  const remainingCells = (7 - (totalGridCells % 7)) % 7;
  const nextDays = Array.from({ length: remainingCells }, (_, i) => i + 1);

  const filteredCalendarEvents = selectedCalendarCategory === null
    ? calendarEvents
    : calendarEvents.filter((e) => e.category_id === selectedCalendarCategory);

  const filteredSchedules = selectedScheduleCategory === null
    ? schedules
    : schedules.filter((s) => s.category_id === selectedScheduleCategory);

  const selectedDayEvents = filteredCalendarEvents.filter((e) => e.event_date === selectedDate);

  return (
    <motion.div
      layout
      transition={{ type: 'spring', stiffness: 300, damping: 25 }}
      className="w-full flex flex-col select-text"
    >
      {/* =========================================================================
          BOTÓN DE RETORNO (SOLO CUANDO SE ESTÁ DENTRO DE UNA SUB-VISTA)
          ========================================================================= */}
      {activeView !== 'menu' && (
        <div className="flex items-center justify-between border-b border-red-950/40 pb-2.5 mb-3 shrink-0">
          <button
            type="button"
            onClick={() => setActiveView(activeView === 'contacts' ? 'extensions' : 'menu')}
            className="flex items-center gap-2 text-xs font-mono text-white/70 hover:text-white px-3 py-1.5 rounded-xl bg-[#070709] hover:bg-[#111116] border border-red-950/40 shadow-[inset_2px_2px_4px_#020203,inset_-1px_-1px_3px_#14141B] hover:shadow-[0_0_10px_rgba(239,68,68,0.2)] transition-all cursor-pointer group"
          >
            <span className="text-[#EF4444] group-hover:-translate-x-0.5 transition-transform">←</span>
            <span>Volver</span>
          </button>

          {/* Selector de Persona en la TopBar del Chat */}
          {activeView === 'chat' && availablePersonas && activePersona && onSelectPersona && (
            <div className="flex items-center gap-2">
              <span className="text-[11px] font-mono text-white/40 hidden sm:inline">Persona:</span>
              <PersonaSelector
                availablePersonas={availablePersonas}
                activePersona={activePersona}
                onSelectPersona={onSelectPersona}
                compact
              />
            </div>
          )}

          <div className="flex items-center gap-2 shrink-0">
            <span className="text-xs font-medium text-white">{getViewTitle()}</span>
            <span className="w-1.5 h-1.5 rounded-full bg-[#EF4444] shadow-[0_0_6px_#EF4444] animate-pulse" />
          </div>
        </div>
      )}

      {/* =========================================================================
          CONTENIDO DINÁMICO (MORPHING ENTRE MENÚ Y SUB-VISTAS)
          ========================================================================= */}
      <AnimatePresence mode="wait">
        {/* ================= VISTA MENÚ: CUADRÍCULA ESTRICTA DE MICRO-WIDGETS ================= */}
        {activeView === 'menu' && (
          <motion.div
            key="view-menu-grid"
            initial={{ opacity: 0, scale: 0.96 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.96 }}
            transition={{ duration: 0.15 }}
            className="grid grid-cols-2 gap-3.5 w-full"
          >
            {menuItems.map((item) => (
              <motion.div
                key={item.id}
                whileHover={{ scale: 1.02 }}
                whileTap={{ scale: 0.98 }}
                onClick={item.action}
                className="flex flex-col justify-between p-3.5 rounded-2xl neu-extruded transition-all cursor-pointer group text-left w-full min-h-[102px]"
              >
                {/* Cabecera del Micro-Widget */}
                <div className="flex items-center justify-between w-full">
                  <div className="flex items-center gap-2.5">
                    <div className="w-10 h-10 rounded-xl neu-inset text-[#EF4444] drop-shadow-[0_0_6px_rgba(239,68,68,0.4)] flex items-center justify-center shrink-0">
                      {item.icon}
                    </div>
                    <span className="text-white font-semibold text-xs tracking-wide group-hover:text-white">
                      {item.title}
                    </span>
                  </div>

                  {/* Badges en tiempo real en la esquina superior derecha (Pozos Inset Neumórficos) */}
                  {item.id === 'chat' && (
                    <span className="flex items-center gap-1.5 px-2 py-0.5 rounded-full neu-inset text-[10px] font-mono text-white">
                      <span className="w-1.5 h-1.5 rounded-full neu-led-red animate-pulse" />
                      Live
                    </span>
                  )}
                  {item.id === 'vision' && (
                    <span className="flex items-center px-2 py-0.5 rounded-full neu-inset text-[10px] font-mono text-[#EF4444]">
                      Multimodal
                    </span>
                  )}
                  {item.id === 'calendar' && (
                    <span className="flex items-center px-2 py-0.5 rounded-full neu-inset text-[10px] font-mono text-white font-medium">
                      {upcomingEventInfo.badge}
                    </span>
                  )}
                  {item.id === 'tasks' && (
                    <span className="flex items-center px-2 py-0.5 rounded-full neu-inset text-[10px] font-mono text-white font-medium">
                      {tasksProgress.completed}/{tasksProgress.total}
                    </span>
                  )}
                  {item.id === 'schedule' && (
                    <span className="flex items-center px-2 py-0.5 rounded-full neu-inset text-[10px] font-mono text-white font-medium">
                      {schedules.length} bloques
                    </span>
                  )}
                  {item.id === 'notes' && (
                    <span className="flex items-center px-2 py-0.5 rounded-full neu-inset text-[10px] font-mono text-white font-medium">
                      {notes.length} notas
                    </span>
                  )}
                  {item.id === 'settings' && (
                    <span className="flex items-center px-2 py-0.5 rounded-full neu-inset text-[10px] font-mono text-white/80">
                      v2.0
                    </span>
                  )}
                  {item.id === 'extensions' && (
                    <span className="flex items-center px-2 py-0.5 rounded-full neu-inset text-[10px] font-mono text-white">
                      {whatsappConnected ? '2/2' : '1/2'}
                    </span>
                  )}
                </div>

                {/* Contenido Dinámico Específico por Micro-Widget */}
                <div className="mt-2 w-full">
                  {item.id === 'chat' && (
                    <>
                      <div className="text-xs text-white/90 font-medium truncate">
                        {activePersona ? getPersonaMetadata(activePersona).name : 'DeepSeek-R1 / Ollama'}
                      </div>
                      <div className="text-[11px] text-white/40 truncate">IA conversacional y ejecución local</div>
                    </>
                  )}

                  {item.id === 'vision' && (
                    <>
                      <div className="text-[11px] text-white/60 truncate">Percepción visual con LLaVA</div>
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          setActiveView('chat');
                          onCaptureAreaVision?.();
                        }}
                        className="mt-2 w-full py-1.5 px-2.5 rounded-xl bg-gradient-to-r from-[#B82A2A] to-[#EF4444] hover:from-[#DC2626] hover:to-[#F87171] border border-red-500/40 shadow-[2px_2px_6px_#040406,-1px_-1px_4px_#1c1c24] flex items-center justify-center gap-1.5 text-[11px] font-semibold text-white transition-all cursor-pointer group/btn active:translate-y-0.5"
                      >
                        <span className="text-xs group-hover/btn:scale-110 transition-transform">📸</span>
                        <span>Capturar Área (1-Tap)</span>
                      </button>
                    </>
                  )}

                  {item.id === 'calendar' && (
                    <>
                      <div className="text-xs text-white/90 font-semibold truncate">
                        {upcomingEventInfo.title}
                      </div>
                      <div className="text-[11px] text-[#EF4444] font-medium flex items-center gap-1 mt-0.5">
                        <svg className="w-3 h-3 text-[#EF4444]" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
                        </svg>
                        <span>{upcomingEventInfo.timeText}</span>
                      </div>
                    </>
                  )}

                  {item.id === 'tasks' && (
                    <>
                      <div className="text-xs text-white/90 font-medium truncate">
                        {tasksProgress.summaryText}
                      </div>
                      <div className="w-full neu-inset rounded-full h-2 mt-2 overflow-hidden">
                        <div
                          className="h-full neu-led-red rounded-full transition-all duration-500"
                          style={{ width: `${tasksProgress.percent}%` }}
                        />
                      </div>
                    </>
                  )}

                  {item.id === 'schedule' && (
                    <>
                      <div className="text-xs text-white/90 font-medium truncate">Rutina y enfoque activo</div>
                      <div className="text-[11px] text-white/40 truncate mt-0.5">Gestión de tiempos y descanso</div>
                    </>
                  )}

                  {item.id === 'notes' && (
                    <>
                      <div className="text-xs text-white/90 font-semibold truncate">
                        {latestNoteInfo.title}
                      </div>
                      <div className="text-[11px] text-white/50 truncate italic mt-0.5">
                        «{latestNoteInfo.snippet}»
                      </div>
                    </>
                  )}

                  {item.id === 'settings' && (
                    <>
                      <div className="text-xs text-white/90 font-medium truncate">Núcleo de Memoria SQLite</div>
                      <div className="text-[11px] text-white/70 truncate mt-0.5 font-mono flex items-center gap-1.5">
                        <span className="w-1.5 h-1.5 rounded-full bg-white shadow-[0_0_6px_rgba(255,255,255,0.9)]" />
                        <span>Base de datos sincronizada</span>
                      </div>
                    </>
                  )}

                  {item.id === 'extensions' && (
                    <>
                      <div className="text-xs text-white/90 font-medium truncate">Integraciones activas</div>
                      <div className="text-[11px] text-white/50 truncate mt-0.5 flex items-center gap-2.5">
                        <span className="flex items-center gap-1">
                          <span className={`w-1.5 h-1.5 rounded-full ${whatsappConnected ? 'bg-white shadow-[0_0_6px_rgba(255,255,255,0.8)]' : 'bg-white/20'}`} />
                          WhatsApp
                        </span>
                        <span className="flex items-center gap-1">
                          <span className={`w-1.5 h-1.5 rounded-full ${telegramStatus?.active ? 'bg-white shadow-[0_0_6px_rgba(255,255,255,0.8)]' : 'bg-white/20'}`} />
                          Telegram
                        </span>
                      </div>
                    </>
                  )}
                </div>
              </motion.div>
            ))}
          </motion.div>
        )}

        {/* ================= VISTA CHAT ================= */}
        {activeView === 'chat' && (
          <motion.div
            key="view-chat"
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -6 }}
            transition={{ duration: 0.15 }}
            className="w-full flex flex-col justify-between"
          >
            {/* Contenedor dinámico en tiempo real: Multi-Agente Status */}
            <AnimatePresence>
              {isStreaming && enigmaStatus && (
                <motion.div
                  initial={{ opacity: 0, y: -6, scale: 0.97 }}
                  animate={{ opacity: 1, y: 0, scale: 1 }}
                  exit={{ opacity: 0, y: -6, scale: 0.97 }}
                  transition={{ duration: 0.2 }}
                  className="mb-3 px-3.5 py-2.5 rounded-2xl bg-[#0B0B0E] border border-red-950/50 shadow-[inset_2px_2px_5px_#020203,inset_-2px_-2px_5px_#14141B,0_0_15px_rgba(239,68,68,0.15)] flex items-center justify-between gap-3 text-xs shrink-0"
                >
                  <div className="flex items-center gap-2.5">
                    <div className="relative flex items-center justify-center w-4 h-4">
                      <span className="absolute w-full h-full rounded-full bg-[#EF4444]/40 animate-ping" />
                      <span className="relative w-2 h-2 rounded-full bg-[#EF4444] shadow-[0_0_8px_rgba(239,68,68,0.9)]" />
                    </div>
                    <span className="text-white font-medium tracking-wide">
                      {enigmaStatus.status}
                    </span>
                  </div>
                  {enigmaStatus.model && (
                    <span className="px-2 py-0.5 rounded-full text-[10px] font-mono font-medium tracking-wider uppercase bg-[#070709] border border-red-950/40 text-[#EF4444] shadow-[inset_2px_2px_4px_#020203,inset_-1px_-1px_3px_#14141B]">
                      {enigmaStatus.model}
                    </span>
                  )}
                </motion.div>
              )}
            </AnimatePresence>

            <div
              ref={chatScrollRef}
              className="max-h-[420px] overflow-y-auto w-full flex flex-col pr-1.5 pb-6 scrollbar-thin scrollbar-thumb-white/10 scrollbar-track-transparent"
            >
              {messages.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-8 text-center">
                  <span className="w-2.5 h-2.5 rounded-full bg-[#EF4444] shadow-[0_0_12px_rgba(239,68,68,0.9)] animate-ping mb-3" />
                  <p className="text-sm text-white font-medium">Escribe o dicta tu consulta en la barra superior</p>
                  <p className="text-xs text-white/40 mt-1">Enigma responderá al instante con voz e inteligencia local.</p>
                </div>
              ) : (
                messages.map((msg, idx) => (
                  <React.Fragment key={msg.id || idx}>
                    {msg.role === 'user' ? (
                      <div className="flex justify-end w-full mb-3">
                        <div className="bg-[#121217] border border-red-950/50 text-white rounded-2xl rounded-tr-sm px-4 py-2.5 max-w-[85%] text-right shadow-[4px_4px_10px_#040406,-2px_-2px_6px_#15151C] text-sm leading-relaxed select-text font-light">
                          <RichMessageText content={msg.content} isUser />
                        </div>
                      </div>
                    ) : (
                      renderEnigmaMessage(msg.content, isStreaming && idx === messages.length - 1, msg.model_used, msg.thoughts)
                    )}
                  </React.Fragment>
                ))
              )}
            </div>

            <div className="pt-2 border-t border-white/5 flex items-center justify-between text-xs text-white/40 shrink-0 mt-2">
              <span className="flex items-center gap-1.5">
                <span className="w-1.5 h-1.5 rounded-full bg-[#EF4444] shadow-[0_0_6px_#EF4444]" />
                {activePersona ? (
                  <span>
                    Agente activo:{' '}
                    <span className="text-[#EF4444] font-semibold font-mono">
                      {getPersonaMetadata(activePersona).name}
                    </span>
                  </span>
                ) : (
                  <span>Multi-Agente • SQLite Core Activo</span>
                )}
              </span>
              {onClearChat && (
                <button
                  onClick={() => {
                    onClearChat();
                    setActiveView('menu');
                  }}
                  className="px-2.5 py-1 rounded-lg bg-[#070709] border border-red-950/40 shadow-[inset_2px_2px_4px_#020203,inset_-1px_-1px_3px_#14141B] text-white/60 hover:text-white transition-colors cursor-pointer text-[11px]"
                >
                  Limpiar historial
                </button>
              )}
            </div>
          </motion.div>
        )}

        {/* ================= VISTA CALENDARIO: 100% REAL SQLITE ================= */}
        {activeView === 'calendar' && (
          <motion.div
            key="view-calendar"
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -6 }}
            transition={{ duration: 0.15 }}
            className="w-full flex flex-col max-h-[390px] overflow-y-auto scrollbar-thin scrollbar-thumb-white/10 pr-1 space-y-2.5"
          >
            {/* Pestañas Dinámicas de Subcategorías (Carpetas) */}
            <div className="shrink-0 pb-0.5">
              <ModuleCategoryTabs
                moduleType="calendars"
                selectedCategoryId={selectedCalendarCategory}
                onSelectCategory={setSelectedCalendarCategory}
              />
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-3 flex-1">
              {/* Cuadrícula Mensual Real */}
              <div className="bg-white/[0.03] border border-white/10 rounded-2xl p-3.5 flex flex-col">
                <div className="flex items-center justify-between mb-2.5">
                  <div className="flex items-center gap-1.5">
                    <span className="text-xs font-semibold text-white">
                      {monthNames[viewMonth]} {viewYear}
                    </span>
                    <div className="flex items-center gap-0.5 ml-1">
                      <button
                        type="button"
                        onClick={() => setCurrentMonthDate(new Date(viewYear, viewMonth - 1, 1))}
                        className="text-white/40 hover:text-white p-0.5 rounded hover:bg-white/5 cursor-pointer text-xs"
                      >
                        ‹
                      </button>
                      <button
                        type="button"
                        onClick={() => setCurrentMonthDate(new Date(viewYear, viewMonth + 1, 1))}
                        className="text-white/40 hover:text-white p-0.5 rounded hover:bg-white/5 cursor-pointer text-xs"
                      >
                        ›
                      </button>
                    </div>
                  </div>
                  <span className="text-[11px] font-mono text-[#d43b3b] bg-[#b82a2a]/10 px-2 py-0.5 rounded-md border border-[#b82a2a]/20">
                    Hoy: {today.getDate()} {monthNames[today.getMonth()].slice(0, 3)}
                  </span>
                </div>

                <div className="grid grid-cols-7 gap-1 text-center text-[10px] font-mono text-white/40 mb-1.5">
                  <span>L</span><span>M</span><span>X</span><span>J</span><span>V</span>
                  <span className="text-[#d43b3b]">S</span><span className="text-[#d43b3b]">D</span>
                </div>

                {/* Días generados dinámicamente con marcadores de eventos en SQLite */}
                <div className="grid grid-cols-7 gap-1 text-center text-xs font-mono">
                  {prevDays.map((d, i) => (
                    <span key={`prev-${i}`} className="p-1 text-white/15 select-none">
                      {d}
                    </span>
                  ))}

                  {currentDays.map((d) => {
                    const dateStr = `${viewYear}-${String(viewMonth + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
                    const hasEvents = filteredCalendarEvents.some((e) => e.event_date === dateStr);
                    const isToday = dateStr === todayStr;
                    const isSelected = dateStr === selectedDate;

                    return (
                      <button
                        key={d}
                        type="button"
                        onClick={() => setSelectedDate(dateStr)}
                        className={`relative flex flex-col items-center justify-center p-1 rounded-lg transition-all cursor-pointer ${
                          isSelected
                            ? 'bg-[#b82a2a] text-white font-bold shadow-[0_0_10px_rgba(184,42,42,0.7)]'
                            : isToday
                            ? 'border border-[#b82a2a]/50 bg-[#b82a2a]/15 text-[#e05050] font-semibold'
                            : hasEvents
                            ? 'bg-white/[0.06] text-white hover:bg-[#b82a2a]/20 border border-[#b82a2a]/30 font-semibold'
                            : 'text-white/70 hover:bg-white/10'
                        }`}
                      >
                        <span>{d}</span>
                        {/* Marcador distintivo de día con evento (punto rojo Enigma) */}
                        {hasEvents && (
                          <span
                            className={`w-1 h-1 rounded-full mt-0.5 ${
                              isSelected ? 'bg-white shadow-[0_0_4px_#fff]' : 'bg-[#b82a2a] shadow-[0_0_6px_rgba(184,42,42,0.9)]'
                            }`}
                          />
                        )}
                      </button>
                    );
                  })}

                  {nextDays.map((d, i) => (
                    <span key={`next-${i}`} className="p-1 text-white/15 select-none">
                      {d}
                    </span>
                  ))}
                </div>
              </div>

              {/* Lista Real de Eventos del Día Seleccionado */}
              <div className="bg-white/[0.02] border border-white/5 rounded-2xl p-3 flex flex-col justify-between">
                <div className="flex items-center justify-between mb-2">
                  <span className="text-xs font-semibold text-white">
                    Eventos: <span className="font-mono text-[#d43b3b]">{selectedDate}</span>
                  </span>
                  <button
                    type="button"
                    onClick={() => setIsAddingEvent(!isAddingEvent)}
                    className="text-[11px] text-[#d43b3b] hover:text-[#e05050] font-medium px-2 py-0.5 rounded-lg bg-[#b82a2a]/10 border border-[#b82a2a]/20 transition-all cursor-pointer"
                  >
                    {isAddingEvent ? 'Cancelar' : '+ Añadir'}
                  </button>
                </div>

                {/* Formulario rápido para añadir evento manual */}
                {isAddingEvent && (
                  <form onSubmit={handleManualAddEvent} className="mb-2.5 p-2 rounded-xl bg-white/[0.04] border border-white/10 space-y-2">
                    <input
                      type="text"
                      placeholder="Título del evento..."
                      value={manualTitle}
                      onChange={(e) => setManualTitle(e.target.value)}
                      className="w-full bg-black/40 border border-white/10 rounded-lg px-2.5 py-1 text-xs text-white placeholder-white/30 outline-none focus:border-[#b82a2a]/50"
                      autoFocus
                    />
                    <div className="flex items-center gap-2">
                      <input
                        type="time"
                        value={manualTime}
                        onChange={(e) => setManualTime(e.target.value)}
                        className="bg-black/40 border border-white/10 rounded-lg px-2 py-1 text-xs text-white font-mono outline-none focus:border-[#b82a2a]/50"
                      />
                      <button
                        type="submit"
                        disabled={!manualTitle.trim()}
                        className="flex-1 bg-[#b82a2a]/80 hover:bg-[#b82a2a] text-white text-xs py-1 rounded-lg font-medium transition-all disabled:opacity-40 cursor-pointer"
                      >
                        Guardar Evento
                      </button>
                    </div>
                  </form>
                )}

                {/* Lista de eventos reales */}
                <div className="space-y-2 flex-1 overflow-y-auto max-h-[220px] scrollbar-thin scrollbar-thumb-white/10 pr-1">
                  {selectedDayEvents.length === 0 ? (
                    <div className="flex flex-col items-center justify-center py-8 text-center text-white/40">
                      <svg className="w-6 h-6 mb-2 opacity-30 text-[#d43b3b]" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
                      </svg>
                      <div className="text-xs text-white/60 font-medium">Sin eventos para esta fecha</div>
                      <div className="text-[10px] text-white/30 mt-1 max-w-[200px]">
                        Pídele a Enigma por voz o chat: <br />
                        <span className="text-[#d43b3b] font-mono">"Añade reunión mañana a las 11:00"</span>
                      </div>
                    </div>
                  ) : (
                    selectedDayEvents.map((event) => (
                      <div
                        key={event.id}
                        className="p-2.5 rounded-xl bg-white/[0.04] border border-white/10 hover:border-[#b82a2a]/40 flex items-start justify-between gap-2.5 group transition-all"
                      >
                        <div className="flex items-start gap-2.5 min-w-0">
                          <div className="w-1 h-7 rounded-full bg-[#b82a2a] shadow-[0_0_6px_rgba(184,42,42,0.8)] shrink-0 mt-0.5" />
                          <div className="flex-1 min-w-0">
                            <div className="text-xs font-semibold text-white truncate">{event.title}</div>
                            <div className="text-[10px] text-white/40 font-mono flex items-center gap-1.5 mt-0.5">
                              <span>⏰ {event.event_time}</span>
                              <span>•</span>
                              <span className="text-[#d43b3b]">Aviso {event.notify_before_mins}m</span>
                              {event.notified === 1 && (
                                <span className="text-[#EF4444] font-semibold ml-1">✓ Notificado</span>
                              )}
                            </div>
                          </div>
                        </div>

                        <button
                          type="button"
                          onClick={(e) => handleDeleteEvent(event.id, e)}
                          title="Eliminar de SQLite"
                          className="text-white/20 hover:text-[#d43b3b] p-1 opacity-0 group-hover:opacity-100 transition-all cursor-pointer"
                        >
                          <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                          </svg>
                        </button>
                      </div>
                    ))
                  )}
                </div>
              </div>
            </div>
          </motion.div>
        )}

        {/* ================= VISTA TAREAS: 100% REAL SQLITE ================= */}
        {activeView === 'tasks' && (
          <motion.div
            key="view-tasks"
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -6 }}
            transition={{ duration: 0.15 }}
            className="w-full flex flex-col max-h-[380px] overflow-y-auto scrollbar-thin scrollbar-thumb-white/10 pr-1 space-y-2.5"
          >
            {/* Pestañas Dinámicas de Subcategorías (Carpetas) */}
            <div className="shrink-0 pb-0.5">
              <ModuleCategoryTabs
                moduleType="tasks"
                selectedCategoryId={selectedTaskCategory}
                onSelectCategory={setSelectedTaskCategory}
              />
            </div>

            <div className="shrink-0">
              <div className="flex items-center justify-between text-xs mb-1">
                <span className="text-white/60 font-medium">Progreso Real (SQLite)</span>
                <span className="font-mono text-[#d43b3b] font-semibold">
                  {completedCount} de {filteredTasks.length} ({progressPercent}%)
                </span>
              </div>
              <div className="w-full h-1.5 bg-white/10 rounded-full overflow-hidden">
                <motion.div
                  className="h-full bg-gradient-to-r from-[#9e1f1f] to-[#d43b3b]"
                  initial={{ width: 0 }}
                  animate={{ width: `${progressPercent}%` }}
                  transition={{ duration: 0.4 }}
                />
              </div>
            </div>

            <form onSubmit={handleAddTask} className="flex gap-2 shrink-0">
              <input
                type="text"
                value={newTaskInput}
                onChange={(e) => setNewTaskInput(e.target.value)}
                placeholder="Nueva tarea persistente en SQLite..."
                className="flex-1 bg-white/[0.04] border border-white/10 rounded-xl px-3 py-1.5 text-xs text-white placeholder-white/30 outline-none focus:border-[#b82a2a]/60"
              />
              <button
                type="submit"
                disabled={!newTaskInput.trim()}
                className="bg-[#b82a2a]/80 hover:bg-[#b82a2a] text-white px-3.5 py-1.5 rounded-xl text-xs font-medium transition-all disabled:opacity-40 cursor-pointer"
              >
                + Añadir
              </button>
            </form>

            <div className="space-y-1.5">
              {filteredTasks.length === 0 ? (
                <div className="text-center py-6 text-xs text-white/40">
                  {selectedTaskCategory ? 'No hay tareas en esta carpeta.' : 'No hay tareas registradas en la base de datos.'}
                </div>
              ) : (
                filteredTasks.map((task) => {
                  const isDone = task.status === 'completed';
                  return (
                    <div
                      key={task.id}
                      onClick={() => handleToggleTask(task)}
                      className={`group flex items-center justify-between p-2.5 rounded-xl border transition-all cursor-pointer ${
                        isDone
                          ? 'bg-white/[0.02] border-white/5 opacity-60'
                          : 'bg-white/[0.04] border-white/10 hover:border-[#b82a2a]/30'
                      }`}
                    >
                      <div className="flex items-center gap-2.5 min-w-0">
                        <div
                          className={`w-3.5 h-3.5 rounded border flex items-center justify-center transition-all ${
                            isDone
                              ? 'bg-[#b82a2a] border-[#b82a2a] text-white'
                              : 'border-white/30 group-hover:border-[#d43b3b]'
                          }`}
                        >
                          {isDone && (
                            <svg className="w-2.5 h-2.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" />
                            </svg>
                          )}
                        </div>
                        <span
                          className={`text-xs select-none truncate ${
                            isDone ? 'line-through text-white/40' : 'text-white/90'
                          }`}
                        >
                          {task.title}
                        </span>
                      </div>

                      <button
                        type="button"
                        onClick={(e) => handleDeleteTask(task.id, e)}
                        className="text-white/20 hover:text-[#d43b3b] transition-colors p-1 opacity-0 group-hover:opacity-100"
                      >
                        <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                        </svg>
                      </button>
                    </div>
                  );
                })
              )}
            </div>
          </motion.div>
        )}

        {/* ================= VISTA HORARIOS: 100% REAL SQLITE ================= */}
        {activeView === 'schedule' && (
          <motion.div
            key="view-schedule"
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -6 }}
            transition={{ duration: 0.15 }}
            className="w-full flex flex-col max-h-[380px] overflow-y-auto scrollbar-thin scrollbar-thumb-white/10 pr-1 space-y-2.5"
          >
            {/* Pestañas Dinámicas de Subcategorías (Carpetas) */}
            <div className="shrink-0 pb-0.5">
              <ModuleCategoryTabs
                moduleType="schedules"
                selectedCategoryId={selectedScheduleCategory}
                onSelectCategory={setSelectedScheduleCategory}
              />
            </div>

            {filteredSchedules.length === 0 ? (
              <div className="text-center py-6 text-xs text-white/40">
                {selectedScheduleCategory ? 'No hay horarios en esta carpeta.' : 'No hay bloques de horario configurados.'}
              </div>
            ) : (
              filteredSchedules.map((slot) => (
                <div
                  key={slot.id}
                  className="p-2.5 rounded-xl border bg-white/[0.03] border-white/10 flex items-center justify-between transition-all"
                >
                  <div className="flex items-center gap-3">
                    <div className="font-mono text-xs text-[#d43b3b] font-semibold w-24 shrink-0">
                      {slot.start_time} - {slot.end_time}
                    </div>
                    <div className="text-xs font-medium text-white">{slot.block_name}</div>
                  </div>
                  <span className="text-[10px] font-mono text-white/40">{slot.day_of_week}</span>
                </div>
              ))
            )}
          </motion.div>
        )}

        {/* ================= VISTA NOTAS RÁPIDAS (SISTEMA NUEVO) ================= */}
        {activeView === 'notes' && <NotesView />}

        {/* ================= VISTA AJUSTES ================= */}
        {activeView === 'settings' && (
          <motion.div
            key="view-settings"
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -6 }}
            transition={{ duration: 0.15 }}
            className="w-full flex flex-col max-h-[380px] overflow-y-auto scrollbar-thin scrollbar-thumb-white/10 pr-1 space-y-2.5"
          >
            <div className="p-3 rounded-2xl bg-white/[0.03] border border-white/10 flex items-center justify-between">
              <div>
                <div className="text-xs font-semibold text-white">Voz Piper TTS (Dave)</div>
                <div className="text-[10px] text-white/50">Síntesis neural local rápida mediante PipeWire.</div>
              </div>
              <button
                type="button"
                onClick={onToggleVoice}
                className={`px-3 py-1.5 rounded-xl text-xs font-medium border transition-all cursor-pointer ${
                  voiceEnabled
                    ? 'bg-[#b82a2a]/20 border-[#b82a2a]/40 text-[#e05050]'
                    : 'bg-white/5 border-white/10 text-white/40'
                }`}
              >
                {voiceEnabled ? 'Activada' : 'Silenciada'}
              </button>
            </div>

            <div className="p-3 rounded-2xl neu-extruded flex items-center justify-between">
              <div>
                <div className="text-xs font-semibold text-white">Modelo Ollama</div>
                <div className="text-[10px] text-white/50">deepseek-r1:14b en local con Tool Calling.</div>
              </div>
              <span className="text-xs font-mono text-white neu-inset px-2.5 py-0.5 rounded-md flex items-center gap-1.5">
                <span className="w-1.5 h-1.5 rounded-full neu-led-red animate-pulse" />
                Conectado
              </span>
            </div>

            <div className="p-3 rounded-2xl neu-extruded flex items-center justify-between">
              <div>
                <div className="text-xs font-semibold text-white">Base de Datos Enigma</div>
                <div className="text-[10px] text-white/50">SQLite (~/.local/share/enigma/enigma_core.db)</div>
              </div>
              <span className="text-xs font-mono text-[#EF4444] neu-inset px-2.5 py-0.5 rounded-md flex items-center gap-1.5">
                <span className="w-1.5 h-1.5 rounded-full neu-led-red" />
                SQLite Conectado
              </span>
            </div>

            <div className="p-3 rounded-2xl bg-white/[0.03] border border-white/10 flex items-center justify-between">
              <div>
                <div className="text-xs font-semibold text-white">Dictado de Voz (Vosk)</div>
                <div className="text-[10px] text-white/50">Reconocimiento continuo de 'oye enigma'.</div>
              </div>
              <button
                type="button"
                onClick={onToggleSTT}
                className={`px-3 py-1.5 rounded-xl text-xs font-medium border transition-all cursor-pointer ${
                  isListeningSTT
                    ? 'bg-[#b82a2a] text-white border-[#b82a2a]'
                    : 'bg-white/5 border-white/10 text-white/40'
                }`}
              >
                {isListeningSTT ? 'Grabando' : 'Dictado'}
              </button>
            </div>
          </motion.div>
        )}

        {/* ================= VISTA EXTENSIONES: 100% REAL SQLITE + WHATSAPP ================= */}
        {activeView === 'extensions' && (
          <motion.div
            key="view-extensions"
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -6 }}
            transition={{ duration: 0.15 }}
            className="w-full flex flex-col max-h-[380px] overflow-y-auto scrollbar-thin scrollbar-thumb-white/10 pr-1 space-y-3"
          >
            {/* Tarjeta Destacada: Microservicio WhatsApp Baileys */}
            <div className="p-3.5 rounded-2xl neu-extruded flex flex-col gap-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2.5">
                  <div className={`w-2 h-2 rounded-full ${whatsappConnected ? 'neu-led-red' : 'bg-white/30'} animate-pulse`} />
                  <div>
                    <div className="text-xs font-semibold text-white tracking-wide flex items-center gap-1.5">
                      <span>WhatsApp Bridge (Baileys)</span>
                      <span className="text-[10px] font-mono text-white neu-inset px-2 py-0.5 rounded-md">
                        Local :3030
                      </span>
                    </div>
                    <div className="text-[10px] text-white/50 font-mono">
                      {whatsappConnected
                        ? `Conectado como: ${whatsappUser || 'Sesión activa'}`
                        : 'Sesión local no iniciada'}
                    </div>
                  </div>
                </div>

                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => {
                      fetchWhatsAppStatus();
                      fetchWhatsAppQr();
                    }}
                    disabled={isLoadingQr}
                    className="text-[10px] font-mono px-2.5 py-1 rounded-lg neu-extruded text-white/80 hover:text-white transition-all cursor-pointer"
                  >
                    {isLoadingQr ? 'Cargando...' : 'Comprobar'}
                  </button>
                  <span className="text-[10px] font-mono px-2.5 py-0.5 rounded-md neu-inset text-white">
                    {whatsappConnected ? 'Vinculado' : 'Escanear QR'}
                  </span>
                </div>
              </div>

              {/* Si no está conectado y hay código QR disponible */}
              {!whatsappConnected && (
                <div className="flex flex-col items-center p-3 rounded-xl neu-inset">
                  <div className="text-xs text-white/80 font-medium mb-1 text-center">
                    Vincula WhatsApp con Enigma
                  </div>
                  <div className="text-[10px] text-white/40 mb-3 text-center max-w-[280px]">
                    Abre WhatsApp en tu móvil → Dispositivos vinculados → Vincular un dispositivo y escanea este código.
                  </div>

                  {whatsappQr ? (
                    <div className="p-2 bg-white rounded-xl shadow-xl">
                      <img
                        src={whatsappQr}
                        alt="Código QR de WhatsApp"
                        className="w-40 h-40 object-contain rounded-lg"
                      />
                    </div>
                  ) : (
                    <div className="w-40 h-40 rounded-xl neu-inset flex flex-col items-center justify-center gap-2 text-white/40">
                      <span className="w-4 h-4 border-2 border-[#EF4444] border-t-transparent rounded-full animate-spin" />
                      <span className="text-[11px] font-mono">Esperando QR...</span>
                    </div>
                  )}

                  <div className="text-[9px] text-[#EF4444] font-mono mt-2 flex items-center gap-1">
                    <span>⚡ Las credenciales se guardan localmente para no repetir el escaneo</span>
                  </div>
                </div>
              )}

                {/* Botón directo para ir a la vista nativa de Contactos */}
                <div className="mt-1 pt-2 border-t border-red-950/40">
                  <button
                    type="button"
                    onClick={() => setActiveView('contacts')}
                    className="w-full py-2.5 px-3 rounded-xl neu-extruded flex items-center justify-between transition-all cursor-pointer group shadow-sm"
                  >
                    <div className="flex items-center gap-2">
                      <span className="text-base group-hover:scale-110 transition-transform">👥</span>
                      <div className="text-left">
                        <div className="text-xs font-bold text-white group-hover:text-[#EF4444] transition-colors">
                          Gestionar y Limpiar Contactos
                        </div>
                        <div className="text-[10px] text-white/50 font-mono">
                          1 contacto por línea · Arrastrar para seleccionar · Borrado permanente
                        </div>
                      </div>
                    </div>
                    <span className="px-2 py-0.5 rounded-md neu-inset text-white font-mono text-[10px] font-semibold">
                      {whatsappContacts.length} contactos ➔
                    </span>
                  </button>
                </div>
              </div>

            {/* Tarjeta Destacada: Google Workspace (Gmail & Calendar) */}
            <div className="p-3.5 rounded-2xl neu-extruded flex flex-col gap-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2.5">
                  <div className={`w-2 h-2 rounded-full ${googleConnected ? 'neu-led-red' : 'bg-white/30'} animate-pulse`} />
                  <div>
                    <div className="text-xs font-semibold text-white tracking-wide flex items-center gap-1.5">
                      <span>Google Workspace (Gmail & Calendar)</span>
                      <span className="text-[10px] font-mono text-white neu-inset px-2 py-0.5 rounded-md">
                        OAuth 2.0
                      </span>
                    </div>
                    <div className="text-[10px] text-white/50 font-mono">
                      {googleConnected
                        ? 'Vinculado · Lectura de correos y agenda activas'
                        : 'No vinculado · Introduce tus credenciales'}
                    </div>
                  </div>
                </div>

                <div className="flex items-center gap-2">
                  {googleConnected ? (
                    <>
                      <button
                        type="button"
                        onClick={handleFetchGmailEmails}
                        disabled={isLoadingEmails}
                        className="text-[10px] font-mono px-2.5 py-1 rounded-lg neu-extruded text-white/80 hover:text-white transition-all cursor-pointer"
                      >
                        {isLoadingEmails ? 'Leyendo...' : 'Comprobar'}
                      </button>
                      <button
                        type="button"
                        onClick={handleDisconnectGoogle}
                        className="text-[10px] font-mono px-2.5 py-1 rounded-lg neu-extruded text-[#EF4444] hover:text-[#DC2626] transition-all cursor-pointer"
                      >
                        Desconectar
                      </button>
                    </>
                  ) : (
                    <span className="text-[10px] font-mono px-2.5 py-0.5 rounded-md neu-inset text-white/60">
                      Sin vincular
                    </span>
                  )}
                </div>
              </div>

              {!googleConnected ? (
                <div className="flex flex-col gap-2.5 p-3 rounded-xl neu-inset">
                  <div className="text-xs text-white/80 font-medium">
                    Configuración de Google OAuth 2.0
                  </div>
                  <div className="text-[10px] text-white/40 leading-relaxed">
                    Introduce el <code className="text-[#EF4444] neu-inset px-1.5 py-0.5 rounded">Client ID</code> y <code className="text-[#EF4444] neu-inset px-1.5 py-0.5 rounded">Client Secret</code> de Google Cloud Console. Al pulsar vincular, se abrirá tu navegador para autorizar a Enigma.
                  </div>

                  <div className="space-y-2 mt-1">
                    <div>
                      <label className="text-[10px] text-white/60 font-mono block mb-1">Client ID:</label>
                      <input
                        type="text"
                        value={googleClientId}
                        onChange={(e) => setGoogleClientId(e.target.value)}
                        placeholder="xxxx.apps.googleusercontent.com"
                        className="w-full text-xs px-2.5 py-1.5 rounded-lg neu-inset text-white placeholder-white/20 focus:outline-none focus:border-[#EF4444] font-mono"
                      />
                    </div>
                    <div>
                      <label className="text-[10px] text-white/60 font-mono block mb-1">Client Secret:</label>
                      <input
                        type="password"
                        value={googleClientSecret}
                        onChange={(e) => setGoogleClientSecret(e.target.value)}
                        placeholder="GOCSPX-xxxx"
                        className="w-full text-xs px-2.5 py-1.5 rounded-lg neu-inset text-white placeholder-white/20 focus:outline-none focus:border-[#EF4444] font-mono"
                      />
                    </div>
                  </div>

                  {googleError && (
                    <div className="text-[10px] text-[#EF4444] neu-inset p-2 rounded-lg font-mono">
                      {googleError}
                    </div>
                  )}

                  <button
                    type="button"
                    onClick={handleConnectGoogle}
                    disabled={isConnectingGoogle}
                    className="w-full mt-1 py-2 px-3 rounded-xl neu-extruded hover:border-[#EF4444] text-white font-semibold text-xs transition-all cursor-pointer flex items-center justify-center gap-2 disabled:opacity-50"
                  >
                    {isConnectingGoogle ? (
                      <>
                        <span className="w-3.5 h-3.5 border-2 border-white border-t-transparent rounded-full animate-spin" />
                        <span>Esperando autorización en el navegador...</span>
                      </>
                    ) : (
                      <>
                        <span className="text-[#EF4444]">🔗</span>
                        <span>Vincular con Google Workspace</span>
                      </>
                    )}
                  </button>
                </div>
              ) : (
                <div className="flex flex-col gap-2 p-2.5 rounded-xl neu-inset">
                  <div className="flex items-center justify-between text-[11px]">
                    <span className="text-white/60 font-mono">Permisos activos:</span>
                    <span className="text-white font-mono text-[10px] neu-inset px-2 py-0.5 rounded">
                      Gmail + Google Calendar
                    </span>
                  </div>

                  {gmailEmails.length > 0 && (
                    <div className="mt-1 space-y-1.5 max-h-48 overflow-y-auto pr-1">
                      <div className="text-[10px] text-white/40 font-mono uppercase tracking-wider">Últimos correos detectados:</div>
                      {gmailEmails.map((em) => (
                        <div key={em.id} className="p-2 rounded-lg neu-extruded text-[11px]">
                          <div className="flex items-center justify-between">
                            <span className="font-semibold text-white truncate max-w-[200px]">{em.from}</span>
                            <span className="text-[9px] text-white/40 font-mono truncate">{em.date}</span>
                          </div>
                          <div className="text-[#EF4444] text-[10px] font-medium truncate mt-0.5">{em.subject}</div>
                          <div className="text-white/50 text-[10px] truncate mt-0.5">{em.snippet}</div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* Tarjeta Destacada: Bot Privado de Telegram */}
            <div className="p-3.5 rounded-2xl neu-extruded flex flex-col gap-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2.5">
                  <div className={`w-2 h-2 rounded-full ${telegramStatus?.active ? 'neu-led-red' : 'bg-white/30'} animate-pulse`} />
                  <div>
                    <div className="text-xs font-semibold text-white tracking-wide flex items-center gap-1.5">
                      <span>Telegram Bot Privado</span>
                      <span className="text-[10px] font-mono text-white neu-inset px-2 py-0.5 rounded-md">
                        Telegram Bridge
                      </span>
                    </div>
                    <div className="text-[10px] text-white/50 font-mono">
                      {telegramStatus?.active
                        ? `Vinculado · Chat ID: ${telegramStatus.chat_id}`
                        : (telegramStatus?.configured
                            ? 'Token configurado · Inicia una conversación con tu bot en Telegram'
                            : 'Token no configurado')}
                    </div>
                  </div>
                </div>

                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={handleSendTelegramTest}
                    disabled={isSendingTelegramTest || !telegramStatus?.active}
                    className="text-[10px] font-mono px-2.5 py-1 rounded-lg neu-extruded text-white/80 hover:text-white transition-all cursor-pointer disabled:opacity-40"
                  >
                    {isSendingTelegramTest ? 'Enviando...' : 'Test Alerta'}
                  </button>
                  <span className="text-[10px] font-mono px-2.5 py-0.5 rounded-md neu-inset text-white">
                    {telegramStatus?.active ? 'Activo' : 'Pendiente'}
                  </span>
                </div>
              </div>

              {telegramNotice && (
                <div className="text-[10px] text-white neu-inset p-2 rounded-lg font-mono">
                  {telegramNotice}
                </div>
              )}
            </div>

            {/* Demás Extensiones */}
            {extensions
              .filter((ext) => ext.service_name !== 'telegram' && ext.service_name !== 'telegram_chat_id')
              .map((ext) => (
              <div
                key={ext.id}
                className="p-3 rounded-2xl neu-extruded flex items-center justify-between"
              >
                <div className="flex items-center gap-2.5">
                  <div className="w-1.5 h-1.5 rounded-full neu-led-red" />
                  <div>
                    <div className="text-xs font-semibold text-white">{ext.service_name}</div>
                    <div className="text-[10px] text-white/40 font-mono">SQLite Core Integration</div>
                  </div>
                </div>
                <span className="text-[10px] font-mono px-2 py-0.5 rounded-md neu-inset text-white/80">
                  {ext.status}
                </span>
              </div>
            ))}
          </motion.div>
        )}

        {/* ================= VISTA CONTACTOS WHATSAPP (1 LÍNEA POR CONTACTO, REACTIVO AL PANEL) ================= */}
        {activeView === 'contacts' && (
          <motion.div
            key="view-contacts"
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -6 }}
            transition={{ duration: 0.15 }}
            className="w-full flex flex-col"
          >
            <WhatsAppContactsView
              contacts={whatsappContacts}
              onContactsDeleted={(deletedIds) => {
                setWhatsappContacts((prev) => prev.filter((c) => !deletedIds.includes(c.id)));
              }}
              onContactAdded={fetchWhatsAppContacts}
            />
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
};
