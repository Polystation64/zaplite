import { ehDeSaida, textoDaBolha, ultimaBolha } from "../bolhas.js";
import { addAct, dropAct, ensureDock } from "../dock.js";
import { ai } from "../ia.js";
import { reg } from "../nucleo.js";
import { showPanel } from "../painel.js";

/* 16. Detector de golpes ----------------------------------------------
   GATILHO: sob demanda, no botão direito da mensagem e no dock. Nada de
   varredura: um classificador rodando sozinho em cima de toda mensagem que
   chega custa uma chamada por mensagem E cria o pior resultado possível — o
   usuário passa a esperar que o aviso apareça, e a AUSÊNCIA de aviso vira
   um selo de "isto aqui é seguro" que ninguém emitiu.

   TOM — é a parte que mais importa neste módulo. O que volta é a OPINIÃO de
   um modelo de linguagem lendo texto, sem abrir link nenhum, sem consultar
   lista de fraude nenhuma e sem saber quem é o remetente. Ele erra nas duas
   direções: chama de golpe uma cobrança legítima e deixa passar um golpe bem
   escrito. Por isso:

     · o painel se chama "Opinião da IA", não "Veredito";
     · a resposta é emoldurada por um aviso FIXO, escrito por nós, que o
       modelo não pode reescrever nem suprimir — se ele fugir do formato, o
       aviso continua lá;
     · o prompt pede SINAIS e o que NÃO dá para saber daqui, em vez de um
       "sim/não". Um "não é golpe" curto é exatamente a falsa segurança que
       este módulo não pode produzir;
     · nenhum link é aberto, resolvido ou consultado — o texto vai como
       texto. Um clique de verificação é um clique num link de golpe.       */
const SISTEMA =
  "Você ajuda alguém a avaliar uma mensagem recebida no WhatsApp. Você NÃO abre links " +
  "nem consulta nada: só lê o texto. Responda em português do Brasil, em no máximo 6 " +
  "linhas curtas, neste formato:\n" +
  "Sinais de alerta: (lista curta, ou 'nenhum evidente')\n" +
  "Sinais de que pode ser legítima: (lista curta, ou 'nenhum evidente')\n" +
  "O que não dá para saber só pelo texto: (uma linha)\n" +
  "NUNCA declare que algo é seguro nem garanta que é golpe. Nunca peça dados da pessoa.";

const AVISO_TOPO =
  "OPINIÃO DE UM MODELO DE IA — não é veredito.\n" +
  "Ele leu só este texto: não abriu o link, não checou o número, não conhece o remetente.\n" +
  "Erra nos dois sentidos. Na dúvida, confirme por outro canal que você já usava antes.\n" +
  "----------------------------------------";

const AVISO_RODAPE =
  "----------------------------------------\n" +
  "Nenhum link foi aberto para produzir esta análise.\n" +
  "Regra que vale mais do que a resposta acima: ninguém legítimo pede código de\n" +
  "verificação, senha ou PIX por mensagem, com pressa.";

/** A análise crua do modelo. Sem moldura — quem mostra é quem chama. */
export async function analisarGolpe(texto) {
  return await ai(SISTEMA, "Mensagem recebida:\n\n" + texto);
}

/** Analisa um texto e mostra o resultado JÁ emoldurado pelos avisos. */
export async function checarGolpe(texto) {
  if (!texto || !texto.trim()) throw new Error("não há texto nesta mensagem para analisar.");
  showPanel("Parece golpe? — opinião da IA", AVISO_TOPO + "\n\nAnalisando…");
  const r = await analisarGolpe(texto);
  showPanel("Parece golpe? — opinião da IA", AVISO_TOPO + "\n\n" + r + "\n\n" + AVISO_RODAPE);
  return r;
}

export function registrarGolpe() {
  reg({
    id: "scamDetect",
    apply() {
      addAct(ensureDock(), "zl-golpe", "🛡", "Checar a última recebida", "", async () => {
        const b = ultimaBolha((x) => !ehDeSaida(x) && !!textoDaBolha(x));
        if (!b) {
          return showPanel(
            "Parece golpe? — opinião da IA",
            "Não achei nenhuma mensagem recebida com texto na conversa aberta."
          );
        }
        try {
          b.scrollIntoView({ block: "center" });
        } catch (_) {
          /* rolar é conforto, não requisito */
        }
        try {
          await checarGolpe(textoDaBolha(b));
        } catch (e) {
          showPanel("Parece golpe? — opinião da IA", "Falhou: " + ((e && e.message) || e));
        }
      });
    },
    revert() {
      dropAct("zl-golpe");
    },
  });
}
