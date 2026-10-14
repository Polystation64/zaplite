/* TEMAS VISUAIS — cor, FONTE e efeito, cada um em versão CLARA e ESCURA.
   Três camadas, da mais ampla para a mais garantida:

     1. variáveis WDS do próprio WhatsApp Web (medidas na página em
        13/10/2026: `--WDS-surface-default`, `--WDS-content-default`,
        `--WDS-systems-bubble-surface-outgoing`…) — repintam o app inteiro do
        jeito que ele mesmo se pinta;
     2. `.zl-in` / `.zl-out`, que `modulos/tema.js` pendura na bolha desenhada
        (`[data-testid="msg-container"]`, seletor medido em bolhas.js) — os
        efeitos de bolha valem mesmo se o WhatsApp renomear uma variável;
     3. fonte e efeito global (aurora, linhas de varredura).

   Cada tema é uma FUNÇÃO do modo ("claro" | "escuro"): `modulos/tema.js`
   decide o modo (escolha do usuário, ou o do próprio WhatsApp no automático).

   Fontes: SÓ as que vêm no Windows. Fonte remota é proibida aqui (README,
   "Notas de depuração" 1) e o CSP do WhatsApp nem deixaria.
   Movimento: desligado quando o Windows pede "reduzir animações". */

const EMOJI = '"Segoe UI Emoji","Segoe UI Symbol"';

/** Seletor das variáveis: o WhatsApp as define no <body> (classe dark/light). */
const ALVO_VARS = "html body, html body.dark, html body.light, #app";

function fonte(pilha) {
  return `#app, #app :is(div,span,p,input,textarea,button,a,h1,h2,h3,label,li),
    #zl-panel, #zl-panel *, #zl-ctx, #zl-ctx * { font-family: ${pilha}, ${EMOJI} !important; }`;
}

/** Variáveis WDS em bloco. `p` = paleta do tema naquele modo. */
function vars(p) {
  return `${ALVO_VARS} {
    --WDS-background-wash-plain: ${p.fundo} !important;
    --WDS-surface-default: ${p.superficie} !important;
    --WDS-surface-elevated-emphasized: ${p.elevada} !important;
    --WDS-surface-highlight: ${p.destaque} !important;
    --WDS-surface-pressed: ${p.destaque} !important;
    --WDS-content-default: ${p.texto} !important;
    --WDS-content-deemphasized: ${p.textoSuave} !important;
    --WDS-content-action-default: ${p.acao} !important;
    --text-action: ${p.acao} !important;
    --WDS-systems-chat-background-wallpaper: ${p.papelDeParede} !important;
    --WDS-systems-chat-foreground-wallpaper: transparent !important;
    --WDS-systems-chat-surface-composer: ${p.caixa} !important;
    --WDS-systems-chat-surface-tray: ${p.superficie} !important;
    --WDS-systems-bubble-surface-outgoing: ${p.saida} !important;
    --WDS-systems-bubble-surface-incoming: ${p.entrada} !important;
    --WDS-systems-bubble-content-deemphasized: ${p.textoSuave} !important;
    --bubble-meta-icon: ${p.textoSuave} !important;
    --border-bubble: transparent !important;
    --panel-background-deep: ${p.superficie} !important;
    --app-background-stripe: transparent !important;
  }`;
}

const SEM_MOVIMENTO = (regras) => `@media (prefers-reduced-motion: no-preference) { ${regras} }`;

/* ------------------------------------------------------------------------
   1. VIDRO LÍQUIDO — a linguagem de 2026 (iOS 26 "Liquid Glass"): camadas
   translúcidas com desfoque, reflexo especular no topo e aurora ao fundo.
   Legibilidade é a crítica do estilo: no escuro, texto claro sobre vidro
   escurecido; no claro, texto escuro sobre vidro leitoso — nunca vidro
   transparente demais atrás de texto.
   ------------------------------------------------------------------------ */
