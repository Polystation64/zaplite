import { invoke } from "./ponte.js";

/* --- painel flutuante para exibir resultados de IA --------------------
   `acoes` é uma lista [[rótulo, função], ...] desenhada como botões abaixo
   do texto. Existe por causa do A7: erro cru ("whisper-cli não encontrado")
   fez o usuário concluir que o recurso não existe, quando o instalador está
   dentro do binário. Uma mensagem sem caminho de saída não é um aviso, é um
   beco. */
export function showPanel(title, body, acoes) {
  let p = document.getElementById("zl-panel");
  if (!p) {
    p = document.createElement("div");
    p.id = "zl-panel";
    p.innerHTML =
      '<div class="zl-panel-head"><b></b><span class="zl-acoes"><button class="zl-copy" title="Copiar texto">Copiar</button><button class="zl-x" title="Fechar">✕</button></span></div><div class="zl-panel-body"></div>';
    document.body.appendChild(p);
    p.querySelector(".zl-x").onclick = () => p.remove();
    p.querySelector(".zl-copy").onclick = async (ev) => {
      const txt = p.querySelector(".zl-panel-body").textContent || "";
      const b = ev.currentTarget;
      try {
        await navigator.clipboard.writeText(txt);
      } catch (_) {
        /* clipboard bloqueado: seleciona para o usuário copiar na mão */
        const r = document.createRange();
        r.selectNodeContents(p.querySelector(".zl-panel-body"));
        const sel = window.getSelection();
        sel.removeAllRanges(); sel.addRange(r);
      }
      const antes = b.textContent;
      b.textContent = "Copiado!";
      setTimeout(() => { b.textContent = antes; }, 1400);
    };
  }
  p.querySelector("b").textContent = title;
  p.querySelector(".zl-panel-body").textContent = body;
  const velhas = p.querySelector(".zl-panel-acoes");
  if (velhas) velhas.remove();
  if (acoes && acoes.length) {
    const barra = document.createElement("div");
    barra.className = "zl-panel-acoes";
    acoes.forEach(([rotulo, fn]) => {
      const b = document.createElement("button");
      b.textContent = rotulo;
      b.onclick = () => {
        try {
          fn();
        } catch (e) {
          console.error("[ZapLite] ação do painel falhou:", e);
        }
      };
      barra.appendChild(b);
    });
    p.appendChild(barra);
  }
  return p;
}

/* A7 — "ainda não instalado" nunca vira erro cru: vira convite com botão que
   abre o Painel JÁ na seção de transcrição. */
export function ehFaltaDeInstalacao(e) {
  const m = (e && e.message) || String(e || "");
  return m.indexOf("[zl-setup]") >= 0;
}
function textoSemCarimbo(e) {
  return ((e && e.message) || String(e || "")).replace("[zl-setup] ", "").replace(/^transcribe_audio → /, "");
}
export function avisarInstalacaoDaTranscricao(e) {
  showPanel(
    "Transcrição ainda não instalada",
    textoSemCarimbo(e) +
      "\n\nO instalador vem dentro do ZapLite: o botão abaixo abre o Painel já na seção certa, " +
      "onde dá para baixar o motor e o modelo de voz sem sair do app.",
    [
      [
        "Instalar transcrição",
        () => invoke("open_settings", { secao: "ia" }).catch((err) => showPanel("Erro", err.message)),
      ],
    ]
  );
}
