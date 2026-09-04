import { imagemDaBolha, ultimaBolha } from "../bolhas.js";
import { addAct, dropAct, ensureDock } from "../dock.js";
import {
  LADO,
  TETO_BYTES,
  carregarDeArquivo,
  carregarImagem,
  corDoPixel,
  desenharFigurinha,
  paraWebp,
} from "../figurinha.js";
import { salvarArquivo } from "../midia.js";
import { css, dropCss, reg } from "../nucleo.js";
import { showPanel } from "../painel.js";

/* 18. CRIADOR DE FIGURINHAS ----------------------------------------------
   Recortar, escrever e exportar .webp de figurinha (512x512, alfa), tudo no
   Canvas da própria página. O desenho e o encoder moram em `figurinha.js`,
   compartilhados com o módulo 19 — aqui é só a interface de ajuste.

   HONESTIDADE DO "REMOVE FUNDO": o que existe é remoção por COR (croma). Você
   aponta a cor do fundo na prévia, escolhe a tolerância e os pixels parecidos
   ficam transparentes. Isso resolve print com fundo liso e foto de estúdio, e
   NÃO resolve foto de rua — não há recorte de objeto aqui, e o painel diz
   isso na tela em vez de deixar a pessoa descobrir depois. A descrição do
   catálogo foi corrigida junto.

   NADA daqui envia: a figurinha pronta vai para o disco pelo mesmo diálogo de
   "salvar como" de todos os outros arquivos (`salvarArquivo` → `save_media`).
   ------------------------------------------------------------------------ */

const ID_ACT = "zl-fig";
const CSS_KEY = "zl-fig-style";

export const CSS_FIGURINHA = `
  .zl-fig-cv{width:214px;height:214px;display:block;margin:0 auto;border-radius:10px;cursor:crosshair;
    border:1px solid rgba(255,255,255,.14);
    background-color:#0b141a;
    background-image:linear-gradient(45deg,#243138 25%,transparent 25%),
      linear-gradient(-45deg,#243138 25%,transparent 25%),
      linear-gradient(45deg,transparent 75%,#243138 75%),
      linear-gradient(-45deg,transparent 75%,#243138 75%);
    background-size:16px 16px;
    background-position:0 0,0 8px,8px -8px,-8px 0}
  .zl-fig-lin{display:flex;align-items:center;gap:8px;font-size:12px}
  .zl-fig-lin > span:first-child{flex:0 0 74px;color:#8696a0}
  .zl-fig-lin input[type=range]{flex:1;accent-color:var(--zl-accent,#22d3aa);min-width:0}
  .zl-fig-cor{width:22px;height:22px;border-radius:6px;border:1px solid rgba(255,255,255,.25);flex:0 0 auto}
  .zl-fig-arq{font-size:11.5px;color:#8696a0}
  .zl-fig-arq input[type=file]{display:block;margin-top:4px;font-size:11px;max-width:100%}
  .zl-fig-b{background:rgba(255,255,255,.09);border:none;color:#e9edef;cursor:pointer;
    font-size:11.5px;padding:5px 9px;border-radius:7px;font-family:inherit}
  .zl-fig-b:hover{background:rgba(255,255,255,.16)}
`;

const AVISO_CROMA =
  "“Remover fundo” aqui é REMOÇÃO POR COR, não recorte inteligente: o ZapLite apaga os pixels " +
  "parecidos com a cor que você apontar na prévia. Funciona em fundo liso (print, fundo branco, " +
  "estúdio) e não funciona em foto de rua — não existe detecção de objeto neste app, e não vamos " +
  "fingir que existe.";

/** O estado da figurinha em edição. Um só, porque só existe um painel. */
const est = {
  img: null,
  origem: "",
  zoom: 1,
  dx: 0,
  dy: 0,
  croma: false,
  cor: { r: 255, g: 255, b: 255 },
  tolerancia: 18,
  textoTopo: "",
  textoBase: "",
};

function opcoes() {
  return {
    zoom: est.zoom,
    dx: est.dx,
    dy: est.dy,
    croma: est.croma ? { r: est.cor.r, g: est.cor.g, b: est.cor.b, tolerancia: est.tolerancia } : null,
    textoTopo: est.textoTopo,
    textoBase: est.textoBase,
  };
}

/** A última imagem renderizada da conversa aberta, ou null. */
export function ultimaImagemDaConversa() {
  const b = ultimaBolha((x) => !!imagemDaBolha(x));
  return b ? imagemDaBolha(b) : null;
}

function nomeCurto(s) {
  const t = String(s || "").trim();
  return t.length > 34 ? t.slice(0, 33) + "…" : t;
}

