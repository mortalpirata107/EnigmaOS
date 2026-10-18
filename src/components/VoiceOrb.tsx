import React, { useRef, useEffect, useCallback } from 'react';
import { invoke } from '@tauri-apps/api/core';

export type VoiceOrbState = 'idle' | 'listening' | 'thinking' | 'searching' | 'speaking' | 'done' | 'alert';

export interface VoiceOrbProps {
  state?: VoiceOrbState;
  audioLevels?: { bass: number; treble: number };
  bands?: [number, number, number];
  onset?: number;
  speechEnv?: number;
  size?: number | string;
  className?: string;
  interactive?: boolean;
}

export const STATES: VoiceOrbState[] = ['idle', 'listening', 'thinking', 'searching', 'speaking', 'done', 'alert'];

const clamp = (v: number, lo = 0, hi = 1) => Math.max(lo, Math.min(hi, Number.isFinite(+v) ? +v : lo));

const weightsFor = (state: VoiceOrbState): [number, number, number, number, number, number, number] => [
  state === 'idle' ? 1 : 0,
  state === 'listening' ? 1 : 0,
  state === 'thinking' ? 1 : 0,
  state === 'searching' ? 1 : 0,
  state === 'speaking' ? 1 : 0,
  state === 'done' ? 1 : 0,
  state === 'alert' ? 1 : 0,
];

// Generador pseudoaleatorio determinista
const seeded = (i: number) => {
  const s = Math.sin(i * 127.1 + 311.7) * 43758.5453;
  return s - Math.floor(s);
};

// Generador de partículas para la bola de polvo 3D irregular volumétrica
// Sin ecuador, sin aros, sin polos ordenados
const generateDustSphere = (count: number) => {
  const data = new Float32Array(count * 4);
  for (let i = 0; i < count; i++) {
    const theta = seeded(i * 7 + 13) * 6.28318530718;
    const cosPhi = seeded(i * 11 + 37) * 2.0 - 1.0;
    const sinPhi = Math.sqrt(Math.max(0, 1.0 - cosPhi * cosPhi));

    const dx = sinPhi * Math.cos(theta);
    const dy = cosPhi;
    const dz = sinPhi * Math.sin(theta);

    const randR = seeded(i * 13 + 59);
    const radFactor = 0.25 + 0.75 * Math.pow(randR, 0.65);
    const dustJitter = 0.88 + 0.24 * seeded(i * 17 + 83);
    const r = radFactor * dustJitter;
    const u = seeded(i * 19 + 101);

    data.set([dx * r, dy * r, dz * r, u], i * 4);
  }
  return data;
};

