import { addAct, dropAct, ensureDock } from "../dock.js";
import { ai, collectVisibleMessages } from "../ia.js";
import { reg } from "../nucleo.js";
import { showPanel } from "../painel.js";

/* 12. Resumo de conversa ----------------------------------------------- */
export function registrarResumir() {
  reg({
    id: "summarize",
    apply() {
      addAct(ensureDock(), "zl-sum", "∑", "Resumir esta conversa", "", async (b) => {
        const conv = collectVisibleMessages();
        if (!conv) return alert("Abra uma conversa primeiro.");
        showPanel("Resumo da conversa", "Resumindo…");
        try {
          const r = await ai(
            "Você resume conversas de WhatsApp em português do Brasil, de forma objetiva, em tópicos curtos. Destaque decisões, pendências e perguntas em aberto.",
            "Resuma:\n\n" + conv
          );
          showPanel("Resumo da conversa", r);
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
