import { addAct, dropAct, ensureDock } from "../dock.js";
import { ai, collectVisibleMessages } from "../ia.js";
import { reg, settings } from "../nucleo.js";
import { showPanel } from "../painel.js";

/* 14. Rascunho de resposta com seu tom --------------------------------- */
export function registrarRascunhoResposta() {
  reg({
    id: "draftReply",
    apply() {
      addAct(ensureDock(), "zl-draft", "✍", "Sugerir uma resposta", "", async () => {
        const conv = collectVisibleMessages(30);
        if (!conv) return alert("Abra uma conversa primeiro.");
        showPanel("Rascunho", "Escrevendo…");
        try {
          const tone = settings.aiTone || "direto, amigável e claro";
          const r = await ai(
            `Você sugere UMA resposta curta de WhatsApp em português do Brasil, no tom ${tone}. Responda apenas com o texto da mensagem, sem aspas.`,
            "Contexto:\n" + conv + "\n\nSugira minha próxima resposta."
          );
          const box = document.querySelector('div[contenteditable="true"][data-tab]');
          if (box) {
            box.focus();
            document.execCommand("insertText", false, r.trim());
            const p = document.getElementById("zl-panel");
            if (p) p.remove();
          } else {
            showPanel("Rascunho", r);
          }
        } catch (e) {
          showPanel("Rascunho", "Falhou: " + (e.message || e));
        }
      });
    },
    revert() {
      dropAct("zl-draft");
    },
  });
}