/** Monta (uma vez) o formulário e devolve `{ form, redesenhar }`. */
function montarFormulario(aoMudarOrigem) {
  const form = document.createElement("div");
  form.className = "zl-form";

  const cv = document.createElement("canvas");
  cv.className = "zl-fig-cv";
  cv.width = LADO;
  cv.height = LADO;

  const situacao = document.createElement("div");
  situacao.className = "zl-lim";

  function redesenhar() {
    desenharFigurinha(est.img, opcoes(), cv);
    situacao.textContent = est.img
      ? "Origem: " + est.origem + " · " + (est.img.naturalWidth || 0) + "×" +
        (est.img.naturalHeight || 0) + " px → sai 512×512 com fundo transparente."
      : "Nenhuma imagem carregada ainda. Use um dos dois botões abaixo.";
  }

  // Clicar na prévia escolhe a cor do croma — o único jeito de acertar a cor
  // do fundo sem pedir hexadecimal a quem quer só fazer uma figurinha.
  cv.onclick = (e) => {
    if (!est.img) return;
    const r = cv.getBoundingClientRect();
    const x = ((e.clientX - r.left) / r.width) * LADO;
    const y = ((e.clientY - r.top) / r.height) * LADO;
    // A cor tem que sair da imagem SEM o croma aplicado, senão a segunda
    // escolha leria um pixel que a primeira já apagou.
    const limpo = desenharFigurinha(est.img, Object.assign(opcoes(), { croma: null }));
    const c = corDoPixel(limpo, x, y);
    if (!c.a) return; // clicou no vazio: não há cor de fundo ali
    est.cor = { r: c.r, g: c.g, b: c.b };
    est.croma = true;
    sincronizar();
    redesenhar();
  };

  /* --- origem da imagem ------------------------------------------------ */
  const origem = document.createElement("div");
  origem.className = "zl-fig-arq";
  const bConversa = document.createElement("button");
  bConversa.className = "zl-fig-b";
  bConversa.type = "button";
  bConversa.textContent = "Usar a última imagem da conversa";
  bConversa.onclick = async () => {
    const img = ultimaImagemDaConversa();
    if (!img) {
      return showPanel(
        "Criador de figurinhas",
        "Nenhuma imagem renderizada na conversa aberta. A conversa é virtualizada: role até a " +
          "imagem e deixe-a carregar, ou escolha um arquivo do disco."
      );
    }
    try {
      est.img = await carregarImagem(img.src);
      est.origem = "imagem da conversa";
      aoMudarOrigem();
    } catch (e) {
      showPanel("Não deu para usar essa imagem", e.message);
    }
  };
  const arq = document.createElement("input");
  arq.type = "file";
  arq.accept = "image/*";
  arq.onchange = async () => {
    const f = arq.files && arq.files[0];
    if (!f) return;
    try {
      est.img = await carregarDeArquivo(f);
      est.origem = "arquivo " + nomeCurto(f.name);
      aoMudarOrigem();
    } catch (e) {
      showPanel("Não deu para abrir a imagem", e.message);
    }
  };
  origem.appendChild(bConversa);
  origem.appendChild(arq);

  /* --- controles ------------------------------------------------------- */
  function faixa(rotulo, min, max, passo, valor, aoMudar) {
    const l = document.createElement("div");
    l.className = "zl-fig-lin";
    const t = document.createElement("span");
    t.textContent = rotulo;
    const i = document.createElement("input");
    i.type = "range";
    i.min = String(min);
    i.max = String(max);
    i.step = String(passo);
    i.value = String(valor);
    const v = document.createElement("span");
    v.style.cssText = "flex:0 0 40px;text-align:right;color:#8696a0";
    const pintar = () => (v.textContent = i.value);
    i.oninput = () => {
      aoMudar(parseFloat(i.value));
      pintar();
      redesenhar();
    };
    pintar();
    l.appendChild(t);
    l.appendChild(i);
    l.appendChild(v);
    return { l, i };
  }

  const fZoom = faixa("zoom", 0.5, 4, 0.05, est.zoom, (v) => (est.zoom = v));
  const fX = faixa("mover ↔", -1, 1, 0.02, est.dx, (v) => (est.dx = v));
  const fY = faixa("mover ↕", -1, 1, 0.02, est.dy, (v) => (est.dy = v));

  function campo(rotulo, valor, aoMudar) {
    const l = document.createElement("div");
    l.className = "zl-fig-lin";
    const t = document.createElement("span");
    t.textContent = rotulo;
    const i = document.createElement("input");
    i.type = "text";
    i.value = valor;
    i.spellcheck = false;
    i.oninput = () => {
      aoMudar(i.value);
      redesenhar();
    };
    l.appendChild(t);
    l.appendChild(i);
    return l;
  }

  const cTopo = campo("texto topo", est.textoTopo, (v) => (est.textoTopo = v));
  const cBase = campo("texto baixo", est.textoBase, (v) => (est.textoBase = v));

  const linhaCroma = document.createElement("label");
  const chk = document.createElement("input");
  chk.type = "checkbox";
  chk.checked = est.croma;
  chk.onchange = () => {
    est.croma = chk.checked;
    redesenhar();
  };
  const amostra = document.createElement("span");
  amostra.className = "zl-fig-cor";
  linhaCroma.appendChild(chk);
  linhaCroma.appendChild(
    document.createTextNode("remover fundo pela cor (clique na prévia para escolher a cor) ")
  );
  linhaCroma.appendChild(amostra);

  const fTol = faixa("tolerância", 0, 60, 1, est.tolerancia, (v) => (est.tolerancia = v));

  const nota = document.createElement("div");
  nota.className = "zl-lim";
  nota.textContent = AVISO_CROMA;

  function sincronizar() {
    chk.checked = est.croma;
    amostra.style.background = "rgb(" + est.cor.r + "," + est.cor.g + "," + est.cor.b + ")";
    fZoom.i.value = String(est.zoom);
    fX.i.value = String(est.dx);
    fY.i.value = String(est.dy);
    fTol.i.value = String(est.tolerancia);
  }

  form.appendChild(cv);
  form.appendChild(situacao);
  form.appendChild(origem);
  form.appendChild(fZoom.l);
  form.appendChild(fX.l);
  form.appendChild(fY.l);
  form.appendChild(cTopo);
  form.appendChild(cBase);
  form.appendChild(linhaCroma);
  form.appendChild(fTol.l);
  form.appendChild(nota);

  sincronizar();
  redesenhar();
  return { form, redesenhar, sincronizar };
}

