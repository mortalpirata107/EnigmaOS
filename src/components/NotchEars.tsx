import React from 'react';

interface EndCapProps {
  className?: string;
}

/**
 * EndCap for the left side of a capsule hanging from top: 0 (y=0 to y=34).
 * Curves down smoothly from the top screen edge (y=0) to the bottom border (y=34).
 * Used on Left of RightCapsule. Seamless black, no borders.
 */
export const CapsuleLeftEndCap: React.FC<EndCapProps> = ({ className = '' }) => (
  <svg
    width={30}
    height={34}
    viewBox="0 0 30 34"
    fill="none"
    className={`shrink-0 pointer-events-none select-none ${className}`}
  >
    <path
      d="M 0,0 A 12,12 0 0,1 12,12 L 12,18 A 16,16 0 0,0 28,34 L 30,34 L 30,0 Z"
      fill="#0B0B0E"
    />
  </svg>
);

/**
 * EndCap for the right side of a capsule hanging from top: 0 (y=0 to y=34).
 * Curves up smoothly from the bottom border (y=34) to the top screen edge (y=0).
 * Used on Right of LeftCapsule. Seamless black, no borders.
 */
export const CapsuleRightEndCap: React.FC<EndCapProps> = ({ className = '' }) => (
  <svg
    width={30}
    height={34}
    viewBox="0 0 30 34"
    fill="none"
    className={`shrink-0 pointer-events-none select-none ${className}`}
  >
    <path
      d="M 0,0 L 0,34 L 2,34 A 16,16 0 0,0 18,18 L 18,12 A 12,12 0 0,1 30,0 Z"
      fill="#0B0B0E"
    />
  </svg>
);

/**
 * Top-Left Concave Ear for the Dynamic Notch.
 * Curves smoothly from the top screen bezel (y=0) into the left vertical edge (y=16).
 * Seamless black, no stroke or border.
 */
export const NotchTopLeftEar: React.FC<EndCapProps> = ({ className = '' }) => (
  <svg
    width={18}
    height={16}
    viewBox="0 0 18 16"
    fill="none"
    className={`overflow-visible pointer-events-none select-none ${className}`}
  >
    <path
      d="M 0,0 A 16,16 0 0,1 16,16 L 18,16 L 18,0 Z"
      fill="#0B0B0E"
    />
  </svg>
);

/**
 * Top-Right Concave Ear for the Dynamic Notch.
 * Curves smoothly from the right vertical edge (y=16) into the top screen bezel (y=0).
 * Seamless black, no stroke or border.
 */
export const NotchTopRightEar: React.FC<EndCapProps> = ({ className = '' }) => (
  <svg
    width={18}
    height={16}
    viewBox="0 0 18 16"
    fill="none"
    className={`overflow-visible pointer-events-none select-none ${className}`}
  >
    <path
      d="M 0,16 A 16,16 0 0,1 16,0 L -2,0 L -2,16 Z"
      fill="#0B0B0E"
    />
  </svg>
);
