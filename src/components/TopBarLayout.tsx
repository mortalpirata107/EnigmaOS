import React, { useRef, useState, useCallback, useEffect } from 'react';
import { LeftCapsule } from './LeftCapsule';
import { DynamicNotch } from './DynamicNotch';
import { RightCapsule } from './RightCapsule';
import { syncAllTopBarRegions } from '../utils/syncInputRegions';

export const TopBarLayout: React.FC = () => {
  const leftRef = useRef<HTMLDivElement>(null);
  const notchRef = useRef<HTMLDivElement>(null);
  const rightRef = useRef<HTMLDivElement>(null);

  const [isMediaExpanded, setIsMediaExpanded] = useState<boolean>(false);
  const [isSearchOpen, setIsSearchOpen] = useState<boolean>(false);
  const [, setIsRightExpanded] = useState<boolean>(false);

  // Sincronización inicial de regiones físicas en Cairo/GDK y en cambios de ventana
  useEffect(() => {
    syncAllTopBarRegions();
    const t1 = setTimeout(syncAllTopBarRegions, 50);
    const t2 = setTimeout(syncAllTopBarRegions, 150);
    const t3 = setTimeout(syncAllTopBarRegions, 350);
    const t4 = setTimeout(syncAllTopBarRegions, 800);
    const t5 = setTimeout(syncAllTopBarRegions, 1500);

    const handleResize = () => {
      syncAllTopBarRegions();
    };

    window.addEventListener('resize', handleResize);
    return () => {
      clearTimeout(t1);
      clearTimeout(t2);
      clearTimeout(t3);
      clearTimeout(t4);
      clearTimeout(t5);
      window.removeEventListener('resize', handleResize);
    };
  }, []);

  // Heartbeat ultra-ligero para mantener el compositor de WebKitGTK activo en Wayland
  useEffect(() => {
    let animId: number;
    let frame = 0;
    const tickerEl = document.getElementById('topbar-heartbeat');
    const tick = () => {
      frame = (frame + 1) % 60;
      if (tickerEl && frame === 0) {
        tickerEl.style.opacity = tickerEl.style.opacity === '0.001' ? '0.002' : '0.001';
      }
      animId = requestAnimationFrame(tick);
    };
    animId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(animId);
  }, []);

  const handleHoverChange = useCallback((expanded: boolean) => {
    setIsMediaExpanded(expanded);
    syncAllTopBarRegions();
    setTimeout(syncAllTopBarRegions, 60);
    setTimeout(syncAllTopBarRegions, 160);
    setTimeout(syncAllTopBarRegions, 360);
  }, []);

  const handleOpenSearch = useCallback(() => {
    setIsSearchOpen(true);
    handleHoverChange(true);
  }, [handleHoverChange]);

  const handlePopoverChange = useCallback((isOpen: boolean) => {
    setIsRightExpanded(isOpen);
    setTimeout(syncAllTopBarRegions, 16);
  }, []);

  return (
    <div
      id="topbar-canvas"
      className="fixed top-0 left-0 w-full h-[900px] m-0 p-0 bg-transparent select-none pointer-events-none z-50 overflow-visible"
      style={{ top: 0, left: 0, margin: 0, padding: 0, willChange: 'transform' }}
    >
      {/* Heartbeat invisible de 1px para el compositor de WebKitGTK */}
      <div 
        id="topbar-heartbeat" 
        style={{ position: 'absolute', top: 0, left: 0, width: 1, height: 1, opacity: 0.001, pointerEvents: 'none', willChange: 'opacity' }} 
      />

      {/* 1. Cápsula Izquierda: Anclada estrictamente a top-0 y left-0 absoluto */}
      <div 
        className="pointer-events-auto absolute top-0 left-0 m-0 p-0"
        style={{ top: 0, left: 0, margin: 0, padding: 0, willChange: 'transform' }}
      >
        <LeftCapsule 
          innerRef={leftRef} 
          onOpenSearch={handleOpenSearch}
        />
      </div>

      {/* 2. Dynamic Notch Central & Enigma Field: Anclada a top-0 en el centro */}
      <DynamicNotch 
        innerRef={notchRef} 
        isExpanded={isMediaExpanded}
        onHoverChange={handleHoverChange}
        isSearchOpen={isSearchOpen}
        onSearchOpenChange={setIsSearchOpen}
      />

      {/* 3. Cápsula Derecha: Anclada estrictamente a top-0 y right-0 absoluto */}
      <div 
        className="pointer-events-auto absolute top-0 right-0 m-0 p-0"
        style={{ top: 0, right: 0, margin: 0, padding: 0, willChange: 'transform' }}
      >
        <RightCapsule 
          innerRef={rightRef}
          onPopoverChange={handlePopoverChange}
        />
      </div>
    </div>
  );
};

export default TopBarLayout;
