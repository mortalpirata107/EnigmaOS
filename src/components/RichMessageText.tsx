import React, { useState } from 'react';
import { Mail, Copy, Check, Code, Calendar, ChevronDown, ChevronUp } from 'lucide-react';
import { LiquidGlassImageCard } from './LiquidGlassImageCard';

interface RichMessageTextProps {
  content: string;
  isUser?: boolean;
}

interface EmailItem {
  remitente?: string;
  from?: string;
  de?: string;
  asunto?: string;
  subject?: string;
  fecha?: string;
  date?: string;
  contenido?: string;
  snippet?: string;
  cuerpo?: string;
  body?: string;
}

// Resalta sintácticamente cadenas JSON para que luzcan elegantes y modernas
export const SyntaxHighlightedJson: React.FC<{ jsonString: string }> = ({ jsonString }) => {
  const highlight = (json: string) => {
    // Normalizar formato si es necesario
    try {
      const parsed = JSON.parse(json);
      json = JSON.stringify(parsed, null, 2);
    } catch {
      // Usar tal cual si ya es un string
    }

    const lines = json.split('\n');
    return lines.map((line, idx) => {
      // Claves ("key":)
      let formattedLine = line.replace(
        /("(\\u[a-zA-Z0-9]{4}|\\[^u]|[^\\"])*")(\s*:)/g,
        '<span class="text-sky-300 font-medium">$1</span><span class="text-white/40">$3</span>'
      );
      // Valores string
      formattedLine = formattedLine.replace(
        /:\s*("(\\u[a-zA-Z0-9]{4}|\\[^u]|[^\\"])*")/g,
        ': <span class="text-emerald-300">$1</span>'
      );
      // Números
      formattedLine = formattedLine.replace(
        /:\s*(-?\d+\.?\d*([eE][+-]?\d+)?)/g,
        ': <span class="text-amber-400 font-mono">$1</span>'
      );
      // Booleans y null
      formattedLine = formattedLine.replace(
        /:\s*(true|false|null)/g,
        ': <span class="text-purple-400 font-semibold">$1</span>'
      );

      return (
        <div key={idx} dangerouslySetInnerHTML={{ __html: formattedLine || '&nbsp;' }} />
      );
    });
  };

  return (
    <pre className="text-[12px] font-mono leading-relaxed overflow-x-auto p-3 bg-black/80 rounded-xl border border-white/10 text-white/90 selection:bg-[#b82a2a]/40">
      {highlight(jsonString)}
    </pre>
  );
};

// Helper para separar nombre y dirección de correo
const parseSenderInfo = (raw: string) => {
  const trimmed = raw.trim();
  const match = trimmed.match(/^(.*?)\s*[\(<]([^>)]+)[\)>]$/);
  if (match) {
    const name = match[1].trim() || match[2].trim();
    const email = match[2].trim();
    return { name, email };
  }
  return { name: trimmed || 'Remitente desconocido', email: '' };
};

// Helper para fecha corta
const parseShortDate = (rawDate: string) => {
  if (!rawDate) return '';
  const match = rawDate.match(/\b(\d{1,2}\s+[A-Za-z]{3}(?:\s+\d{2,4})?)/);
  if (match) return match[1];
  const dateNum = rawDate.match(/\b(\d{1,2}[\/\-]\d{1,2}(?:[\/\-]\d{2,4})?)/);
  if (dateNum) return dateNum[1];
  return rawDate.slice(0, 12);
};