// =============================================================================
// SHADERS WEBGL (GLSL ES 1.0 Estricto y universalmente compatible)
// =============================================================================
const VS = `
precision highp float;
attribute vec4 seed; // dx, dy, dz, u

uniform float time;
uniform float pixels;
uniform float density;
uniform float onset;
uniform float speechEnv;
uniform vec4 weights;       // idle, listening, thinking, searching
uniform vec3 extraWeights;  // speaking, done, alert
uniform vec3 bands;         // bass, mid, treble
uniform vec3 mouse;         // mouseX, mouseY, isHovered
uniform vec2 mouseVel;

varying vec3 vColor;
varying float vAlpha;
varying float vSpark;

float hash(vec3 p) {
  return fract(sin(dot(p, vec3(127.1, 311.7, 74.7))) * 43758.5453);
}

float noise3d(vec3 p) {
  vec3 i = floor(p);
  vec3 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float a = mix(hash(i), hash(i + vec3(1.0, 0.0, 0.0)), f.x);
  float b = mix(hash(i + vec3(0.0, 1.0, 0.0)), hash(i + vec3(1.0, 1.0, 0.0)), f.x);
  float c = mix(hash(i + vec3(0.0, 0.0, 1.0)), hash(i + vec3(1.0, 0.0, 1.0)), f.x);
  float d = mix(hash(i + vec3(0.0, 1.0, 1.0)), hash(i + vec3(1.0, 1.0, 1.0)), f.x);
  return mix(mix(a, b, f.y), mix(c, d, f.y), f.z) * 2.0 - 1.0;
}

vec3 rotateY(vec3 p, float a) {
  float c = cos(a);
  float s = sin(a);
  return vec3(c * p.x + s * p.z, p.y, c * p.z - s * p.x);
}

void main() {
  float t = time;
  vec3 pos = seed.xyz;
  float u = seed.w;

  float rBase = length(pos);
  vec3 dir = rBase > 0.001 ? normalize(pos) : vec3(0.0, 1.0, 0.0);

  // Deriva cuántica suave de las motas de polvo
  vec3 drift = vec3(
    noise3d(pos * 2.0 + vec3(t * 0.15, 0.0, -t * 0.12)),
    noise3d(pos * 2.0 + vec3(0.0, t * 0.14, t * 0.10)),
    noise3d(pos * 2.0 + vec3(-t * 0.11, t * 0.09, 0.0))
  );

  // 1. FORMA BASE: BOLA DE POLVO IRREGULAR ORGÁNICA (sin líneas, sin ecuador)
  float n1 = noise3d(dir * 2.5 + vec3(t * 0.30, -t * 0.25, t * 0.20));
  float n2 = noise3d(dir * 5.0 - vec3(t * 0.40, t * 0.35, -t * 0.30));
  float irregularFactor = 0.85 + 0.24 * n1 + 0.10 * n2;
  
  vec3 dustPos = dir * (rBase * irregularFactor * 0.55) + drift * 0.035;
  dustPos = rotateY(dustPos, t * 0.15);

  // 2. EXPANSIÓN, VIBRACIÓN ACÚSTICA 3D Y ONDAS EXPANSIVAS VOLUMÉTRICAS
  float bass = bands.x;
  float treble = bands.z;
  float soundEnergy = bass * 1.6 + treble * 1.2 + onset * 1.8;
  float isListening = weights.y;
  float isSpeaking = extraWeights.x;
  float activeSpeech = max(soundEnergy, max(isSpeaking * (0.45 + 0.55 * speechEnv), isListening * (0.35 + 0.45 * soundEnergy)));
  float voiceActivity = soundEnergy + isListening * 0.30 + isSpeaking * (0.40 + 0.35 * speechEnv);

  // A. Vibración física 3D en tiempo real (Acoustic 3D Jitter)
  vec3 acousticJitter = vec3(
    noise3d(pos * 9.0 + vec3(t * 16.0, 0.0, 0.0)),
    noise3d(pos * 9.0 + vec3(0.0, t * 16.0, 0.0)),
    noise3d(pos * 9.0 + vec3(0.0, 0.0, t * 16.0))
  ) * activeSpeech * 0.16;
  dustPos += acousticJitter;

  // B. Ondas expansivas volumétricas radiales viajando desde el núcleo hacia el exterior
  float wavePhase = rBase * 18.0 - t * 12.0;
  float shockwave = sin(wavePhase) * (0.28 + 0.32 * speechEnv) * activeSpeech;
  float bassShock = sin(rBase * 10.0 - t * 6.0) * bass * 0.35;
  dustPos += dir * (shockwave + bassShock);

  // C. Expansión irregular orgánica
  float soundN1 = noise3d(dir * 3.0 + vec3(t * 2.5, -t * 2.0, t * 1.5));
  float soundN2 = noise3d(dir * 6.5 - vec3(t * 3.5, t * 3.0, -t * 2.5));
  float randomExpansion = 0.5 + 0.35 * soundN1 + 0.15 * soundN2;
  dustPos += dir * (voiceActivity * randomExpansion * 0.45);

  // Modo Thinking: Condensación cuántica hacia el núcleo con respiración rítmica
  float isThinking = weights.z;
  if (isThinking > 0.03) {
    float breath = 1.0 + 0.22 * sin(t * 3.5);
    float coreRadius = (0.20 + 0.06 * sin(t * 7.0 + u * 12.56)) * breath;
    vec3 quantumCore = dir * (rBase * 0.35 * breath + coreRadius);
    quantumCore = rotateY(quantumCore, t * 2.6 + dir.y * 3.0);
    dustPos = mix(dustPos, quantumCore, isThinking * 0.82);
  }

  // 3. INTERACCIÓN DEL RATÓN: "COMO SI SOPLARAN PERO SE VUELVE A UNIR"
  if (mouse.z > 0.5) {
    vec2 toMouse = dustPos.xy - mouse.xy;
    float dist = length(toMouse);
    float blowRadius = 0.65;

    if (dist < blowRadius) {
      float blowStrength = pow(1.0 - (dist / blowRadius), 1.8);
      vec2 blowDir = normalize(toMouse + vec2(0.0001, 0.0001));
      float gust = noise3d(vec3(pos.xy * 6.0, t * 4.0));
      vec2 blowDisp = (blowDir * (0.35 + 0.15 * gust) + mouseVel * 0.25) * blowStrength;

      dustPos.xy += blowDisp;
      dustPos.z += (gust * 0.20 + 0.10) * blowStrength;
    }
  }

  // 4. PROYECCIÓN Y TAMAÑO
  float depth = clamp((dustPos.z + 1.2) / 2.4, 0.0, 1.0);
  float perspective = 3.0 / (3.0 - dustPos.z * 0.55);
  gl_Position = vec4(dustPos.xy * perspective * 0.80, 0.0, 1.0);

  float pointVar = fract(sin(u * 9123.4) * 47453.2);
  float pSize = (2.2 + 1.8 * depth + 1.0 * pointVar) * density * pixels / 700.0;
  gl_PointSize = max(1.5, pSize);

  // Paleta Carmesí #b82a2a constante y Ámbar Cuántico en Thinking
  vec3 crimson = vec3(0.72, 0.16, 0.16); // #b82a2a
  vec3 ruby = vec3(0.92, 0.22, 0.22);
  vec3 ember = vec3(1.00, 0.40, 0.25);
  vec3 amberGold = vec3(1.00, 0.70, 0.30);

  float core = 1.0 - clamp(rBase / 0.85, 0.0, 1.0);
  vec3 col = mix(crimson, ruby, core * 0.8 + 0.2 * n1);

  if (isThinking > 0.03) {
    col = mix(col, ember, isThinking * 0.65);
    col = mix(col, amberGold, isThinking * (0.35 + 0.25 * sin(t * 3.5)));
  }

  vColor = col;
  vAlpha = 0.45 + 0.45 * depth + 0.35 * core + soundEnergy * 0.30;
  float waveCrest = clamp(sin(wavePhase), 0.0, 1.0);
  vSpark = (soundEnergy * 0.60 + treble * 0.60 + waveCrest * activeSpeech * 0.85 + (u > 0.93 ? 0.75 : 0.0));
}
`;

