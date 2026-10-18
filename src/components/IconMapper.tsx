import React from 'react';
import { convertFileSrc } from '@tauri-apps/api/core';
import { 
  SiSpotify, 
  SiDiscord, 
  SiOpera, 
  SiFirefox, 
  SiGooglechrome, 
  SiBrave, 
  SiSteam, 
  SiObsidian, 
  SiTelegram, 
  SiKde 
} from 'react-icons/si';
import { 
  VscVscode, 
  VscTerminalBash, 
  VscFolder 
} from 'react-icons/vsc';

export interface AppBrandInfo {
  icon: React.ComponentType<{ className?: string; style?: React.CSSProperties }>;
  brandColor: string;
  shadowColor: string;
}

const BRAND_REGISTRY: Record<string, AppBrandInfo> = {
  spotify: {
    icon: SiSpotify,
    brandColor: '#1ED760',
    shadowColor: 'rgba(30, 215, 96, 0.45)',
  },
  discord: {
    icon: SiDiscord,
    brandColor: '#5865F2',
    shadowColor: 'rgba(88, 101, 242, 0.5)',
  },
  opera: {
    icon: SiOpera,
    brandColor: '#FF1B2D',
    shadowColor: 'rgba(255, 27, 45, 0.5)',
  },
  operagx: {
    icon: SiOpera,
    brandColor: '#FA1E4E',
    shadowColor: 'rgba(250, 30, 78, 0.5)',
  },
  'antigravity-ide': {
    icon: VscVscode,
    brandColor: '#007ACC',
    shadowColor: 'rgba(0, 122, 204, 0.5)',
  },
  antigravity: {
    icon: VscVscode,
    brandColor: '#007ACC',
    shadowColor: 'rgba(0, 122, 204, 0.5)',
  },
  vscode: {
    icon: VscVscode,
    brandColor: '#007ACC',
    shadowColor: 'rgba(0, 122, 204, 0.5)',
  },
  code: {
    icon: VscVscode,
    brandColor: '#007ACC',
    shadowColor: 'rgba(0, 122, 204, 0.5)',
  },
  ide: {
    icon: VscVscode,
    brandColor: '#007ACC',
    shadowColor: 'rgba(0, 122, 204, 0.5)',
  },
  terminal: {
    icon: VscTerminalBash,
    brandColor: '#10B981',
    shadowColor: 'rgba(16, 185, 129, 0.5)',
  },
  kitty: {
    icon: VscTerminalBash,
    brandColor: '#10B981',
    shadowColor: 'rgba(16, 185, 129, 0.5)',
  },
  konsole: {
    icon: VscTerminalBash,
    brandColor: '#10B981',
    shadowColor: 'rgba(16, 185, 129, 0.5)',
  },
  bash: {
    icon: VscTerminalBash,
    brandColor: '#10B981',
    shadowColor: 'rgba(16, 185, 129, 0.5)',
  },
  dolphin: {
    icon: VscFolder,
    brandColor: '#3B82F6',
    shadowColor: 'rgba(59, 130, 246, 0.5)',
  },
  files: {
    icon: VscFolder,
    brandColor: '#3B82F6',
    shadowColor: 'rgba(59, 130, 246, 0.5)',
  },
  archivos: {
    icon: VscFolder,
    brandColor: '#3B82F6',
    shadowColor: 'rgba(59, 130, 246, 0.5)',
  },
  firefox: {
    icon: SiFirefox,
    brandColor: '#FF7139',
    shadowColor: 'rgba(255, 113, 57, 0.55)',
  },
  'google-chrome': {
    icon: SiGooglechrome,
    brandColor: '#4285F4',
    shadowColor: 'rgba(66, 133, 244, 0.55)',
  },
  chrome: {
    icon: SiGooglechrome,
    brandColor: '#4285F4',
    shadowColor: 'rgba(66, 133, 244, 0.55)',
  },
  brave: {
    icon: SiBrave,
    brandColor: '#FB542B',
    shadowColor: 'rgba(251, 84, 43, 0.55)',
  },
  steam: {
    icon: SiSteam,
    brandColor: '#1A9FFF',
    shadowColor: 'rgba(26, 159, 255, 0.55)',
  },
  telegram: {
    icon: SiTelegram,
    brandColor: '#24A1DE',
    shadowColor: 'rgba(36, 161, 222, 0.55)',
  },
  obsidian: {
    icon: SiObsidian,
    brandColor: '#A78BFA',
    shadowColor: 'rgba(167, 139, 250, 0.55)',
  },
  systemsettings: {
    icon: SiKde,
    brandColor: '#00C3FF',
    shadowColor: 'rgba(0, 195, 255, 0.5)',
  },
  settings: {
    icon: SiKde,
    brandColor: '#00C3FF',
    shadowColor: 'rgba(0, 195, 255, 0.5)',
  },
  preferencias: {
    icon: SiKde,
    brandColor: '#00C3FF',
    shadowColor: 'rgba(0, 195, 255, 0.5)',
  },
};

