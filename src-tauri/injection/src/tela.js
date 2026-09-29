/* Um observador compartilhado; efeitos visuais dormem com a janela oculta.
   Cada assinante tem exclusao de sobreposicao e uma ultima rodada pendente. */
const leitores = new Set();
let observer = null, fallback = null, timer = null;
/* Classes `zl-` que penduramos em nós do PRÓPRIO WhatsApp (body, linha da
   lista, img). Não fazem o nó virar "nosso": sem esta lista, o `zl-blur` no
   <body> sem classe fazia TODA mutação da página ser ignorada com a janela
   sem foco. Classe nova aplicada com `classList.add` em nó alheio entra
   aqui — o bundle.test.js falha se faltar. */
export const MARCADORES_EM_NO_ALHEIO = new Set(["zl-blur", "zl-bsc-alvo", "zl-nsfw-alvo", "zl-nsfw-livre"]);
function nosso(no) {
  const sel = '[id^="zl-"],[class^="zl-"]';
  const el = no && (no.nodeType === 1 ? no : no.parentElement);
  let r = el && el.closest ? el.closest(sel) : null;
  while (r) {
    if (r.tagName !== "BODY" && r.tagName !== "HTML") {
      if (String(r.id || "").startsWith("zl-")) return true;
      const c = r.classList && r.classList[0];
      if (c && c.startsWith("zl-") && !MARCADORES_EM_NO_ALHEIO.has(c)) return true;
    }
    const pai = r.parentElement;
    r = pai && pai.closest ? pai.closest(sel) : null;
  }
  return false;
}
/* Digitar muta o campo a cada tecla (texto e spans). Nenhum assinante
   depende do que está dentro de um campo editável, e sem este corte os
   assinantes rodavam a cada ~300 ms enquanto se escrevia. */
function editavel(no) {
  const el = no && (no.nodeType === 1 ? no : no.parentElement);
  return !!(el && el.isContentEditable);
}
function relevante(m) {
  if (nosso(m.target) || editavel(m.target)) return false;
  if (m.type === "childList") {
    const nos = [...m.addedNodes, ...m.removedNodes];
    if (nos.length && nos.every(nosso)) return false;
  }
  return true;
}
/* Intervalo mínimo entre duas rodadas do MESMO assinante. Sem ele, com a
   página agitada ("digitando…", presença, áudio tocando) a varredura inteira
   da lista rodava ~3x/s — mais que os 1,2–1,5 s dos intervalos que o
   observador substituiu. Quem precisa de mais pressa (NSFW) pede menos. */
const MIN_PADRAO_MS = 1000;
function pedir() {
  if (timer) return;
  timer = setTimeout(() => { timer = null; leitores.forEach(agendar); }, 300);
}
/* Roda agora se o intervalo mínimo já passou; senão, marca UMA rodada para
   quando passar — a última mudança nunca fica sem varredura. */
function agendar(item) {
  if (!leitores.has(item) || (!item.background && document.hidden)) return;
  if (item.espera) return;
  const falta = item.ultimo + item.minMs - Date.now();
  if (falta > 0) {
    item.espera = setTimeout(() => { item.espera = null; rodar(item); }, falta);
    return;
  }
  rodar(item);
}
async function rodar(item) {
  if (!leitores.has(item) || (!item.background && document.hidden)) return;
  if (item.running) { item.again = true; return; }
  item.running = true;
  item.ultimo = Date.now();
  try { await item.fn(); } catch (e) { console.warn("[ZapLite] atualizar tela", e); }
  finally {
    item.running = false;
    // Só ESTE assinante repete; antes o `pedir()` aqui rodava todos de novo.
    if (item.again) { item.again = false; agendar(item); }
  }
}
export function observarTela(fn, background = false, minMs = MIN_PADRAO_MS) {
  const item = { fn, background, minMs, ultimo: 0, espera: null, running: false, again: false };
  leitores.add(item);
  if (!observer && document.body) {
    observer = new MutationObserver(ms => { if (ms.some(relevante)) pedir(); });
    observer.observe(document.body, {subtree:true, childList:true, characterData:true, attributes:true,
      attributeFilter:["aria-label","aria-selected","data-id","data-testid","src","title"]});
    document.addEventListener("visibilitychange", pedir);
    fallback = setInterval(pedir, 6000);
  }
  rodar(item);
  return () => {
    leitores.delete(item);
    clearTimeout(item.espera); item.espera = null;
    if (!leitores.size) {
      if (observer) observer.disconnect(); observer = null;
      clearInterval(fallback); fallback = null;
      clearTimeout(timer); timer = null;
      document.removeEventListener("visibilitychange", pedir);
    }
  };
}
