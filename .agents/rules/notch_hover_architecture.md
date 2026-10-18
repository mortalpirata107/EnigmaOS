---
description: Arquitectura de Hover del Notch y Máscara Wayland/Cairo
---

# REGLA INMUTABLE: Arquitectura de Hover del Notch y Máscara Wayland/Cairo

Esta arquitectura ha sido validada, optimizada y congelada por orden explícita del usuario. **BAJO NINGUNA CIRCUNSTANCIA SE DEBE MODIFICAR O REVERTIR ESTA LÓGICA**.

---

### 1. Principio Fundamental
- **Enfoque Hover HTML Directo:** El elemento visible del Notch (`<motion.div>` en `DynamicNotch.tsx`) es el receptor directo de los eventos de hover (`onMouseEnter`, `onMouseLeave`, `onPointerEnter`, `onPointerLeave`).
- **PROHIBIDO:** No volver a introducir divs superpuestos ("hitboxes fantasma", overlays transparentes con `z-20` o `pointer-events-auto` flotantes) que bloqueen los clics sobre los botones multimedia o provoquen desincronización de eventos.
- **PROHIBIDO:** No colocar botones de cierre "✕" en la cabecera del reproductor.

---

### 2. Máscara Física Wayland/Cairo (`src/hooks/useInputRegions.ts`)
- **Región de 2 Estados Discretos (Sin 60 FPS flood):**
  - **Modo Reposo (`expanded = false`):** Tamaño exacto del reloj `255x34 px` centrado en pantalla.
  - **Modo Expandido (`expanded = true`):** Región de `580x320 px` centrado en pantalla (con un margen transparente alrededor de los `520x260 px` del Notch visual).
- **Por qué el margen transparente de 580x320 es crítico:**
  Si la máscara física coincidiera exactamente con los 520x260 del Notch visual, al salir el cursor hacia el escritorio saldría de la ventana Wayland antes de que WebKit pudiera registrar la salida, congelando el Notch en abierto. El margen transparente garantiza que WebKit reciba el evento de salida del elemento visual y dispare `onMouseLeave`.
- **Cierre tras Retracción:** Al salir, la máscara física permanece en 580x320 durante 280 ms mientras Framer Motion repliega el Notch visualmente, y luego se reduce a 255x34.

---

### 3. Detección Nativa de Hardware (`src-tauri/src/main.rs`)
- Se conecta la señal nativa de GTK3 `connect_leave_notify_event` sobre `gtk_win`.
- Al salir el puntero de la superficie GTK en cualquier dirección o a alta velocidad, emite el evento Tauri `hardware_pointer_leave`.
- `DynamicNotch.tsx` escucha este evento y repliega el Notch de inmediato al estado de reposo.

---

### 4. Botones Multimedia (`src/components/MediaExpanded.tsx`)
- Todos los controles (Play/Pause, Anterior, Siguiente, Seek, Tabs) deben conservar `pointer-events-auto`, `cursor-pointer`, `type="button"` y `e.stopPropagation()`.
- La llamada a `playPause()` invoca `media_control('play_pause')` y envía el comando D-Bus a Spotify vía `busctl`.
