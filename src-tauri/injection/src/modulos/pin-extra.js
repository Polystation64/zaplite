import { marcaDeFixada, painelDaLista } from "../lista.js";
import { observarTela } from "../tela.js";
import { addAct, dropAct, ensureDock } from "../dock.js";
import { chatIdAberto, chatIdDaLinha, linhasDaLista, nomeDaConversaAberta, nomeDaLinha } from "../lista.js";
import { cliqueReal } from "../midia.js";
import { css, dropCss, reg, settings } from "../nucleo.js";
import { showPanel } from "../painel.js";
import { invoke } from "../ponte.js";

/* 07. FIXAR SEM LIMITE ----------------------------------------------------
   O WhatsApp limita as conversas fixadas. Este módulo mantém uma segunda
   lista, LOCAL, que não tem limite e não encosta na primeira.

   POR QUE UMA FAIXA PRÓPRIA, e não reordenar a lista: a lista de conversas é
   VIRTUALIZADA — o WhatsApp monta e desmonta as linhas conforme a rolagem, e
   ele mesmo as reordena a cada mensagem que chega. Qualquer tentativa de
   empurrar linhas para cima seria desfeita pelo próprio WhatsApp no segundo
   seguinte, e brigaria com os fixados REAIS dele. A faixa fica ACIMA da lista,
   é nossa, e a lista continua sendo dele. Os fixados reais do WhatsApp não são
   tocados: este módulo nunca abre o menu nativo nem clica em "Fixar".

   CHAVE: o jid (`chatIdDaLinha`, o mesmo do `focus_chat` e das notas). Nome de
   conversa muda; id não. O nome é guardado só como RÓTULO, para a faixa ter o
   que escrever quando a linha não está renderizada — e ele é reconferido
   contra a lista sempre que a linha aparece.

   SOBREVIVE A RELOAD E A RENAVEGAÇÃO porque o dado mora no settings.json (via
   `save_module_data`, o mesmo caminho estreito dos lembretes) e porque a faixa
   é remontada por um temporizador, do mesmo jeito que o indicador das notas —
   quando o SPA recria a árvore, ela volta sozinha.

   NADA daqui abre conversa por conta própria, escreve na caixa ou envia: o
   único clique que abre uma conversa é o do usuário, no item da faixa.
   ------------------------------------------------------------------------ */

const ID_ACT = "zl-pin";
const CSS_KEY = "zl-pin-style";
const ID_FAIXA = "zl-pin-faixa";

const CSS_PIN = `
  #${ID_FAIXA}{display:flex;flex-wrap:wrap;gap:5px;padding:7px 10px;
    border-bottom:1px solid rgba(255,255,255,.09);background:rgba(34,211,170,.06);
    font-family:system-ui,sans-serif;max-height:104px;overflow:auto}
  #${ID_FAIXA} .zl-pin-tit{width:100%;font-size:10px;letter-spacing:.08em;color:#8696a0;
    text-transform:uppercase;margin-bottom:1px}
  #${ID_FAIXA} .zl-pin-chip{display:inline-flex;align-items:center;gap:5px;max-width:100%;
    padding:3px 4px 3px 8px;border-radius:99px;background:rgba(255,255,255,.08);
    border:1px solid rgba(255,255,255,.10);cursor:pointer}
  #${ID_FAIXA} .zl-pin-chip:hover{background:rgba(34,211,170,.20)}
  #${ID_FAIXA} .zl-pin-chip .nm{font-size:12px;color:#e9edef;max-width:150px;
    overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  #${ID_FAIXA} .zl-pin-chip .off{border:none;background:rgba(0,0,0,.28);color:#e9edef;
    cursor:pointer;font-size:10px;line-height:1;padding:3px 5px;border-radius:99px;font-family:inherit}
  #${ID_FAIXA} .zl-pin-chip .off:hover{background:rgba(244,63,94,.55)}
  .zl-pin-dot{position:absolute;right:3px;top:3px;font-size:9px;line-height:1;pointer-events:none;z-index:5;
    filter:drop-shadow(0 0 2px rgba(0,0,0,.7))}
`;

let timer = null;
/** Lista em memória: `[{ jid, nome }]`. Espelha `settings.pinExtra`. */
let fixados = [];

function carregar() {
  const bruto = settings.pinExtra;
  fixados = Array.isArray(bruto)
    ? bruto
        .filter((x) => x && typeof x.jid === "string" && x.jid)
        .map((x) => ({ jid: x.jid, nome: String(x.nome || "").slice(0, 80) }))
    : [];
}

