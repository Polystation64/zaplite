import { bolhasVisiveis } from "../bolhas.js";
import { addAct, dropAct, ensureDock } from "../dock.js";
import {
  chatIdDaLinha,
  horaDaLinha,
  linhasDaLista,
  nomeDaConversaAberta,
  nomeDaLinha,
  previaDaLinha,
} from "../lista.js";
import { cliqueReal } from "../midia.js";
import { css, dropCss, reg } from "../nucleo.js";
import { showPanel } from "../painel.js";
import { dadosDaBolha } from "./exportar.js";

/* 10. BUSCA AVANÇADA ------------------------------------------------------
   Filtra por texto, remetente, data e tipo de mídia.

   O LIMITE ESTRUTURAL, dito na tela ANTES e DEPOIS de buscar: a lista de
   conversas e o painel de mensagens do WhatsApp são VIRTUALIZADOS. Só existe
   no DOM o que está renderizado — medido na lista real do usuário:
   `#pane-side` com scrollHeight 13024 para clientHeight 831 e 71 linhas no
   DOM, para ~181 conversas. Buscar "no histórico" daqui é impossível sem
   rolar a conversa inteira por conta própria, que é exatamente a automação que
   os outros módulos deste app se recusam a fazer (ela dispara carregamento em
   massa e chama atenção da sessão).

   Então esta busca faz o que dá e DIZ o tamanho do que fez: quantas mensagens
   e quantas conversas foram varridas, e quantas ficaram de fora do filtro de
   data por não terem carimbo legível. Um número na tela é a diferença entre
   "não achei" e "não procurei aí".

   NADA daqui envia, escreve na caixa ou marca mensagem como lida. Clicar num
   resultado de mensagem só ROLA até ela; clicar num resultado de conversa
   clica na linha — é o usuário abrindo a conversa dele.
   ------------------------------------------------------------------------ */

const ID_ACT = "zl-busca";
const CSS_KEY = "zl-busca-style";

const CSS_BUSCA = `
  .zl-bsc-lin{display:flex;align-items:center;gap:8px;font-size:12px}
  .zl-bsc-lin > span:first-child{flex:0 0 76px;color:#8696a0}
  .zl-bsc-lin input,.zl-bsc-lin select{flex:1;min-width:0;box-sizing:border-box;
    background:#0b141a;color:#e9edef;font-family:inherit;font-size:12.5px;
    border:1px solid rgba(255,255,255,.14);border-radius:8px;padding:6px 8px}
  .zl-bsc-hit{display:block;width:100%;text-align:left;font-family:inherit;cursor:pointer;
    background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.08);color:#e9edef;
    border-radius:8px;padding:6px 8px;font-size:12px;line-height:1.4}
  .zl-bsc-hit:hover{background:rgba(34,211,170,.16)}
  .zl-bsc-hit b{color:var(--zl-accent,#22d3aa);font-weight:700}
  .zl-bsc-hit i{color:#8696a0;font-style:normal;font-size:10.5px}
  .zl-bsc-alvo{outline:3px solid var(--zl-accent,#22d3aa) !important;outline-offset:2px;
    border-radius:8px;transition:outline-color .3s}
`;

const AVISO =
  "Escopo real: só o que está RENDERIZADO. A lista de conversas e a conversa aberta são " +
  "virtualizadas e o ZapLite não as rola sozinho — role até onde quiser ANTES de buscar e os " +
  "números abaixo sobem. Isto não busca no histórico do WhatsApp, e nenhum resultado aqui vem " +
  "de servidor nenhum.";

const TIPOS = [
  ["", "qualquer coisa"],
  ["texto", "só texto (sem mídia)"],
  ["imagem", "imagem"],
  ["vídeo", "vídeo"],
  ["áudio", "áudio"],
  ["documento", "documento"],
];

/* PURA e testada por `bundle.test.js`. Texto comparável: sem acento, sem caixa.
   Sem isto "cafe" não acha "café" e a busca parece quebrada. */
export function normalizar(s) {
  return String(s || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();
}

/* PURA e testada. Uma data em número comparável (AAAAMMDD), aceitando o que o
   `data-pre-plain-text` do WhatsApp entrega ("15/08/2026", "15/08/26") e o que
   o `<input type=date>` entrega ("2026-08-15"). Devolve 0 quando não dá para
   afirmar — e quem chama trata 0 como "sem data", nunca como "não casou". */
export function dataComparavel(s) {
  const t = String(s || "").trim();
  if (!t) return 0;
  let m = t.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) return +m[1] * 10000 + +m[2] * 100 + +m[3];
  m = t.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2}|\d{4})$/);
  if (!m) return 0;
  const dia = +m[1];
  const mes = +m[2];
  let ano = +m[3];
  if (ano < 100) ano += 2000;
  if (dia < 1 || dia > 31 || mes < 1 || mes > 12) return 0;
  return ano * 10000 + mes * 100 + dia;
}