export function getAppBrand(windowClass?: string, appName?: string, title?: string): AppBrandInfo | null {
  const candidates = [
    windowClass?.toLowerCase() || '',
    appName?.toLowerCase() || '',
    title?.toLowerCase() || '',
  ];

  for (const query of candidates) {
    if (!query) continue;

    for (const [key, brand] of Object.entries(BRAND_REGISTRY)) {
      if (query.includes(key) || key.includes(query)) {
        return brand;
      }
    }
  }

  return null;
}


export interface AppIconProps {
  iconPath?: string;
  windowClass?: string;
  appName?: string;
  title?: string;
  className?: string;
}

/**
 * Authentic Icon Component:
 * - If an icon path or data URL is provided, renders the real desktop icon using convertFileSrc.
 * - Otherwise matches registered brand SVGs.
 * - For unmapped apps without paths, renders a sleek neomorphic glass tile with the initial letter.
 */
export const AppIcon: React.FC<AppIconProps> = ({
  iconPath,
  windowClass,
  appName,
  title,
  className = 'w-full h-full',
}) => {
  const [imgError, setImgError] = React.useState(false);
  const rawPath = iconPath || (windowClass?.startsWith('/') ? windowClass : (appName?.startsWith('/') ? appName : ''));
  const isAbsPath = !!rawPath && rawPath.startsWith('/');
  const isUrl = !!rawPath && /^(https?:|data:|asset:)/.test(rawPath);

  if (!imgError && (isAbsPath || isUrl)) {
    return (
      <div className="w-full h-full flex items-center justify-center p-0.5">
        <img
          src={isAbsPath ? convertFileSrc(rawPath) : rawPath}
          alt={appName || title || 'App'}
          draggable={false}
          decoding="async"
          className={`${className} object-contain select-none drop-shadow-[0_3px_8px_rgba(0,0,0,0.7)]`}
          onError={() => setImgError(true)}
        />
      </div>
    );
  }

  const brand = getAppBrand(windowClass, appName, title);

  if (brand) {
    const IconComponent = brand.icon;
    return (
      <div className="w-full h-full flex items-center justify-center p-1">
        <IconComponent
          className={className}
          style={{
            color: brand.brandColor,
            filter: `drop-shadow(0 4px 10px ${brand.shadowColor}) drop-shadow(0 2px 4px rgba(0,0,0,0.8))`,
          }}
        />
      </div>
    );
  }

  // Neomorphic Fallback Tile with Initial Letter for Unmapped Applications (Cubo/Terminal en Rojo y Blanco)
  const displayName = title || appName || windowClass || 'App';
  const initial = displayName.trim().slice(0, 2).toUpperCase() || 'AP';

  return (
    <div className="w-full h-full rounded-xl bg-[#070709] border border-red-950/40 shadow-[inset_2px_2px_4px_#020203,inset_-1px_-1px_3px_#14141B] flex flex-col items-center justify-center p-1 select-none">
      <span className="text-[9px] font-mono font-bold text-[#EF4444] uppercase tracking-tighter leading-none mb-0.5">
        {initial}
      </span>
      <svg className="w-3.5 h-3.5 text-white/80" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8} d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4" />
      </svg>
    </div>
  );
};