function vidro(modo) {
  const e = modo === "escuro";
  const p = e
    ? {
        fundo: "transparent", superficie: "rgba(18,20,38,.55)", elevada: "rgba(30,32,58,.82)",
        destaque: "rgba(255,255,255,.10)", texto: "#f3f4ff", textoSuave: "rgba(225,228,255,.62)",
        acao: "#9ad8ff", papelDeParede: "transparent", caixa: "rgba(255,255,255,.08)",
        saida: "color-mix(in srgb, var(--zl-accent) 42%, rgba(20,20,40,.35))", entrada: "rgba(255,255,255,.09)",
      }
    : {
        fundo: "transparent", superficie: "rgba(255,255,255,.55)", elevada: "rgba(255,255,255,.88)",
        destaque: "rgba(255,255,255,.75)", texto: "#1b1d33", textoSuave: "rgba(27,29,51,.6)",
        acao: "#2563eb", papelDeParede: "transparent", caixa: "rgba(255,255,255,.7)",
        saida: "color-mix(in srgb, var(--zl-accent) 22%, rgba(255,255,255,.7))", entrada: "rgba(255,255,255,.62)",
      };
  const aurora = e
    ? `radial-gradient(60vmax 60vmax at 12% 18%, color-mix(in srgb, var(--zl-accent) 55%, transparent), transparent 60%),
       radial-gradient(50vmax 50vmax at 88% 22%, rgba(0,200,255,.38), transparent 60%),
       radial-gradient(55vmax 55vmax at 60% 95%, rgba(255,80,170,.30), transparent 60%), #0b0d1c`
    : `radial-gradient(60vmax 60vmax at 12% 18%, color-mix(in srgb, var(--zl-accent) 35%, transparent), transparent 60%),
       radial-gradient(50vmax 50vmax at 88% 22%, rgba(120,220,255,.45), transparent 60%),
       radial-gradient(55vmax 55vmax at 60% 95%, rgba(255,170,210,.45), transparent 60%), #eef1fb`;
  const borda = e ? "rgba(255,255,255,.16)" : "rgba(255,255,255,.85)";
  const sombra = e ? "rgba(0,0,0,.28)" : "rgba(40,50,90,.14)";
  return `
  ${fonte('"Segoe UI Variable Text","Segoe UI Variable Display","Segoe UI",system-ui,sans-serif')}
  ${vars(p)}
  html body { background: ${aurora} !important; background-size: 160% 160% !important; }
  ${SEM_MOVIMENTO(`html body { animation: zl-aurora 38s ease-in-out infinite alternate; }
    @keyframes zl-aurora { from { background-position: 0% 0%; } to { background-position: 100% 100%; } }`)}
  #side, #main header, #main footer {
    backdrop-filter: blur(22px) saturate(160%) !important;
    -webkit-backdrop-filter: blur(22px) saturate(160%) !important;
  }
  .zl-in, .zl-out {
    backdrop-filter: blur(14px) saturate(170%);
    border: 1px solid ${borda} !important;
    border-radius: 20px !important;
    box-shadow: 0 10px 30px ${sombra}, inset 0 1px 0 rgba(255,255,255,${e ? ".28" : ".95"}) !important;
  }
  .zl-out { box-shadow: 0 10px 30px color-mix(in srgb, var(--zl-accent) ${e ? "30%" : "18%"}, transparent),
                        inset 0 1px 0 rgba(255,255,255,${e ? ".35" : ".95"}) !important; }
  #main footer [contenteditable="true"] { border-radius: 18px !important; }
  ::selection { background: color-mix(in srgb, var(--zl-accent) ${e ? "60%" : "35%"}, transparent); }
`;
}

/* ------------------------------------------------------------------------
   2. BRUTAL — neobrutalismo: bordas grossas, sombra dura SEM blur, cantos
   retos, cor chapada e tipografia condensada. No escuro, a borda vira clara
   e a sombra dura vira amarela (preto sobre preto não existe).
   ------------------------------------------------------------------------ */