const FS = `
precision mediump float;
varying vec3 vColor;
varying float vAlpha;
varying float vSpark;

void main() {
  vec2 coord = gl_PointCoord - vec2(0.5, 0.5);
  float r = length(coord) * 2.0;
  if (r > 1.0) discard;

  float core = 1.0 - smoothstep(0.10, 0.65, r);
  float halo = exp(-r * r * 4.0) * 0.35;
  float a = (core + halo) * vAlpha;

  vec3 whiteSpark = vec3(1.0, 0.95, 0.92);
  vec3 finalCol = vColor * a + whiteSpark * (vSpark * core * 0.65);

  gl_FragColor = vec4(finalCol, min(1.0, a + vSpark * core * 0.5));
}
`;

// Partícula para el motor Canvas 2D de respaldo garantizado
interface Dust2D {
  dx: number;
  dy: number;
  dz: number;
  r: number;
  u: number;
  bx: number;
  by: number;
  bz: number;
  bvx: number;
  bvy: number;
  bvz: number;
}

export const VoiceOrb: React.FC<VoiceOrbProps> = ({
  state = 'idle',
  audioLevels,
  bands,
  onset,
  speechEnv,
  size = 200,
  className = '',
  interactive = true,
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const haloRef = useRef<HTMLCanvasElement>(null);

  // WebGL State
  const glRef = useRef<WebGLRenderingContext | null>(null);
  const programRef = useRef<WebGLProgram | null>(null);
  const bufferRef = useRef<WebGLBuffer | null>(null);
  const countRef = useRef<number>(0);
  const uniformsRef = useRef<Record<string, WebGLUniformLocation | null>>({});
  const useFallback2D = useRef<boolean>(false);

  // Canvas 2D Fallback State
  const particles2D = useRef<Dust2D[]>([]);

  const timeRef = useRef<number>(0);
  const lastTimeRef = useRef<number>(0);
  const frameIdRef = useRef<number>(0);

  const weightsRef = useRef<number[]>([1, 0, 0, 0, 0, 0, 0]);
  const bandsRef = useRef<number[]>([0, 0, 0]);
  const onsetRef = useRef<number>(0);
  const speechEnvRef = useRef<number>(0.3);
  const mouseRef = useRef<{ x: number; y: number; active: boolean }>({ x: 0, y: 0, active: false });
  const mouseVelRef = useRef<{ x: number; y: number }>({ x: 0, y: 0 });
  const lastMousePosRef = useRef<{ x: number; y: number; time: number }>({ x: 0, y: 0, time: 0 });

  const targetWeights = weightsFor(state);
  const targetWeightsRef = useRef<number[]>(targetWeights);
  useEffect(() => {
    targetWeightsRef.current = targetWeights;
  });

  const audioInputsRef = useRef({
    bands,
    onset,
    speechEnv,
    audioLevels,
  });
  useEffect(() => {
    audioInputsRef.current = { bands, onset, speechEnv, audioLevels };
  });

  // Inicialización de partículas 2D
  const init2DParticles = useCallback((count: number) => {
    const list: Dust2D[] = [];
    for (let i = 0; i < count; i++) {
      const theta = seeded(i * 7 + 13) * 6.28318530718;
      const cosPhi = seeded(i * 11 + 37) * 2.0 - 1.0;
      const sinPhi = Math.sqrt(Math.max(0, 1.0 - cosPhi * cosPhi));

      const dx = sinPhi * Math.cos(theta);
      const dy = cosPhi;
      const dz = sinPhi * Math.sin(theta);

      const randR = seeded(i * 13 + 59);
      const radFactor = 0.22 + 0.78 * Math.pow(randR, 0.65);
      const dustJitter = 0.88 + 0.24 * seeded(i * 17 + 83);
      const r = radFactor * dustJitter;
      const u = seeded(i * 19 + 101);

      list.push({
        dx, dy, dz, r, u,
        bx: 0, by: 0, bz: 0,
        bvx: 0, bvy: 0, bvz: 0,
      });
    }
    particles2D.current = list;
  }, []);

  const setupWebGL = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    try {
      const gl = (canvas.getContext('webgl2') ||
        canvas.getContext('webgl', {
          alpha: true,
          antialias: true,
          depth: false,
          premultipliedAlpha: true,
        }) ||
        canvas.getContext('experimental-webgl')) as WebGLRenderingContext | null;

      if (!gl) {
        invoke('log_frontend', { msg: '[VoiceOrb] WebGL context not available, activating Canvas 2D engine' }).catch(() => {});
        useFallback2D.current = true;
        init2DParticles(1400);
        return;
      }

      const createShader = (src: string, type: number) => {
        const shader = gl.createShader(type);
        if (!shader) return null;
        gl.shaderSource(shader, src);
        gl.compileShader(shader);
        if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
          const log = gl.getShaderInfoLog(shader);
          console.warn('[VoiceOrb] Shader compile error:', log);
          invoke('log_frontend', { msg: `[VoiceOrb] Shader compile error: ${log}` }).catch(() => {});
          gl.deleteShader(shader);
          return null;
        }
        return shader;
      };

      const vs = createShader(VS, gl.VERTEX_SHADER);
      const fs = createShader(FS, gl.FRAGMENT_SHADER);
      if (!vs || !fs) {
        invoke('log_frontend', { msg: '[VoiceOrb] Shaders failed, falling back to Canvas 2D engine' }).catch(() => {});
        useFallback2D.current = true;
        init2DParticles(1400);
        return;
      }

      const program = gl.createProgram();
      if (!program) return;
      gl.attachShader(program, vs);
      gl.attachShader(program, fs);
      gl.linkProgram(program);

      if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
        const log = gl.getProgramInfoLog(program);
        console.warn('[VoiceOrb] Program link error:', log);
        invoke('log_frontend', { msg: `[VoiceOrb] Program link error: ${log}` }).catch(() => {});
        useFallback2D.current = true;
        init2DParticles(1400);
        return;
      }

      gl.useProgram(program);
      const buffer = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, buffer);

      const attr = gl.getAttribLocation(program, 'seed');
      gl.enableVertexAttribArray(attr);
      gl.vertexAttribPointer(attr, 4, gl.FLOAT, false, 0, 0);

      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE);
      gl.disable(gl.DEPTH_TEST);

      const uniforms: Record<string, WebGLUniformLocation | null> = {};
      for (const name of [
        'time', 'pixels', 'density', 'speechEnv', 'weights', 'extraWeights',
        'bands', 'onset', 'mouse', 'mouseVel'
      ]) {
        uniforms[name] = gl.getUniformLocation(program, name);
      }

      glRef.current = gl;
      programRef.current = program;
      bufferRef.current = buffer;
      uniformsRef.current = uniforms;
      countRef.current = 0;
      useFallback2D.current = false;
    } catch (e) {
      console.warn('[VoiceOrb] WebGL setup exception:', e);
      useFallback2D.current = true;
      init2DParticles(1400);
    }
  }, [init2DParticles]);

  const handlePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!interactive) return;
    const rect = e.currentTarget.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;
    const x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    const y = -(((e.clientY - rect.top) / rect.height) * 2 - 1);
    const now = performance.now();
    const dt = Math.max(0.008, (now - lastMousePosRef.current.time) / 1000);

    const rawVx = clamp((x - lastMousePosRef.current.x) / dt, -1.8, 1.8);
    const rawVy = clamp((y - lastMousePosRef.current.y) / dt, -1.8, 1.8);
    mouseVelRef.current.x = mouseVelRef.current.x * 0.60 + rawVx * 0.40;
    mouseVelRef.current.y = mouseVelRef.current.y * 0.60 + rawVy * 0.40;

    lastMousePosRef.current = { x, y, time: now };
    mouseRef.current = { x, y, active: true };
  };

  const handlePointerLeave = () => {
    mouseRef.current.active = false;
    mouseVelRef.current = { x: 0, y: 0 };
  };

  // Bucle principal a 60 FPS
  useEffect(() => {
    setupWebGL();

    const animate = (now: number) => {
      const elapsed = lastTimeRef.current ? (now - lastTimeRef.current) / 1000 : 1 / 60;
      const dt = Math.min(0.08, elapsed);
      lastTimeRef.current = now;
      timeRef.current += dt;

      // Suavizado de pesos
      const curTarget = targetWeightsRef.current;
      const k = 1 - Math.exp(-dt / 0.22);
      for (let i = 0; i < 7; i++) {
        weightsRef.current[i] += (curTarget[i] - weightsRef.current[i]) * k;
      }

      // Amortiguación del viento
      mouseVelRef.current.x *= Math.exp(-dt * 3.5);
      mouseVelRef.current.y *= Math.exp(-dt * 3.5);

      // Reactividad acústica
      const audioIn = audioInputsRef.current;
      if (audioIn.bands) {
        const b0 = clamp(audioIn.bands[0]);
        const b1 = clamp(audioIn.bands[1]);
        const b2 = clamp(audioIn.bands[2]);

        bandsRef.current[0] += (b0 - bandsRef.current[0]) * 0.45;
        bandsRef.current[1] += (b1 - bandsRef.current[1]) * 0.45;
        bandsRef.current[2] += (b2 - bandsRef.current[2]) * 0.45;

        if (typeof audioIn.onset === 'number') {
          onsetRef.current = Math.max(0, audioIn.onset);
        }
        if (typeof audioIn.speechEnv === 'number') {
          speechEnvRef.current = Math.max(0.15, audioIn.speechEnv);
        }
      } else if (audioIn.audioLevels) {
        const bassVal = audioIn.audioLevels.bass > 1.0 ? audioIn.audioLevels.bass / 100 : audioIn.audioLevels.bass;
        const trebleVal = audioIn.audioLevels.treble > 1.0 ? audioIn.audioLevels.treble / 100 : audioIn.audioLevels.treble;
        const bassNorm = clamp(bassVal * 2.0);
        const trebleNorm = clamp(trebleVal * 2.0);

        bandsRef.current[0] += (bassNorm - bandsRef.current[0]) * 0.35;
        bandsRef.current[1] += (((bassNorm + trebleNorm) * 0.5) - bandsRef.current[1]) * 0.25;
        bandsRef.current[2] += (trebleNorm - bandsRef.current[2]) * 0.35;

        onsetRef.current = Math.max(0, onsetRef.current - dt * 2.5);
        if (bassNorm > 0.35) onsetRef.current = bassNorm;
        speechEnvRef.current = Math.max(0.2, (bassNorm + trebleNorm) * 0.85);
      } else {
        bandsRef.current[0] *= 0.88;
        bandsRef.current[1] *= 0.88;
        bandsRef.current[2] *= 0.88;
        onsetRef.current *= 0.85;
        speechEnvRef.current = 0.45 + 0.45 * Math.sin(timeRef.current * 7.5);
      }

      const canvas = canvasRef.current;
      const halo = haloRef.current;
      if (!canvas || !halo) {
        frameIdRef.current = requestAnimationFrame(animate);
        return;
      }

      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const rawW = canvas.clientWidth || (typeof size === 'number' ? size : 270);
      const sizePx = Math.max(120, Math.round(rawW * dpr));
      if (canvas.width !== sizePx || canvas.height !== sizePx) {
        canvas.width = canvas.height = halo.width = halo.height = sizePx;
      }

      // Halo 2D difuso
      const hctx = halo.getContext('2d');
      if (hctx) {
        hctx.clearRect(0, 0, sizePx, sizePx);
        const glow = hctx.createRadialGradient(
          sizePx * 0.5, sizePx * 0.5, sizePx * 0.05,
          sizePx * 0.5, sizePx * 0.5, sizePx * 0.46
        );
        const soundPulse = (bandsRef.current[0] * 0.08 + onsetRef.current * 0.06);
        glow.addColorStop(0, `rgba(184,42,42,0.02)`);
        glow.addColorStop(0.5, `rgba(184,42,42,${0.04 + soundPulse})`);
        glow.addColorStop(1, `rgba(184,42,42,0)`);
        hctx.fillStyle = glow;
        hctx.fillRect(0, 0, sizePx, sizePx);
      }

      // =========================================================================
      // MOTOR A: WEBGL (Si está disponible)
      // =========================================================================
      const gl = glRef.current;
      if (!useFallback2D.current && gl && programRef.current) {
        const count = 12000;
        if (countRef.current !== count) {
          countRef.current = count;
          const seeds = generateDustSphere(count);
          gl.bindBuffer(gl.ARRAY_BUFFER, bufferRef.current);
          gl.bufferData(gl.ARRAY_BUFFER, seeds, gl.STATIC_DRAW);
        }

        gl.viewport(0, 0, sizePx, sizePx);
        gl.clearColor(0, 0, 0, 0);
        gl.clear(gl.COLOR_BUFFER_BIT);

        gl.useProgram(programRef.current);
        const u = uniformsRef.current;
        if (u.time) gl.uniform1f(u.time, timeRef.current);
        if (u.pixels) gl.uniform1f(u.pixels, sizePx);
        if (u.density) gl.uniform1f(u.density, Math.pow(12000 / count, 0.32));
        if (u.speechEnv) gl.uniform1f(u.speechEnv, speechEnvRef.current);
        
        if (u.weights) gl.uniform4f(u.weights, weightsRef.current[0], weightsRef.current[1], weightsRef.current[2], weightsRef.current[3]);
        if (u.extraWeights) gl.uniform3f(u.extraWeights, weightsRef.current[4], weightsRef.current[5], weightsRef.current[6]);
        
        if (u.bands) gl.uniform3fv(u.bands, bandsRef.current);
        if (u.onset) gl.uniform1f(u.onset, onsetRef.current);
        if (u.mouse) gl.uniform3f(u.mouse, mouseRef.current.x, mouseRef.current.y, mouseRef.current.active ? 1.0 : 0.0);
        if (u.mouseVel) gl.uniform2f(u.mouseVel, mouseVelRef.current.x, mouseVelRef.current.y);

        gl.drawArrays(gl.POINTS, 0, count);
      }
      // =========================================================================
      // MOTOR B: CANVAS 2D DE ALTO RENDIMIENTO (Garantía absoluta de render)
      // =========================================================================
      else {
        const ctx = canvas.getContext('2d');
        if (ctx) {
          ctx.clearRect(0, 0, sizePx, sizePx);
          ctx.globalCompositeOperation = 'lighter';

          const t = timeRef.current;
          const rotY = t * 0.15;

          const soundEnergy = bandsRef.current[0] * 1.6 + bandsRef.current[2] * 1.2 + onsetRef.current * 1.8;
          const isListening = weightsRef.current[1];
          const isThinking = weightsRef.current[2];
          const isSpeaking = weightsRef.current[4];
          const activeSpeech = Math.max(soundEnergy, Math.max(isSpeaking * (0.45 + 0.55 * speechEnvRef.current), isListening * (0.35 + 0.45 * soundEnergy)));
          const voiceAct = soundEnergy + isListening * 0.30 + isSpeaking * (0.40 + 0.35 * speechEnvRef.current);

          const mouseActive = mouseRef.current.active;
          const mx = mouseRef.current.x;
          const my = mouseRef.current.y;
          const mvx = mouseVelRef.current.x;
          const mvy = mouseVelRef.current.y;

          const center = sizePx * 0.5;
          const radiusScale = sizePx * 0.38;

          const list = particles2D.current;
          for (let i = 0; i < list.length; i++) {
            const p = list[i];

            // 1. Bola de polvo irregular orgánica
            const noiseFactor = 0.88 + 0.22 * Math.sin(p.dx * 3.5 + t * 0.8) * Math.cos(p.dy * 3.5 - t * 0.7);
            let pr = p.r * noiseFactor * 0.55;

            // 2. Ondas expansivas volumétricas y expansión irregular por sonido/voz
            const wavePhase = p.r * 18.0 - t * 12.0;
            if (activeSpeech > 0.02) {
              const shockwave = Math.sin(wavePhase) * (0.28 + 0.32 * speechEnvRef.current) * activeSpeech;
              const bassShock = Math.sin(p.r * 10.0 - t * 6.0) * bandsRef.current[0] * 0.35;
              pr += shockwave + bassShock;
            }

            if (voiceAct > 0.02) {
              const spike = 0.5 + 0.5 * Math.sin(p.u * 45.0 + t * 3.5);
              pr += voiceAct * spike * 0.38;
            }

            // Modo Thinking: Condensación cuántica rítmica en Canvas 2D
            if (isThinking > 0.03) {
              const breath = 1.0 + 0.22 * Math.sin(t * 3.5);
              const targetR = (0.20 + 0.06 * Math.sin(t * 7.0 + p.u * 12.56)) * breath;
              pr = pr * (1.0 - isThinking * 0.78) + targetR * isThinking;
            }

            // Coordenadas base
            let px = p.dx * pr;
            let py = p.dy * pr;
            let pz = p.dz * pr;

            // Vibración acústica 3D en tiempo real (Acoustic 3D Jitter)
            if (activeSpeech > 0.02) {
              px += Math.sin(p.dx * 9.0 + t * 16.0) * activeSpeech * 0.08;
              py += Math.cos(p.dy * 9.0 + t * 16.0) * activeSpeech * 0.08;
              pz += Math.sin(p.dz * 9.0 + t * 16.0) * activeSpeech * 0.08;
            }

            // Rotación cuántica (más rápida en thinking)
            const rotSpeed = rotY + (isThinking > 0.03 ? t * 0.35 * isThinking : 0);
            const cosCurrent = Math.cos(rotSpeed);
            const sinCurrent = Math.sin(rotSpeed);
            const rx = cosCurrent * px + sinCurrent * pz;
            const rz = -sinCurrent * px + cosCurrent * pz;
            px = rx;
            pz = rz;

            // 3. Interacción "Soplar pero se vuelve a unir"
            if (mouseActive) {
              const dx = px - mx;
              const dy = py - my;
              const dist = Math.sqrt(dx * dx + dy * dy);
              const blowRad = 0.65;

              if (dist < blowRad) {
                const blowForce = Math.pow(1.0 - (dist / blowRad), 1.8);
                const invD = 1.0 / (dist + 0.001);
                const blowTargetX = (dx * invD * 0.35 + mvx * 0.25) * blowForce;
                const blowTargetY = (dy * invD * 0.35 + mvy * 0.25) * blowForce;

                // Integración física de desplazamiento
                p.bvx += (blowTargetX - p.bx) * dt * 25.0;
                p.bvy += (blowTargetY - p.by) * dt * 25.0;
              }
            }

            // Restauración elástica continua hacia la nube ("se vuelve a unir")
            p.bvx += (-p.bx) * dt * 12.0;
            p.bvy += (-p.by) * dt * 12.0;
            p.bvx *= Math.exp(-dt * 6.0);
            p.bvy *= Math.exp(-dt * 6.0);

            p.bx += p.bvx * dt;
            p.by += p.bvy * dt;

            // Posición final combinada
            const fx = px + p.bx;
            const fy = py + p.by;
            const fz = pz;

            // Proyección perspectiva
            const persp = 3.0 / (3.0 - fz * 0.55);
            const screenX = center + fx * persp * radiusScale;
            const screenY = center - fy * persp * radiusScale;

            const depth = clamp((fz + 1.2) / 2.4, 0.0, 1.0);
            const alpha = 0.45 + 0.45 * depth + soundEnergy * 0.30;
            const pSize = Math.max(1.5, (1.8 + 1.8 * depth) * (sizePx / 400));

            // Destello de chispas incandescentes en crestas o por voz
            const waveCrest = Math.max(0, Math.sin(wavePhase));
            const isSpark = p.u > 0.94 || (activeSpeech > 0.25 && waveCrest > 0.7) || (soundEnergy > 0.4 && p.u > 0.85);

            if (isSpark) {
              ctx.fillStyle = `rgba(255, 245, 240, ${Math.min(1.0, alpha + 0.35)})`;
            } else if (isThinking > 0.05) {
              const breathColor = 0.5 + 0.5 * Math.sin(t * 3.5);
              const rCol = Math.round(230 + 25 * breathColor);
              const gCol = Math.round(90 + 70 * breathColor);
              const bCol = 35;
              ctx.fillStyle = `rgba(${rCol}, ${gCol}, ${bCol}, ${alpha})`;
            } else {
              ctx.fillStyle = `rgba(184, 42, 42, ${alpha})`;
            }

            ctx.beginPath();
            ctx.arc(screenX, screenY, pSize, 0, 6.2831853);
            ctx.fill();
          }
        }
      }

      frameIdRef.current = requestAnimationFrame(animate);
    };

    frameIdRef.current = requestAnimationFrame(animate);

    return () => {
      cancelAnimationFrame(frameIdRef.current);
    };
  }, [setupWebGL]);

  const dimension = typeof size === 'number' ? `${size}px` : size;

  return (
    <div
      ref={containerRef}
      onPointerMove={handlePointerMove}
      onPointerLeave={handlePointerLeave}
      className={`relative flex items-center justify-center select-none ${className}`}
      style={{
        width: dimension,
        height: dimension,
        touchAction: 'none',
      }}
    >
      {/* Canvas 2D de halo difuso */}
      <canvas
        ref={haloRef}
        className="absolute inset-0 w-full h-full pointer-events-none"
        style={{ mixBlendMode: 'screen' }}
      />
      {/* Canvas de renderizado de la nube de polvo (WebGL o Canvas2D fallback) */}
      <canvas
        ref={canvasRef}
        className="absolute inset-0 w-full h-full pointer-events-none"
        style={{ mixBlendMode: 'screen' }}
      />
    </div>
  );
};

export default VoiceOrb;
