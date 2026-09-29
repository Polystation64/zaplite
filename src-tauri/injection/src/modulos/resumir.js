import { addAct, dropAct, ensureDock } from "../dock.js";
import { ai, coletarMensagens } from "../ia.js";
import { reg } from "../nucleo.js";
import { showPanel } from "../painel.js";

/* 12. Resumo de conversa ----------------------------------------------- */
export function registrarResumir() {
  reg({
    id: "summarize",
    apply() {
      addAct(ensureDock(), "zl-sum", "∑", "Resumir esta conversa", "", async (b) => {
        const { texto: conv, incluidas, deFora } = coletarMensagens();
        if (!conv) return showPanel("Resumo da conversa", "Abra uma conversa primeiro.");
        // Conversa longa: resume as mais recentes que cabem e DIZ isso, em vez
        // de falhar no teto de tamanho do pedido.
        const nota = deFora
          ? `\n\n— Resumo das ${incluidas} mensagens mais recentes; ${deFora} mais antigas ficaram de fora pelo limite de tamanho.`
          : "";
        showPanel("Resumo da conversa", "Resumindo…");
        try {
          const r = await ai(
            "Você resume conversas de WhatsApp em português do Brasil, de forma objetiva, em tópicos curtos. Destaque decisões, pendências e perguntas em aberto.",
            "Resuma:\n\n" + conv
          );
          showPanel("Resumo da conversa", r + nota);
        } catch (e) {
          showPanel("Resumo da conversa", "Falhou: " + (e.message || e));
        }
      });
    },
    revert() {
      dropAct("zl-sum");
    },
  });
}
