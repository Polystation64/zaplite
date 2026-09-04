import { imagemDaBolha, ultimaBolha } from "../bolhas.js";
import { addAct, dropAct, ensureDock } from "../dock.js";
import { ai, imagemEmBase64 } from "../ia.js";
import { mostrarTranscricaoNaBolha } from "../midia.js";
import { reg } from "../nucleo.js";
import { showPanel } from "../painel.js";

/* 15. OCR de imagens --------------------------------------------------
   ISTO JÁ EXISTIA, meio implementado: "Extrair texto da imagem" estava
   escrito dentro do menu do botão direito, sem interruptor, sem entrada no
   catálogo e com o seletor de <img> copiado ali mesmo. O que muda aqui:

     · vira módulo com interruptor (o menu do botão direito passa a
       perguntar `on("ocr")` antes de oferecer o item);
     · o alvo sai do helper de bolhas (`imagemDaBolha`), não de um seletor
       novo;
     · o resultado fica pendurado NA BOLHA, além do painel — um print de
       endereço ou de código PIX é justamente o que se quer copiar depois,
       e o botão de copiar já existe naquele helper;
     · CAMINHO DE VISÃO. A chamada leva imagem, e é o Rust que escolhe o
       modelo: com imagem ele usa `aiVisionModel` ("Modelo para imagem" no
       Painel). Se esse campo estiver vazio e o modelo de texto for um
       apelido `auto/*`, o `ai_complete` RECUSA com a explicação — medimos
       que o roteador descarta a imagem e responde "não recebi imagem
       nenhuma", que é uma resposta errada com cara de certa. Aqui isso
       chega como erro visível, no painel.

   GATILHO: sob demanda. Uma imagem por clique, nunca uma varredura. */
const SISTEMA =
  "Você transcreve todo o texto visível de uma imagem, preservando a ordem e as " +
  "quebras de linha. Responda só com o texto, sem comentários. Se não houver texto " +
  "nenhum, responda exatamente: (sem texto na imagem)";

/** Lê o texto de uma <img> já renderizada na página. */
export async function textoDaImagem(img) {
  const { b64, mediaType } = await imagemEmBase64(img);
  return await ai(SISTEMA, "Extraia o texto desta imagem.", { image: b64, mediaType });
}

/** OCR de UMA bolha, com o resultado no painel e na própria bolha. */
export async function ocrDaBolha(bolha) {
  const img = imagemDaBolha(bolha);
  if (!img) throw new Error("esta mensagem não tem imagem.");
  showPanel("Texto da imagem", "Lendo…");
  const t = await textoDaImagem(img);
  showPanel("Texto da imagem", t);
  mostrarTranscricaoNaBolha(bolha, t, "🔤 ");
  return t;
}

export function registrarOcr() {
  reg({
    id: "ocr",
    apply() {
      addAct(ensureDock(), "zl-ocr", "🔤", "Ler texto da última imagem", "", async () => {
        const b = ultimaBolha((x) => !!imagemDaBolha(x));
        if (!b) {
          return showPanel(
            "Texto da imagem",
            "Não achei nenhuma imagem na conversa aberta.\n\n" +
              "O WhatsApp só decifra a mídia que está na tela: role até a imagem antes de pedir."
          );
        }
        try {
          b.scrollIntoView({ block: "center" });
        } catch (_) {
          /* rolar é conforto, não requisito */
        }
        try {
          await ocrDaBolha(b);
        } catch (e) {
          showPanel("Texto da imagem", "Falhou: " + ((e && e.message) || e));
        }
      });
    },
    revert() {
      dropAct("zl-ocr");
    },
  });
}
