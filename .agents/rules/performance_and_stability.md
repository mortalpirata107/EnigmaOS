---
description: Directrices de estabilidad, rendimiento y prevencion de congelamientos en Antigravity IDE
---

# Directivas de Estabilidad y Rendimiento en Antigravity IDE

Para evitar saturación de la cola de eventos IPC, picos de memoria en Electron y bloqueos de la interfaz (unresponsive window):

1. **Ejecución de Comandos Consolidada:** 
   - No encadenar decenas de micro-llamadas a herramientas en un único turno.
   - Si se requiere inspeccionar múltiples elementos o ejecutar diagnósticos, consolidar las consultas en scripts o comandos únicos y concisos.

2. **Exclusión de Directorios de Compilación:**
   - Mantener siempre excluido `src-tauri/target/` (19+ GB) y `node_modules/` de las búsquedas masivas y monitores de archivos en `.vscode/settings.json`.

3. **Respuestas Claras y Enfocadas:**
   - Evitar volcados de texto o logs gigantescos directos en el chat sin recortar o resumir, para evitar colapsar el motor de renderizado Blink/Chromium.
