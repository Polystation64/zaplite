import { BOLHA_MIOLO, bolhasVisiveis } from "../bolhas.js";
import { ehBolhaDeAudio, mostrarTranscricaoNaBolha, transcreverBolha } from "../midia.js";
import { reg } from "../nucleo.js";
import { avisarInstalacaoDaTranscricao, ehFaltaDeInstalacao, showPanel } from "../painel.js";

/* 11. Transcrição de áudio (local, Whisper) ---------------------------- */
export function registrarTranscrever() {
  reg({
    id: "transcribe",
    apply() {
      if (this._timer) return;
      const inject = () => {
        bolhasVisiveis().forEach((bubble) => {
          if (bubble.querySelector(".zl-tr-btn") || !ehBolhaDeAudio(bubble)) return;
          const b = document.createElement("button");
          b.className = "zl-tr-btn";
          b.textContent = "📝 Transcrever";
          b.onclick = async () => {
            b.textContent = "⏳ ...";
            try {
              mostrarTranscricaoNaBolha(bubble, await transcreverBolha(bubble));
              b.remove();
            } catch (e) {
              b.textContent = "📝 Transcrever";
              // A7: "ainda não instalado" não é erro, é um passo que falta.
              if (ehFaltaDeInstalacao(e)) avisarInstalacaoDaTranscricao(e);
              else showPanel("Transcrição", (e && e.message) || String(e));
            }
          };
          (bubble.querySelector(BOLHA_MIOLO) || bubble).appendChild(b);
        });
      };
      this._timer = setInterval(inject, 1500);
    },
    revert() {
      clearInterval(this._timer);
      this._timer = null;
      document.querySelectorAll(".zl-tr-btn").forEach((e) => e.remove());
    },
  });
}
