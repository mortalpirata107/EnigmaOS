import { invoke } from '@tauri-apps/api/core';

let lastTopBarRegionsKey = '';

function q(val: number): number {
  return Math.round(val / 4) * 4;
}

export function getTopBarRegions(): [number, number, number, number][] {
  const dpr = window.devicePixelRatio || 1;
  const regions: [number, number, number, number][] = [];
  const screenW = window.innerWidth;
  const centerX = screenW / 2;

  if (document.body.dataset.modalOpen === 'true') {
    return [[0, 0, Math.round(screenW * dpr), Math.round(1150 * dpr)]];
  }

  // 1. Left Capsule (strictly anchored at top: 0, left: 0)
  const leftEl = document.getElementById('left-capsule');
  if (leftEl) {
    const r = leftEl.getBoundingClientRect();
    const w = Math.max(320, r.width > 50 ? r.width : 320);
    const h = 34;
    regions.push([
      0,
      0,
      q(w * dpr),
      q(h * dpr),
    ]);
  } else {
    regions.push([0, 0, q(320 * dpr), q(34 * dpr)]);
  }

  // 2. Center Dynamic Notch and Enigma Forcefield Container (strictly anchored at top: 0)
  const notchEl = document.getElementById('dynamic-notch');
  const enigmaInput = document.getElementById('enigma-input-capsule');
  const enigmaOutput = document.getElementById('enigma-output-panel');
  const forcefieldEl = document.getElementById('enigma-forcefield-container');

  if (enigmaInput || enigmaOutput) {
    // Enigma AI está activo: otorgar hitbox al contenedor padre completo de Enigma
    const targetEl = forcefieldEl || notchEl;
    if (targetEl) {
      const r = targetEl.getBoundingClientRect();
      const w = Math.max(360, r.width > 50 ? r.width : 360);
      const h = Math.max(500, r.height > 50 ? r.height : 500);
      const left = r.width > 50 ? r.left : (centerX - w / 2);
      regions.push([
        Math.max(0, q(left * dpr)),
        0,
        q(w * dpr),
        q(h * dpr),
      ]);
    }
  } else if (notchEl) {
    const isExpanded = notchEl.dataset.expanded === 'true';
    const isSearch = notchEl.dataset.search === 'true';
    const section = notchEl.dataset.section;
    const r = notchEl.getBoundingClientRect();

    const isClipboard = notchEl.dataset.clipboard === 'true';

    if (isClipboard) {
      const targetW = 560;
      const targetH = 490;
      const left = centerX - targetW / 2;
      regions.push([
        Math.max(0, q(left * dpr)),
        0,
        q(targetW * dpr),
        q(targetH * dpr),
      ]);
    } else if (isExpanded) {
      // Cobertura completa inmediata del notch expandido a t=0 para evitar que el ratón salga durante la animación
      const targetW = isSearch ? 560 : Math.max(520, r.width > 100 ? r.width : 520);
      const targetH = isSearch ? 430 : (section === 'settings' ? 360 : (section === 'telemetry' ? 220 : Math.max(300, r.height > 100 ? r.height : 300)));
      const left = centerX - targetW / 2;
      regions.push([
        Math.max(0, q(left * dpr)),
        0,
        q(targetW * dpr),
        q(targetH * dpr),
      ]);
    } else {
      // En reposo: EL NOTCH NUNCA DEBE SER MENOR A 280px x 34px
      const defaultW = Math.max(280, r.width > 100 ? r.width : 280);
      const defaultH = 34;
      const left = r.width > 100 ? r.left : (centerX - defaultW / 2);
      regions.push([
        Math.max(0, q(left * dpr)),
        0,
        q(defaultW * dpr),
        q(defaultH * dpr),
      ]);
    }
  } else {
    regions.push([
      q((centerX - 130) * dpr),
      0,
      q(260 * dpr),
      q(34 * dpr),
    ]);
  }

  // 3. Right Status Capsule (strictly anchored at top: 0)
  const rightEl = document.getElementById('right-status-capsule');
  if (rightEl) {
    const r = rightEl.getBoundingClientRect();
    const expandedChild = rightEl.querySelector('[data-menu-expanded="true"]');
    
    if (expandedChild) {
      const cRect = expandedChild.getBoundingClientRect();
      const minX = Math.min(r.left > 50 ? r.left : (screenW - 380), cRect.left, r.right - 380);
      const maxX = Math.max(r.right > 50 ? r.right : screenW, cRect.right);
      const maxY = Math.max(cRect.bottom + 8, 40);
      regions.push([
        q(minX * dpr),
        0,
        q((maxX - minX) * dpr),
        q(maxY * dpr),
      ]);
    } else {
      // En reposo: estrictamente 34px de alto para NO bloquear clics debajo en ventanas activas
      const minX = r.width > 50 ? r.left : (screenW - 320);
      const h = 34;
      regions.push([
        q(minX * dpr),
        0,
        q((screenW - minX) * dpr),
        q(h * dpr),
      ]);
    }
  } else {
    regions.push([q((screenW - 320) * dpr), 0, q(320 * dpr), q(34 * dpr)]);
  }

  return regions;
}

export function forceSyncTopBarRegions() {
  lastTopBarRegionsKey = '';
  syncAllTopBarRegions();
}

export function syncAllTopBarRegions() {
  try {
    const isModalActive = document.body.dataset.modalOpen === 'true';

    const regions = getTopBarRegions();
    const key = JSON.stringify(regions);
    if (lastTopBarRegionsKey === key) return;
    lastTopBarRegionsKey = key;

    if (isModalActive) {
      invoke('log_frontend', {
        msg: `[syncAllTopBarRegions] Modal active - applied full input pass: ${key}`,
      }).catch(() => {});
    }

    invoke('update_custom_input_regions', { regions }).catch(() => {});
  } catch (err) {
    console.warn('[syncAllTopBarRegions] Error:', err);
  }
}
