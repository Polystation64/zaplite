import { css, dropCss, reg } from "../nucleo.js";

/* 29. Blur ao perder o foco (privacidade) ------------------------------ */
export function registrarBlurPrivacidade() {
  reg({
    id: "privacyBlur",
    apply() {
      if (this._hooked) return;
      this._hooked = true;
      css("body.zl-blur #app{filter:blur(14px);transition:filter .15s}", "zl-blur-style");
      this._blur = () => document.body.classList.add("zl-blur");
      this._focus = () => document.body.classList.remove("zl-blur");
      window.addEventListener("blur", this._blur);
      window.addEventListener("focus", this._focus);
    },
    revert() {
      dropCss("zl-blur-style");
      document.body.classList.remove("zl-blur");
      window.removeEventListener("blur", this._blur);
      window.removeEventListener("focus", this._focus);
      this._hooked = false;
    },
  });
}
