/* ========================================================================
   BOLHAS DE MENSAGEM — UM lugar só (V1)
   ------------------------------------------------------------------------
   O seletor `div.message-in, div.message-out` estava COPIADO em 8 pontos
   (anti-apagadas x3, transcrição, collectVisibleMessages x2, velocidade de
   áudio, menu do botão direito, camada de conexão). Medido no DOM real da
   sessão logada em 16/08/2026, com conversa aberta e cheia:

       div.message-in   = 0        .message-in       = 0
       div.message-out  = 0        [class*=message-] = 0

   Ou seja: a classe SUMIU do WhatsApp Web, e por isso "Resumir esta
   conversa" respondia "Abra uma conversa primeiro" com a conversa aberta.
   O que existe hoje (mesma medição, 8 a 25 bolhas por conversa em 16
   conversas diferentes):

       #main div[role="row"] > div[data-id][data-testid^="conv-msg-"]
       ├─ [data-testid="msg-container"]   ← a bolha desenhada
       ├─ [data-pre-plain-text]           ← "[13:38, 15/08/2026] Fulano: "
       ├─ span.selectable-text / [data-testid="selectable-text"]
       └─ [data-icon="tail-in"] | [data-icon="tail-out"]  (só na 1a do grupo)

   As classes CSS de hoje são atômicas e ofuscadas (`x1n2onr6 xscbp6u`),
   idênticas para entrada e saída: não dá para tirar direção delas. Direção
   medida por três sinais independentes, nesta ordem de confiança:

     1. `tail-in` / `tail-out` (só na primeira bolha de cada bloco);
     2. GEOMETRIA — medido: bolha de entrada encosta na esquerda do painel
        (folga 62 px, constante) e a de saída na direita (folga 67 px,
        constante). É o sinal que nenhum remetente consegue forjar;
     3. `aria-label="Você:"` e os rótulos de status (" Entregue ", " Lida ")
        que só existem em bolha de saída.

   Cada função abaixo degrada sozinha: some um sinal, os outros seguram. */
const BOLHA_SEL = [
  "div.message-in",
  "div.message-out",
  '[data-testid^="conv-msg-"]',
  '#main div[role="row"] [data-id]',
].join(",");
export const BOLHA_MIOLO = '[data-testid="msg-container"]';
const TAIL_SEL = '[data-icon^="tail-"],[data-testid^="tail-"]';
// ORDEM importa: `querySelector` com vírgula devolve o primeiro nó na ordem
// do DOCUMENTO, não o primeiro seletor da lista — e `.copyable-text` é o
// ENVOLTÓRIO do texto (traz o horário e o status junto). Por isso a busca é
// seletor a seletor, do mais específico para o mais frouxo.
const TEXTO_SELS = ["span.selectable-text", '[data-testid="selectable-text"]', ".copyable-text"];
const META_SEL = '[data-testid="msg-meta"],[data-testid="msg-status"]';

function painelDasBolhas() {
  return (
    document.querySelector('[data-testid="conversation-panel-messages"]') ||
    document.querySelector("#main") ||
    null
  );
}
/** É mesmo uma bolha, e não um pedaço de uma? */
function ehBolha(el) {
  if (!el || el.nodeType !== 1) return false;
  try {
    if (el.classList.contains("message-in") || el.classList.contains("message-out")) return true;
    const tid = el.getAttribute("data-testid") || "";
    if (tid.indexOf("conv-msg-") === 0) return true;
    // `[data-id]` seco só vale dentro de uma linha do painel de mensagens
    if (!el.hasAttribute("data-id")) return false;
    return !!el.closest('#main div[role="row"], [data-testid="conversation-panel-messages"]');
  } catch (_) {
    return false;
  }
}
/** Bolhas renderizadas dentro de `raiz` (documento inteiro por padrão).
    Dedupe e sem aninhadas: uma citação dentro de outra bolha não vira bolha. */
