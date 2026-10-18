import React, { useState, useEffect } from 'react';
import { motion } from 'framer-motion';

interface ClockCapsuleProps {
  innerRef?: React.Ref<HTMLDivElement>;
}

export const ClockCapsule: React.FC<ClockCapsuleProps> = ({ innerRef }) => {
  const [currentTime, setCurrentTime] = useState<Date>(new Date());

  useEffect(() => {
    const timer = setInterval(() => setCurrentTime(new Date()), 1000);
    return () => clearInterval(timer);
  }, []);

  const formattedTime = currentTime.toLocaleTimeString('es-ES', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });

  const formattedDate = currentTime.toLocaleDateString('es-ES', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
  });

  return (
    <motion.div
      ref={innerRef}
      whileHover={{ scale: 1.02 }}
      className="pointer-events-auto flex items-center gap-2 px-3.5 py-1.5 rounded-full bg-black border border-[#b82a2a]/50 shadow-[0_4px_16px_rgba(0,0,0,0.95)] text-white select-none transition-colors duration-300 hover:border-[#b82a2a]"
      title="Fecha y Hora del Sistema"
    >
      {/* Reloj Tabular HH:mm:ss */}
      <span className="font-mono-num font-bold text-xs text-white tracking-wider">
        {formattedTime}
      </span>

      {/* Punto Separador Rojo Carmesí */}
      <span className="text-[#b82a2a] font-bold text-sm leading-none">·</span>

      {/* Fecha en Español */}
      <span className="font-mono text-xs font-medium text-white/90 capitalize">
        {formattedDate}
      </span>
    </motion.div>
  );
};
