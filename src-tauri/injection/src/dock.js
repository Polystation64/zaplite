import { css, flushCss, settings } from "./nucleo.js";
import { showPanel } from "./painel.js";
import { invoke } from "./ponte.js";

/* --- estilos base dos nossos elementos ------------------------------- */
const BASE_CSS = `
    #zl-dock{position:fixed;right:0;top:50%;transform:translateY(-50%);z-index:2147483000;
      display:flex;align-items:flex-end;flex-direction:column;gap:0;font-family:system-ui,sans-serif}
    #zl-tab{width:34px;height:64px;border:none;cursor:pointer;color:#04120e;font-weight:800;
      font-size:17px;border-radius:12px 0 0 12px;background:var(--zl-accent,#22d3aa);
      box-shadow:-3px 0 14px rgba(0,0,0,.35);display:grid;place-items:center;
      transition:width .12s}
    #zl-tab:hover{width:40px}
    #zl-menu{display:none;flex-direction:column;gap:2px;margin-top:8px;padding:8px;
      background:#111b21;border:1px solid rgba(255,255,255,.10);border-radius:12px 0 0 12px;
      box-shadow:-6px 0 26px rgba(0,0,0,.5);min-width:214px}
    #zl-dock.open #zl-menu{display:flex}
    .zl-act{display:flex;align-items:center;gap:10px;width:100%;padding:9px 11px;border:none;
      background:transparent;color:#e9edef;font-size:13px;border-radius:8px;cursor:pointer;
      text-align:left;font-family:inherit}
    .zl-act:hover{background:rgba(255,255,255,.07)}
    .zl-act .ic{width:22px;text-align:center;font-size:14px;color:var(--zl-accent,#22d3aa);flex:0 0 auto}
    .zl-act .kbd{margin-left:auto;font-size:10px;color:#6b7c89;font-family:ui-monospace,monospace}
    .zl-sep{height:1px;background:rgba(255,255,255,.08);margin:5px 4px}
    .zl-note{padding:6px 11px 2px;font-size:10.5px;color:#6b7c89;line-height:1.4}

    .zl-tr-btn{margin:4px 6px 0;padding:2px 8px;font-size:11px;border:none;border-radius:8px;
      cursor:pointer;background:var(--zl-accent,#22d3aa);color:#04120e;opacity:.9;font-weight:600}
    .zl-recovered{margin-top:4px;padding:4px 8px;font-size:12.5px;border-radius:8px;
      background:rgba(34,211,170,.12);color:inherit;
      user-select:text;-webkit-user-select:text;cursor:text}
    .zl-tr-copy{display:inline-block;margin-left:6px;vertical-align:middle;
      background:rgba(34,211,170,.25);border:none;color:inherit;cursor:pointer;
      font-size:10.5px;font-weight:700;padding:2px 7px;border-radius:6px;user-select:none}
    .zl-tr-copy:hover{background:rgba(34,211,170,.45)}
    #zl-panel{position:fixed;right:60px;bottom:20px;width:340px;max-height:60vh;z-index:2147483001;
      display:flex;flex-direction:column;background:#111b21;color:#e9edef;border-radius:14px;
      box-shadow:0 12px 40px rgba(0,0,0,.5);overflow:hidden;border:1px solid rgba(255,255,255,.08)}
    .zl-panel-head{display:flex;justify-content:space-between;align-items:center;
      padding:10px 14px;background:var(--zl-accent,#22d3aa);color:#04120e;font-weight:600}
    .zl-panel-head .zl-x{background:none;border:none;color:#04120e;cursor:pointer;font-size:14px}
    .zl-panel-body{padding:12px 14px;overflow:auto;white-space:pre-wrap;line-height:1.45;font-size:13.5px;user-select:text;-webkit-user-select:text;cursor:text}
    .zl-acoes{display:flex;align-items:center;gap:8px}
    .zl-panel-head .zl-copy{background:rgba(4,18,14,.14);border:none;color:#04120e;cursor:pointer;font-size:11.5px;font-weight:700;padding:3px 9px;border-radius:7px}
    .zl-panel-head .zl-copy:hover{background:rgba(4,18,14,.26)}
    .zl-panel-acoes{display:flex;gap:8px;flex-wrap:wrap;padding:0 14px 12px}
    .zl-panel-acoes button{background:var(--zl-accent,#22d3aa);color:#04120e;border:none;cursor:pointer;
      font-size:12px;font-weight:700;padding:7px 12px;border-radius:8px;font-family:inherit}
    .zl-panel-acoes button:hover{filter:brightness(1.1)}
    .zl-bar{margin-top:10px;height:8px;border-radius:99px;background:rgba(255,255,255,.13);overflow:hidden}
    .zl-bar i{display:block;height:100%;background:var(--zl-accent,#22d3aa);transition:width .1s linear}

    /* A4 — modo NSFW. O borrão vai SÓ nos elementos que o JS marcou (mídia
       dentro de bolha, prévia da lista, visualizador); a interface do WhatsApp
       usa <svg>/[data-icon], que nunca recebem a classe. */
    .zl-nsfw-alvo{filter:blur(20px) !important;transition:filter .12s ease}
    .zl-nsfw-alvo:hover{filter:blur(0) !important}
    .zl-nsfw-alvo.zl-nsfw-livre{filter:none !important}
  `;

