import { bolhaDe } from "../bolhas.js";
import { reg } from "../nucleo.js";

/* 21. Velocidade extra de áudio ---------------------------------------- */
export function registrarVelocidadeAudio() {
  reg({
    id: "audioSpeed",
    apply() {
      if (this._timer) return;
      const speeds = [1, 1.5, 2, 2.5, 3];
      this._timer = setInterval(() => {
        document.querySelectorAll("audio").forEach((a) => {
          if (a.dataset.zlSpeed) return;
          a.dataset.zlSpeed = "1";
          const b = document.createElement("button");
          b.className = "zl-tr-btn";
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
      }, 1500);
    },
    revert() {
      clearInterval(this._timer);
      this._timer = null;
    },
  });
}
