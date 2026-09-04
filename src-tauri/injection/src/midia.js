import { bolhasVisiveis, textoDaBolha } from "./bolhas.js";
import { showPanel } from "./painel.js";
import { invoke } from "./ponte.js";

/* ========================================================================
   ÁUDIO DE UMA MENSAGEM — UM lugar só (V2)
   ------------------------------------------------------------------------
   O padrão `bolha.querySelector("audio")` + `fetch(audio.src)` estava
   COPIADO em dois pontos (botão na bolha e menu do botão direito) e os dois
   quebraram juntos — é a mesma família do cisma das classes `message-in`.
   MEDIDO no DOM real da sessão logada em 17/08/2026, conversa aberta com 6
   mensagens de voz na tela:

       #main audio          = 0     document audio   = 0   (ANTES do play)
       #main audio          = 0     document audio   = 0   (DEPOIS do play)

   Ou seja: NÃO existe elemento `<audio>` nenhum — nem antes, nem depois de
   reproduzir. O `querySelector("audio")` devolvia null e o código lançava
   "Áudio não encontrado no player.", que é exatamente o que o usuário viu.
   O que a bolha de voz tem hoje (mesma medição):

       div[role="row"] > [data-testid^="conv-msg-"]
       ├─ [data-testid="msg-container"]
       ├─ button[data-testid="audio-player-frame-spinner"]  ← o controle
       ├─ [data-testid="loading-spinner"]  (enquanto baixa)
       ├─ span[data-icon="ptt-status"]
       └─ <canvas>                          ← a onda desenhada, sem bytes

   De onde vêm os bytes, então: a página decifra a mídia e cria um Blob.
   Medido no mesmo experimento, `URL.createObjectURL` recebeu 6 Blobs
   `audio/mp4` e, ao reproduzir, 3 Blobs `audio/ogg; codecs=opus` de 4966,
   15160 e 34617 bytes. É o ÚNICO ponto do processo em que os bytes do áudio
   passam por uma API pública — por isso a captura é aqui.

   Os dois ganchos são `Proxy` sobre a função nativa, não funções novas:
   `Reflect.apply` mantém o comportamento idêntico e o `toString()` continua
   devolvendo "[native code]" (um wrapper comum apareceria como código
   nosso para qualquer verificação da página).

   EFEITO COLATERAL, assumido de propósito: para obter os bytes é preciso
   mandar a página reproduzir a mensagem, e reproduzir uma mensagem de voz
   manda o recibo de "ouvida" para quem enviou. É o mesmo que o usuário
   faria à mão para saber o conteúdo; o player é silenciado e pausado no
   instante em que os bytes aparecem. */
const AUD_MIME = /^audio\//i;
const AUD_MAX_BLOBS = 24;      // teto: um Blob retido é memória retida
const AUD_ESPERA_MS = 20000;   // baixar+decifrar um áudio longo demora
const AUD = { blobs: new Map(), ordem: [], play: null, capturando: false };

function lembrarBlob(url, blob) {
  AUD.blobs.set(url, { blob, ts: Date.now() });
  AUD.ordem.push(url);
  while (AUD.ordem.length > AUD_MAX_BLOBS) {
    const velho = AUD.ordem.shift();
    if (velho !== url) AUD.blobs.delete(velho);
  }
}
export function instalarCapturaDeAudio() {
  try {
    URL.createObjectURL = new Proxy(URL.createObjectURL, {
      apply(alvo, self, args) {
        const url = Reflect.apply(alvo, self, args);
        try {
          const o = args[0];
          if (o && typeof o.arrayBuffer === "function" && AUD_MIME.test(String(o.type || ""))) {
            lembrarBlob(url, o);
          }
        } catch (_) {}
        return url;
      },
    });
    // Quem toca é um elemento que NÃO está no documento (por isso
    // `querySelectorAll("audio")` não acha nada). O gancho no `play` é o que
    // liga "cliquei no play desta bolha" ao elemento e ao src de verdade.
    HTMLMediaElement.prototype.play = new Proxy(HTMLMediaElement.prototype.play, {
      apply(alvo, self, args) {
        try {
          if (AUD.capturando) self.muted = true;
          AUD.play = { el: self, ts: Date.now() };
        } catch (_) {}
        return Reflect.apply(alvo, self, args);
      },
    });
  } catch (e) {
    console.error("[ZapLite] não consegui instalar a captura de áudio:", e);
  }
}

