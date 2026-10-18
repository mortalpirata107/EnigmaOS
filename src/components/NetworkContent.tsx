import React from 'react';
import { 
  Wifi, 
  Activity, 
  Network, 
  Lock, 
  CheckCircle2, 
  Globe
} from 'lucide-react';
import { useDetailedNetwork } from '../hooks/useDetailedNetwork';

export const NetworkContent: React.FC = () => {
  const { network, isLoading, connectWifi, disconnectCurrent } = useDetailedNetwork();

  const isEthernet = network.conn_type === 'ethernet';
  const isWifi = network.conn_type === 'wifi';
  const isDisconnected = network.conn_type === 'none' || network.state === 'disconnected';

  return (
    <div 
      className="w-full h-full flex flex-col p-3.5 text-white select-none overflow-hidden"
      onClick={(e) => e.stopPropagation()}
    >
      {/* Header con botón de cerrar */}
      <div className="flex items-center justify-between pb-2 mb-2 border-b border-[#b82a2a]/20 shrink-0">
        <div className="flex items-center gap-2">
          <div className="w-6 h-6 rounded-lg bg-[#08080C] border border-[#b82a2a]/50 flex items-center justify-center text-[#b82a2a]">
            {isEthernet ? <Network className="w-3.5 h-3.5 text-[#b82a2a]" /> : <Wifi className="w-3.5 h-3.5 text-[#b82a2a]" />}
          </div>
          <span className="text-xs font-bold font-mono tracking-wider text-white uppercase">
            Estado de Red
          </span>
        </div>
      </div>

      {/* =========================================================================
          LOS 2 WIDGETS PRINCIPALES OBLIGATORIOS:
          Widget 1: Velocidad de la red
          Widget 2: Tipo de conexión
          ========================================================================= */}
      <div className="grid grid-cols-2 gap-2.5 mb-3 shrink-0">
        {/* WIDGET 1: VELOCIDAD */}
        <div className="p-3 rounded-xl bg-[#08080C] border border-[#b82a2a]/30 flex flex-col justify-between shadow-[0_0_10px_rgba(184,42,42,0.15)]">
          <div className="flex items-center justify-between text-[#b82a2a] mb-1">
            <span className="text-[10px] font-mono font-bold uppercase tracking-wider text-white/50">
              Velocidad
            </span>
            <Activity className="w-3.5 h-3.5 animate-pulse text-[#b82a2a]" />
          </div>
          <div>
            <span className="text-lg font-bold font-mono text-white tracking-wide block">
              {isDisconnected ? '0 Mbps' : network.speed_label}
            </span>
            <span className="text-[10px] font-mono text-[#b82a2a] block">
              {isDisconnected ? 'Sin tráfico' : 'Enlace activo'}
            </span>
          </div>
        </div>

        {/* WIDGET 2: TIPO DE CONEXIÓN */}
        <div className="p-3 rounded-xl bg-[#08080C] border border-[#b82a2a]/30 flex flex-col justify-between shadow-[0_0_10px_rgba(184,42,42,0.15)]">
          <div className="flex items-center justify-between text-[#b82a2a] mb-1">
            <span className="text-[10px] font-mono font-bold uppercase tracking-wider text-white/50">
              Conexión
            </span>
            {isEthernet ? (
              <Network className="w-3.5 h-3.5 text-[#b82a2a]" />
            ) : isWifi ? (
              <Wifi className="w-3.5 h-3.5 text-[#b82a2a]" />
            ) : (
              <Globe className="w-3.5 h-3.5 text-[#b82a2a]/50" />
            )}
          </div>
          <div>
            <span className="text-xs font-bold text-white block truncate">
              {isDisconnected ? 'Sin Conexión' : isEthernet ? 'Cableada' : 'Wi-Fi 6'}
            </span>
            <span className="text-[10px] font-mono text-white/60 block truncate">
              {network.name || (isDisconnected ? 'Desconectado' : 'Conectado')}
            </span>
          </div>
        </div>
      </div>

      {/* CASO 1: CONEXIÓN POR CABLE (ETHERNET) */}
      {isEthernet && (
        <div className="p-3 rounded-xl bg-[#08080C] border border-white/10 text-xs font-mono space-y-1.5">
          <div className="flex items-center justify-between">
            <span className="text-white/50">Interfaz:</span>
            <span className="text-white font-bold">{network.device}</span>
          </div>
          {network.ip_address && (
            <div className="flex items-center justify-between">
              <span className="text-white/50">Dirección IP:</span>
              <span className="text-white font-bold">{network.ip_address}</span>
            </div>
          )}
          <div className="flex items-center justify-between pt-1 border-t border-white/10">
            <span className="text-white/50">Estado:</span>
            <span className="text-[#b82a2a] font-bold flex items-center gap-1">
              <span className="w-1.5 h-1.5 rounded-full bg-[#b82a2a] animate-ping" />
              Transmisión Gigabit
            </span>
          </div>
        </div>
      )}

      {/* CASO 2: CONEXIÓN WI-FI */}
      {isWifi && (
        <div className="flex-1 overflow-y-auto space-y-3 pr-1 custom-scrollbar min-h-0">
          <div>
            <span className="text-[11px] font-mono font-bold text-[#b82a2a] uppercase tracking-wider flex items-center gap-1.5 mb-1.5 px-1">
              <CheckCircle2 className="w-3 h-3 text-[#b82a2a]" />
              Red Conectada
            </span>
            <div className="flex items-center justify-between px-3 py-2 rounded-xl bg-[#08080C] border border-[#b82a2a]/40 shadow-[0_0_10px_rgba(184,42,42,0.15)]">
              <div className="min-w-0 pr-2">
                <span className="text-xs font-bold text-white block truncate">{network.name}</span>
                <span className="text-[10px] font-mono text-white/50 block">IP: {network.ip_address || '192.168.1.x'}</span>
              </div>
              <button
                type="button"
                onClick={disconnectCurrent}
                disabled={isLoading}
                className="px-2.5 py-1 rounded-lg bg-[#08080C] border border-[#b82a2a]/40 text-[10px] font-mono font-bold text-[#b82a2a] hover:bg-[#b82a2a]/20 hover:text-white transition-all cursor-pointer shrink-0"
              >
                Desconectar
              </button>
            </div>
          </div>

          <div>
            <span className="text-[11px] font-mono font-bold text-white/70 uppercase tracking-wider block mb-1.5 px-1">
              Redes Disponibles ({network.wifi_networks.length})
            </span>
            <div className="space-y-1.5">
              {network.wifi_networks.length === 0 ? (
                <div className="px-3 py-2 rounded-xl bg-[#08080C] border border-white/10 text-[11px] text-white/40 font-mono">
                  Buscando redes Wi-Fi...
                </div>
              ) : (
                network.wifi_networks
                  .filter((w) => !w.in_use)
                  .map((item) => (
                    <div
                      key={item.ssid}
                      className="flex items-center justify-between px-3 py-2 rounded-xl bg-[#08080C] border border-white/10 hover:border-[#b82a2a]/30 transition-colors"
                    >
                      <div className="min-w-0 pr-2">
                        <span className="text-xs font-medium text-white block truncate">{item.ssid}</span>
                        <div className="flex items-center gap-2 text-[10px] font-mono text-white/40">
                          <span>Señal: {item.signal}%</span>
                          {item.security && (
                            <span className="flex items-center gap-0.5 text-white/50">
                              <Lock className="w-2.5 h-2.5 text-[#b82a2a]" />
                              {item.security.includes('WPA') ? 'WPA2/3' : item.security}
                            </span>
                          )}
                        </div>
                      </div>
                      <button
                        type="button"
                        onClick={() => connectWifi(item.ssid)}
                        disabled={isLoading}
                        className="px-2.5 py-1 rounded-lg bg-[#08080C] border border-[#b82a2a]/50 text-[10px] font-mono font-bold text-white hover:bg-[#b82a2a]/30 transition-all cursor-pointer shrink-0"
                      >
                        Conectar
                      </button>
                    </div>
                  ))
              )}
            </div>
          </div>
        </div>
      )}

      {/* CASO 3: SIN INTERNET */}
      {isDisconnected && (
        <div className="text-center py-4">
          <Globe className="w-8 h-8 text-[#b82a2a]/40 mx-auto mb-2" />
          <p className="text-xs text-white/60 font-mono">No hay conexión de red activa</p>
          <p className="text-[11px] text-white/40 mt-1">Conecta un cable Ethernet o activa el Wi-Fi</p>
        </div>
      )}

      {/* Margen inferior mínimo 5px */}
      <div className="h-1 shrink-0" />
    </div>
  );
};
