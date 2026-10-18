import React, { useState, useEffect } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow';
import { invoke } from '@tauri-apps/api/core';
import { TopBarLayout } from './components/TopBarLayout';
import { BottomDock } from './components/BottomDock';
import { ErrorBoundary } from './components/ErrorBoundary';

export const App: React.FC = () => {
  const [windowLabel, setWindowLabel] = useState<string>(() => {
    try {
      const urlParams = new URLSearchParams(window.location.search);
      const urlWindow = urlParams.get('window');
      if (urlWindow) return urlWindow;
      return getCurrentWebviewWindow()?.label || getCurrentWindow()?.label || 'main';
    } catch {
      return 'main';
    }
  });

  useEffect(() => {
    try {
      const urlParams = new URLSearchParams(window.location.search);
      if (!urlParams.get('window')) {
        const label = getCurrentWebviewWindow()?.label || getCurrentWindow()?.label;
        if (label && label !== windowLabel) {
          setWindowLabel(label);
        }
      }
    } catch (e) {
      console.warn('[App] Error retrieving window label:', e);
    }
  }, [windowLabel]);

  useEffect(() => {
    invoke('log_frontend', { msg: `App rendered with windowLabel: ${windowLabel} (href: ${window.location.href})` }).catch(() => {});

    const handlePointerDown = (e: PointerEvent) => {
      const target = e.target as HTMLElement | null;
      const desc = target
        ? `${target.tagName.toLowerCase()}${target.id ? '#' + target.id : ''}${target.className ? '.' + String(target.className).split(' ')[0] : ''}`
        : 'null';
      invoke('log_frontend', {
        msg: `[PointerDown:${windowLabel}] (${Math.round(e.clientX)}, ${Math.round(e.clientY)}) on ${desc}`,
      }).catch(() => {});
    };

    window.addEventListener('pointerdown', handlePointerDown, true);
    return () => window.removeEventListener('pointerdown', handlePointerDown, true);
  }, [windowLabel]);

  return (
    <ErrorBoundary>
      {windowLabel === 'dock' ? <BottomDock /> : <TopBarLayout />}
    </ErrorBoundary>
  );
};

export default App;
