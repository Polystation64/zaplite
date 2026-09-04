/* ========================================================================
   LINHAS DA LISTA DE CONVERSAS (#pane-side) — UM lugar só
   ------------------------------------------------------------------------
   Mesma razão de existir do helper de bolhas: estes seletores e estas
   medições estavam TODOS dentro do módulo de notificações, e o resumo
   diário precisa exatamente deles (nome da conversa, prévia, autor, rótulo
   de hora). Uma segunda cópia divergiria no primeiro cisma do WhatsApp — e
   quem quebraria primeiro seria o módulo que ninguém está olhando.

   As medições citadas nos comentários abaixo são as originais, feitas no DOM
   real da sessão logada; nada aqui foi reescrito na mudança de arquivo.
   ======================================================================== */

/** As linhas da lista de conversas, na ordem em que o WhatsApp as desenha
    (mais recente primeiro). Lista VIRTUALIZADA: só existe aqui o que está
    renderizado, e é honesto que seja assim — quem chama sabe o tamanho. */
export function linhasDaLista() {
  const pane = document.querySelector("#pane-side");
  if (!pane) return [];
  try {
    return [...pane.querySelectorAll('[role="listitem"], [role="row"]')];
  } catch (_) {
    return [];
  }
}

// Nome da conversa: só do bloco de TÍTULO da linha, nunca da prévia.
export function nomeDaLinha(row) {
  const t =
    row.querySelector('[data-testid="cell-frame-title"] span[title]') ||
    row.querySelector('[role="gridcell"][aria-colindex="2"] span[title]');
  return t ? (t.getAttribute("title") || t.textContent || "").trim() : "";
}

// U3: horário QUE O WHATSAPP MOSTRA NA LINHA — é o horário da mensagem,
// não o do disparo da notificação. Medido: "16:35" para hoje, "07/08/2026"
// para conversa antiga. Se não vier, o Rust cai na hora do disparo.
export function horaDaLinha(row) {
  const el =
    row.querySelector('[data-testid="cell-frame-primary-detail"]') ||
    row.querySelector('[role="gridcell"][aria-colindex="2"] [data-testid*="detail"]');
  const t = el ? (el.textContent || "").trim() : "";
  return t.length <= 24 ? t : "";
}

// V2 — o rótulo da linha diz que a última mensagem é DE AGORA?
//   true  → relógio de hoje, a partir do instante em que passamos a olhar
//   false → "Ontem", "quarta-feira", "07/08/2026", ou hora anterior ao
//           início: é conversa não lida ANTIGA, não notifica
//   null  → não deu para afirmar (sem rótulo / formato desconhecido)
// Fora do bundle isto é testado por `bundle.test.js`.
export function rotuloIndicaNovo(rotulo, desde, agora) {
  const t = String(rotulo || "").trim();
  if (!t) return null;
  const m = t.match(/^(\d{1,2}):(\d{2})\s*([apAP])\.?\s*[mM]?\.?$|^(\d{1,2}):(\d{2})$/);
  if (!m) return false; // rótulo que é DATA (dia da semana, "Ontem", dd/mm)
  const h0 = m[1] !== undefined ? +m[1] : +m[4];
  const min = m[2] !== undefined ? +m[2] : +m[5];
  if (!(h0 >= 0 && h0 <= 23 && min >= 0 && min <= 59)) return null;
  let h = h0;
  const suf = (m[3] || "").toLowerCase();
  if (suf === "p" && h < 12) h += 12;
  if (suf === "a" && h === 12) h = 0;
  const dDesde = new Date(desde);
  const dAgora = new Date(agora);
  // Virou o dia desde que começamos a olhar: um relógio só pode ser de
  // hoje, então é novo. Melhor notificar do que perder mensagem.
  if (dDesde.toDateString() !== dAgora.toDateString()) return true;
  const alvo = new Date(agora);
  alvo.setHours(h, min, 0, 0);
  // 90s de folga: o rótulo tem resolução de minuto e a varredura corre
  // junto com a subida do app.
  return alvo.getTime() >= desde - 90000;
}

