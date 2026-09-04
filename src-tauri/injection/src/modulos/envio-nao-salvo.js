import { addAct, dropAct, ensureDock } from "../dock.js";
import { reg } from "../nucleo.js";

/* 1. Enviar para número não salvo -------------------------------------- */
export function registrarEnvioNaoSalvo() {
  reg({
    id: "unsavedSend",
    apply() {
      addAct(ensureDock(), "zl-unsaved", "☎", "Enviar p/ número não salvo", "", () => {
        const raw = prompt("Número com DDI e DDD (só dígitos). Ex: 5511999998888");
        if (!raw) return;
        const num = raw.replace(/\D/g, "");
        if (num.length < 10) return alert("Número inválido.");
        location.href = "https://web.whatsapp.com/send?phone=" + num;
      });
    },
    revert() {
      dropAct("zl-unsaved");
    },
  });
}