/* PURA e testada. `f`: { texto, remetente, de, ate, tipo }.
   Devolve { casa, semData } — `semData` é true quando havia filtro de data e a
   mensagem não tinha carimbo legível. Essas não casam, mas são CONTADAS e
   relatadas: uma mensagem descartada em silêncio é uma mentira por omissão. */
export function casaMensagem(msg, f) {
  const alvoTexto = normalizar(f.texto);
  if (alvoTexto && normalizar(msg.texto).indexOf(alvoTexto) < 0) return { casa: false, semData: false };

  const alvoQuem = normalizar(f.remetente);
  if (alvoQuem && normalizar(msg.autor).indexOf(alvoQuem) < 0) return { casa: false, semData: false };

  if (f.tipo) {
    if (f.tipo === "texto") {
      if (msg.midia) return { casa: false, semData: false };
    } else if (msg.midia !== f.tipo) {
      return { casa: false, semData: false };
    }
  }

  const de = dataComparavel(f.de);
  const ate = dataComparavel(f.ate);
  if (de || ate) {
    const d = dataComparavel(msg.data);
    if (!d) return { casa: false, semData: true };
    if (de && d < de) return { casa: false, semData: false };
    if (ate && d > ate) return { casa: false, semData: false };
  }
  return { casa: true, semData: false };
}

/* PURA e testada. A linha da lista casa? Aqui NÃO há filtro de data: o rótulo
   da linha é "16:35" ou "Ontem" — não é a data da conversa, é a da última
   mensagem, e frequentemente nem é data. Fingir filtrar conversa por data
   seria inventar precisão que o DOM não tem. */
export function casaConversa(conv, f) {
  const alvoTexto = normalizar(f.texto);
  if (alvoTexto) {
    if (
      normalizar(conv.nome).indexOf(alvoTexto) < 0 &&
      normalizar(conv.previa).indexOf(alvoTexto) < 0
    ) {
      return false;
    }
  }
  const alvoQuem = normalizar(f.remetente);
  if (alvoQuem && normalizar(conv.nome).indexOf(alvoQuem) < 0) return false;
  return true;
}

/** As mensagens renderizadas COM o elemento ao lado, para poder rolar até ele.
    Usa `dadosDaBolha` do exportador: uma leitura de bolha só, no app inteiro. */
function varrerMensagens() {
  const out = [];
  for (const bolha of bolhasVisiveis()) {
    const d = dadosDaBolha(bolha);
    if (d) out.push({ msg: d, el: bolha });
  }
  return out;
}

function varrerConversas() {
  return linhasDaLista()
    .map((r) => ({
      jid: chatIdDaLinha(r),
      nome: nomeDaLinha(r) || "(sem nome)",
      previa: previaDaLinha(r),
      hora: horaDaLinha(r),
      el: r,
    }))
    .filter((c) => c.jid);
}

let alvoAceso = null;
function acender(el) {
  if (alvoAceso) alvoAceso.classList.remove("zl-bsc-alvo");
  alvoAceso = el;
  el.classList.add("zl-bsc-alvo");
  try {
    el.scrollIntoView({ block: "center", behavior: "smooth" });
  } catch (_) {
    el.scrollIntoView();
  }
  setTimeout(() => {
    if (alvoAceso === el) {
      el.classList.remove("zl-bsc-alvo");
      alvoAceso = null;
    }
  }, 4000);
}

function trecho(texto, alvo) {
  const t = String(texto || "");
  if (!alvo) return t.slice(0, 120);
  const i = normalizar(t).indexOf(normalizar(alvo));
  if (i < 0) return t.slice(0, 120);
  const ini = Math.max(0, i - 30);
  return (ini ? "…" : "") + t.slice(ini, ini + 120);
}

