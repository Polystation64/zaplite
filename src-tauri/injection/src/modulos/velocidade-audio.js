import { bolhaDe } from "../bolhas.js";
import { reg } from "../nucleo.js";
import { observarTela } from "../tela.js";

/* 21. Velocidade extra de áudio ---------------------------------------- */
export function registrarVelocidadeAudio() {
  reg({
    id: "audioSpeed",
    apply() {
      if (this._parar) return;
      const speeds = [1, 1.5, 2, 2.5, 3];
      const pendurar = () => {
        document.querySelectorAll("audio").forEach((a) => {
          if (a.dataset.zlSpeed) return;
          a.dataset.zlSpeed = "1";
          const b = document.createElement("button");
          b.className = "zl-tr-btn zl-speed-btn";
          b.textContent = "1x";
          b.onclick = () => {
            let i = speeds.indexOf(parseFloat(a.dataset.zlSpeed));
            i = (i + 1) % speeds.length;
            a.playbackRate = speeds[i];
            a.dataset.zlSpeed = String(speeds[i]);
            b.textContent = speeds[i] + "x";
          };
          const host = bolhaDe(a);
          if (host) host.appendChild(b);
        });
      };
      // Antes era um `setInterval` de 1,5 s varrendo a página inteira, mesmo
      // com a janela oculta. O observador compartilhado só roda quando a tela
      // muda (e dorme com a janela oculta — botão é só visual).
      this._parar = observarTela(pendurar);
    },
    revert() {
      if (this._parar) this._parar();
      this._parar = null;
      // Desligar tem que desfazer: tirar os botões, voltar à velocidade normal
      // e apagar a marca — senão religar o módulo não repõe os botões.
      document.querySelectorAll(".zl-speed-btn").forEach((b) => b.remove());
      document.querySelectorAll("audio[data-zl-speed]").forEach((a) => {
        a.playbackRate = 1;
        delete a.dataset.zlSpeed;
      });
    },
  });
}