export function bolhasEm(raiz) {
  const r = raiz || document;
  let achadas = [];
  try {
    if (r.nodeType === 1 && ehBolha(r)) achadas.push(r);
    if (r.querySelectorAll) achadas = achadas.concat([...r.querySelectorAll(BOLHA_SEL)]);
  } catch (_) {
    return [];
  }
  const out = [];
  for (const el of achadas) {
    if (!ehBolha(el)) continue;
    if (out.indexOf(el) >= 0) continue;
    // se já temos um ancestral dela na lista, ela é parte de uma bolha
    if (out.some((j) => j !== el && j.contains(el))) continue;
    for (let i = out.length - 1; i >= 0; i--) if (el.contains(out[i])) out.splice(i, 1);
    out.push(el);
  }
  return out;
}
/** Todas as bolhas da conversa aberta, na ordem em que estão na tela. */
export function bolhasVisiveis() {
  const p = painelDasBolhas();
  const dentro = p ? bolhasEm(p) : [];
  // Fallback: se o painel mudar de nome, ainda achamos as bolhas soltas.
  return dentro.length ? dentro : bolhasEm(document);
}
/** A bolha que contém `el` (para `closest`, nos módulos de áudio e menu). */
export function bolhaDe(el) {
  if (!el || !el.closest) return null;
  let cand;
  try {
    cand = el.closest(BOLHA_SEL);
  } catch (_) {
    return null;
  }
  while (cand && !ehBolha(cand)) cand = cand.parentElement && cand.parentElement.closest(BOLHA_SEL);
  return cand || null;
}
/** Mensagem enviada por MIM? Três sinais, o mais confiável primeiro. */
export function ehDeSaida(bolha) {
  if (!bolha) return false;
  try {
    if (bolha.classList.contains("message-out")) return true;
    if (bolha.classList.contains("message-in")) return false;
    const tail = bolha.querySelector(TAIL_SEL);
    if (tail) {
      const v = tail.getAttribute("data-icon") || tail.getAttribute("data-testid") || "";
      if (v.indexOf("tail-out") === 0) return true;
      if (v.indexOf("tail-in") === 0) return false;
    }
    // Geometria: de que lado do painel a bolha está desenhada.
    const p = painelDasBolhas();
    const miolo = bolha.querySelector(BOLHA_MIOLO) || bolha;
    if (p) {
      const rb = miolo.getBoundingClientRect();
      const rp = p.getBoundingClientRect();
      if (rb.width > 8 && rp.width > 8) {
        const esq = rb.left - rp.left;
        const dir = rp.right - rb.right;
        if (Math.abs(esq - dir) > 24) return dir < esq;
      }
    }
    // Último recurso: rótulos que só existem em bolha de saída.
    const al = bolha.querySelector(
      '[aria-label^="Você:"],[aria-label^="Voce:"],[aria-label^="You:"],[data-icon^="status-"],[data-icon^="msg-"]'
    );
    return !!al;
  } catch (_) {
    return false;
  }
}
/** O texto da mensagem — nunca o `textContent` da bolha inteira, que traz
    hora, nome do autor e o <title> dos ícones decorativos. */
export function textoDaBolha(bolha) {
  if (!bolha) return "";
  try {
    for (const sel of TEXTO_SELS) {
      const el = bolha.querySelector(sel);
      if (!el || !el.textContent) continue;
      if (sel !== ".copyable-text") return el.textContent;
      // Envoltório: sai o bloco de hora/status antes de ler o texto.
      try {
        const c = el.cloneNode(true);
        c.querySelectorAll(META_SEL).forEach((x) => x.remove());
        return c.textContent || "";
      } catch (_) {
        return el.textContent;
      }
    }
    return "";
  } catch (_) {
    return "";
  }
}
/** Identificador estável da mensagem (chave do anti-apagadas). */
export function idDaBolha(bolha) {
  if (!bolha) return "";
  try {
    const id = bolha.getAttribute("data-id");
    if (id) return id;
    const tid = bolha.getAttribute("data-testid") || "";
    return tid.indexOf("conv-msg-") === 0 ? tid.slice(9) : "";
  } catch (_) {
    return "";
  }
}

/** A6 — a bolha está marcada como apagada? UM lugar só: o módulo
    anti-apagadas e o menu do botão direito faziam (fariam) a mesma pergunta,
    e seletor/regex duplicado é como um cisma do WhatsApp quebra os dois de
    uma vez (ver V1/V2 acima). */
const APAGADA_RE = /apagada|apagou esta mensagem|deleted|se eliminó|this message was deleted/i;
export function ehApagada(bolha) {
  if (!bolha) return false;
  try {
    const c = bolha.cloneNode(true);
    c.querySelectorAll(".zl-recovered").forEach((x) => x.remove());
    return APAGADA_RE.test(c.textContent || "");
  } catch (_) {
    return APAGADA_RE.test((bolha.textContent || ""));
  }
}