/** Sequência de eventos que um mouse de verdade produz. Ver Z1 (a lista de
    conversas abre no `mousedown`, e `element.click()` sozinho não abre). */
export function cliqueReal(alvo) {
  if (!alvo) return;
  const r = alvo.getBoundingClientRect();
  const x = r.left + r.width / 2;
  const y = r.top + r.height / 2;
  const passos = [
    ["pointerover", 0], ["pointerdown", 1], ["mousedown", 1],
    ["pointerup", 0], ["mouseup", 0], ["click", 0],
  ];
  for (const [tipo, botoes] of passos) {
    const Ctor = tipo.indexOf("pointer") === 0 && window.PointerEvent ? PointerEvent : MouseEvent;
    try {
      alvo.dispatchEvent(
        new Ctor(tipo, {
          bubbles: true, cancelable: true, composed: true, view: window,
          clientX: x, clientY: y, button: 0, buttons: botoes,
          pointerId: 1, isPrimary: true,
        })
      );
    } catch (_) {}
  }
}

// RECONHECER que a bolha é de voz e SABER onde clicar são duas perguntas
// diferentes, e misturá-las foi o primeiro erro desta correção: o
// `[data-testid="ptt-status"]` (o ícone de status, um `span`) reconhece a
// bolha mas NÃO reage a clique — clicar nele não fazia nada e a captura
// estourava o tempo. Medido em 17/08/2026, bolha carregada:
//     <button aria-label="Reproduzir mensagem de voz"> ← é este
//   e, enquanto toca, o mesmo botão vira "Pausar mensagem de voz".
const AUD_SINAL_SELS = [
  "audio",
  '[data-testid="ptt-status"]',
  '[data-icon="ptt-status"]',
  '[data-testid="audio-player-frame-spinner"]',
  '[data-testid^="audio-player"]',
  'button[aria-label*="eproduzir mensagem de voz"]',
  'button[aria-label*="ausar mensagem de voz"]',
  'button[aria-label*="lay voice"]',
];
const AUD_CTRL_SELS = [
  'button[aria-label*="eproduzir"]',              // pt-BR (medido)
  'button[aria-label*="lay voice"]',              // en
  'button[aria-label*="lay audio"]',
  '[data-icon="audio-play"]',
  '[data-icon="play"]',
  '[data-testid="audio-player-frame-spinner"]',   // enquanto ainda baixa
];
const AUD_PAUSA_SELS = ['button[aria-label*="ausar"]', 'button[aria-label*="ause"]'];

function primeiro(bolha, sels) {
  if (!bolha) return null;
  for (const s of sels) {
    const el = bolha.querySelector(s);
    if (el) return el.closest("button") || el;
  }
  return null;
}
const controleDeAudio = (bolha) => primeiro(bolha, AUD_CTRL_SELS);
/** A bolha é de áudio? (usado pelo botão e pelo menu do botão direito) */
export const ehBolhaDeAudio = (bolha) => !!primeiro(bolha, AUD_SINAL_SELS);

function esperarBytes(marca, ms) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const olhar = () => {
      // 1) o elemento que começou a tocar depois do nosso clique
      if (AUD.play && AUD.play.ts >= marca) {
        const el = AUD.play.el;
        const src = (el && (el.src || el.currentSrc)) || "";
        const g = AUD.blobs.get(src);
        if (g || src) return resolve({ el, src, blob: g && g.blob });
      }
      // 2) ou um Blob de áudio novo, se a página tocar sem passar por play()
      for (let i = AUD.ordem.length - 1; i >= 0; i--) {
        const g = AUD.blobs.get(AUD.ordem[i]);
        if (g && g.ts >= marca) return resolve({ el: AUD.play && AUD.play.el, src: AUD.ordem[i], blob: g.blob });
      }
      if (Date.now() - t0 >= ms) return resolve({});
      setTimeout(olhar, 100);
    };
    olhar();
  });
}

