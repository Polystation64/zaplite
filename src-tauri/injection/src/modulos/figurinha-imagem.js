import { imagemDaBolha } from "../bolhas.js";
import { addAct, dropAct, ensureDock } from "../dock.js";
import { LADO, TETO_BYTES, carregarImagem, desenharFigurinha, paraWebp } from "../figurinha.js";
import { salvarArquivo } from "../midia.js";
import { css, dropCss, on, reg } from "../nucleo.js";
import { showPanel } from "../painel.js";
import { CSS_FIGURINHA, abrirCriador, ultimaImagemDaConversa } from "./figurinha-criar.js";

/* 19. IMAGEM → FIGURINHA --------------------------------------------------
   O caminho CURTO: pega uma imagem que já está na conversa e a devolve como
   .webp de figurinha (512x512, fundo transparente), sem ajuste nenhum.

   NÃO DUPLICA O 18: o enquadramento, o encoder WebP e o teto de tamanho vêm
   todos de `figurinha.js`, e o botão "Ajustar antes" abre o próprio criador
   com a mesma imagem já carregada. A diferença entre os dois módulos é a
   quantidade de perguntas antes de salvar, não o código que salva.

   ENQUADRAMENTO SEM AJUSTE: a imagem inteira cabe no quadrado (contain) e o
   resto fica TRANSPARENTE — não esticada e não cortada. Foto retangular vira
   figurinha retangular com o resto vazio, que é o que o WhatsApp faz também.

   Nada é enviado: o destino é o disco, pelo diálogo de "salvar como".
   ------------------------------------------------------------------------ */

const ID_ACT = "zl-fig-img";
const CSS_KEY = "zl-fig-img-style";

/** Converte e salva. É o que o menu do botão direito e o dock chamam. */
export async function figurinhaDaImagem(img, rotulo) {
  let carregada;
  try {
    carregada = await carregarImagem(img && (img.src || img));
  } catch (e) {
    return showPanel("Não deu para usar essa imagem", (e && e.message) || String(e));
  }

  const cv = desenharFigurinha(carregada, {});
  let blob;
  try {
    blob = await paraWebp(cv);
  } catch (e) {
    return showPanel("Não deu para gerar a figurinha", (e && e.message) || String(e));
  }

  // Prévia ANTES de abrir o diálogo do Windows: salvar é a única ação
  // irreversível daqui, e ver o resultado antes é barato.
  const form = document.createElement("div");
  form.className = "zl-form";
  const prev = document.createElement("canvas");
  prev.className = "zl-fig-cv";
  prev.width = LADO;
  prev.height = LADO;
  prev.getContext("2d").drawImage(cv, 0, 0);
  prev.style.cursor = "default";
  const info = document.createElement("div");
  info.className = "zl-lim";
  info.textContent =
    "Origem: " + (rotulo || "imagem da conversa") + " (" + (carregada.naturalWidth || 0) + "×" +
    (carregada.naturalHeight || 0) + " px).\n" +
    "Saída: WebP 512×512 com fundo transparente, " + Math.round(blob.size / 1024) + " KB" +
    (blob.size > TETO_BYTES
      ? " — acima do teto prático de " + Math.round(TETO_BYTES / 1024) +
        " KB, o WhatsApp pode recusá-la como figurinha."
      : ".") +
    "\nA imagem inteira cabe no quadrado; o que sobra fica transparente, sem esticar nem cortar. " +
    "Nada é enviado: o botão abaixo abre o “salvar como” do Windows.";
  info.style.whiteSpace = "pre-wrap";
  form.appendChild(prev);
  form.appendChild(info);

  return showPanel("Imagem → figurinha", form, [
    ["Salvar .webp", () => salvarArquivo(blob, "zaplite-figurinha").catch((e) => showPanel("Erro", e.message))],
    ["Ajustar antes (criador)", () => abrirCriador(carregada, rotulo || "imagem da conversa")],
  ]);
}

function abrirPeloDock() {
  const img = ultimaImagemDaConversa();
  if (!img) {
    return showPanel(
      "Imagem → figurinha",
      "Nenhuma imagem renderizada na conversa aberta. A conversa é virtualizada e o ZapLite não a " +
        "rola sozinho: role até a imagem e deixe-a carregar. Pelo menu do botão direito você " +
        "escolhe QUAL imagem virar figurinha."
    );
  }
  return figurinhaDaImagem(img, "última imagem da conversa");
}

/** O item do menu do botão direito, quando o módulo está ligado e a bolha tem
    imagem. Chamado por `menu-contexto.js`, que é quem tem o clique. */
export function itemDeMenuFigurinha(bolha) {
  if (!on("imgToSticker")) return null;
  const img = imagemDaBolha(bolha);
  if (!img) return null;
  return ["\u{1F9E9}", "Transformar em figurinha", () => figurinhaDaImagem(img, "esta imagem")];
}

export function registrarFigurinhaImagem() {
  reg({
    id: "imgToSticker",
    label: "Imagem → figurinha",
    apply() {
      // Mesmo CSS do criador (a prévia é o mesmo canvas quadriculado). `css`
      // é idempotente por chave, então os dois módulos ligados não brigam.
      css(CSS_FIGURINHA, CSS_KEY);
      addAct(ensureDock(), ID_ACT, "\u{1F9E9}", "Última imagem → figurinha", "", abrirPeloDock);
    },
    revert() {
      dropAct(ID_ACT);
      dropCss(CSS_KEY);
    },
  });
}