async function gravar() {
  try {
    await invoke("save_module_data", { chave: "pinExtra", valor: fixados });
    settings.pinExtra = fixados;
  } catch (e) {
    showPanel("Não deu para salvar os fixados", (e && e.message) || String(e));
  }
}

export const estaFixado = (jid) => !!jid && fixados.some((f) => f.jid === jid);

/** A linha renderizada de um jid, ou null (a lista é virtualizada). */
function linhaDe(jid) {
  return linhasDaLista().find((r) => chatIdDaLinha(r) === jid) || null;
}

/** A conversa já está fixada NO WHATSAPP? Só para avisar; nunca para agir. */
function fixadoNativo(row) {
  if (!row) return false;
  try {
    return !!marcaDeFixada(row);
  } catch (_) {
    return false;
  }
}

function abrirConversa(jid, nome) {
  const row = linhaDe(jid);
  if (!row) {
    return showPanel(
      "Conversa fora da parte renderizada",
      "“" + (nome || jid) + "” continua fixada aqui, mas a linha dela não está no pedaço que o " +
        "WhatsApp desenhou agora — a lista é virtualizada e o ZapLite não a rola sozinho (rolar a " +
        "lista inteira por conta própria é o tipo de automação que chama atenção da sessão).\n\n" +
        "Role a lista até ela aparecer, ou use a busca do WhatsApp."
    );
  }
  cliqueReal(row);
}

/* --- a faixa ---------------------------------------------------------- */
function pintarFaixa() {
  const pane = painelDaLista();
  const pai = pane && pane.parentElement;
  let faixa = document.getElementById(ID_FAIXA);
  if (!pai || !fixados.length) {
    if (faixa) faixa.remove();
    return;
  }
  if (!faixa) {
    faixa = document.createElement("div");
    faixa.id = ID_FAIXA;
  }
  // Fora da lista, ACIMA dela: dentro de `#pane-side` a faixa rolaria junto e
  // sumiria — que é justamente o contrário de "fixado".
  if (faixa.parentElement !== pai || faixa.nextElementSibling !== pane) {
    pai.insertBefore(faixa, pane);
  }

  // Rótulos frescos: se a linha está renderizada, o nome dela vence o guardado.
  let mudou = false;
  for (const f of fixados) {
    const row = linhaDe(f.jid);
    const nome = row ? nomeDaLinha(row) : "";
    if (nome && nome !== f.nome) {
      f.nome = nome;
      mudou = true;
    }
  }

  const assinatura = fixados.map((f) => f.jid + String.fromCharCode(0) + f.nome).join("|");
  if (faixa.dataset.zl !== assinatura) {
    faixa.dataset.zl = assinatura;
    faixa.textContent = "";
    const tit = document.createElement("div");
    tit.className = "zl-pin-tit";
    tit.textContent = "Fixados extras do ZapLite (" + fixados.length + ") — locais, fora do limite do WhatsApp";
    faixa.appendChild(tit);
    fixados.forEach((f) => {
      const chip = document.createElement("div");
      chip.className = "zl-pin-chip";
      chip.title = "Abrir “" + (f.nome || f.jid) + "”";
      const nm = document.createElement("span");
      nm.className = "nm";
      nm.textContent = "\u{1F4CC} " + (f.nome || f.jid);
      const off = document.createElement("button");
      off.className = "off";
      off.type = "button";
      off.textContent = "✕";
      off.title = "Tirar dos fixados extras";
      off.onclick = (e) => {
        e.stopPropagation();
        desfixar(f.jid);
      };
      chip.onclick = () => abrirConversa(f.jid, f.nome);
      chip.appendChild(nm);
      chip.appendChild(off);
      faixa.appendChild(chip);
    });
  }
  if (mudou) gravar();
}

/** Marca discreta na linha da lista. Fica à DIREITA porque o ponto das notas
    já ocupa a esquerda — dois módulos ligados não podem se sobrepor. */
function pintarLinhas() {
  for (const row of linhasDaLista()) {
    const tem = estaFixado(chatIdDaLinha(row));
    const ja = row.querySelector(":scope > .zl-pin-dot");
    if (tem && !ja) {
      const d = document.createElement("span");
      d.className = "zl-pin-dot";
      d.textContent = "\u{1F4CC}";
      d.title = "Fixada extra no ZapLite (não é a fixação do WhatsApp)";
      if (getComputedStyle(row).position === "static") row.style.position = "relative";
      row.appendChild(d);
    } else if (!tem && ja) {
      ja.remove();
    }
  }
}

function pintar() {
  try {
    pintarFaixa();
    pintarLinhas();
  } catch (e) {
    console.warn("[ZapLite] pinExtra:", e && e.message);
  }
}