/** Bytes do áudio de UMA bolha. Único caminho — os dois pontos de chamada
    passam por aqui de propósito. */
async function blobDoAudio(bolha) {
  // Caminho A: o `<audio>` clássico. Não existe hoje, fica como retaguarda
  // para o dia em que o WhatsApp voltar a expor um player no documento.
  const el = bolha && bolha.querySelector("audio,video");
  const src0 = el && (el.src || el.currentSrc);
  if (src0) {
    const g = AUD.blobs.get(src0);
    if (g) return g.blob;
    return await (await fetch(src0)).blob();
  }

  // Caminho B (o de hoje): mandar a bolha reproduzir e pegar os bytes.
  // MEDIDO: o clique em "Reproduzir mensagem de voz" faz a página criar um
  // `new Audio()` FORA do documento, apontar o `src` para o blob: do áudio e
  // chamar `play()` — é aí que os dois ganchos se encontram e a associação
  // "esta bolha ↔ estes bytes" fica exata (nada de adivinhar pelo Blob mais
  // recente: ao abrir a conversa a página já cria um blob por mensagem).
  const ctrl = controleDeAudio(bolha);
  if (!ctrl) {
    // já está tocando ESTA bolha (o botão virou "Pausar"): o elemento em
    // reprodução é o desta mensagem, não há o que clicar.
    const tocando = primeiro(bolha, AUD_PAUSA_SELS) && AUD.play && AUD.play.el;
    const src = tocando && (AUD.play.el.src || AUD.play.el.currentSrc);
    if (src) {
      const g = AUD.blobs.get(src);
      return g ? g.blob : await (await fetch(src)).blob();
    }
    throw new Error("esta mensagem não tem player de áudio (nenhum controle encontrado na bolha).");
  }
  const marca = Date.now();
  AUD.capturando = true;
  let achado = {};
  try {
    cliqueReal(ctrl);
    achado = await esperarBytes(marca, AUD_ESPERA_MS);
  } finally {
    AUD.capturando = false;
    // devolve o player ao estado em que estava: pausado, do começo, sem mudo
    try {
      const p = achado.el || (AUD.play && AUD.play.el);
      if (p) { p.pause(); p.currentTime = 0; p.muted = false; }
    } catch (_) {}
  }
  if (achado.blob) return achado.blob;
  if (achado.src) return await (await fetch(achado.src)).blob();
  throw new Error(
    "pedi para reproduzir e os bytes do áudio não apareceram em " +
      Math.round(AUD_ESPERA_MS / 1000) + "s."
  );
}

/** base64 sem estourar a pilha. `String.fromCharCode(...array)` — o que
    estava aqui — quebra com RangeError acima de ~100 mil bytes, e um WAV de
    16 kHz de um minuto tem 1,9 MB. */
function paraBase64(bytes) {
  let s = "";
  const PEDACO = 0x8000;
  for (let i = 0; i < bytes.length; i += PEDACO) {
    s += String.fromCharCode.apply(null, bytes.subarray(i, i + PEDACO));
  }
  return btoa(s);
}

/* ========================================================================
   A3 — SALVAR ARQUIVO: perguntar onde, mostrar progresso, confirmar
   ------------------------------------------------------------------------
   Antes: `save_media` gravava calado em `Downloads\ZapLite`. No Windows esse
   caminho casa, sem diferenciar maiúsculas, com `Downloads\zaplite` — a
   pasta do PROJETO do usuário. A mídia dele caía dentro da árvore de código
   (ver o comentário do lado Rust, com a medição). Agora quem escolhe o
   destino é o diálogo nativo, e o fim do caminho é um aviso com botão para
   abrir o arquivo e para abrir a pasta.
   ======================================================================== */

