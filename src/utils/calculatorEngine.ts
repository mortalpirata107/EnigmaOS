/**
 * Ultra-fast, zero-dependency Math & Unit/Currency Converter Engine
 * Formats results instantenously for Spotlight / Raycast style search.
 */

export interface CalculatorResult {
  expression: string;
  result: string;
  numericValue: number;
  category: 'math' | 'currency' | 'unit';
  detail: string;
}

// Exchange rates reference base: 1 USD (Updated reference table)
const EXCHANGE_RATES_TO_USD: Record<string, number> = {
  USD: 1.0,
  EUR: 1.085, // 1 EUR = 1.085 USD -> 1 USD = 0.921 EUR
  GBP: 1.295,
  CHF: 1.130,
  CAD: 0.725,
  AUD: 0.655,
  JPY: 0.0066, // 1 JPY = 0.0066 USD -> 1 USD = 151 JPY
  CNY: 0.138,
  MXN: 0.051,  // 1 MXN = 0.051 USD -> 1 USD = 19.6 MXN
  BRL: 0.175,
  ARS: 0.0010,
  CLP: 0.00105,
  COP: 0.00023,
  BTC: 68000.0,
  ETH: 2600.0,
};

const CURRENCY_SYMBOLS: Record<string, string> = {
  USD: '$',
  EUR: '€',
  GBP: '£',
  JPY: '¥',
  MXN: '$',
  CAD: 'C$',
  AUD: 'A$',
  CHF: 'CHF',
  CNY: '¥',
  BRL: 'R$',
  ARS: '$',
  CLP: '$',
  COP: '$',
  BTC: '₿',
  ETH: 'Ξ',
};

// Aliases for common currency names
const CURRENCY_ALIASES: Record<string, string> = {
  usd: 'USD',
  dollar: 'USD',
  dolar: 'USD',
  dolares: 'USD',
  dollars: 'USD',
  eur: 'EUR',
  euro: 'EUR',
  euros: 'EUR',
  gbp: 'GBP',
  libra: 'GBP',
  libras: 'GBP',
  pound: 'GBP',
  pounds: 'GBP',
  jpy: 'JPY',
  yen: 'JPY',
  yenes: 'JPY',
  mxn: 'MXN',
  peso: 'MXN',
  pesos: 'MXN',
  cad: 'CAD',
  aud: 'AUD',
  chf: 'CHF',
  franco: 'CHF',
  cny: 'CNY',
  yuan: 'CNY',
  brl: 'BRL',
  real: 'BRL',
  reales: 'BRL',
  ars: 'ARS',
  clp: 'CLP',
  cop: 'COP',
  btc: 'BTC',
  bitcoin: 'BTC',
  eth: 'ETH',
  ethereum: 'ETH',
};

// Unit conversion factors to base unit
const LENGTH_TO_METERS: Record<string, number> = {
  mm: 0.001,
  cm: 0.01,
  m: 1.0,
  metro: 1.0,
  metros: 1.0,
  meter: 1.0,
  meters: 1.0,
  km: 1000.0,
  kilometro: 1000.0,
  kilometros: 1000.0,
  in: 0.0254,
  inch: 0.0254,
  inches: 0.0254,
  pulgada: 0.0254,
  pulgadas: 0.0254,
  ft: 0.3048,
  foot: 0.3048,
  feet: 0.3048,
  pie: 0.3048,
  pies: 0.3048,
  yd: 0.9144,
  yard: 0.9144,
  yards: 0.9144,
  yarda: 0.9144,
  yardas: 0.9144,
  mi: 1609.344,
  mile: 1609.344,
  miles: 1609.344,
  milla: 1609.344,
  millas: 1609.344,
};

const WEIGHT_TO_GRAMS: Record<string, number> = {
  mg: 0.001,
  g: 1.0,
  gram: 1.0,
  grams: 1.0,
  gramo: 1.0,
  gramos: 1.0,
  kg: 1000.0,
  kilo: 1000.0,
  kilos: 1000.0,
  kilogram: 1000.0,
  kilograms: 1000.0,
  oz: 28.3495,
  ounce: 28.3495,
  ounces: 28.3495,
  onza: 28.3495,
  onzas: 28.3495,
  lb: 453.592,
  lbs: 453.592,
  pound: 453.592,
  pounds: 453.592,
  libra: 453.592,
  libras: 453.592,
  ton: 1000000.0,
  tonelada: 1000000.0,
  toneladas: 1000000.0,
};

const DATA_TO_BYTES: Record<string, number> = {
  b: 1,
  byte: 1,
  bytes: 1,
  kb: 1024,
  kilobyte: 1024,
  mb: 1024 * 1024,
  megabyte: 1024 * 1024,
  gb: 1024 * 1024 * 1024,
  gigabyte: 1024 * 1024 * 1024,
  tb: 1024 * 1024 * 1024 * 1024,
  terabyte: 1024 * 1024 * 1024 * 1024,
};

