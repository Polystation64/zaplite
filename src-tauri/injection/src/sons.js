/* SONS DO MODO ICQ — sintetizados na hora (Web Audio), nenhum arquivo.

   Nenhum é cópia de som de terceiro: o "oh-oh" é uma síntese PRÓPRIA de duas
   sílabas descendentes com formantes de vogal (é a lembrança do ICQ, não a
   gravação dele, que tem dono). A tecla é um estalo de ruído filtrado com um
   "thump" grave; a borracha, ruído de banda baixa em três passadas.

   Arquivo só de declarações: o contexto de áudio nasce na primeira vez que
   um som é pedido (quase sempre numa tecla, que já é gesto do usuário — é o
   que a política de autoplay exige). */

import { invoke } from "./ponte.js";

let ctx = null;
/* Arquivos que o PRÓPRIO usuário escolheu no Painel ("Usar meu arquivo…").
   Ficam só na máquina dele: o ZapLite não traz nem distribui som de
   terceiros. Nome do som -> AudioBuffer já decodificado. */
const personalizados = {};

function contexto() {
  try {
    if (!ctx) {
      const C = window.AudioContext || window.webkitAudioContext;
      if (!C) return null;
      ctx = new C();
    }
    if (ctx.state === "suspended") ctx.resume().catch(() => {});
    return ctx;
  } catch (_) {
    return null;
  }
}

function ruido(c, segundos) {
  const n = Math.max(1, Math.floor(c.sampleRate * segundos));
  const buf = c.createBuffer(1, n, c.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < n; i++) d[i] = Math.random() * 2 - 1;
  return buf;
}

function limitar(v) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0.6;
}

/** Toca o arquivo do usuário, se houver. `true` = tocou. */
function tocarPersonalizado(nome, volume) {
  const buf = personalizados[nome];
  const c = buf && contexto();
  if (!c) return false;
  const src = c.createBufferSource();
  src.buffer = buf;
  const g = c.createGain();
  g.gain.value = limitar(volume);
  src.connect(g).connect(c.destination);
  src.start();
  return true;
}

/** Carrega os arquivos marcados como personalizados. O Rust só devolve o
 * arquivo que o usuário escolheu para AQUELE nome — a página nunca dá caminho. */
export async function carregarSonsPersonalizados(marcados) {
  for (const nome of ["tecla", "borracha", "ohoh"]) {
    delete personalizados[nome];
    if (!marcados || !marcados[nome]) continue;
    try {
      const r = await invoke("ler_som_icq", { som: nome });
      const c = contexto();
      if (!c || !r || !r.b64) continue;
      const bin = atob(r.b64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      personalizados[nome] = await c.decodeAudioData(bytes.buffer);
    } catch (e) {
      console.warn("[ZapLite] som personalizado", nome, e);
    }
  }
}

/** Estalo de tecla mecânica: ~30 ms, timbre levemente diferente a cada toque. */
export function somTecla(volume) {
  if (tocarPersonalizado("tecla", volume)) return;
  const c = contexto();
  if (!c) return;
  const v = limitar(volume);
  const t = c.currentTime;
  const src = c.createBufferSource();
  src.buffer = ruido(c, 0.04);
  const bp = c.createBiquadFilter();
  bp.type = "bandpass";
  bp.frequency.value = 2600 + Math.random() * 1400;
  bp.Q.value = 1.4;
  const g = c.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(0.55 * v + 0.0001, t + 0.002);
  g.gain.exponentialRampToValueAtTime(0.0001, t + 0.03);
  src.connect(bp).connect(g).connect(c.destination);
  src.start(t);
  src.stop(t + 0.045);
  // corpo da tecla batendo no fundo
  const o = c.createOscillator();
  o.type = "sine";
  o.frequency.setValueAtTime(170, t);
  o.frequency.exponentialRampToValueAtTime(90, t + 0.02);
  const go = c.createGain();
  go.gain.setValueAtTime(0.18 * v + 0.0001, t);
  go.gain.exponentialRampToValueAtTime(0.0001, t + 0.025);
  o.connect(go).connect(c.destination);
  o.start(t);
  o.stop(t + 0.03);
}

/** Borracha: três passadas de ruído grave, ~220 ms. */
export function somBorracha(volume) {
  if (tocarPersonalizado("borracha", volume)) return;
  const c = contexto();
  if (!c) return;
  const v = limitar(volume);
  const t = c.currentTime;
  const dur = 0.22;
  const src = c.createBufferSource();
  src.buffer = ruido(c, dur);
  const lp = c.createBiquadFilter();
  lp.type = "lowpass";
  lp.frequency.value = 1400;
  const bp = c.createBiquadFilter();
  bp.type = "bandpass";
  bp.frequency.value = 700;
  bp.Q.value = 0.8;
  const g = c.createGain();
  g.gain.setValueAtTime(0.0001, t);
  const passadas = 3;
  for (let i = 0; i < passadas; i++) {
    const a = t + (i * dur) / passadas;
    g.gain.linearRampToValueAtTime(0.42 * v, a + 0.025);
    g.gain.linearRampToValueAtTime(0.06 * v, a + dur / passadas);
  }
  g.gain.linearRampToValueAtTime(0.0001, t + dur);
  src.connect(lp).connect(bp).connect(g).connect(c.destination);
  src.start(t);
  src.stop(t + dur + 0.01);
}

/* Uma sílaba "vozeada": dente-de-serra passando por dois formantes de vogal. */
function silaba(c, inicio, dur, f0a, f0b, formantes, v) {
  const o = c.createOscillator();
  o.type = "sawtooth";
  o.frequency.setValueAtTime(f0a, inicio);
  o.frequency.linearRampToValueAtTime(f0b, inicio + dur);
  const saida = c.createGain();
  saida.gain.setValueAtTime(0.0001, inicio);
  saida.gain.exponentialRampToValueAtTime(0.5 * v + 0.0001, inicio + 0.025);
  saida.gain.setValueAtTime(0.5 * v + 0.0001, inicio + dur * 0.6);
  saida.gain.exponentialRampToValueAtTime(0.0001, inicio + dur);
  for (const [freq, ganho] of formantes) {
    const f = c.createBiquadFilter();
    f.type = "bandpass";
    f.frequency.value = freq;
    f.Q.value = 6;
    const gf = c.createGain();
    gf.gain.value = ganho;
    o.connect(f).connect(gf).connect(saida);
  }
  saida.connect(c.destination);
  o.start(inicio);
  o.stop(inicio + dur + 0.02);
}

/** "Oh-oh": duas sílabas, a segunda mais grave e mais longa (~0,5 s). */
export function somOhOh(volume) {
  if (tocarPersonalizado("ohoh", volume)) return;
  const c = contexto();
  if (!c) return;
  const v = limitar(volume);
  const t = c.currentTime + 0.01;
  silaba(c, t, 0.17, 392, 370, [[520, 1.0], [900, 0.55]], v); // "ô"
  silaba(c, t + 0.21, 0.3, 311, 262, [[470, 1.0], [820, 0.5]], v); // "ôu"
}

export const SONS = { tecla: somTecla, borracha: somBorracha, ohoh: somOhOh };

/** Para o Painel tocar uma amostra ("Ouvir"), via Rust → main window. */
export function tocarSom(nome, volume) {
  const f = SONS[nome];
  if (f) f(volume);
}
