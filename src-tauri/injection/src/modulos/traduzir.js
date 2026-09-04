import { ehDeSaida, textoDaBolha, ultimaBolha } from "../bolhas.js";
import { addAct, dropAct, ensureDock } from "../dock.js";
import { ai, cfgIa } from "../ia.js";
import { mostrarTranscricaoNaBolha } from "../midia.js";
import { reg } from "../nucleo.js";
import { showPanel } from "../painel.js";

/* 13. Tradução --------------------------------------------------------
   GATILHO: SOB DEMANDA, sempre. Nunca automático, e o módulo nem tem modo
   automático para desligar. A conta é simples e foi ela que decidiu:
   traduzir tudo o que chega é UMA chamada de IA POR MENSAGEM. Numa lista de
   grupos ativos isso é dezenas de chamadas por minuto ao provedor pago do
   usuário, num serviço que ele não pediu, para traduzir mensagens que já
   estão no idioma dele — porque quem manda a mensagem escolhe o idioma, e o
   ZapLite não tem como saber de antemão que uma mensagem precisa de
   tradução sem gastar uma chamada perguntando.

   Dois pontos de entrada, ambos um clique explícito:
     · botão direito na mensagem → "Traduzir para <idioma>";
     · dock → "Traduzir a última recebida", para quem prefere teclado/menu.

   O resultado vai para o painel E fica pendurado na bolha (mesmo helper da
   transcrição, com o botão de copiar que já existe lá). */
export const IDIOMA_PADRAO = "português do Brasil";

/** O texto traduzido, sem efeito nenhum na tela. Separado do resto para o
    caso de outro módulo precisar do texto e não do painel. */
export async function traduzir(texto, idioma) {
  const alvo = idioma || cfgIa().traduzirPara;
  return await ai(
    `Você traduz mensagens de WhatsApp para ${alvo}. Responda SÓ com a tradução, ` +
      "sem aspas, sem comentários e sem explicar. Se a mensagem já estiver nesse " +
      "idioma, responda com ela mesma.",
    texto
  );
}

/** Traduz UMA bolha e mostra o resultado nos dois lugares. Chamado pelo menu
    do botão direito e pela entrada do dock — um lugar só, para os dois. */
export async function traduzirBolha(bolha) {
  const texto = textoDaBolha(bolha);
  if (!texto) throw new Error("esta mensagem não tem texto para traduzir.");
  const alvo = cfgIa().traduzirPara;
  showPanel("Tradução → " + alvo, "Traduzindo…");
  const t = await traduzir(texto, alvo);
  showPanel("Tradução → " + alvo, t);
  mostrarTranscricaoNaBolha(bolha, t, "🌐 ");
  return t;
}

export function registrarTraduzir() {
  reg({
    id: "translate",
    apply() {
      addAct(ensureDock(), "zl-tr-lang", "🌐", "Traduzir a última recebida", "", async () => {
        // "recebida": traduzir a própria mensagem que você acabou de escrever
        // seria o caso mais inútil possível, e é o mais fácil de acertar por
        // engano logo depois de enviar.
        const b = ultimaBolha((x) => !ehDeSaida(x) && !!textoDaBolha(x));
        if (!b) {
          return showPanel(
            "Tradução",
            "Não achei nenhuma mensagem recebida com texto na conversa aberta.\n\n" +
              "Abra a conversa e role até a mensagem — só o que está na tela pode ser lido."
          );
        }
        try {
          b.scrollIntoView({ block: "center" });
        } catch (_) {
          /* rolar é conforto, não requisito */
        }
        try {
          await traduzirBolha(b);
        } catch (e) {
          showPanel("Tradução", "Falhou: " + ((e && e.message) || e));
        }
      });
    },
    revert() {
      dropAct("zl-tr-lang");
    },
  });
}
