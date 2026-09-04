import { showPanel } from "./painel.js";

// Propaga o erro de verdade. A versão antiga rejeitava em silêncio e
// fazia qualquer falha de permissão parecer "o botão não faz nada".
export async function invoke(cmd, args) {
  if (!window.__TAURI__ || !window.__TAURI__.core) {
    throw new Error("ponte nativa indisponível (window.__TAURI__ ausente)");
  }
  try {
    return await window.__TAURI__.core.invoke(cmd, args);
  } catch (e) {
    const msg =
      typeof e === "string" ? e : (e && (e.message || e.toString())) || "erro desconhecido";
    const err = new Error(cmd + " → " + msg);
    console.error("[ZapLite]", err.message);
    throw err;
  }
}

// Envolve um handler para que qualquer falha apareça na tela.
export const guarded = (fn, titulo) => async (...a) => {
  try {
    await fn(...a);
  } catch (e) {
    showPanel(titulo || "Erro", (e && e.message) || String(e));
  }
};

const notify = (title, body) => {
  try {
    window.__TAURI__.notification.sendNotification({ title, body });
  } catch (_) {}
};