/* --- o dock: uma aba fixa na borda direita que abre o menu ------------ */
export function ensureDock() {
  if (document.getElementById("zl-dock")) return escoarActs(document.getElementById("zl-menu"));
  if (!document.body) return null;

  const dock = document.createElement("div");
  dock.id = "zl-dock";
  dock.innerHTML =
    '<button id="zl-tab" title="ZapLite (Ctrl+Shift+Z)">Z</button>' +
    '<div id="zl-menu"></div>';
  document.body.appendChild(dock);

  const tab = dock.querySelector("#zl-tab");
  tab.onclick = (e) => {
    e.stopPropagation();
    dock.classList.toggle("open");
  };
  // clicar fora fecha
  document.addEventListener("click", (e) => {
    if (!dock.contains(e.target)) dock.classList.remove("open");
  });

  const menu = dock.querySelector("#zl-menu");

  // O Painel é sempre a primeira entrada e nunca some.
  addAct(menu, "zl-open-panel", "⚙", "Painel do ZapLite", "Ctrl+Shift+Z", () =>
    invoke("open_settings").catch((e) => showPanel("Erro", e.message))
  );
  const sep = document.createElement("div");
  sep.className = "zl-sep";
  sep.id = "zl-sep";
  menu.appendChild(sep);

  if (!window.__TAURI__) {
    const n = document.createElement("div");
    n.className = "zl-note";
    n.textContent =
      "Ponte com o app indisponível: os módulos nativos não vão responder.";
    menu.appendChild(n);
  }
  return escoarActs(menu);
}

/* Monta o dock e as entradas que NÃO são módulo (Painel, dentro do
   `ensureDock`, e Diagnóstico). Idempotente e sem exigir ordem: qualquer
   caminho que precise do dock pronto chama isto — o boot, o observer que
   remonta depois de o SPA recriar a árvore, e o `applyAll` (que também é
   chamado pelo Rust, ao salvar settings, quando o boot pode nem ter
   acontecido). Antes existiam três cópias desta sequência; a que faltava
   era justamente a do `applyAll`. */
export function montarDock() {
  if (!document.body) return null;
  css(BASE_CSS, "zl-base");
  flushCss();
  const menu = ensureDock();
  addAct(menu, "zl-diag", "🩺", "Diagnóstico", "", diagnostico);
  return menu;
}

/* Diagnóstico: testa cada comando nativo e mostra o resultado.
   Existe porque uma falha de permissão silenciosa é impossível de debugar. */