// Tarjeta elegante y compacta para correos electrónicos (Click para expandir)
const EmailJsonCard: React.FC<{ data: EmailItem; rawJson: string }> = ({ data, rawJson }) => {
  const [isExpanded, setIsExpanded] = useState(false);
  const [showRawJson, setShowRawJson] = useState(false);
  const [copied, setCopied] = useState(false);

  const rawSender = data.remitente || data.from || data.de || 'Remitente desconocido';
  const { name: senderName, email: senderEmail } = parseSenderInfo(rawSender);
  const subject = data.asunto || data.subject || '(Sin asunto)';
  const date = data.fecha || data.date || '';
  const shortDate = parseShortDate(date);
  const snippet = data.contenido || data.snippet || data.cuerpo || data.body || '';

  const handleCopy = (e: React.MouseEvent) => {
    e.stopPropagation();
    navigator.clipboard.writeText(rawJson);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div
      onClick={() => setIsExpanded(!isExpanded)}
      className={`w-full my-1.5 rounded-xl border transition-all duration-200 cursor-pointer select-none backdrop-blur-md ${
        isExpanded
          ? 'bg-black border-[#b82a2a] shadow-[0_0_15px_rgba(184,42,42,0.25)] p-3.5'
          : 'bg-black hover:border-[#b82a2a]/40 border-white/10 p-2.5 shadow-sm'
      }`}
    >
      {/* Fila principal compacta */}
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2.5 min-w-0 flex-1">
          <div
            className={`w-7 h-7 rounded-lg flex items-center justify-center shrink-0 transition-colors ${
              isExpanded
                ? 'bg-black border border-[#b82a2a] text-[#b82a2a]'
                : 'bg-black border border-white/10 text-[#b82a2a]'
            }`}
          >
            <Mail className="w-3.5 h-3.5" />
          </div>

          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1.5 min-w-0">
              <span className="text-[12px] font-semibold text-white truncate">{senderName}</span>
              {senderEmail && (
                <span className="text-[10px] text-white/40 font-mono truncate hidden sm:inline">
                  {senderEmail}
                </span>
              )}
            </div>
            <div className="text-[11px] text-white/70 truncate font-light mt-0.5">
              {subject}
            </div>
          </div>
        </div>

        {/* Fecha y Chevron */}
        <div className="flex items-center gap-2 shrink-0">
          {shortDate && (
            <span className="text-[10px] text-white/40 font-mono bg-white/[0.03] px-2 py-0.5 rounded border border-white/5">
              {shortDate}
            </span>
          )}
          <div className="w-5 h-5 rounded flex items-center justify-center text-white/40 hover:text-white transition-colors">
            {isExpanded ? (
              <ChevronUp className="w-3.5 h-3.5 text-[#b82a2a]" />
            ) : (
              <ChevronDown className="w-3.5 h-3.5" />
            )}
          </div>
        </div>
      </div>

      {/* Detalles expandidos (solo visibles tras hacer clic) */}
      {isExpanded && (
        <div
          onClick={(e) => e.stopPropagation()}
          className="mt-3 pt-3 border-t border-white/5 select-text cursor-default animate-in fade-in duration-150"
        >
          {/* Asunto y Fecha completa */}
          <div className="flex items-start justify-between gap-2 mb-2">
            <div className="text-[13px] font-semibold text-white leading-snug">
              {subject}
            </div>
            {date && (
              <div className="flex items-center gap-1 text-[10px] text-white/40 font-mono shrink-0 bg-white/[0.04] px-2 py-0.5 rounded border border-white/5">
                <Calendar className="w-3 h-3 text-white/30" />
                <span>{date}</span>
              </div>
            )}
          </div>

          {/* Snippet / Contenido */}
          {snippet && (
            <div className="bg-black border border-white/10 rounded-xl p-3 text-xs text-white/80 leading-relaxed font-sans mt-2">
              <span className="text-[#b82a2a] mr-1 font-serif text-sm">“</span>
              {snippet}
              <span className="text-[#b82a2a] ml-1 font-serif text-sm">”</span>
            </div>
          )}

          {/* Barra de herramientas inferior */}
          <div className="flex items-center justify-between mt-3 pt-2 border-t border-white/5 text-[11px]">
            <button
              type="button"
              onClick={() => setShowRawJson(!showRawJson)}
              className="flex items-center gap-1.5 text-white/50 hover:text-white font-mono cursor-pointer transition-colors px-2 py-1 rounded hover:bg-white/5"
            >
              <Code className="w-3.5 h-3.5 text-[#b82a2a]" />
              <span>{showRawJson ? 'Ocultar JSON' : 'Ver JSON'}</span>
              {showRawJson ? (
                <ChevronUp className="w-3 h-3 ml-0.5" />
              ) : (
                <ChevronDown className="w-3 h-3 ml-0.5" />
              )}
            </button>

            <button
              type="button"
              onClick={handleCopy}
              className="flex items-center gap-1.5 text-white/50 hover:text-white font-mono cursor-pointer transition-colors px-2 py-1 rounded hover:bg-white/5"
            >
              {copied ? (
                <>
                  <Check className="w-3.5 h-3.5 text-[#EF4444]" />
                  <span className="text-[#EF4444]">Copiado</span>
                </>
              ) : (
                <>
                  <Copy className="w-3.5 h-3.5" />
                  <span>Copiar JSON</span>
                </>
              )}
            </button>
          </div>

          {/* Bloque JSON expandible */}
          {showRawJson && (
            <div className="mt-2.5">
              <SyntaxHighlightedJson jsonString={rawJson} />
            </div>
          )}
        </div>
      )}
    </div>
  );
};