function formatNumber(val: number): string {
  if (Math.abs(val) >= 1e9 || (Math.abs(val) < 1e-4 && val !== 0)) {
    return val.toExponential(4);
  }
  return new Intl.NumberFormat('es-ES', {
    maximumFractionDigits: 4,
    useGrouping: true,
  }).format(val);
}

/**
 * Attempts to parse and evaluate mathematical expressions, percentages,
 * currency conversions and unit conversions.
 */
export function evaluateQuickCalculation(rawQuery: string): CalculatorResult | null {
  const query = rawQuery.trim();
  if (!query || query.length < 2 || query.startsWith('>')) return null;

  // 1. Check for Currency Conversion (e.g., "50 usd a eur", "100 eur to usd", "2500 mxn a eur")
  const currencyMatch = query.match(/^([\d.,]+)\s*([a-zA-Z$€£¥]+)\s*(?:a|in|to|->|=)?\s*([a-zA-Z$€£¥]+)$/i);
  if (currencyMatch) {
    const rawAmount = currencyMatch[1].replace(/,/g, '.');
    const amount = parseFloat(rawAmount);
    const fromRaw = currencyMatch[2].toLowerCase();
    const toRaw = currencyMatch[3].toLowerCase();

    const fromCode = CURRENCY_ALIASES[fromRaw] || fromRaw.toUpperCase();
    const toCode = CURRENCY_ALIASES[toRaw] || toRaw.toUpperCase();

    if (
      !isNaN(amount) &&
      EXCHANGE_RATES_TO_USD[fromCode] &&
      EXCHANGE_RATES_TO_USD[toCode] &&
      fromCode !== toCode
    ) {
      const fromInUsd = amount * EXCHANGE_RATES_TO_USD[fromCode];
      const resultValue = fromInUsd / EXCHANGE_RATES_TO_USD[toCode];
      const rateOne = EXCHANGE_RATES_TO_USD[fromCode] / EXCHANGE_RATES_TO_USD[toCode];

      const toSymbol = CURRENCY_SYMBOLS[toCode] || toCode;
      const fromSymbol = CURRENCY_SYMBOLS[fromCode] || fromCode;

      return {
        expression: `${fromSymbol} ${formatNumber(amount)} ${fromCode}`,
        result: `${toSymbol} ${formatNumber(resultValue)} ${toCode}`,
        numericValue: resultValue,
        category: 'currency',
        detail: `1 ${fromCode} ≈ ${formatNumber(rateOne)} ${toCode} (Tasa referencial)`,
      };
    }
  }

  // 2. Check for Unit Conversion (e.g. "10 km a mi", "5 kg to lb", "30 c a f")
  const unitMatch = query.match(/^([\d.,]+)\s*([a-zA-Z°]+)\s*(?:a|in|to|->|=)?\s*([a-zA-Z°]+)$/i);
  if (unitMatch) {
    const rawAmount = unitMatch[1].replace(/,/g, '.');
    const amount = parseFloat(rawAmount);
    const fromUnit = unitMatch[2].toLowerCase();
    const toUnit = unitMatch[3].toLowerCase();

    if (!isNaN(amount)) {
      // Temperature (c, f, k)
      const isC = fromUnit === 'c' || fromUnit === 'celsius' || fromUnit === '°c';
      const isF = fromUnit === 'f' || fromUnit === 'fahrenheit' || fromUnit === '°f';
      const isK = fromUnit === 'k' || fromUnit === 'kelvin';
      const toC = toUnit === 'c' || toUnit === 'celsius' || toUnit === '°c';
      const toF = toUnit === 'f' || toUnit === 'fahrenheit' || toUnit === '°f';
      const toK = toUnit === 'k' || toUnit === 'kelvin';

      if ((isC || isF || isK) && (toC || toF || toK)) {
        let celsius = amount;
        if (isF) celsius = (amount - 32) * (5 / 9);
        else if (isK) celsius = amount - 273.15;

        let resVal = celsius;
        let unitLabel = '°C';
        if (toF) {
          resVal = celsius * (9 / 5) + 32;
          unitLabel = '°F';
        } else if (toK) {
          resVal = celsius + 273.15;
          unitLabel = 'K';
        }

        return {
          expression: `${formatNumber(amount)} ${fromUnit.toUpperCase()}`,
          result: `${formatNumber(resVal)} ${unitLabel}`,
          numericValue: resVal,
          category: 'unit',
          detail: 'Conversión de temperatura',
        };
      }

      // Length
      if (LENGTH_TO_METERS[fromUnit] && LENGTH_TO_METERS[toUnit]) {
        const inMeters = amount * LENGTH_TO_METERS[fromUnit];
        const resVal = inMeters / LENGTH_TO_METERS[toUnit];
        return {
          expression: `${formatNumber(amount)} ${fromUnit}`,
          result: `${formatNumber(resVal)} ${toUnit}`,
          numericValue: resVal,
          category: 'unit',
          detail: `1 ${fromUnit} = ${formatNumber(LENGTH_TO_METERS[fromUnit] / LENGTH_TO_METERS[toUnit])} ${toUnit}`,
        };
      }

      // Weight
      if (WEIGHT_TO_GRAMS[fromUnit] && WEIGHT_TO_GRAMS[toUnit]) {
        const inGrams = amount * WEIGHT_TO_GRAMS[fromUnit];
        const resVal = inGrams / WEIGHT_TO_GRAMS[toUnit];
        return {
          expression: `${formatNumber(amount)} ${fromUnit}`,
          result: `${formatNumber(resVal)} ${toUnit}`,
          numericValue: resVal,
          category: 'unit',
          detail: `1 ${fromUnit} = ${formatNumber(WEIGHT_TO_GRAMS[fromUnit] / WEIGHT_TO_GRAMS[toUnit])} ${toUnit}`,
        };
      }

      // Data storage
      if (DATA_TO_BYTES[fromUnit] && DATA_TO_BYTES[toUnit]) {
        const inBytes = amount * DATA_TO_BYTES[fromUnit];
        const resVal = inBytes / DATA_TO_BYTES[toUnit];
        return {
          expression: `${formatNumber(amount)} ${fromUnit.toUpperCase()}`,
          result: `${formatNumber(resVal)} ${toUnit.toUpperCase()}`,
          numericValue: resVal,
          category: 'unit',
          detail: `1 ${fromUnit.toUpperCase()} = ${formatNumber(DATA_TO_BYTES[fromUnit] / DATA_TO_BYTES[toUnit])} ${toUnit.toUpperCase()}`,
        };
      }
    }
  }

  // 3. Percentages: "20% de 500", "20% of 500", "140 + 21%", "200 - 15%"
  const percentOfMatch = query.match(/^([\d.,]+)\s*%\s*(?:de|of)\s*([\d.,]+)$/i);
  if (percentOfMatch) {
    const p = parseFloat(percentOfMatch[1].replace(/,/g, '.'));
    const total = parseFloat(percentOfMatch[2].replace(/,/g, '.'));
    if (!isNaN(p) && !isNaN(total)) {
      const resVal = (p / 100) * total;
      return {
        expression: `${p}% de ${total}`,
        result: formatNumber(resVal),
        numericValue: resVal,
        category: 'math',
        detail: `${p}% × ${total} = ${formatNumber(resVal)}`,
      };
    }
  }

  const percentAddSubMatch = query.match(/^([\d.,]+)\s*([+-])\s*([\d.,]+)\s*%$/);
  if (percentAddSubMatch) {
    const base = parseFloat(percentAddSubMatch[1].replace(/,/g, '.'));
    const op = percentAddSubMatch[2];
    const pct = parseFloat(percentAddSubMatch[3].replace(/,/g, '.'));
    if (!isNaN(base) && !isNaN(pct)) {
      const delta = (pct / 100) * base;
      const resVal = op === '+' ? base + delta : base - delta;
      return {
        expression: `${base} ${op} ${pct}%`,
        result: formatNumber(resVal),
        numericValue: resVal,
        category: 'math',
        detail: `${base} ${op} ${formatNumber(delta)} = ${formatNumber(resVal)}`,
      };
    }
  }

  // 4. General Math Expression
  // Clean expression and replace natural symbols
  let expr = query
    .replace(/×/g, '*')
    .replace(/÷/g, '/')
    .replace(/\^/g, '**')
    .replace(/,/g, '.');

  // Support Math functions (sqrt, cbrt, sin, cos, tan, log, ln, abs, round, pi, e)
  expr = expr
    .replace(/\bsqrt\(/gi, 'Math.sqrt(')
    .replace(/\bcbrt\(/gi, 'Math.cbrt(')
    .replace(/\bsin\(/gi, 'Math.sin(')
    .replace(/\bcos\(/gi, 'Math.cos(')
    .replace(/\btan\(/gi, 'Math.tan(')
    .replace(/\bln\(/gi, 'Math.log(')
    .replace(/\blog\(/gi, 'Math.log10(')
    .replace(/\babs\(/gi, 'Math.abs(')
    .replace(/\bround\(/gi, 'Math.round(')
    .replace(/\bpi\b/gi, 'Math.PI')
    .replace(/\be\b/gi, 'Math.E');

  // Verify expression contains only allowed mathematical characters
  // allowed: digits, spaces, Math, +, -, *, /, %, (, ), ., **, commas
  const sanitizedForCheck = expr.replace(/Math\.[a-zA-Z0-9]+/g, '');
  const isValidMath = /^[\d\s+\-*/().%^,]+$/.test(sanitizedForCheck);
  const hasOperatorOrFunc = /[+\-*/%^]/.test(query) || /sqrt|sin|cos|tan|log|pi/i.test(query);

  if (isValidMath && hasOperatorOrFunc) {
    try {
      // Evaluate within a secure sandbox function
      // eslint-disable-next-line no-eval
      const res = Function(`"use strict"; return (${expr});`)();
      if (typeof res === 'number' && !isNaN(res) && isFinite(res)) {
        return {
          expression: query,
          result: formatNumber(res),
          numericValue: res,
          category: 'math',
          detail: `${query} = ${formatNumber(res)}`,
        };
      }
    } catch {
      return null;
    }
  }

  return null;
}