async function diagnostico() {
  const testes = [
    ["load_settings_public", {}],
    ["set_always_on_top", { value: false }],
    ["close_all_toasts", {}],
  ];
  const linhas = ["Ponte nativa: " + (window.__TAURI__ ? "presente" : "AUSENTE"), ""];
  for (const [cmd, args] of testes) {
    try {
      await invoke(cmd, args);
      linhas.push("ok    " + cmd);
    } catch (e) {
      linhas.push("FALHA " + cmd + "\n      " + e.message);
    }
  }
  linhas.push("");
  linhas.push(
    "Módulos ligados: " +
      (Object.entries(settings.modules || {})
        .filter(([, v]) => v)
        .map(([k]) => k)
        .join(", ") || "nenhum")
  );
  showPanel("Diagnóstico", linhas.join("\n"));
}

/* Botão dentro do cabeçalho do próprio WhatsApp, para o app não parecer
   duas coisas coladas. Remontado pelo observer se o SPA recriar o header. */
export function mountHeaderButton() {
  if (document.getElementById("zl-hdr")) return;
  // o cabeçalho da lista de conversas é o primeiro <header> da página
  const header = document.querySelector("header");
  if (!header) return;
  const alvo = header.querySelector("div:last-child") || header;

  const b = document.createElement("button");
  b.id = "zl-hdr";
  b.type = "button";
  b.title = "ZapLite (Ctrl+Shift+Z)";
  b.textContent = "Z";
  b.style.cssText =
    "width:30px;height:30px;margin:0 4px;border:none;border-radius:9px;cursor:pointer;" +
    "font-weight:800;font-size:14px;line-height:1;color:#04120e;" +
    "background:var(--zl-accent,#22d3aa);flex:0 0 auto";
  b.onclick = (e) => {
    e.stopPropagation();
    const d = document.getElementById("zl-dock");
    if (d) d.classList.toggle("open");
  };
  alvo.appendChild(b);
}

/* Itens pedidos enquanto o dock ainda não existia. Sem esta fila, `addAct`
   saía calado e o botão sumia de vez: quem paga é sempre o PRIMEIRO módulo a
   pedir o dock (os seguintes já o encontram criado), então o defeito mudava
   de dono a cada reordenação da lista de módulos em vez de aparecer. */
const ACTS_PENDENTES = [];
function escoarActs(menu) {
  if (menu && ACTS_PENDENTES.length) {
    ACTS_PENDENTES.splice(0).forEach((a) => addAct(menu, a.id, a.icon, a.label, a.kbd, a.fn));
  }
  return menu;
}

export function addAct(menu, id, icon, label, kbd, fn) {
  if (document.getElementById(id)) return;
  if (!menu) {
    // Dock ainda não montado (sem `document.body`, ou `applyAll` rodando
    // antes do boot). Guarda o pedido: `ensureDock` o refaz ao montar.
    if (!ACTS_PENDENTES.some((a) => a.id === id)) {
      ACTS_PENDENTES.push({ id, icon, label, kbd, fn });
    }
    return;
  }
  const b = document.createElement("button");
  b.className = "zl-act";
  b.id = id;
  b.innerHTML =
    '<span class="ic"></span><span class="lb"></span>' +
    (kbd ? '<span class="kbd"></span>' : "");
  b.querySelector(".ic").textContent = icon;
  b.querySelector(".lb").textContent = label;
  if (kbd) b.querySelector(".kbd").textContent = kbd;
  b.onclick = (e) => {
    e.stopPropagation();
    document.getElementById("zl-dock").classList.remove("open");
    fn(b);
  };
  menu.appendChild(b);
}
export const dropAct = (id) => {
  const b = document.getElementById(id);
  if (b) b.remove();
  // Um módulo desligado não pode continuar na fila de espera do dock.
  const i = ACTS_PENDENTES.findIndex((a) => a.id === id);
  if (i >= 0) ACTS_PENDENTES.splice(i, 1);
};
