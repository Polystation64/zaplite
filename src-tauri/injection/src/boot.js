import { montarDock, mountHeaderButton } from "./dock.js";
import { instalarAberturaDeLinks, instalarLinksProfundos, preencherRascunhoPendente } from "./links.js";
import { ouvirEventosDeGravacao } from "./midia.js";
import { applyAll, settings, until } from "./nucleo.js";
import { invoke } from "./ponte.js";


export async function boot() {
  try {
    // O initialization_script roda antes da página existir, então
    // esperamos o body antes de tocar em qualquer coisa do DOM.
    const body = await until(() => document.body, 30000);
    if (!body) {
      console.error("[ZapLite] body nunca apareceu; abortando.");
      return;
    }

    montarDock();
    mountHeaderButton();
    // A1/A3: precisa estar ouvindo ANTES de o usuário clicar em qualquer
    // botão de baixar do WhatsApp — o aviso de "salvo" vem do Rust por
    // evento, e um listener registrado tarde perde o primeiro download.
    ouvirEventosDeGravacao();
    // A2: não é módulo — link que não abre é defeito, não preferência.
    instalarAberturaDeLinks();
    // P2/P3: idem. Um link `whatsapp://` tem que abrir a conversa mesmo com
    // todos os módulos desligados, então isto não passa pelo `applyAll`.
    // O rascunho vem PRIMEIRO: se esta página é o resultado da navegação que
    // nós mesmos fizemos, o texto do link já está esperando no
    // `sessionStorage` e a caixa é o único lugar para onde ele pode ir —
    // preencher, jamais enviar.
    preencherRascunhoPendente();
    instalarLinksProfundos();
    await applyAll();

    // O WhatsApp é um SPA e às vezes recria a árvore. Se o dock ou o botão
    // do cabeçalho sumirem, remonta e reaplica os módulos.
    const guard = new MutationObserver(() => {
      if (!document.getElementById("zl-dock")) {
        montarDock();
        applyAll();
      }
      if (!document.getElementById("zl-hdr")) mountHeaderButton();
    });
    guard.observe(document.body, { childList: true, subtree: true });

    // Atalho local: Ctrl+Shift+Z abre o Painel.
    window.addEventListener("keydown", (e) => {
      if (e.ctrlKey && e.shiftKey && (e.key === "Z" || e.key === "z")) {
        e.preventDefault();
        invoke("open_settings").catch(() => {});
      }
    });

    console.log(
      "[ZapLite] pronto. Ponte nativa:",
      !!window.__TAURI__,
      "| módulos ligados:",
      Object.entries(settings.modules || {})
        .filter(([, v]) => v)
        .map(([k]) => k)
        .join(", ") || "nenhum"
    );
  } catch (e) {
    console.error("[ZapLite] falha no boot:", e);
  }
}