function formatarTamanho(n) {
  if (!n) return "";
  if (n < 1024) return n + " B";
  if (n < 1024 * 1024) return (n / 1024).toFixed(0) + " KB";
  return (n / 1024 / 1024).toFixed(1) + " MB";
}

function mostrarProgresso(titulo, texto, pct) {
  const p = showPanel(titulo, texto);
  const corpo = p.querySelector(".zl-panel-body");
  const bar = document.createElement("div");
  bar.className = "zl-bar";
  const i = document.createElement("i");
  i.style.width = Math.max(0, Math.min(100, Math.round(pct || 0))) + "%";
  bar.appendChild(i);
  corpo.appendChild(bar);
  return p;
}

function fecharPainel() {
  const p = document.getElementById("zl-panel");
  if (p) p.remove();
}

function avisarSalvo(caminho, bytes) {
  const tam = bytes ? "\n" + formatarTamanho(bytes) : "";
  showPanel("Arquivo salvo", caminho + tam, [
    [
      "Abrir arquivo",
      () => invoke("abrir_arquivo", { caminho }).catch((e) => showPanel("Erro", e.message)),
    ],
    [
      "Abrir a pasta",
      () => invoke("revelar_arquivo", { caminho }).catch((e) => showPanel("Erro", e.message)),
    ],
  ]);
}

/* Downloads que a PÁGINA inicia (o botão de baixar do próprio WhatsApp)
   agora passam pelo Rust: ele desce o arquivo para uma área temporária,
   pergunta onde fica e avisa por este evento. Sem isto o WebView2 gravava
   por conta própria e o app nem ficava sabendo. */
let _ouvindoGravacao = false;
export function ouvirEventosDeGravacao() {
  if (_ouvindoGravacao) return;
  if (!window.__TAURI__ || !window.__TAURI__.event) return;
  _ouvindoGravacao = true;
  const ev = window.__TAURI__.event;
  ev.listen("zaplite://save-progress", (e) => {
    const p = (e && e.payload) || {};
    if (typeof p.pct === "number") mostrarProgresso("Salvando arquivo", "Gravando no disco…", p.pct);
  }).catch(() => {});
  ev.listen("zaplite://midia-salva", (e) => {
    const p = (e && e.payload) || {};
    if (p.erro) return showPanel("Não deu para salvar", p.erro);
    if (p.cancelado) {
      return showPanel(
        "Download descartado",
        "Você fechou a janela sem escolher onde salvar “" + (p.nome || "arquivo") +
          "”. O arquivo temporário foi apagado — nada ficou no disco."
      );
    }
    avisarSalvo(p.path, p.bytes);
  }).catch(() => {});
}

/** Lê o blob em pedaços para dar progresso de verdade em arquivo grande. */
async function bytesComProgresso(blob, titulo) {
  const total = blob.size || 0;
  if (!blob.stream || total < 4 * 1024 * 1024) {
    return new Uint8Array(await blob.arrayBuffer());
  }
  const leitor = blob.stream().getReader();
  const partes = [];
  let lido = 0;
  for (;;) {
    const passo = await leitor.read();
    if (passo.done) break;
    partes.push(passo.value);
    lido += passo.value.length;
    mostrarProgresso(titulo, "Preparando o arquivo…", (lido * 100) / total);
  }
  const out = new Uint8Array(lido);
  let off = 0;
  for (const p of partes) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

/** base64 devolvendo o controle ao navegador de tempos em tempos: um vídeo
    de 60 MB numa volta só congela a interface do WhatsApp inteira. */
async function paraBase64Async(bytes, titulo) {
  let s = "";
  const PEDACO = 0x8000;
  let desde = Date.now();
  for (let i = 0; i < bytes.length; i += PEDACO) {
    s += String.fromCharCode.apply(null, bytes.subarray(i, i + PEDACO));
    if (Date.now() - desde > 16) {
      mostrarProgresso(titulo, "Preparando o arquivo…", (i * 100) / bytes.length);
      await new Promise((r) => setTimeout(r, 0));
      desde = Date.now();
    }
  }
  return btoa(s);
}

const EXT_POR_MIME = {
  "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/gif": "gif",
  "video/mp4": "mp4", "video/webm": "webm", "video/quicktime": "mov",
  "audio/ogg": "ogg", "audio/mpeg": "mp3", "audio/mp4": "m4a", "application/pdf": "pdf",
};
function nomeSugerido(blob, prefixo) {
  const mime = String((blob && blob.type) || "").split(";")[0].trim().toLowerCase();
  const ext = EXT_POR_MIME[mime] || (mime.split("/")[1] || "bin").replace(/[^a-z0-9]/g, "");
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  const carimbo =
    d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + "-" + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds());
  return (prefixo || "zaplite") + "-" + carimbo + "." + ext;
}