/** Salva a figurinha do estado atual. Compartilhado com o módulo 19. */
export async function salvarComoFigurinha(img, op, prefixo) {
  const cv = desenharFigurinha(img, op || {});
  const blob = await paraWebp(cv);
  const caminho = await salvarArquivo(blob, prefixo || "zaplite-figurinha");
  return { caminho, bytes: blob.size, cv };
}

/** Abre o criador. `imgInicial` deixa o módulo 19 mandar a imagem já escolhida
    para cá em vez de duplicar a interface ("ajustar antes de salvar"). */
export async function abrirCriador(imgInicial, rotuloOrigem) {
  if (imgInicial) {
    try {
      est.img = await carregarImagem(imgInicial.src || imgInicial);
      est.origem = rotuloOrigem || "imagem da conversa";
    } catch (e) {
      return showPanel("Não deu para abrir a imagem", e.message);
    }
  }
  let ui = null;
  const desenhar = () => {
    if (ui) ui.redesenhar();
  };
  ui = montarFormulario(desenhar);

  return showPanel("Criador de figurinhas", ui.form, [
    [
      "Salvar .webp",
      async () => {
        if (!est.img) {
          return showPanel(
            "Criador de figurinhas",
            "Carregue uma imagem primeiro — pelo botão “Usar a última imagem da conversa” ou " +
              "escolhendo um arquivo do disco."
          );
        }
        try {
          const r = await salvarComoFigurinha(est.img, opcoes(), "zaplite-figurinha");
          if (!r.caminho) return; // usuário cancelou o diálogo; já foi avisado
          if (r.bytes > TETO_BYTES) {
            showPanel(
              "Figurinha salva, mas grande",
              "O arquivo ficou com " + Math.round(r.bytes / 1024) + " KB, acima do teto prático de " +
                Math.round(TETO_BYTES / 1024) + " KB. Ele está no disco em 512×512, mas o " +
                "WhatsApp pode recusá-lo como figurinha. Diminua o texto ou o zoom e salve de novo."
            );
          }
        } catch (e) {
          showPanel("Não deu para gerar a figurinha", (e && e.message) || String(e));
        }
      },
    ],
    [
      "Recomeçar",
      () => {
        est.zoom = 1;
        est.dx = 0;
        est.dy = 0;
        est.croma = false;
        est.tolerancia = 18;
        est.textoTopo = "";
        est.textoBase = "";
        abrirCriador(null, est.origem);
      },
    ],
  ]);
}

export function registrarFigurinhaCriar() {
  reg({
    id: "stickerMaker",
    label: "Criador de figurinhas",
    apply() {
      css(CSS_FIGURINHA, CSS_KEY);
      addAct(ensureDock(), ID_ACT, "\u{1F3A8}", "Criador de figurinhas", "", () => abrirCriador());
    },
    revert() {
      dropAct(ID_ACT);
      dropCss(CSS_KEY);
    },
  });
}