function abrir() {
  const form = document.createElement("div");
  form.className = "zl-form";

  function linha(rotulo, el) {
    const l = document.createElement("div");
    l.className = "zl-bsc-lin";
    const t = document.createElement("span");
    t.textContent = rotulo;
    l.appendChild(t);
    l.appendChild(el);
    return l;
  }
  function entrada(tipo, ph) {
    const i = document.createElement("input");
    i.type = tipo;
    if (ph) i.placeholder = ph;
    i.spellcheck = false;
    return i;
  }

  const iTexto = entrada("text", "palavra ou trecho");
  const iQuem = entrada("text", "nome do remetente");
  const iDe = entrada("date");
  const iAte = entrada("date");
  const iTipo = document.createElement("select");
  TIPOS.forEach(([v, r]) => {
    const o = document.createElement("option");
    o.value = v;
    o.textContent = r;
    iTipo.appendChild(o);
  });
  const iOnde = document.createElement("select");
  [
    ["ambos", "conversa aberta + lista"],
    ["mensagens", "só a conversa aberta"],
    ["conversas", "só a lista de conversas"],
  ].forEach(([v, r]) => {
    const o = document.createElement("option");
    o.value = v;
    o.textContent = r;
    iOnde.appendChild(o);
  });

  const escopo = document.createElement("div");
  escopo.className = "zl-lim";
  const contarEscopo = () => {
    const m = varrerMensagens().length;
    const c = varrerConversas().length;
    escopo.textContent =
      "Varre agora: " + m + " mensagens renderizadas em “" + (nomeDaConversaAberta() || "nenhuma conversa aberta") +
      "” e " + c + " conversas renderizadas na lista.\n\n" + AVISO;
  };
  escopo.style.whiteSpace = "pre-wrap";
  contarEscopo();

  const resultados = document.createElement("div");
  resultados.className = "zl-lista";
  resultados.style.display = "none";

  form.appendChild(linha("contém", iTexto));
  form.appendChild(linha("remetente", iQuem));
  form.appendChild(linha("de (data)", iDe));
  form.appendChild(linha("até (data)", iAte));
  form.appendChild(linha("tipo", iTipo));
  form.appendChild(linha("onde", iOnde));
  form.appendChild(escopo);
  form.appendChild(resultados);

  function buscar() {
    const f = {
      texto: iTexto.value,
      remetente: iQuem.value,
      de: iDe.value,
      ate: iAte.value,
      tipo: iTipo.value,
    };
    const onde = iOnde.value;
    resultados.textContent = "";
    resultados.style.display = "flex";

    const msgs = onde === "conversas" ? [] : varrerMensagens();
    const convs = onde === "mensagens" ? [] : varrerConversas();
    let semData = 0;
    const achouMsg = [];
    for (const m of msgs) {
      const r = casaMensagem(m.msg, f);
      if (r.semData) semData++;
      if (r.casa) achouMsg.push(m);
    }
    const achouConv = convs.filter((c) => casaConversa(c, f));

    const resumo = document.createElement("div");
    resumo.className = "zl-lim";
    resumo.style.whiteSpace = "pre-wrap";
    resumo.textContent =
      "Varridas " + msgs.length + " mensagens e " + convs.length + " conversas (só o renderizado).\n" +
      "Achadas: " + achouMsg.length + " mensagens e " + achouConv.length + " conversas." +
      (semData
        ? "\n" + semData + " mensagens ficaram FORA do filtro de data por não terem carimbo legível " +
          "na bolha (o WhatsApp só põe data em algumas). Sem filtro de data elas voltam a ser vistas."
        : "") +
      (iDe.value || iAte.value
        ? "\nO filtro de data NÃO vale para a lista de conversas: o rótulo da linha (“16:35”, " +
          "“Ontem”) é da última mensagem e quase nunca é uma data."
        : "");
    resultados.appendChild(resumo);

    if (!achouMsg.length && !achouConv.length) {
      const v = document.createElement("div");
      v.className = "zl-lim";
      v.textContent = "Nada casou dentro do que estava renderizado. Role a conversa (ou a lista) e busque de novo.";
      resultados.appendChild(v);
      return;
    }

    achouConv.forEach((c) => {
      const b = document.createElement("button");
      b.className = "zl-bsc-hit";
      b.type = "button";
      const t = document.createElement("b");
      t.textContent = "conversa · " + c.nome;
      const d = document.createElement("div");
      d.textContent = trecho(c.previa, f.texto);
      const h = document.createElement("i");
      h.textContent = c.hora ? " " + c.hora : "";
      b.appendChild(t);
      b.appendChild(h);
      b.appendChild(d);
      b.onclick = () => cliqueReal(c.el);
      b.title = "Abrir esta conversa";
      resultados.appendChild(b);
    });

    achouMsg.forEach((m) => {
      const b = document.createElement("button");
      b.className = "zl-bsc-hit";
      b.type = "button";
      const t = document.createElement("b");
      t.textContent = (m.msg.autor || (m.msg.saida ? "Você" : "recebida")) + (m.msg.midia ? " · " + m.msg.midia : "");
      const h = document.createElement("i");
      h.textContent = " " + [m.msg.hora, m.msg.data].filter(Boolean).join(", ");
      const d = document.createElement("div");
      d.textContent = trecho(m.msg.texto, f.texto);
      b.appendChild(t);
      b.appendChild(h);
      b.appendChild(d);
      b.onclick = () => acender(m.el);
      b.title = "Rolar até esta mensagem (não abre nem marca nada)";
      resultados.appendChild(b);
    });
  }

  iTexto.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      buscar();
    }
  });

  const p = showPanel("Busca avançada", form, [
    ["Buscar", buscar],
    ["Recontar o escopo", contarEscopo],
  ]);
  setTimeout(() => iTexto.focus(), 0);
  return p;
}

export function registrarBuscaAvancada() {
  reg({
    id: "advSearch",
    label: "Busca avançada",
    apply() {
      css(CSS_BUSCA, CSS_KEY);
      addAct(ensureDock(), ID_ACT, "\u{1F50E}", "Busca avançada", "", abrir);
    },
    revert() {
      dropAct(ID_ACT);
      if (alvoAceso) {
        alvoAceso.classList.remove("zl-bsc-alvo");
        alvoAceso = null;
      }
      dropCss(CSS_KEY);
    },
  });
}
