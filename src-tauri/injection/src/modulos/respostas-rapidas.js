import { addAct, dropAct, ensureDock } from "../dock.js";
import { reg, settings } from "../nucleo.js";
import { showPanel } from "../painel.js";
import { invoke } from "../ponte.js";

/* 03. RESPOSTAS RÁPIDAS ---------------------------------------------------
   `/pix` + espaço (ou Tab) vira o texto que o usuário cadastrou, DENTRO da
   caixa de mensagem.

   A REGRA DURA DO PROJETO, e a razão de este módulo ser pequeno: expandir é
   ESCREVER, nunca enviar. Não existe aqui nenhum `Enter` sintético, nenhum
   clique no botão de enviar, nenhum `KeyboardEvent` de tecla de envio — o
   único efeito é trocar o atalho pelo texto na caixa que o usuário está
   digitando. Quem aperta Enter é ele, olhando para o texto já expandido.
   Por isso, também, o gatilho NUNCA é Enter: se fosse, um atalho digitado por
   engano viraria mensagem enviada.

   ONDE PODE DISPARAR: só dentro da caixa de mensagem da conversa aberta
   (`#main footer [contenteditable]`). A busca de conversas e a busca dentro
   da conversa são contenteditable também, e expandir texto lá dentro seria
   um bug com cara de sabotagem — daí `ehCaixaDeMensagem`.

   A lista mora em `quickReplies`, no settings.json, e é editada no Painel.
   ------------------------------------------------------------------------ */

const ID_ACT = "zl-qr";

/** A lista cadastrada, saneada. Cada item: `{atalho:"/pix", texto:"…"}`. */
export function atalhosCadastrados() {
  const bruto = settings && settings.quickReplies;
  if (!Array.isArray(bruto)) return [];
  return bruto
    .map((r) => ({
      atalho: String((r && r.atalho) || "").trim(),
      texto: String((r && r.texto) || ""),
    }))
    .filter((r) => r.atalho && r.texto);
}

/* PURA e testada fora do navegador (`bundle.test.js`). Recebe o texto do
   início do nó até o cursor e devolve o pedaço a substituir. Separada do DOM
   de propósito: é aqui que mora a decisão de disparar ou não, e decisão que só
   dá para exercitar com um WhatsApp aberto não é decisão testada. */
export function acharAtalho(antes, atalhos, exigeEspaco) {
  const s = String(antes || "");
  // `(^|\s)` impede que "http://ola/pix" expanda: o atalho tem que começar
  // palavra. O espaço final é o gatilho de digitação; sem ele, é o Tab.
  const m = exigeEspaco
    ? s.match(/(^|\s)(\/[\w-]+)[ \u00a0]$/)
    : s.match(/(^|\s)(\/[\w-]+)$/);
  if (!m) return null;
  const alvo = m[2].toLowerCase();
  const lista = Array.isArray(atalhos) ? atalhos : [];
  for (const r of lista) {
    const a = String((r && r.atalho) || "").trim().toLowerCase();
    if (a !== alvo) continue;
    const texto = String((r && r.texto) || "");
    if (!texto) return null;
    const tamanho = m[0].length - m[1].length;
    return { inicio: s.length - tamanho, fim: s.length, texto };
  }
  return null;
}

/** É a caixa de MENSAGEM (não a busca, não um campo qualquer da página)? */
function ehCaixaDeMensagem(el) {
  if (!el || el.nodeType !== 1) return false;
  try {
    if (el.getAttribute("contenteditable") !== "true") return false;
    const main = document.querySelector("#main");
    if (!main || !main.contains(el)) return false;
    // A busca DENTRO da conversa vive no painel lateral direito, fora do
    // <footer>. A caixa de mensagem é a única contenteditable do rodapé.
    return !!el.closest("footer");
  } catch (_) {
    return false;
  }
}

/** Troca `[inicio,fim)` do nó de texto do cursor pelo texto da resposta.
    `insertText` é a MESMA operação de uma digitação: a página recebe
    `beforeinput`/`input` e atualiza o próprio estado. Escrever no `textContent`
    à mão deixaria o editor do WhatsApp com um valor que ele não conhece. */
function escreverNaCaixa(no, inicio, fim, texto) {
  const sel = window.getSelection();
  if (!sel) return false;
  const r = document.createRange();
  r.setStart(no, inicio);
  r.setEnd(no, fim);
  sel.removeAllRanges();
  sel.addRange(r);
  return document.execCommand("insertText", false, texto);
}