function limparMarcas() {
  const f = document.getElementById(ID_FAIXA);
  if (f) f.remove();
  document.querySelectorAll(".zl-pin-dot").forEach((d) => d.remove());
}

async function desfixar(jid) {
  fixados = fixados.filter((f) => f.jid !== jid);
  await gravar();
  pintar();
}

async function fixarAberta() {
  const jid = chatIdAberto();
  if (!jid) {
    return showPanel(
      "Fixar sem limite",
      "Nenhuma conversa aberta. Abra a conversa que você quer fixar — a fixação fica presa ao " +
        "identificador dela, não ao nome (nome muda, id não)."
    );
  }
  if (estaFixado(jid)) {
    await desfixar(jid);
    return showPanel("Fixados extras", "“" + (nomeDaConversaAberta() || jid) + "” saiu dos fixados extras.");
  }
  const row = linhaDe(jid);
  fixados.push({ jid, nome: nomeDaConversaAberta() || (row ? nomeDaLinha(row) : "") || jid });
  await gravar();
  pintar();
  showPanel(
    "Fixada no ZapLite",
    "“" + (nomeDaConversaAberta() || jid) + "” entrou na faixa de fixados extras, no topo da lista.\n\n" +
      (fixadoNativo(row)
        ? "Aviso: esta conversa JÁ está fixada no próprio WhatsApp. Ela vai aparecer nos dois " +
          "lugares — o ZapLite não mexeu na fixação nativa e não vai mexer.\n\n"
        : "") +
      "Isto é LOCAL: fica só nesta máquina, não é a fixação do WhatsApp e a outra pessoa não fica " +
      "sabendo. A fixação do WhatsApp continua exatamente como estava."
  );
}

function abrirGerenciador() {
  const form = document.createElement("div");
  form.className = "zl-form";

  const cab = document.createElement("div");
  cab.style.whiteSpace = "pre-wrap";
  const jid = chatIdAberto();
  cab.textContent =
    (jid
      ? "Conversa aberta: " + (nomeDaConversaAberta() || jid) +
        (estaFixado(jid) ? "\nJá está nos fixados extras." : "\nAinda não está nos fixados extras.")
      : "Nenhuma conversa aberta.") +
    "\nFixados extras agora: " + fixados.length;

  const lim = document.createElement("div");
  lim.className = "zl-lim";
  lim.textContent =
    "Esta lista é LOCAL e não tem limite. Ela não é a fixação do WhatsApp: o ZapLite nunca clica " +
    "em “Fixar conversa” no menu nativo, então os fixados de verdade continuam como estão. A " +
    "faixa fica acima da lista e sobrevive a recarregar e a renavegar, porque o que ela guarda " +
    "é o identificador da conversa, no settings.json desta máquina.";

  const lista = document.createElement("div");
  lista.className = "zl-lista";
  if (!fixados.length) {
    const v = document.createElement("div");
    v.className = "zl-lim";
    v.textContent = "Nenhuma conversa fixada aqui ainda.";
    lista.appendChild(v);
  }
  fixados.forEach((f) => {
    const it = document.createElement("div");
    it.className = "zl-item";
    const t = document.createElement("span");
    const renderizada = !!linhaDe(f.jid);
    t.textContent = (f.nome || f.jid) + (renderizada ? "" : "  (linha não renderizada agora)");
    const x = document.createElement("button");
    x.className = "zl-x2";
    x.type = "button";
    x.textContent = "tirar";
    x.onclick = async () => {
      await desfixar(f.jid);
      abrirGerenciador();
    };
    it.appendChild(t);
    it.appendChild(x);
    lista.appendChild(it);
  });

  form.appendChild(cab);
  form.appendChild(lim);
  form.appendChild(lista);

  return showPanel("Fixar sem limite (" + fixados.length + ")", form, [
    [jid && estaFixado(jid) ? "Desafixar esta conversa" : "Fixar a conversa aberta", fixarAberta],
  ]);
}

export function registrarPinExtra() {
  reg({
    id: "pinExtra",
    label: "Fixar sem limite",
    apply() {
      css(CSS_PIN, CSS_KEY);
      addAct(ensureDock(), ID_ACT, "\u{1F4CC}", "Fixados extras", "", abrirGerenciador);
      carregar();
      pintar();
      if (timer) return;
      // 1,5 s, o mesmo ritmo do indicador das notas: é o que faz a faixa
      // voltar quando o SPA recria a árvore, sem observar o documento inteiro.
      timer = observarTela(pintar);
    },
    revert() {
      dropAct(ID_ACT);
      if (timer) {
        timer();
        timer = null;
      }
      limparMarcas();
      dropCss(CSS_KEY);
    },
  });
}