function brutal(modo) {
  const e = modo === "escuro";
  const tinta = e ? "#f2f2f2" : "#111111";
  const sombra = e ? "#ffd23f" : "#111111";
  const p = e
    ? {
        fundo: "#151515", superficie: "#1d1d1d", elevada: "#262626", destaque: "#333333",
        texto: "#f5f5f5", textoSuave: "#bdbdbd", acao: "#7aa2ff", papelDeParede: "#151515",
        caixa: "#262626", saida: "#ffd23f", entrada: "#262626",
      }
    : {
        fundo: "#fff4cc", superficie: "#fffdf5", elevada: "#ffffff", destaque: "#ffe066",
        texto: "#111111", textoSuave: "#3d3d3d", acao: "#1f4dff", papelDeParede: "#fff4cc",
        caixa: "#ffffff", saida: "#ffd23f", entrada: "#ffffff",
      };
  return `
  ${fonte('"Bahnschrift","Arial Narrow","Segoe UI",sans-serif')}
  ${vars(p)}
  #side, #main header, #main footer { border: 3px solid ${tinta} !important; }
  #main header { box-shadow: 0 4px 0 ${sombra} !important; }
  #main header :is(span,div) { text-transform: uppercase; letter-spacing: .02em; }
  .zl-in, .zl-out {
    border: 3px solid ${tinta} !important;
    border-radius: 0 !important;
    box-shadow: 5px 5px 0 ${sombra} !important;
    transition: transform .08s ease, box-shadow .08s ease;
  }
  .zl-out { background-color: #ffd23f !important; }
  .zl-out :is(span,div) { color: #111 !important; }
  .zl-in { background-color: ${p.entrada} !important; }
  .zl-in :is(span,div) { color: ${p.texto} !important; }
  ${e ? ".zl-out { border-color: #111 !important; }" : ""}
  .zl-in:hover, .zl-out:hover { transform: translate(-2px,-2px); box-shadow: 7px 7px 0 ${sombra} !important; }
  #main footer [contenteditable="true"] {
    border: 3px solid ${tinta} !important; border-radius: 0 !important;
    box-shadow: 4px 4px 0 ${sombra} !important; background: ${p.caixa} !important; color: ${p.texto} !important;
  }
  ::selection { background: #ff5c8a; color: #111; }
`;
}

/* ------------------------------------------------------------------------
   3. TERMINAL — escuro: CRT de fósforo verde, linhas de varredura e uma
   cintilação quase imperceptível. Claro: visor LCD monocromático (o verde-
   oliva dos portáteis dos anos 90), tinta escura, grade de pixel sutil.
   ------------------------------------------------------------------------ */