/* MEDIDO na prova da onda 2 (04/09/2026, sessão real, alvo contenteditable
   dentro de `#main footer`): o evento chegava CERTO —
   `isTrusted=true inputType=insertText ce=true dentroDeMain=true closestFooter=true` —,
   `acharAtalho` casava, o intervalo do atalho era selecionado… e o texto não
   trocava. A prova do quê: depois da tentativa a seleção ficava NÃO colapsada
   em offset 8, exatamente onde `escreverNaCaixa` a tinha posto. Ou seja, a
   seleção foi feita e o `insertText` de dentro dela devolveu falso.

   Causa: o Chromium recusa um `execCommand` de edição REENTRANTE, disparado
   de dentro do próprio despacho de `beforeinput`/`input`. Nada de errado com
   a decisão nem com o alvo — o que estava errado era o MOMENTO.

   Correção: a decisão continua síncrona (é ela que decide se o Tab é nosso,
   e `preventDefault` não pode esperar), mas a ESCRITA sai do despacho, num
   `setTimeout(0)`. E, como entre a decisão e a escrita a página continua
   editando, a escrita reconfere que o atalho ainda está exatamente onde
   estava antes de trocar qualquer coisa — senão desiste em silêncio. */

/** Decide, agora, se há expansão; devolve a FUNÇÃO que escreve, ou null. */
function planejarExpansao(alvo, exigeEspaco) {
  if (!ehCaixaDeMensagem(alvo)) return null;
  const sel = window.getSelection();
  if (!sel || !sel.isCollapsed || !sel.anchorNode) return null;
  const no = sel.anchorNode;
  if (no.nodeType !== 3) return null;
  if (!alvo.contains(no)) return null;
  const off = sel.anchorOffset;
  const antes = (no.textContent || "").slice(0, off);
  const achado = acharAtalho(antes, atalhosCadastrados(), exigeEspaco);
  // Atalho começando antes deste nó de texto: não dá para afirmar o que se
  // está substituindo, então não substitui nada.
  if (!achado || achado.inicio < 0) return null;
  const esperado = antes.slice(achado.inicio);
  return function escrever() {
    if (!no.parentNode) return;
    if ((no.textContent || "").slice(achado.inicio, off) !== esperado) return;
    escreverNaCaixa(no, achado.inicio, off, achado.texto);
  };
}

let ouvindo = false;
function aoDigitar(ev) {
  // Só o que o USUÁRIO digitou. Um evento sintético de outro script não
  // expande nada — e a expansão nunca nasce de um temporizador nosso.
  if (!ev.isTrusted) return;
  const alvo = ev.target;
  if (ev.type === "keydown") {
    // Enter NUNCA entra aqui. Tab é o gatilho explícito; e o
    // `preventDefault` só acontece quando há mesmo o que expandir, para
    // não sequestrar a navegação por teclado da página.
    if (ev.key !== "Tab" || ev.shiftKey || ev.ctrlKey || ev.altKey) return;
    const escrever = planejarExpansao(alvo, false);
    if (!escrever) return;
    ev.preventDefault();
    setTimeout(escrever, 0);
    return;
  }
  // `input`: o gatilho é o espaço logo depois do atalho.
  if (ev.inputType && ev.inputType.indexOf("delete") === 0) return;
  const escrever = planejarExpansao(alvo, true);
  if (escrever) setTimeout(escrever, 0);
}

function listar() {
  const lista = atalhosCadastrados();
  if (!lista.length) {
    return showPanel(
      "Respostas rápidas",
      "Nenhum atalho cadastrado ainda.\n\n" +
        "Cadastre no Painel do ZapLite, aba MÓDULOS, no bloco “Respostas rápidas”. " +
        "Depois é só digitar o atalho na caixa de mensagem e apertar espaço (ou Tab): " +
        "o texto entra na caixa — o ZapLite NUNCA envia por conta própria.",
      [["Abrir o Painel", () => invoke("open_settings", { secao: "modulos" }).catch(() => {})]]
    );
  }
  const corpo = lista
    .map((r) => r.atalho + "\n    " + r.texto.replace(/\n/g, "\n    "))
    .join("\n\n");
  return showPanel(
    "Respostas rápidas (" + lista.length + ")",
    corpo +
      "\n\n———\nDigite o atalho na caixa de mensagem e aperte espaço ou Tab. " +
      "A expansão escreve na caixa e para por aí: enviar continua sendo você.",
    [["Editar no Painel", () => invoke("open_settings", { secao: "modulos" }).catch(() => {})]]
  );
}

export function registrarRespostasRapidas() {
  reg({
    id: "quickReplies",
    label: "Respostas rápidas",
    apply() {
      addAct(ensureDock(), ID_ACT, "⚡", "Respostas rápidas", "", listar);
      if (ouvindo) return;
      ouvindo = true;
      // Captura: o editor do WhatsApp para a propagação de algumas teclas.
      document.addEventListener("keydown", aoDigitar, true);
      document.addEventListener("input", aoDigitar, true);
    },
    revert() {
      dropAct(ID_ACT);
      if (!ouvindo) return;
      ouvindo = false;
      document.removeEventListener("keydown", aoDigitar, true);
      document.removeEventListener("input", aoDigitar, true);
    },
  });
}