/** Único caminho de "salvar um blob em disco". Devolve o caminho final, ou
    null se o usuário cancelou o diálogo. */
export async function salvarArquivo(blob, prefixo) {
  ouvirEventosDeGravacao();
  const titulo = "Salvando arquivo";
  mostrarProgresso(titulo, "Preparando o arquivo…", 0);
  const bytes = await bytesComProgresso(blob, titulo);
  const b64 = await paraBase64Async(bytes, titulo);
  mostrarProgresso(titulo, "Escolha onde salvar na janela do Windows…", 100);
  const r = await invoke("save_media", { dataB64: b64, filename: nomeSugerido(blob, prefixo) });
  if (!r || r.cancelado) {
    fecharPainel();
    return null;
  }
  avisarSalvo(r.path, r.bytes);
  return r.path;
}

/** OGG/Opus (ou mp4/aac) → WAV PCM 16 bits, 16 kHz, mono — o formato que o
    whisper.cpp quer. Feito AQUI porque a WebView2 já traz os decodificadores
    (é a mesma engine do Chrome): sem isto o app dependeria do ffmpeg
    instalado à parte, em toda máquina que receber o instalador. */
async function wav16kMono(blob) {
  const buf = await blob.arrayBuffer();
  const Off = window.OfflineAudioContext || window.webkitOfflineAudioContext;
  if (!Off) throw new Error("sem OfflineAudioContext nesta webview");
  // decodificar num contexto de 16 kHz já entrega o áudio reamostrado
  let dados = await new Off(1, 1, 16000).decodeAudioData(buf.slice(0));
  if (dados.sampleRate !== 16000) {
    const off = new Off(1, Math.max(1, Math.ceil(dados.duration * 16000)), 16000);
    const fonte = off.createBufferSource();
    fonte.buffer = dados;
    fonte.connect(off.destination);
    fonte.start();
    dados = await off.startRendering();
  }
  const n = dados.length;
  const canais = dados.numberOfChannels;
  const wav = new Uint8Array(44 + n * 2);
  const dv = new DataView(wav.buffer);
  const txt = (p, s) => { for (let i = 0; i < s.length; i++) wav[p + i] = s.charCodeAt(i); };
  txt(0, "RIFF"); dv.setUint32(4, 36 + n * 2, true); txt(8, "WAVE");
  txt(12, "fmt "); dv.setUint32(16, 16, true); dv.setUint16(20, 1, true);
  dv.setUint16(22, 1, true); dv.setUint32(24, 16000, true);
  dv.setUint32(28, 16000 * 2, true); dv.setUint16(32, 2, true); dv.setUint16(34, 16, true);
  txt(36, "data"); dv.setUint32(40, n * 2, true);
  const c0 = dados.getChannelData(0);
  const c1 = canais > 1 ? dados.getChannelData(1) : null;
  for (let i = 0; i < n; i++) {
    let v = c1 ? (c0[i] + c1[i]) / 2 : c0[i];
    v = v < -1 ? -1 : v > 1 ? 1 : v;
    dv.setInt16(44 + i * 2, v < 0 ? v * 0x8000 : v * 0x7fff, true);
  }
  return wav;
}