// Marcas de direção de texto (U+200e/f, U+202a-e, U+2066-9) que o
// WhatsApp embrulha em volta da prévia. São invisíveis, mas quebram
// qualquer comparação de string — e era numa comparação dessas que a
// extração do autor morria.
export function limparTexto(s) {
  return (s || "")
    .replace(/[\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

// Prévia da última mensagem (o texto que o remetente controla).
export function previaDaLinha(row) {
  const sec = row.querySelector('[data-testid="cell-frame-secondary"]');
  const alvo = (sec && (sec.querySelector("span[title]") || sec.querySelector("span"))) || null;
  if (alvo) return limparTexto(alvo.getAttribute("title") || alvo.textContent);
  const spans = [...row.querySelectorAll("span")];
  return spans.length > 1 ? limparTexto(spans[spans.length - 1].textContent) : "";
}

// W3 — QUEM FALOU no grupo, lido da ESTRUTURA da linha, não de texto.
//
// Medido no DOM real da sessão logada (16/08, 69 linhas, 32 grupos):
// dentro de `[data-testid="cell-frame-secondary"]` existe
// `span[data-testid="last-msg-status"]`, e em GRUPO seus filhos DIRETOS
// são, nesta ordem:
//   [0] <div>…<span dir="auto">Marcelo</span></div>   ← o autor
//   [1] <span>":&nbsp;"</span>                         ← o separador
//   [2] <span dir="ltr|auto">texto da mensagem</span>
// Em conversa 1:1 o filho [0] JÁ É o texto (medido: nenhum separador de
// topo), então esta função devolve "" e nenhum autor é inventado.
//
// Por que a tentativa anterior falhava SEMPRE, apesar de "passar" em
// teste sintético: ela casava `sec.innerText` contra a prévia, e o
// CONTADOR de não lidas (`span[data-testid="icon-unread-count"]`) também
// mora dentro de `cell-frame-secondary`. Medido: innerText
// "Pai : Figurinha 1" contra prévia "Figurinha" — a guarda reprovava e o
// autor era descartado. Exatamente as linhas COM mensagem nova, que são
// as únicas que notificam.
// O `textContent` de um nó inclui o <title> dos SVGs decorativos que o
// WhatsApp põe na linha. Medido em produção: o ícone de "entregue" fez o
// autor sair como `"wds-ic-deliveredVocê"`. Ícone não é texto — some.
export function textoSemIcone(n) {
  if (!n) return "";
  if (n.nodeType !== 1) return n.textContent || "";
  try {
    const c = n.cloneNode(true);
    c.querySelectorAll('svg, [aria-hidden="true"], [data-testid="chat-msg-symbol"]').forEach(
      (x) => x.remove()
    );
    return c.textContent || "";
  } catch (_) {
    return n.textContent || "";
  }
}

export function autorDaLinha(row) {
  try {
    const sec = row.querySelector('[data-testid="cell-frame-secondary"]');
    if (!sec) return "";
    const host = sec.querySelector('[data-testid="last-msg-status"]');
    if (!host) return "";
    const kids = [...host.childNodes];
    let sep = -1;
    for (let i = 0; i < kids.length && i < 5; i++) {
      const t = textoSemIcone(kids[i]).replace(/[\s\u00a0]/g, "");
      if (t === ":") {
        sep = i;
        break;
      }
      // bloco longo antes de qualquer ":" é a mensagem, não um autor
      if (t.length > 48) break;
    }
    // sep === 0 significa que a própria mensagem começa com ":": não há
    // bloco de autor antes dela.
    if (sep < 1) return "";
    return limparTexto(kids.slice(0, sep).map(textoSemIcone).join(""))
      .replace(/:$/, "")
      .trim()
      .slice(0, 60);
  } catch (_) {
    return "";
  }
}

/** Identificador ESTÁVEL da conversa, lido da linha da lista.
    O WhatsApp Web não põe o jid em atributo nenhum, mas o item da lista
    virtualizada tem chave de React `chat-<jid>` (ex.: `chat-1276...@lid`,
    `chat-5521...@g.us`). Medido na lista real: 69 linhas, 69 ids, 0 duplicados.
    É isso que o clique do toast usa — casar por NOME é indefensável, porque o
    nome de uma conversa pode ser reproduzido no CORPO de uma mensagem por
    qualquer remetente (medido: 139 `span[title]` para 69 conversas, 70 deles
    prévias).

    Mora AQUI, e não dentro do módulo de notificações, porque as notas por
    contato, os lembretes e as ações em massa precisam da mesma chave. */
export function chatIdDaLinha(row) {
  if (!row) return "";
  try {
    const k = Object.keys(row).find((x) => x.startsWith("__reactFiber$"));
    if (!k) return "";
    let f = row[k];
    for (let i = 0; i < 8 && f; i++) {
      if (typeof f.key === "string" && f.key.startsWith("chat-")) return f.key.slice(5);
      f = f.return;
    }
  } catch (_) {}
  return "";
}

/** A linha da conversa ABERTA agora. A marca vem da própria linha
    (`aria-selected`), nunca de comparar o título do cabeçalho com o nome da
    conversa: comparação por nome deixa um remetente escolher o texto certo e
    se passar por outra conversa. */
export function linhaSelecionada() {
  return (
    linhasDaLista().find(
      (r) =>
        r.querySelector('[aria-selected="true"]') || r.getAttribute("aria-selected") === "true"
    ) || null
  );
}

/** O jid da conversa ABERTA, ou "" quando nenhuma está. Mesmo id que o
    `focus_chat` usa. É a chave das notas por contato: o nome muda, o id não. */
export function chatIdAberto() {
  return chatIdDaLinha(linhaSelecionada());
}

/** O nome da conversa aberta, para EXIBIR (nunca para identificar). Vem do
    cabeçalho do painel de mensagens; cai na linha selecionada se o cabeçalho
    mudar de forma. */
export function nomeDaConversaAberta() {
  try {
    const h = document.querySelector("#main header");
    if (h) {
      const t =
        h.querySelector('[data-testid="conversation-info-header-chat-title"]') ||
        h.querySelector("span[title]");
      const s = t ? (t.getAttribute("title") || t.textContent || "").trim() : "";
      if (s) return s;
    }
  } catch (_) {}
  const sel = linhaSelecionada();
  return sel ? nomeDaLinha(sel) : "";
}