function terminal(modo) {
  const e = modo === "escuro";
  const tinta = e ? "#3dff86" : "#0f380f";
  const brilho = e ? "rgba(61,255,134,.45)" : "transparent";
  const p = e
    ? {
        fundo: "#030603", superficie: "#060c07", elevada: "#0a140b", destaque: "rgba(61,255,134,.10)",
        texto: tinta, textoSuave: "#1fa354", acao: "#c5ff6b", papelDeParede: "#030603",
        caixa: "#050a05", saida: "rgba(61,255,134,.07)", entrada: "transparent",
      }
    : {
        fundo: "#c4cfa1", superficie: "#b8c48f", elevada: "#cdd8ab", destaque: "rgba(15,56,15,.12)",
        texto: tinta, textoSuave: "#306230", acao: "#0f380f", papelDeParede: "#c4cfa1",
        caixa: "#d2dcb2", saida: "rgba(15,56,15,.10)", entrada: "transparent",
      };
  const tela = e
    ? `repeating-linear-gradient(0deg, rgba(0,0,0,.22) 0 1px, transparent 1px 3px),
       radial-gradient(ellipse at center, transparent 60%, rgba(0,0,0,.55) 100%)`
    : `repeating-linear-gradient(0deg, rgba(15,56,15,.06) 0 1px, transparent 1px 3px),
       repeating-linear-gradient(90deg, rgba(15,56,15,.05) 0 1px, transparent 1px 3px)`;
  return `
  ${fonte('"Cascadia Mono","Cascadia Code","Consolas","Lucida Console",monospace')}
  ${vars(p)}
  ${e ? `#app { text-shadow: 0 0 6px ${brilho}; } #app svg { filter: drop-shadow(0 0 3px rgba(61,255,134,.5)); }` : ""}
  .zl-in, .zl-out {
    border: 1px solid ${e ? "rgba(61,255,134,.38)" : "rgba(15,56,15,.45)"} !important;
    border-radius: 2px !important;
    box-shadow: ${e ? "0 0 12px rgba(61,255,134,.12) inset" : "none"} !important;
  }
  .zl-in { border-left: 4px solid ${tinta} !important; }
  .zl-out { border-right: 4px solid ${tinta} !important; }
  .zl-in :is(span,div), .zl-out :is(span,div) { color: ${tinta} !important; }
  #main footer [contenteditable="true"] { caret-color: ${tinta}; }
  html body::after {
    content: ""; position: fixed; inset: 0; pointer-events: none; z-index: 2147483000;
    background: ${tela};
  }
  ${e ? SEM_MOVIMENTO(`html body::after { animation: zl-crt 5s steps(1) infinite; }
    @keyframes zl-crt { 0%,96%,100% { opacity: 1; } 97% { opacity: .9; } 98% { opacity: 1; } 99% { opacity: .94; } }`) : ""}
  ::selection { background: ${tinta}; color: ${e ? "#030603" : "#c4cfa1"}; text-shadow: none; }
`;
}

/* ------------------------------------------------------------------------
   4. ICQ 2000 — claro: Windows 2000, cinza de sistema, barra de título em
   degradê azul, bevel em relevo, bolha amarela de "tooltip", Tahoma.
   Escuro: o mesmo desenho à noite — cinza-carvão, barra azul-marinho,
   bolhas escuras com o amarelo virando âmbar. Os sons ficam em `sons.js`.
   ------------------------------------------------------------------------ */
function icq(modo) {
  const e = modo === "escuro";
  const claro = e ? "#4a4a4a" : "#ffffff";
  const escuro = e ? "#0c0c0c" : "#808080";
  const p = e
    ? {
        fundo: "#202020", superficie: "#2b2b2b", elevada: "#333333", destaque: "#1f4f8f",
        texto: "#ececec", textoSuave: "#a8a8a8", acao: "#7fb2ff", papelDeParede: "#1a1a1a",
        caixa: "#2b2b2b", saida: "#1f2f4a", entrada: "#3b3820",
      }
    : {
        fundo: "#d4d0c8", superficie: "#ffffff", elevada: "#ffffff", destaque: "#316ac5",
        texto: "#000000", textoSuave: "#555555", acao: "#0000cc", papelDeParede: "#ece9d8",
        caixa: "#ffffff", saida: "#dfeaff", entrada: "#ffffe1",
      };
  const titulo = e
    ? "linear-gradient(90deg, #06122e 0%, #123a6e 55%, #2d5f9a 100%)"
    : "linear-gradient(90deg, #0a246a 0%, #3a6ea5 55%, #a6caf0 100%)";
  return `
  ${fonte('Tahoma,Verdana,"Segoe UI",sans-serif')}
  ${vars(p)}
  #side, #main { border: 2px solid; border-color: ${claro} ${escuro} ${escuro} ${claro} !important; }
  #main header, #side header { background: ${titulo} !important; }
  #main header :is(span,div), #side header :is(span,div) { color: #ffffff !important; }
  #main header svg, #side header svg { color: #ffffff !important; }
  .zl-in, .zl-out {
    border: 1px solid ${e ? "#5a5a5a" : "#808080"} !important;
    border-radius: 2px !important;
    box-shadow: 1px 1px 0 ${claro} inset, 2px 2px 0 rgba(0,0,0,${e ? ".45" : ".18"}) !important;
  }
  .zl-in { background-color: ${p.entrada} !important; }
  .zl-out { background-color: ${p.saida} !important; border-color: ${e ? "#3d5a85" : "#7f9db9"} !important; }
  .zl-in :is(span,div), .zl-out :is(span,div) { color: ${e ? "#f0f0e0" : "#000"} !important; }
  #main footer [contenteditable="true"] {
    background: ${p.caixa} !important; color: ${p.texto} !important; border-radius: 0 !important;
    border: 2px solid; border-color: ${escuro} ${claro} ${claro} ${escuro} !important;
  }
  ::-webkit-scrollbar { width: 16px; height: 16px; background: ${p.fundo}; }
  ::-webkit-scrollbar-thumb { background: ${e ? "#3a3a3a" : "#d4d0c8"}; border: 2px solid; border-color: ${claro} ${escuro} ${escuro} ${claro}; }
  ::selection { background: #316ac5; color: #fff; }
`;
}

export const TEMAS = {
  vidro: { nome: "Vidro Líquido", css: vidro },
  brutal: { nome: "Brutal", css: brutal },
  terminal: { nome: "Terminal", css: terminal },
  icq: { nome: "ICQ 2000", css: icq },
};

/** Modo efetivo: a escolha do usuário, ou — no automático — o do próprio
 * WhatsApp (classe `dark` no <body>, medida em 13/10/2026). */
export function modoEfetivo(escolha, whatsappEscuro) {
  if (escolha === "claro" || escolha === "escuro") return escolha;
  return whatsappEscuro ? "escuro" : "claro";
}