/** Bolha → texto. Os DOIS pontos de chamada usam esta função. */
/* Vocabulário da conversa para o prompt inicial do Whisper.
   Nomes próprios e jargão são justamente onde ele erra; dar o contexto
   antes melhora bastante o acerto. Só texto que já está na tela. */
function contextoDaConversa() {
  const partes = [];
  const titulo = document.querySelector('#main header span[title]');
  if (titulo) partes.push(titulo.getAttribute("title") || titulo.textContent || "");
  try {
    const bolhas = bolhasVisiveis().slice(-25);
    for (const b of bolhas) {
      const t = (textoDaBolha(b) || "").trim();
      if (t && t.length < 220) partes.push(t);
    }
  } catch (_) {}
  let ctx = partes.filter(Boolean).join(". ").replace(/\s+/g, " ").trim();
  if (ctx.length > 800) ctx = ctx.slice(ctx.length - 800);
  return ctx;
}

/** Segundos de áudio de uma bolha, lidos do rótulo que a página já desenha
    ("0:37"). Serve ao A5 para DESCARTAR um áudio longo ANTES de mandar a
    página reproduzi-lo — reproduzir manda o recibo de "ouvida", então
    descobrir a duração só depois seria tarde. Devolve 0 se não achar. */
export function segundosDaBolha(bolha) {
  try {
    const m = /(?:^|\s)(\d{1,2}):([0-5]\d)(?::([0-5]\d))?(?:\s|$)/.exec(bolha.textContent || "");
    if (!m) return 0;
    return m[3]
      ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3])
      : Number(m[1]) * 60 + Number(m[2]);
  } catch (_) {
    return 0;
  }
}

/** Bolha → texto transcrito. `maxSeg` (opcional) aborta antes de gastar CPU
    com whisper se o áudio decodificado passar do limite. */
export async function transcreverBolha(bolha, maxSeg) {
  const blob = await blobDoAudio(bolha);
  let b64;
  try {
    const wav = await wav16kMono(blob);
    if (maxSeg && (wav.length - 44) / 2 / 16000 > maxSeg) {
      const err = new Error("áudio mais longo que o limite de " + maxSeg + "s");
      err.zlLongoDemais = true;
      throw err;
    }
    b64 = paraBase64(wav);
  } catch (e) {
    if (e && e.zlLongoDemais) throw e;
    // decodificação falhou (formato exótico): manda o original e deixa o
    // Rust tentar o ffmpeg, que diz com todas as letras se não estiver lá.
    console.warn("[ZapLite] decodificação na página falhou:", e);
    b64 = paraBase64(new Uint8Array(await blob.arrayBuffer()));
  }
  return await invoke("transcribe_audio", { audioB64: b64, prompt: contextoDaConversa() });
}

/** Pendura o texto transcrito NA BOLHA. UM lugar só: o botão "Transcrever"
    e o A5 (transcrição automática) mostram exatamente a mesma coisa, e é
    também o que o A5 usa para saber que esta bolha já foi feita. */
export function mostrarTranscricaoNaBolha(bolha, texto, marca) {
  if (!bolha || bolha.querySelector(".zl-tr-txt")) return null;
  const out = document.createElement("div");
  out.className = "zl-recovered zl-tr-out";
  const txt = document.createElement("span");
  txt.className = "zl-tr-txt";
  txt.textContent = (marca || "📝 ") + texto;
  out.appendChild(txt);
  const cp = document.createElement("button");
  cp.className = "zl-tr-copy";
  cp.textContent = "Copiar";
  cp.title = "Copiar a transcrição";
  cp.onclick = async (ev) => {
    ev.stopPropagation();
    try {
      await navigator.clipboard.writeText(texto);
    } catch (_) {
      const r = document.createRange();
      r.selectNodeContents(txt);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(r);
    }
    cp.textContent = "Copiado!";
    setTimeout(() => {
      cp.textContent = "Copiar";
    }, 1400);
  };
  out.appendChild(cp);
  bolha.appendChild(out);
  return out;
}