// Tarjeta genérica para cualquier bloque JSON (Compacta con toggle)
const GenericJsonCard: React.FC<{ rawJson: string }> = ({ rawJson }) => {
  const [isExpanded, setIsExpanded] = useState(false);
  const [copied, setCopied] = useState(false);

  const handleCopy = (e: React.MouseEvent) => {
    e.stopPropagation();
    navigator.clipboard.writeText(rawJson);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  let summary = 'Datos JSON';
  try {
    const parsed = JSON.parse(rawJson);
    if (Array.isArray(parsed)) {
      summary = `Array JSON (${parsed.length} items)`;
    } else if (typeof parsed === 'object' && parsed !== null) {
      const keys = Object.keys(parsed);
      summary = `Objeto JSON (${keys.slice(0, 3).join(', ')}${keys.length > 3 ? '...' : ''})`;
    }
  } catch {}

  return (
    <div
      onClick={() => setIsExpanded(!isExpanded)}
      className="w-full my-1.5 rounded-xl bg-black/40 border border-white/10 hover:border-white/20 p-2.5 shadow-sm backdrop-blur-md transition-all cursor-pointer select-none group"
    >
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 min-w-0">
          <div className="w-6 h-6 rounded-lg bg-amber-500/10 border border-amber-500/20 flex items-center justify-center text-amber-400 shrink-0">
            <Code className="w-3 h-3" />
          </div>
          <span className="text-xs font-mono font-medium text-white/80 truncate">
            {summary}
          </span>
        </div>

        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={handleCopy}
            className="flex items-center gap-1 text-[10px] text-white/50 hover:text-white font-mono cursor-pointer transition-colors px-2 py-0.5 rounded hover:bg-white/5"
          >
            {copied ? (
              <>
                <Check className="w-3 h-3 text-[#EF4444]" />
                <span className="text-[#EF4444]">Copiado</span>
              </>
            ) : (
              <>
                <Copy className="w-3.5 h-3.5" />
                <span>Copiar</span>
              </>
            )}
          </button>
          <div className="text-white/40 group-hover:text-white transition-colors">
            {isExpanded ? (
              <ChevronUp className="w-3.5 h-3.5 text-amber-400" />
            ) : (
              <ChevronDown className="w-3.5 h-3.5" />
            )}
          </div>
        </div>
      </div>

      {isExpanded && (
        <div
          onClick={(e) => e.stopPropagation()}
          className="mt-2.5 pt-2 border-t border-white/5 select-text cursor-default"
        >
          <SyntaxHighlightedJson jsonString={rawJson} />
        </div>
      )}
    </div>
  );
};

/**
 * Limpia asteriscos huérfanos ('**') provocados por interrupciones de stream o tokens truncados.
 */
export const cleanOrphanMarkdownAsterisks = (raw: string): string => {
  if (!raw) return '';
  // Si la línea o texto termina en '**' suelto sin contenido
  let cleaned = raw.replace(/\*\*\s*$/, '');
  // Contar cuántas ocurrencias de '**' existen en el texto
  const matches = cleaned.match(/\*\*/g);
  if (matches && matches.length % 2 !== 0) {
    // Si el número de '**' es impar, eliminamos el último marcador abierto incompleto
    const lastIdx = cleaned.lastIndexOf('**');
    cleaned = cleaned.substring(0, lastIdx) + cleaned.substring(lastIdx + 2);
  }
  return cleaned;
};

// Renderizador recursivo para negritas (**...** o __...__), cursiva (*...*), y código inline (`...`)
export const renderInlineMarkdown = (text: string): React.ReactNode => {
  if (!text) return null;
  const sanitized = cleanOrphanMarkdownAsterisks(text);

  // Segmentar por código inline `...`
  const codeParts = sanitized.split(/(`[^`]+`)/g);

  return codeParts.map((part, pIdx) => {
    if (part.startsWith('`') && part.endsWith('`') && part.length >= 2) {
      return (
        <code
          key={pIdx}
          className="px-1.5 py-0.5 rounded bg-white/10 text-[#b82a2a] font-mono text-[12px] border border-white/10 mx-0.5"
        >
          {part.slice(1, -1)}
        </code>
      );
    }

    // Segmentar por negritas (**...** o __...__)
    const boldParts = part.split(/(\*\*[\s\S]+?\*\*|__[\s\S]+?__)/g);

    return boldParts.map((bPart, bIdx) => {
      const isAsteriskBold = bPart.startsWith('**') && bPart.endsWith('**') && bPart.length >= 4;
      const isUnderlineBold = bPart.startsWith('__') && bPart.endsWith('__') && bPart.length >= 4;

      if (isAsteriskBold || isUnderlineBold) {
        return (
          <strong key={`${pIdx}-${bIdx}`} className="font-bold text-white tracking-wide">
            {renderInlineMarkdown(bPart.slice(2, -2))}
          </strong>
        );
      }

      // Segmentar por cursiva *...*
      const italicParts = bPart.split(/(\*[^*]+\*)/g);

      return italicParts.map((iPart, iIdx) => {
        if (iPart.startsWith('*') && iPart.endsWith('*') && iPart.length >= 2) {
          return (
            <em key={`${pIdx}-${bIdx}-${iIdx}`} className="italic text-white/90">
              {iPart.slice(1, -1)}
            </em>
          );
        }

        return <React.Fragment key={`${pIdx}-${bIdx}-${iIdx}`}>{iPart}</React.Fragment>;
      });
    });
  });
};

/**
 * Componente principal que analiza texto enriquecido:
 * - Detecta y renderiza negritas, cursivas y citas (>)
 * - Detecta bloques de código ```json ... ``` y JSONs de correos
 * - Convierte correos JSON en tarjetas visuales de última generación
 */
export const RichMessageText: React.FC<RichMessageTextProps> = ({ content, isUser = false }) => {
  if (!content) return null;
  const cleanContent = cleanOrphanMarkdownAsterisks(content);

  // 1. Extraer bloques de código con ```
  const initialSegments: Array<{ type: 'text' | 'code' | 'json'; content: string; language?: string }> = [];
  const codeRegex = /```([a-zA-Z0-9_-]*)\s*([\s\S]*?)```/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = codeRegex.exec(cleanContent)) !== null) {
    if (match.index > lastIndex) {
      initialSegments.push({
        type: 'text',
        content: cleanContent.substring(lastIndex, match.index),
      });
    }

    const language = (match[1] || '').trim().toLowerCase();
    const code = (match[2] || '').trim();

    if (language === 'json' || (code.startsWith('{') && code.endsWith('}')) || (code.startsWith('[') && code.endsWith(']'))) {
      initialSegments.push({
        type: 'json',
        content: code,
        language: 'json',
      });
    } else {
      initialSegments.push({
        type: 'code',
        content: code,
        language,
      });
    }

    lastIndex = match.index + match[0].length;
  }

  if (lastIndex < cleanContent.length) {
    initialSegments.push({
      type: 'text',
      content: cleanContent.substring(lastIndex),
    });
  }

  // 2. Extraer bloques JSON directos {...} o [...] que pudieran no venir entre triple comillas ```
  const segments: Array<{ type: 'text' | 'code' | 'json'; content: string; language?: string }> = [];

  for (const seg of initialSegments) {
    if (seg.type !== 'text') {
      segments.push(seg);
      continue;
    }

    const raw = seg.content;
    let searchIdx = 0;
    let textStart = 0;

    while (searchIdx < raw.length) {
      const openBrace = raw.indexOf('{', searchIdx);
      const openBracket = raw.indexOf('[', searchIdx);
      let startPos = -1;
      let openChar = '{';
      let closeChar = '}';

      if (openBrace !== -1 && (openBracket === -1 || openBrace < openBracket)) {
        startPos = openBrace;
        openChar = '{';
        closeChar = '}';
      } else if (openBracket !== -1) {
        startPos = openBracket;
        openChar = '[';
        closeChar = ']';
      }

      if (startPos === -1) {
        break;
      }

      // Encontrar cierre balanceado
      let depth = 0;
      let inString = false;
      let escape = false;
      let endPos = -1;

      for (let i = startPos; i < raw.length; i++) {
        const c = raw[i];
        if (escape) {
          escape = false;
          continue;
        }
        if (c === '\\') {
          escape = true;
          continue;
        }
        if (c === '"') {
          inString = !inString;
          continue;
        }
        if (!inString) {
          if (c === openChar) depth++;
          else if (c === closeChar) {
            depth--;
            if (depth === 0) {
              endPos = i;
              break;
            }
          }
        }
      }

      if (endPos !== -1) {
        const candidate = raw.substring(startPos, endPos + 1).trim();
        try {
          const parsed = JSON.parse(candidate);
          if (parsed && typeof parsed === 'object') {
            if (startPos > textStart) {
              segments.push({
                type: 'text',
                content: raw.substring(textStart, startPos),
              });
            }
            segments.push({
              type: 'json',
              content: candidate,
              language: 'json',
            });
            textStart = endPos + 1;
            searchIdx = endPos + 1;
            continue;
          }
        } catch {
          // No es JSON válido, continuar buscando
        }
      }

      searchIdx = startPos + 1;
    }

    if (textStart < raw.length) {
      segments.push({
        type: 'text',
        content: raw.substring(textStart),
      });
    }
  }

  return (
    <div className={`space-y-1.5 ${isUser ? 'text-right' : 'text-left'}`}>
      {segments.map((segment, sIdx) => {
        if (segment.type === 'json') {
          try {
            const parsed = JSON.parse(segment.content);

            // Si es un array de correos
            if (Array.isArray(parsed)) {
              const isEmailArray = parsed.some(
                (item) => item && typeof item === 'object' && (item.remitente || item.from || item.asunto || item.subject)
              );
              if (isEmailArray) {
                return (
                  <div key={sIdx} className="space-y-2 my-2">
                    {parsed.map((emailItem, eIdx) => (
                      <EmailJsonCard
                        key={eIdx}
                        data={emailItem}
                        rawJson={JSON.stringify(emailItem, null, 2)}
                      />
                    ))}
                  </div>
                );
              }
            }

            // Si es un objeto de correo individual
            if (parsed && typeof parsed === 'object') {
              if (parsed.remitente || parsed.from || parsed.asunto || parsed.subject || parsed.contenido || parsed.snippet) {
                return (
                  <EmailJsonCard
                    key={sIdx}
                    data={parsed}
                    rawJson={JSON.stringify(parsed, null, 2)}
                  />
                );
              }
            }

            // Es un JSON genérico
            return <GenericJsonCard key={sIdx} rawJson={segment.content} />;
          } catch {
            // Si falló el parseo, mostrar como tarjeta genérica con el string original
            return <GenericJsonCard key={sIdx} rawJson={segment.content} />;
          }
        }

        if (segment.type === 'code') {
          return (
            <pre
              key={sIdx}
              className="text-[12px] font-mono leading-relaxed overflow-x-auto p-3 bg-black/50 rounded-xl border border-white/10 text-white/90 my-2"
            >
              <code>{segment.content}</code>
            </pre>
          );
        }

        // Segmento de texto normal con soporte para líneas, citas (>) y negritas
        const lines = segment.content.split('\n');

        return (
          <React.Fragment key={sIdx}>
            {lines.map((line, lIdx) => {
              const trimmed = line.trim();

              // 1. Detectar imagen en formato Markdown !\[(.*?)\]\((.*?)\) standalone
              const standaloneImgMatch = trimmed.match(/^!\[([^\]]*)\]\(([^)]+)\)$/);
              if (standaloneImgMatch) {
                return (
                  <LiquidGlassImageCard
                    key={lIdx}
                    altText={standaloneImgMatch[1] || 'Imagen generada'}
                    imagePath={standaloneImgMatch[2]}
                  />
                );
              }

              // 2. Si es una línea de cita tipo `> ...`
              if (trimmed.startsWith('>')) {
                const quoteText = trimmed.replace(/^>\s?/, '');
                const quoteImgMatch = quoteText.match(/!\[([^\]]*)\]\(([^)]+)\)/);
                if (quoteImgMatch) {
                  return (
                    <LiquidGlassImageCard
                      key={lIdx}
                      altText={quoteImgMatch[1] || 'Imagen generada'}
                      imagePath={quoteImgMatch[2]}
                    />
                  );
                }
                return (
                  <div
                    key={lIdx}
                    className="my-1.5 pl-3 py-1 border-l-2 border-[#b82a2a] bg-black/60 rounded-r-lg text-white/90 text-sm leading-relaxed"
                  >
                    {renderInlineMarkdown(quoteText)}
                  </div>
                );
              }

              // 3. Detectar imagen incrustada dentro de una línea con texto
              const inlineImgMatch = trimmed.match(/!\[([^\]]*)\]\(([^)]+)\)/);
              if (inlineImgMatch) {
                const alt = inlineImgMatch[1];
                const src = inlineImgMatch[2];
                const textBefore = trimmed.substring(0, inlineImgMatch.index).trim();
                const textAfter = trimmed.substring(inlineImgMatch.index! + inlineImgMatch[0].length).trim();
                return (
                  <div key={lIdx} className="space-y-1.5 my-1.5">
                    {textBefore && (
                      <div className="leading-relaxed">
                        {renderInlineMarkdown(textBefore)}
                      </div>
                    )}
                    <LiquidGlassImageCard
                      altText={alt || 'Imagen generada'}
                      imagePath={src}
                    />
                    {textAfter && (
                      <div className="leading-relaxed text-xs text-white/50">
                        {renderInlineMarkdown(textAfter)}
                      </div>
                    )}
                  </div>
                );
              }

              // 4. Detectar línea con ruta directa de imagen generada (ej: `Ruta: /tmp/...png`)
              const rawPathMatch = trimmed.match(/^(?:`?Ruta:\s*`?)?(\/(?:tmp|home)[^\s`]+\.(?:png|jpg|jpeg|webp))(?:\s*`?)?$/i);
              if (rawPathMatch && (trimmed.includes('enigma_sd_') || trimmed.includes('enigma_creative'))) {
                return (
                  <LiquidGlassImageCard
                    key={lIdx}
                    altText="Imagen generada por Stable Diffusion"
                    imagePath={rawPathMatch[1]}
                  />
                );
              }

              // Línea normal vacía
              if (!trimmed) {
                return <div key={lIdx} className="h-1.5" />;
              }

              // Línea normal con texto
              return (
                <div key={lIdx} className="leading-relaxed">
                  {renderInlineMarkdown(line)}
                </div>
              );
            })}
          </React.Fragment>
        );
      })}
    </div>
  );
};

export default RichMessageText;
