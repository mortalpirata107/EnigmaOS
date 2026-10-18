import { useEffect, useRef, useCallback } from 'react';
import { invoke } from '@tauri-apps/api/core';
import type { InputRegion } from '../types';

interface InputRegionsProps {
  leftRef: React.RefObject<HTMLElement | null>;
  rightRef: React.RefObject<HTMLElement | null>;
  isRightExpanded?: boolean;
  isSearchOpen?: boolean;
}

export function useInputRegions({ 
  leftRef, 
  rightRef, 
  isRightExpanded = false,
  isSearchOpen = false,
}: InputRegionsProps) {
  const isExpandedRef = useRef<boolean>(false);
  const isRightExpandedRef = useRef<boolean>(isRightExpanded);
  const isSearchOpenRef = useRef<boolean>(isSearchOpen);
  const collapseTimeoutRef = useRef<number | null>(null);
  const animationFrameIdRef = useRef<number | null>(null);
  const lastRegionsKeyRef = useRef<string>('');

  const applyHardwareRegions = useCallback((expanded: boolean) => {
    try {
      const regions: InputRegion[] = [];
      const dpr = window.devicePixelRatio || 1;

      // 1. Left Capsule (exact bounds from DOM)
      if (leftRef.current) {
        const rect = leftRef.current.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0) {
          regions.push([
            Math.round(rect.left * dpr),
            Math.round(rect.top * dpr),
            Math.round(rect.width * dpr),
            Math.round(rect.height * dpr),
          ]);
        }
      } else {
        regions.push([0, 0, Math.round(300 * dpr), Math.round(34 * dpr)]);
      }

      // 2. Right Capsule: Hitbox Dinámica compartida mediante ResizeObserver y getBoundingClientRect
      if (rightRef.current) {
        const rect = rightRef.current.getBoundingClientRect();
        let minX = rect.left;
        let maxX = rect.right;
        let minY = rect.top;
        let maxY = rect.bottom;

        // Comprobar si hay algún botón expandido dentro
        const expandedChild = rightRef.current.querySelector('[data-menu-expanded="true"]');
        if (expandedChild) {
          const childRect = expandedChild.getBoundingClientRect();
          minX = Math.min(minX, childRect.left);
          maxX = Math.max(maxX, childRect.right);
          maxY = Math.max(maxY, childRect.bottom);
        }

        const width = maxX - minX;
        const height = maxY - minY;

        if (width > 0 && height > 0) {
          regions.push([
            Math.round(minX * dpr),
            Math.round(minY * dpr),
            Math.round(width * dpr),
            Math.round(height * dpr),
          ]);
        }
      } else {
        const w = window.innerWidth;
        regions.push([Math.round((w - 300) * dpr), 0, Math.round(300 * dpr), Math.round(34 * dpr)]);
      }

      // 3. Center Notch: Región exacta según estado (Idle vs Expandido vs Búsqueda)
      const screenCenterX = window.innerWidth / 2;
      const isNotchActive = expanded || isSearchOpenRef.current;
      const notchWidth = isNotchActive ? 580 : 255;
      const notchHeight = isSearchOpenRef.current ? 400 : (isNotchActive ? 340 : 34);
      const notchX = Math.round(screenCenterX - notchWidth / 2);

      regions.push([
        Math.round(notchX * dpr),
        0,
        Math.round(notchWidth * dpr),
        Math.round(notchHeight * dpr),
      ]);

      const key = JSON.stringify(regions);
      if (lastRegionsKeyRef.current === key) {
        return;
      }
      lastRegionsKeyRef.current = key;

      invoke('update_custom_input_regions', { regions }).catch(() => {});
    } catch (err) {
      console.warn('[EnigmaOS] Error applying input regions:', err);
    }
  }, [leftRef, rightRef]);

  // Actualización inmediata al cambiar estado de expansión (hitbox instantánea)
  useEffect(() => {
    isRightExpandedRef.current = isRightExpanded;
    applyHardwareRegions(isExpandedRef.current);
  }, [isRightExpanded, applyHardwareRegions]);

  useEffect(() => {
    isSearchOpenRef.current = isSearchOpen;
    applyHardwareRegions(isExpandedRef.current || isSearchOpen);
  }, [isSearchOpen, applyHardwareRegions]);

  useEffect(() => {
    const el = rightRef.current;
    if (!el) return;

    const resizeObserver = new ResizeObserver(() => {
      applyHardwareRegions(isExpandedRef.current);
    });

    resizeObserver.observe(el);

    return () => {
      resizeObserver.disconnect();
    };
  }, [rightRef, applyHardwareRegions]);

  // Método llamado al entrar o salir del Notch
  const setNotchExpanded = useCallback((expanded: boolean) => {
    isExpandedRef.current = expanded;

    if (collapseTimeoutRef.current) {
      window.clearTimeout(collapseTimeoutRef.current);
      collapseTimeoutRef.current = null;
    }

    if (expanded) {
      applyHardwareRegions(true);
    } else {
      collapseTimeoutRef.current = window.setTimeout(() => {
        if (!isExpandedRef.current) {
          applyHardwareRegions(false);
        }
      }, 280);
    }
  }, [applyHardwareRegions]);

  // Sincronización inicial y listener de resize de ventana
  useEffect(() => {
    const mountTimer = setTimeout(() => {
      applyHardwareRegions(isExpandedRef.current);
    }, 60);

    const handleResize = () => {
      applyHardwareRegions(isExpandedRef.current);
    };

    window.addEventListener('resize', handleResize);
    return () => {
      clearTimeout(mountTimer);
      if (collapseTimeoutRef.current) clearTimeout(collapseTimeoutRef.current);
      if (animationFrameIdRef.current) cancelAnimationFrame(animationFrameIdRef.current);
      window.removeEventListener('resize', handleResize);
    };
  }, [applyHardwareRegions]);

  return { setNotchExpanded, applyHardwareRegions };
}
