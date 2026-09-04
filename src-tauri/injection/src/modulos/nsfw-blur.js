import { bolhasVisiveis } from "../bolhas.js";
import { reg, settings, throttleComCauda } from "../nucleo.js";

/* 33. Modo NSFW — toda mídia entra borrada -----------------------------
   Regras que este módulo respeita:
   · borra CONTEÚDO, nunca a interface. Os alvos saem do helper de bolhas
     (V1) e de `img`/`video` — os ícones do WhatsApp são <svg>/[data-icon] e
     por construção nunca recebem a classe;
   · pega o que chega DEPOIS: o WhatsApp renderiza mídia sob demanda, então
     além da varredura periódica há um MutationObserver;
   · revelar é por item: passar o mouse mostra enquanto o ponteiro estiver
     ali, clicar libera aquele item até a próxima renderização. O clique NÃO
     é cancelado, senão abrir a foto pararia de funcionar (ver A2). */
const NSFW_MIN_PX = 40;   // abaixo disso é ícone/figurinha de texto
const NSFW_VARREDURA_MS = 400;
export function registrarNsfwBlur() {
  reg({
    id: "nsfwBlur",
    apply() {
      if (this._on) return;
      this._on = true;
      const self = this;

      const marcar = (el) => {
        if (!el || el.classList.contains("zl-nsfw-alvo")) return;
        try {
          if (el.closest("#zl-dock,#zl-panel,#zl-ctx,.zl-recovered")) return;
        } catch (_) {}
        const r = el.getBoundingClientRect();
        // Sem tamanho ainda (não renderizou): marca mesmo assim. O custo de
        // marcar cedo é uma classe; o de marcar tarde é a imagem aparecer nua.
        if (r.width && r.height && (r.width < NSFW_MIN_PX || r.height < NSFW_MIN_PX)) return;
        el.classList.add("zl-nsfw-alvo");
      };
      const midiasDe = (raiz) => {
        if (!raiz || !raiz.querySelectorAll) return [];
        try {
          return [].slice.call(raiz.querySelectorAll("img,video"));
        } catch (_) {
          return [];
        }
      };

      const varrer = () => {
        // 1) conteúdo de mensagem
        bolhasVisiveis().forEach((b) => midiasDe(b).forEach(marcar));
        // 2) prévia na lista de conversas (desligável em settings.nsfw.lista)
        if (!(settings.nsfw && settings.nsfw.lista === false)) {
          midiasDe(document.querySelector("#pane-side")).forEach(marcar);
        }
        // 3) visualizador em tela cheia — abrir a foto não pode desfazer o modo
        midiasDe(document.querySelector('[data-testid="media-viewer"]')).forEach(marcar);
        const modal = document.querySelector("[data-animate-modal-body]");
        if (modal) midiasDe(modal).forEach(marcar);
      };
      const pedir = throttleComCauda(varrer, NSFW_VARREDURA_MS);
      self._pedir = pedir;

      self._obs = new MutationObserver(pedir);
      self._obs.observe(document.body, { childList: true, subtree: true });
      // Rede de segurança para o que muda sem inserir nó (troca de `src`).
      self._timer = setInterval(varrer, 1500);

      self._clique = (e) => {
        const alvo = e.target && e.target.closest && e.target.closest(".zl-nsfw-alvo");
        if (alvo) alvo.classList.add("zl-nsfw-livre"); // sem preventDefault
      };
      document.addEventListener("click", self._clique, true);

      varrer();
    },
    revert() {
      if (this._obs) this._obs.disconnect();
      this._obs = null;
      if (this._pedir && this._pedir.cancelar) this._pedir.cancelar();
      clearInterval(this._timer);
      this._timer = null;
      if (this._clique) document.removeEventListener("click", this._clique, true);
      document.querySelectorAll(".zl-nsfw-alvo").forEach((e) => {
        e.classList.remove("zl-nsfw-alvo");
        e.classList.remove("zl-nsfw-livre");
      });
      this._on = false;
    },
  });
}
