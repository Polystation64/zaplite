import { bolhaDe, ehApagada, textoDaBolha } from "../bolhas.js";
import { ai } from "../ia.js";
import { ehBolhaDeAudio, salvarArquivo, transcreverBolha } from "../midia.js";
import { css, dropCss, moduloPorId, on, reg, settings } from "../nucleo.js";
import { avisarInstalacaoDaTranscricao, ehFaltaDeInstalacao, showPanel } from "../painel.js";
import { guarded, invoke } from "../ponte.js";

/* 32. Menu de contexto no botão direito das mensagens ------------------ */
export function registrarMenuContexto() {
  reg({
    id: "contextMenu",
    apply() {
      if (this._on) return;
      this._on = true;
      const self = this;

      css(
        `#zl-ctx{position:fixed;z-index:2147483002;min-width:206px;padding:6px;
           background:#111b21;border:1px solid rgba(255,255,255,.10);border-radius:11px;
           box-shadow:0 14px 40px rgba(0,0,0,.55);font-family:system-ui,sans-serif}
         #zl-ctx button{display:flex;align-items:center;gap:10px;width:100%;padding:8px 10px;
           border:none;background:transparent;color:#e9edef;font-size:13px;border-radius:7px;
           cursor:pointer;text-align:left;font-family:inherit}
         #zl-ctx button:hover{background:rgba(255,255,255,.07)}
         #zl-ctx .ic{width:20px;text-align:center;color:var(--zl-accent,#22d3aa)}
         #zl-ctx .hd{padding:5px 10px 7px;font-size:10.5px;color:#6b7c89;
           border-bottom:1px solid rgba(255,255,255,.07);margin-bottom:4px;
           white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:220px}`,
        "zl-ctx-style"
      );

      function fecha() {
        const m = document.getElementById("zl-ctx");
        if (m) m.remove();
      }

      function abre(x, y, titulo, itens) {
        fecha();
        const m = document.createElement("div");
        m.id = "zl-ctx";
        const hd = document.createElement("div");
        hd.className = "hd";
        hd.textContent = titulo;
        m.appendChild(hd);
        itens.forEach(([icone, rotulo, acao]) => {
          const b = document.createElement("button");
          b.innerHTML = '<span class="ic"></span><span class="lb"></span>';
          b.querySelector(".ic").textContent = icone;
          b.querySelector(".lb").textContent = rotulo;
          b.onclick = (e) => {
            e.stopPropagation();
            fecha();
            acao();
          };
          m.appendChild(b);
        });
        document.body.appendChild(m);
        // não deixa vazar para fora da tela
        const r = m.getBoundingClientRect();
        m.style.left = Math.min(x, innerWidth - r.width - 8) + "px";
        m.style.top = Math.min(y, innerHeight - r.height - 8) + "px";
      }

      self._close = fecha;
      document.addEventListener("click", fecha);
      document.addEventListener("scroll", fecha, true);

      self._handler = (ev) => {
        const bolha = bolhaDe(ev.target);
        if (!bolha) return; // fora de mensagem, deixa o menu nativo
        ev.preventDefault();
        ev.stopPropagation();

        const texto = textoDaBolha(bolha);
        // V2: nada de `querySelector("audio")` aqui — o mesmo helper do botão
        // da bolha decide o que é áudio e de onde vêm os bytes. Seletor
        // duplicado é o que faz um cisma do WhatsApp quebrar os dois de uma vez.
        const audio = ehBolhaDeAudio(bolha);
        const img = bolha.querySelector('img[src^="blob:"], img[src^="data:"]');
        const video = bolha.querySelector('video[src^="blob:"], video source[src^="blob:"]');
        const itens = [];

        /* A6 — "ver mensagem apagada". Só aparece quando ESTA bolha está
           marcada como apagada; se não temos o texto, o item continua
           aparecendo, mas dizendo por quê (a alternativa — sumir — faz o
           usuário achar que o recurso não existe, que foi exatamente o que
           aconteceu com a transcrição). */
        if (ehApagada(bolha)) {
          const ad = moduloPorId("antiDelete");
          const guardado = ad ? ad.textoGuardado(bolha) : "";
          if (guardado) {
            itens.push([
              "🕵",
              "Ver mensagem apagada",
              () => {
                if (ad) ad.revelarNaBolha(bolha, guardado);
                showPanel("Mensagem apagada", guardado);
              },
            ]);
          } else if (!on("antiDelete")) {
            itens.push([
              "🕵",
              "Mensagem apagada (módulo desligado)",
              () =>
                showPanel(
                  "Mensagem apagada",
                  "O módulo Anti-apagadas está desligado, então o ZapLite não guardou o texto desta mensagem.\n\n" +
                    "Ligue-o no Painel para que as próximas mensagens apagadas possam ser lidas.",
                  [["Abrir o Painel", () => invoke("open_settings", { secao: "mods" }).catch(() => {})]]
                ),
            ]);
          } else {
            itens.push([
              "🕵",
              "Mensagem apagada (sem cópia)",
              () =>
                showPanel(
                  "Mensagem apagada",
                  "Esta mensagem foi apagada antes de o ZapLite vê-la na tela — o texto original nunca chegou aqui, " +
                    "então não há o que mostrar.\n\nO ZapLite só guarda o que passou pela conversa aberta com ele rodando."
                ),
            ]);
          }
        }

        if (audio) {
          itens.push([
            "📝",
            "Transcrever este áudio",
            guarded(async () => {
              showPanel("Transcrição", "Transcrevendo…");
              try {
                showPanel("Transcrição", await transcreverBolha(bolha));
              } catch (e) {
                if (ehFaltaDeInstalacao(e)) return avisarInstalacaoDaTranscricao(e);
                throw e;
              }
            }, "Transcrição"),
          ]);
        }

        if (img) {
          itens.push([
            "🔤",
            "Extrair texto da imagem",
            guarded(async () => {
              showPanel("Texto da imagem", "Lendo…");
              const b = await (await fetch(img.src)).blob();
              const b64 = await new Promise((r) => {
                const fr = new FileReader();
                fr.onload = () => r(String(fr.result).split(",")[1]);
                fr.readAsDataURL(b);
              });
              const t = await ai(
                "Você transcreve todo o texto visível de uma imagem. Responda só com o texto, sem comentários.",
                "Extraia o texto desta imagem.",
                { image: b64, mediaType: b.type || "image/jpeg" }
              );
              showPanel("Texto da imagem", t);
            }, "OCR"),
          ]);
          itens.push([
            "💾",
            "Salvar imagem…",
            guarded(async () => {
              await salvarArquivo(await (await fetch(img.src)).blob(), "zaplite-imagem");
            }, "Salvar imagem"),
          ]);
        }

        if (video) {
          itens.push([
            "💾",
            "Salvar vídeo…",
            guarded(async () => {
              const src = video.src || (video.getAttribute && video.getAttribute("src")) || "";
              if (!src) throw new Error("não achei os bytes deste vídeo na página.");
              await salvarArquivo(await (await fetch(src)).blob(), "zaplite-video");
            }, "Salvar vídeo"),
          ]);
        }

        if (texto) {
          itens.push([
            "⧉",
            "Copiar texto",
            () => navigator.clipboard.writeText(texto).catch(() => {}),
          ]);
          itens.push([
            "🌐",
            "Traduzir para português",
            guarded(async () => {
              showPanel("Tradução", "Traduzindo…");
              const t = await ai(
                "Você traduz mensagens para português do Brasil. Responda só com a tradução.",
                texto
              );
              showPanel("Tradução", t);
            }, "Tradução"),
          ]);
          itens.push([
            "✍",
            "Responder com sugestão da IA",
            guarded(async () => {
              showPanel("Rascunho", "Escrevendo…");
              const tom = settings.aiTone || "direto, amigável e claro";
              const r = await ai(
                `Você sugere UMA resposta curta de WhatsApp em português do Brasil, no tom ${tom}. Responda apenas com o texto da mensagem.`,
                "Responder a esta mensagem:\n" + texto
              );
              const cx = document.querySelector('div[contenteditable="true"][data-tab]');
              if (cx) {
                cx.focus();
                document.execCommand("insertText", false, r.trim());
                const p = document.getElementById("zl-panel");
                if (p) p.remove();
              } else showPanel("Rascunho", r);
            }, "Sugestão"),
          ]);
          itens.push([
            "🛡",
            "Isso parece golpe?",
            guarded(async () => {
              showPanel("Análise", "Analisando…");
              const t = await ai(
                "Você avalia se uma mensagem é golpe, phishing ou fraude. Responda em português do Brasil, em até 4 linhas: veredito e os sinais que o justificam.",
                texto
              );
              showPanel("Análise", t);
            }, "Análise"),
          ]);
        }

        if (!itens.length) return;
        const titulo = texto ? texto.slice(0, 40) : audio ? "Mensagem de voz" : "Mídia";
        abre(ev.clientX, ev.clientY, titulo, itens);
      };

      document.addEventListener("contextmenu", self._handler, true);
    },

    revert() {
      if (this._handler) document.removeEventListener("contextmenu", this._handler, true);
      if (this._close) this._close();
      dropCss("zl-ctx-style");
      this._on = false;
    },
  });
}
