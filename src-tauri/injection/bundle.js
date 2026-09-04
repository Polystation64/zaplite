/* ============================================================================
   ZapLite — bundle injetado no WhatsApp Web.

   ARQUIVO GERADO. Não edite: edite os módulos em src-tauri/injection/src/ e
   rode `npm run empacotar`. Ele está no git porque o Rust o embute com
   `include_str!` e o build.rs o confere.
   ============================================================================ */
(function () {
  "use strict";
  if (window.__ZAPLITE__) return;
  window.__ZAPLITE__ = true;

(() => {
  // src-tauri/injection/src/bolhas.js
  var BOLHA_SEL = [
    "div.message-in",
    "div.message-out",
    '[data-testid^="conv-msg-"]',
    '#main div[role="row"] [data-id]'
  ].join(",");
  var BOLHA_MIOLO = '[data-testid="msg-container"]';
  var TAIL_SEL = '[data-icon^="tail-"],[data-testid^="tail-"]';
  var TEXTO_SELS = ["span.selectable-text", '[data-testid="selectable-text"]', ".copyable-text"];
  var META_SEL = '[data-testid="msg-meta"],[data-testid="msg-status"]';
  function painelDasBolhas() {
    return document.querySelector('[data-testid="conversation-panel-messages"]') || document.querySelector("#main") || null;
  }
  function ehBolha(el) {
    if (!el || el.nodeType !== 1) return false;
    try {
      if (el.classList.contains("message-in") || el.classList.contains("message-out")) return true;
      const tid = el.getAttribute("data-testid") || "";
      if (tid.indexOf("conv-msg-") === 0) return true;
      if (!el.hasAttribute("data-id")) return false;
      return !!el.closest('#main div[role="row"], [data-testid="conversation-panel-messages"]');
    } catch (_) {
      return false;
    }
  }
  function bolhasEm(raiz) {
    const r = raiz || document;
    let achadas = [];
    try {
      if (r.nodeType === 1 && ehBolha(r)) achadas.push(r);
      if (r.querySelectorAll) achadas = achadas.concat([...r.querySelectorAll(BOLHA_SEL)]);
    } catch (_) {
      return [];
    }
    const out = [];
    for (const el of achadas) {
      if (!ehBolha(el)) continue;
      if (out.indexOf(el) >= 0) continue;
      if (out.some((j) => j !== el && j.contains(el))) continue;
      for (let i = out.length - 1; i >= 0; i--) if (el.contains(out[i])) out.splice(i, 1);
      out.push(el);
    }
    return out;
  }
  function bolhasVisiveis() {
    const p = painelDasBolhas();
    const dentro = p ? bolhasEm(p) : [];
    return dentro.length ? dentro : bolhasEm(document);
  }
  function bolhaDe(el) {
    if (!el || !el.closest) return null;
    let cand;
    try {
      cand = el.closest(BOLHA_SEL);
    } catch (_) {
      return null;
    }
    while (cand && !ehBolha(cand)) cand = cand.parentElement && cand.parentElement.closest(BOLHA_SEL);
    return cand || null;
  }
  function ehDeSaida(bolha) {
    if (!bolha) return false;
    try {
      if (bolha.classList.contains("message-out")) return true;
      if (bolha.classList.contains("message-in")) return false;
      const tail = bolha.querySelector(TAIL_SEL);
      if (tail) {
        const v = tail.getAttribute("data-icon") || tail.getAttribute("data-testid") || "";
        if (v.indexOf("tail-out") === 0) return true;
        if (v.indexOf("tail-in") === 0) return false;
      }
      const p = painelDasBolhas();
      const miolo = bolha.querySelector(BOLHA_MIOLO) || bolha;
      if (p) {
        const rb = miolo.getBoundingClientRect();
        const rp = p.getBoundingClientRect();
        if (rb.width > 8 && rp.width > 8) {
          const esq = rb.left - rp.left;
          const dir = rp.right - rb.right;
          if (Math.abs(esq - dir) > 24) return dir < esq;
        }
      }
      const al = bolha.querySelector(
        '[aria-label^="Voc\xEA:"],[aria-label^="Voce:"],[aria-label^="You:"],[data-icon^="status-"],[data-icon^="msg-"]'
      );
      return !!al;
    } catch (_) {
      return false;
    }
  }
  function textoDaBolha(bolha) {
    if (!bolha) return "";
    try {
      for (const sel of TEXTO_SELS) {
        const el = bolha.querySelector(sel);
        if (!el || !el.textContent) continue;
        if (sel !== ".copyable-text") return el.textContent;
        try {
          const c = el.cloneNode(true);
          c.querySelectorAll(META_SEL).forEach((x) => x.remove());
          return c.textContent || "";
        } catch (_) {
          return el.textContent;
        }
      }
      return "";
    } catch (_) {
      return "";
    }
  }
  function idDaBolha(bolha) {
    if (!bolha) return "";
    try {
      const id = bolha.getAttribute("data-id");
      if (id) return id;
      const tid = bolha.getAttribute("data-testid") || "";
      return tid.indexOf("conv-msg-") === 0 ? tid.slice(9) : "";
    } catch (_) {
      return "";
    }
  }
  var APAGADA_RE = /apagada|apagou esta mensagem|deleted|se eliminó|this message was deleted/i;
  function ehApagada(bolha) {
    if (!bolha) return false;
    try {
      const c = bolha.cloneNode(true);
      c.querySelectorAll(".zl-recovered").forEach((x) => x.remove());
      return APAGADA_RE.test(c.textContent || "");
    } catch (_) {
      return APAGADA_RE.test(bolha.textContent || "");
    }
  }
  function imagemDaBolha(bolha) {
    if (!bolha) return null;
    try {
      return bolha.querySelector('img[src^="blob:"], img[src^="data:"]');
    } catch (_) {
      return null;
    }
  }
  function ultimaBolha(filtro) {
    const todas = bolhasVisiveis();
    for (let i = todas.length - 1; i >= 0; i--) {
      try {
        if (filtro(todas[i])) return todas[i];
      } catch (_) {
      }
    }
    return null;
  }

  // src-tauri/injection/src/ponte.js
  async function invoke(cmd, args) {
    if (!window.__TAURI__ || !window.__TAURI__.core) {
      throw new Error("ponte nativa indispon\xEDvel (window.__TAURI__ ausente)");
    }
    try {
      return await window.__TAURI__.core.invoke(cmd, args);
    } catch (e) {
      const msg = typeof e === "string" ? e : e && (e.message || e.toString()) || "erro desconhecido";
      const err = new Error(cmd + " \u2192 " + msg);
      console.error("[ZapLite]", err.message);
      throw err;
    }
  }
  var guarded = (fn, titulo) => async (...a) => {
    try {
      await fn(...a);
    } catch (e) {
      showPanel(titulo || "Erro", e && e.message || String(e));
    }
  };
  var notify = (title, body) => {
    try {
      window.__TAURI__.notification.sendNotification({ title, body });
    } catch (_) {
    }
  };

  // src-tauri/injection/src/painel.js
  function showPanel(title, body, acoes) {
    let p = document.getElementById("zl-panel");
    if (!p) {
      p = document.createElement("div");
      p.id = "zl-panel";
      p.innerHTML = '<div class="zl-panel-head"><b></b><span class="zl-acoes"><button class="zl-copy" title="Copiar texto">Copiar</button><button class="zl-x" title="Fechar">\u2715</button></span></div><div class="zl-panel-body"></div>';
      document.body.appendChild(p);
      p.querySelector(".zl-x").onclick = () => p.remove();
      p.querySelector(".zl-copy").onclick = async (ev) => {
        const txt = p.querySelector(".zl-panel-body").textContent || "";
        const b = ev.currentTarget;
        try {
          await navigator.clipboard.writeText(txt);
        } catch (_) {
          const r = document.createRange();
          r.selectNodeContents(p.querySelector(".zl-panel-body"));
          const sel = window.getSelection();
          sel.removeAllRanges();
          sel.addRange(r);
        }
        const antes = b.textContent;
        b.textContent = "Copiado!";
        setTimeout(() => {
          b.textContent = antes;
        }, 1400);
      };
    }
    p.querySelector("b").textContent = title;
    const corpo = p.querySelector(".zl-panel-body");
    corpo.textContent = "";
    if (body && body.nodeType) corpo.appendChild(body);
    else corpo.textContent = body;
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
            console.error("[ZapLite] a\xE7\xE3o do painel falhou:", e);
          }
        };
        barra.appendChild(b);
      });
      p.appendChild(barra);
    }
    return p;
  }
  function ehFaltaDeInstalacao(e) {
    const m = e && e.message || String(e || "");
    return m.indexOf("[zl-setup]") >= 0;
  }
  function textoSemCarimbo(e) {
    return (e && e.message || String(e || "")).replace("[zl-setup] ", "").replace(/^transcribe_audio → /, "");
  }
  function avisarInstalacaoDaTranscricao(e) {
    showPanel(
      "Transcri\xE7\xE3o ainda n\xE3o instalada",
      textoSemCarimbo(e) + "\n\nO instalador vem dentro do ZapLite: o bot\xE3o abaixo abre o Painel j\xE1 na se\xE7\xE3o certa, onde d\xE1 para baixar o motor e o modelo de voz sem sair do app.",
      [
        [
          "Instalar transcri\xE7\xE3o",
          () => invoke("open_settings", { secao: "ia" }).catch((err) => showPanel("Erro", err.message))
        ]
      ]
    );
  }

  // src-tauri/injection/src/dock.js
  var BASE_CSS = `
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

    /* Onda 2 \u2014 campos dentro do painel (nota, lembrete, sele\xE7\xE3o em massa).
       O painel j\xE1 existia; o que faltava era com que cara um <textarea> e uma
       lista de caixinhas ficam dentro dele. */
    .zl-form{display:flex;flex-direction:column;gap:8px;white-space:normal}
    .zl-form textarea,.zl-form input[type=text],.zl-form input[type=time],.zl-form input[type=number]{
      width:100%;box-sizing:border-box;background:#0b141a;color:#e9edef;font-family:inherit;
      font-size:13px;border:1px solid rgba(255,255,255,.14);border-radius:8px;padding:8px 9px}
    .zl-form textarea{min-height:110px;resize:vertical;line-height:1.45}
    .zl-form textarea:focus,.zl-form input:focus{outline:2px solid var(--zl-accent,#22d3aa);outline-offset:-1px}
    .zl-form label{display:flex;align-items:flex-start;gap:8px;font-size:12.5px;line-height:1.4;cursor:pointer}
    .zl-form label input[type=checkbox]{margin:2px 0 0;flex:0 0 auto;accent-color:var(--zl-accent,#22d3aa)}
    .zl-lim{font-size:11px;color:#8696a0;line-height:1.45}
    .zl-lista{display:flex;flex-direction:column;gap:6px;max-height:34vh;overflow:auto;
      border:1px solid rgba(255,255,255,.08);border-radius:8px;padding:8px}
    .zl-item{display:flex;align-items:center;gap:8px;font-size:12.5px}
    .zl-item .zl-x2{margin-left:auto;background:rgba(255,255,255,.08);border:none;color:#e9edef;
      cursor:pointer;font-size:11px;padding:2px 8px;border-radius:6px;font-family:inherit}
    .zl-item .zl-x2:hover{background:rgba(244,63,94,.35)}

    /* Onda 2 \u2014 indicador discreto de "esta conversa tem nota". Um bloco de
       papel no cabe\xE7alho da conversa aberta e um ponto na linha da lista. */
    #zl-nota-hdr{width:28px;height:28px;margin:0 4px;border:none;border-radius:9px;cursor:pointer;
      font-size:14px;line-height:1;background:transparent;color:#8696a0;flex:0 0 auto}
    #zl-nota-hdr.tem{background:var(--zl-accent,#22d3aa);color:#04120e}
    #zl-nota-hdr:hover{filter:brightness(1.15)}
    .zl-nota-dot{position:absolute;left:2px;top:2px;width:7px;height:7px;border-radius:99px;
      background:var(--zl-accent,#22d3aa);box-shadow:0 0 0 2px rgba(0,0,0,.35);pointer-events:none;z-index:5}

    /* A4 \u2014 modo NSFW. O borr\xE3o vai S\xD3 nos elementos que o JS marcou (m\xEDdia
       dentro de bolha, pr\xE9via da lista, visualizador); a interface do WhatsApp
       usa <svg>/[data-icon], que nunca recebem a classe. */
    .zl-nsfw-alvo{filter:blur(20px) !important;transition:filter .12s ease}
    .zl-nsfw-alvo:hover{filter:blur(0) !important}
    .zl-nsfw-alvo.zl-nsfw-livre{filter:none !important}
  `;
  function ensureDock() {
    if (document.getElementById("zl-dock")) return escoarActs(document.getElementById("zl-menu"));
    if (!document.body) return null;
    const dock = document.createElement("div");
    dock.id = "zl-dock";
    dock.innerHTML = '<button id="zl-tab" title="ZapLite (Ctrl+Shift+Z)">Z</button><div id="zl-menu"></div>';
    document.body.appendChild(dock);
    const tab = dock.querySelector("#zl-tab");
    tab.onclick = (e) => {
      e.stopPropagation();
      dock.classList.toggle("open");
    };
    document.addEventListener("click", (e) => {
      if (!dock.contains(e.target)) dock.classList.remove("open");
    });
    const menu = dock.querySelector("#zl-menu");
    addAct(
      menu,
      "zl-open-panel",
      "\u2699",
      "Painel do ZapLite",
      "Ctrl+Shift+Z",
      () => invoke("open_settings").catch((e) => showPanel("Erro", e.message))
    );
    const sep = document.createElement("div");
    sep.className = "zl-sep";
    sep.id = "zl-sep";
    menu.appendChild(sep);
    if (!window.__TAURI__) {
      const n = document.createElement("div");
      n.className = "zl-note";
      n.textContent = "Ponte com o app indispon\xEDvel: os m\xF3dulos nativos n\xE3o v\xE3o responder.";
      menu.appendChild(n);
    }
    return escoarActs(menu);
  }
  function montarDock() {
    if (!document.body) return null;
    css(BASE_CSS, "zl-base");
    flushCss();
    const menu = ensureDock();
    addAct(menu, "zl-diag", "\u{1FA7A}", "Diagn\xF3stico", "", diagnostico);
    return menu;
  }
  async function diagnostico() {
    const testes = [
      ["load_settings_public", {}],
      ["set_always_on_top", { value: false }],
      ["close_all_toasts", {}]
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
      "M\xF3dulos ligados: " + (Object.entries(settings.modules || {}).filter(([, v]) => v).map(([k]) => k).join(", ") || "nenhum")
    );
    showPanel("Diagn\xF3stico", linhas.join("\n"));
  }
  function mountHeaderButton() {
    if (document.getElementById("zl-hdr")) return;
    const header = document.querySelector("header");
    if (!header) return;
    const alvo = header.querySelector("div:last-child") || header;
    const b = document.createElement("button");
    b.id = "zl-hdr";
    b.type = "button";
    b.title = "ZapLite (Ctrl+Shift+Z)";
    b.textContent = "Z";
    b.style.cssText = "width:30px;height:30px;margin:0 4px;border:none;border-radius:9px;cursor:pointer;font-weight:800;font-size:14px;line-height:1;color:#04120e;background:var(--zl-accent,#22d3aa);flex:0 0 auto";
    b.onclick = (e) => {
      e.stopPropagation();
      const d = document.getElementById("zl-dock");
      if (d) d.classList.toggle("open");
    };
    alvo.appendChild(b);
  }
  var ACTS_PENDENTES = [];
  function escoarActs(menu) {
    if (menu && ACTS_PENDENTES.length) {
      ACTS_PENDENTES.splice(0).forEach((a) => addAct(menu, a.id, a.icon, a.label, a.kbd, a.fn));
    }
    return menu;
  }
  function addAct(menu, id, icon, label, kbd, fn) {
    if (document.getElementById(id)) return;
    if (!menu) {
      if (!ACTS_PENDENTES.some((a) => a.id === id)) {
        ACTS_PENDENTES.push({ id, icon, label, kbd, fn });
      }
      return;
    }
    const b = document.createElement("button");
    b.className = "zl-act";
    b.id = id;
    b.innerHTML = '<span class="ic"></span><span class="lb"></span>' + (kbd ? '<span class="kbd"></span>' : "");
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
  var dropAct = (id) => {
    const b = document.getElementById(id);
    if (b) b.remove();
    const i = ACTS_PENDENTES.findIndex((a) => a.id === id);
    if (i >= 0) ACTS_PENDENTES.splice(i, 1);
  };

  // src-tauri/injection/src/nucleo.js
  var settings = {};
  var on = (id) => settings.modules && settings.modules[id] === true;
  var wait = (ms) => new Promise((r) => setTimeout(r, ms));
  async function until(fn, timeout = 2e4, step = 300) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      const v = fn();
      if (v) return v;
      await wait(step);
    }
    return null;
  }
  var cssQueue = [];
  var css = (text, key) => {
    const root = document.head || document.documentElement;
    if (!root) {
      cssQueue.push([text, key]);
      return;
    }
    let el = document.getElementById(key);
    if (!el) {
      el = document.createElement("style");
      el.id = key;
      root.appendChild(el);
    }
    el.textContent = text;
  };
  var flushCss = () => {
    while (cssQueue.length) {
      const [t, k] = cssQueue.shift();
      css(t, k);
    }
  };
  var dropCss = (key) => {
    const el = document.getElementById(key);
    if (el) el.remove();
  };
  var modules = [];
  var reg = (m) => modules.push(m);
  var moduloPorId = (id) => modules.filter((m) => m.id === id)[0] || null;
  function throttleComCauda(fn, ms) {
    let ultima = 0;
    let cauda = null;
    const rodar = () => {
      cauda = null;
      ultima = Date.now();
      fn();
    };
    const pedir = () => {
      const falta = ms - (Date.now() - ultima);
      if (falta <= 0) {
        rodar();
        return;
      }
      if (cauda) return;
      cauda = setTimeout(rodar, falta);
    };
    pedir.cancelar = () => {
      if (cauda) {
        clearTimeout(cauda);
        cauda = null;
      }
    };
    return pedir;
  }
  var MODULOS_PADRAO = {
    unsavedSend: true,
    antiDelete: true,
    transcribe: true,
    summarize: true,
    draftReply: true,
    audioSpeed: true,
    theme: true,
    smartNotify: true,
    contextMenu: true,
    // A4/A5 nascem DESLIGADOS: um muda a aparência de toda a tela, o outro
    // gasta CPU e manda recibo de "ouvida" sem o usuário pedir.
    nsfwBlur: false,
    autoTranscribe: false,
    // Os quatro de IA nascem LIGADOS, e isso não contradiz o parágrafo acima:
    // ligado, cada um deles acrescenta uma entrada no menu e nada mais. Não há
    // varredura, observador nem chamada de IA sem um clique — o custo de
    // deixá-los ligados é uma linha no dock, não uma conta no provedor.
    translate: true,
    ocr: true,
    scamDetect: true,
    dailyDigest: true,
    // Onda 2 — os seis LOCAIS. Nascem ligados pela mesma razão dos de IA, e
    // aqui o argumento é ainda mais forte: nenhum deles chama provedor nenhum,
    // nenhum manda byte para fora e cinco dos seis não fazem NADA até um
    // clique. O único com efeito contínuo é `contactNotes`, e o efeito é um
    // temporizador de 1,5 s que pinta um indicador — não uma varredura.
    //
    // `quickReplies` fica ligado e mesmo assim inerte: sem atalho cadastrado no
    // Painel, `acharAtalho` devolve null em toda tecla. E ele NUNCA envia:
    // expandir é escrever na caixa, e o gatilho jamais é Enter.
    contactNotes: true,
    quickReplies: true,
    reminders: true,
    bulkUnread: true,
    exportChat: true,
    bulkDownload: true
  };
  async function applyAll() {
    try {
      settings = await invoke("load_settings_public") || {};
    } catch (e) {
      console.warn("[ZapLite] load_settings_public falhou:", e.message);
      settings = {};
    }
    settings.modules = Object.assign({}, MODULOS_PADRAO, settings.modules || {});
    if (!document.getElementById("zl-dock")) {
      await until(() => document.body, 3e4);
      montarDock();
    }
    for (const m of modules) {
      try {
        if (on(m.id)) m.apply();
        else m.revert();
      } catch (e) {
        console.warn("[ZapLite] m\xF3dulo", m.id, e);
      }
    }
  }

  // src-tauri/injection/src/conn-core.js
  function connCore() {
    let isTop = true;
    try {
      isTop = window.top === window;
    } catch (_) {
      isTop = false;
    }
    if (!isTop) return;
    const TICK_MS = 1e3;
    const FAST_TICK_MS = 250;
    const HEARTBEAT_MS = 3e3;
    const PENDING_MS = 4e3;
    const BUFFER_STUCK_MS = 2500;
    const UNANSWERED_MS = 5e4;
    const SILENCE_MS = 65e3;
    const SOCKET_GRACE_MS = 5e3;
    const STARTING_MAX_MS = 3e4;
    const LOADING_MAX_MS = 12e4;
    const AUTH_SUSPEITO_MS = 45e3;
    const QUEDA_RECENTE_MS = 18e4;
    const LOGIN_TICKS_MIN = 3;
    const FAILED_REST_MS = 3e5;
    const CONFIRMA_MS = 2e3;
    const DEBOUNCE_MS = 300;
    const REEMISSAO_MIN_MS = 5e3;
    const PEDIDO_COMPROVADO_MIN_MS = 5e3;
    const STABLE_OK_MS = 15e3;
    const MAX_ATTEMPTS = 10;
    const BACKOFF_BASE_MS = 2e3;
    const BACKOFF_CAP_MS = 6e4;
    const FILA_MAX = 12;
    const SIM_DROP_MS = 15e3;
    const SIM_CHORD = "Ctrl+Alt+Shift+D";
    const NativeWS = window.WebSocket;
    const live = /* @__PURE__ */ new Map();
    let hadSocket = false;
    let lastRx = 0;
    let lastTx = 0;
    let txSemResposta = 0;
    let blockUntil = 0;
    function marcaRx() {
      lastRx = Date.now();
      txSemResposta = 0;
    }
    function marcaTx() {
      const t = Date.now();
      lastTx = t;
      if (!txSemResposta) txSemResposta = t;
    }
    const enc = typeof TextEncoder === "function" ? new TextEncoder() : null;
    function tamanho(d) {
      try {
        if (d == null) return 0;
        if (typeof d === "string") return enc ? enc.encode(d).length : d.length;
        if (typeof d.byteLength === "number") return d.byteLength;
        if (typeof d.size === "number") return d.size;
      } catch (_) {
      }
      return 0;
    }
    function ZLWebSocket(url, protocols) {
      const ws = protocols !== void 0 ? new NativeWS(url, protocols) : new NativeWS(url);
      const agora = Date.now();
      const r = { env: 0, dren: 0, drenTs: agora, rx: agora, tx: 0 };
      hadSocket = true;
      live.set(ws, r);
      ws.addEventListener("open", () => {
        r.rx = Date.now();
        marcaRx();
      });
      ws.addEventListener("message", () => {
        r.rx = Date.now();
        marcaRx();
      });
      ws.addEventListener("close", () => {
        live.delete(ws);
      });
      try {
        const envioNativo = ws.send.bind(ws);
        Object.defineProperty(ws, "send", {
          value: function(dados) {
            marcaTx();
            r.tx = Date.now();
            r.env += tamanho(dados);
            return envioNativo(dados);
          },
          writable: true,
          configurable: true
        });
      } catch (_) {
      }
      if (Date.now() < blockUntil) {
        setTimeout(() => {
          try {
            ws.close();
          } catch (_) {
          }
        }, 50);
      }
      return ws;
    }
    ZLWebSocket.prototype = NativeWS.prototype;
    ["CONNECTING", "OPEN", "CLOSING", "CLOSED"].forEach((k) => {
      ZLWebSocket[k] = NativeWS[k];
    });
    try {
      Object.defineProperty(window, "WebSocket", { value: ZLWebSocket, writable: true, configurable: true });
    } catch (_) {
    }
    const openSockets = () => {
      let n = 0;
      live.forEach((_r, w) => {
        if (w.readyState === NativeWS.OPEN) n++;
      });
      return n;
    };
    const bufferPreso = () => {
      let m = 0;
      live.forEach((_r, w) => {
        try {
          if (w.readyState === NativeWS.OPEN && w.bufferedAmount > m) m = w.bufferedAmount;
        } catch (_) {
        }
      });
      return m;
    };
    function amostraBuffers() {
      const now = Date.now();
      live.forEach((r, w) => {
        let b;
        try {
          if (w.readyState === NativeWS.CLOSED) {
            live.delete(w);
            return;
          }
          if (w.readyState !== NativeWS.OPEN) return;
          b = w.bufferedAmount || 0;
        } catch (_) {
          return;
        }
        const drenado = r.env - b;
        if (b === 0 || drenado > r.dren) {
          r.dren = drenado;
          r.drenTs = now;
        }
      });
    }
    function socketsPresos(now) {
      const out = [];
      live.forEach((r, w) => {
        try {
          if (w.readyState !== NativeWS.OPEN) return;
          const b = w.bufferedAmount || 0;
          if (b > 0 && now - r.drenTs > BUFFER_STUCK_MS) out.push({ ws: w, bytes: b, ms: now - r.drenTs });
        } catch (_) {
        }
      });
      return out;
    }
    let state = "STARTING";
    let since = Date.now();
    let reason = "boot";
    let attempts = 0;
    let nextAttemptAt = 0;
    let restaurado = false;
    let semPonte = false;
    let pendingSince = null;
    let semUiDesde = Date.now();
    let naoProntoTicks = 0;
    let lastOpenTs = Date.now();
    let stableTimer = null;
    let evaluating = false;
    let loginTicks = 0;
    let authDesde = null;
    let ultimaQueda = 0;
    let cand = null;
    let candDesde = 0;
    let failedDesde = 0;
    let pedindo = false;
    let ultimoPedidoComprovado = 0;
    let aguardandoAte = 0;
    let aguardandoMotivo = "";
    let agendado = 0;
    let flushando = false;
    const fila = [];
    const backoffDe = (n) => Math.min(BACKOFF_BASE_MS * Math.pow(2, Math.max(0, n - 1)), BACKOFF_CAP_MS);
    async function restauraContador() {
      try {
        const s = await invoke("get_connection_state");
        const a = parseInt(s && s.attempts || 0, 10);
        attempts = isFinite(a) && a > 0 ? Math.min(a, MAX_ATTEMPTS) : 0;
        const descanso = parseInt(s && s.descansoMs || 0, 10) || 0;
        const hold = parseInt(s && s.holdMs || 0, 10) || 0;
        const espera = Math.max(descanso, hold);
        if (espera > 0) {
          aguardandoAte = Date.now() + Math.min(espera, BACKOFF_CAP_MS * 30);
          nextAttemptAt = aguardandoAte;
          aguardandoMotivo = descanso > 0 ? "o app j\xE1 tentou o bastante neste cen\xE1rio e est\xE1 aguardando" : "backoff em curso";
        }
        semPonte = false;
        console.log("[ZapLite/conn] contador restaurado do Rust:", attempts, "| aguardando", Math.max(0, nextAttemptAt - Date.now()), "ms | cen\xE1rio", s && s.cenario || "\u2014");
      } catch (e) {
        semPonte = true;
        console.warn("[ZapLite/conn] sem ponte nativa: sem contador confi\xE1vel, recupera\xE7\xE3o limitada ao n\xEDvel 1");
      }
      restaurado = true;
    }
    function entrega(t) {
      return invoke("conn_transition", t).catch((e) => {
        while (fila.length >= FILA_MAX) fila.shift();
        fila.push(t);
        throw e;
      });
    }
    const enviadas = [];
    function marcaEnviada(sig) {
      enviadas.push({ sig, ts: Date.now() });
      while (enviadas.length > 8) enviadas.shift();
    }
    function foiNossa(sig) {
      const lim = Date.now() - 15e3;
      for (let i = enviadas.length - 1; i >= 0; i--) {
        if (enviadas[i].ts >= lim && enviadas[i].sig === sig) return true;
      }
      return false;
    }
    let ultimaEmissao = { chave: "", ts: 0 };
    function sendTransition(prev, st, rs, quando) {
      const chave = prev + ">" + st + "|" + rs;
      const agora = Date.now();
      if (chave === ultimaEmissao.chave && agora - ultimaEmissao.ts < REEMISSAO_MIN_MS) {
        return Promise.resolve();
      }
      ultimaEmissao = { chave, ts: agora };
      const t = {
        prev,
        state: st,
        reason: rs,
        attempts,
        ts: new Date(quando || agora).toISOString()
      };
      marcaEnviada(st + "|" + rs);
      return entrega(t).catch(() => {
      });
    }
    async function flushFila() {
      if (flushando) return;
      flushando = true;
      try {
        let guarda = FILA_MAX + 1;
        while (fila.length && guarda-- > 0) {
          const t = fila[0];
          try {
            await invoke("conn_transition", t);
          } catch (_) {
            return;
          }
          if (fila[0] === t) fila.shift();
        }
      } finally {
        flushando = false;
      }
    }
    function setState(st, rs) {
      if (st === state) return;
      const prev = state;
      const agora = Date.now();
      state = st;
      reason = rs;
      since = agora;
      if (st === "FAILED") failedDesde = agora;
      console.log("[ZapLite/conn]", prev, "\u2192", st, "|", rs);
      sendTransition(prev, st, rs, agora);
      sinaliza();
      clearTimeout(stableTimer);
      if (st === "CONNECTED") {
        stableTimer = setTimeout(() => {
          if (state === "CONNECTED") {
            attempts = 0;
            nextAttemptAt = 0;
          }
        }, STABLE_OK_MS);
      }
    }
    function visivel(el) {
      if (!el) return false;
      try {
        const r = el.getBoundingClientRect();
        if (r.width < 8 || r.height < 8) return false;
        const s = getComputedStyle(el);
        return s.visibility !== "hidden" && s.display !== "none" && parseFloat(s.opacity || "1") > 0.05;
      } catch (_) {
        return false;
      }
    }
    function algumVisivel(sel, raiz) {
      let els;
      try {
        els = (raiz || document).querySelectorAll(sel);
      } catch (_) {
        return false;
      }
      for (const e of els) if (visivel(e)) return true;
      return false;
    }
    const PRONTO_SEL = '#pane-side, [data-testid="wa-web-main-screen"], [data-testid="chat-list"]';
    function appReady() {
      return algumVisivel(PRONTO_SEL);
    }
    const CARREGANDO_SEL = '[data-testid="wa-web-loading-screen"], [data-testid="startup-progress"]';
    function loadingScreen() {
      if (algumVisivel(CARREGANDO_SEL)) return true;
      return !appReady() && algumVisivel('progress, [role="progressbar"]');
    }
    const LOGIN_SEL = [
      'canvas[aria-label*="QR" i]',
      'canvas[aria-label*="scan" i]',
      'canvas[aria-label*="escane" i]',
      "div[data-ref] canvas",
      '[data-testid="qrcode"]',
      "[data-animate-qr-code]",
      // Contêiner da tela de vincular aparelho. Medido no DOM de uma tela de
      // login REAL (14/08 15:40): data-testid `link-device-qr-code`,
      // `link-device-qrcode-alt-linking-help`, `link-device-qrcode-alt-linking-hint`.
      // Nenhum `link-device-*` aparece na página logada (medição da sessão
      // conectada: 107 testids, nenhum deles). Precisa estar aqui porque o QR
      // EXPIRA: o WhatsApp troca o canvas pelo estado "recarregar código" e,
      // sem este seletor, a tela de login deixava de ser reconhecida, caía no
      // ramo de STARTING e era recarregada pelo teto de carregamento —
      // medido em 15:54:17, em cima de um QR real que o usuário precisava ler.
      '[data-testid^="link-device"]'
    ].join(",");
    function qrPlausivel() {
      let cs;
      try {
        cs = document.querySelectorAll("canvas");
      } catch (_) {
        return false;
      }
      for (const c of cs) {
        const r = c.getBoundingClientRect();
        if (r.width < 160 || r.width > 600) continue;
        if (Math.abs(r.width - r.height) > r.width * 0.12) continue;
        if (!visivel(c)) continue;
        const cx = r.left + r.width / 2;
        if (cx < innerWidth * 0.15 || cx > innerWidth * 0.85) continue;
        if (r.top > innerHeight || r.bottom < 0) continue;
        return true;
      }
      return false;
    }
    function loginScreen() {
      if (appReady() || loadingScreen()) return false;
      if (algumVisivel(LOGIN_SEL)) return true;
      return qrPlausivel();
    }
    const BANNER_ICONE = [
      '[data-icon="alert-phone"]',
      '[data-icon="alert-computer"]',
      '[data-icon="offline"]',
      '[data-icon="alert-phone-refreshed"]',
      '[data-icon="alert-computer-refreshed"]',
      '[data-icon="alert-connection"]'
    ].join(",");
    function offlineBanner() {
      const app = document.getElementById("app");
      if (!app) return null;
      let els;
      try {
        els = app.querySelectorAll(BANNER_ICONE);
      } catch (_) {
        return null;
      }
      for (const e of els) {
        if (!visivel(e)) continue;
        const faixa = e.closest('[data-testid="chat-butterbar"]') || e.parentElement;
        try {
          if (faixa && faixa.getBoundingClientRect().height < 8) continue;
        } catch (_) {
          continue;
        }
        return "aviso de conex\xE3o do WhatsApp vis\xEDvel";
      }
      return null;
    }
    const PENDENTE_SEL = [
      '[data-icon="msg-time"]',
      '[data-icon="msg-time-full"]',
      '[data-icon="msg-time-refreshed"]',
      '[data-testid="msg-time"]',
      '[data-icon="status-time"]'
    ].join(",");
    const NOME_ICONE_FAM = /^(wds-ic-|msg-|status-|ic-)/;
    const PENDENTE_NOME = /(clock|time|pend|sched|hourglass|wait|sending)/i;
    const PENDENTE_ROTULO = /(pendente|enviando|aguardando|pending|sending|clock)/i;
    const RESOLVIDO = /(lida|lido|entregue|enviad|read|deliver|sent|check)/i;
    let ultimoIconePendente = "";
    let statusDesconhecidos = [];
    function nomeDoIcone(el) {
      try {
        const a = el.getAttribute("data-icon") || el.getAttribute("data-testid") || "";
        if (a && NOME_ICONE_FAM.test(a)) return a;
        const t = el.querySelector("svg title, title");
        const v = t && t.textContent ? t.textContent.trim() : "";
        if (v && NOME_ICONE_FAM.test(v)) return v;
        if (a) return a;
        return v;
      } catch (_) {
        return "";
      }
    }
    function nosDeStatus(bolha) {
      const out = [];
      try {
        for (const e of bolha.querySelectorAll("[aria-label]")) {
          const nome = nomeDoIcone(e);
          if (!nome || !NOME_ICONE_FAM.test(nome)) continue;
          out.push({ el: e, nome, rotulo: e.getAttribute("aria-label") || "" });
        }
      } catch (_) {
      }
      return out;
    }
    function pendingOutgoing() {
      let achou = false;
      for (const b of bolhasVisiveis()) {
        if (algumVisivel(PENDENTE_SEL, b)) {
          if (ehDeSaida(b)) {
            ultimoIconePendente = "legado:data-icon";
            achou = true;
            break;
          }
          continue;
        }
        const nos = nosDeStatus(b);
        if (!nos.length) continue;
        let saida = null;
        for (const n of nos) {
          if (!visivel(n.el)) continue;
          const pendente = PENDENTE_NOME.test(n.nome) || PENDENTE_ROTULO.test(n.rotulo);
          if (!pendente) {
            if (!RESOLVIDO.test(n.nome) && !RESOLVIDO.test(n.rotulo) && statusDesconhecidos.indexOf(n.nome) < 0 && statusDesconhecidos.length < 8) {
              statusDesconhecidos.push(n.nome);
              console.warn("[ZapLite/conn] status de mensagem desconhecido:", n.nome, n.rotulo);
            }
            continue;
          }
          if (saida == null) saida = ehDeSaida(b);
          if (!saida) break;
          ultimoIconePendente = n.nome + " / '" + n.rotulo.trim() + "'";
          achou = true;
          break;
        }
        if (achou) break;
      }
      return achou;
    }
    const ESTADOS = {
      STARTING: 1,
      NEEDS_AUTH: 1,
      CONNECTED: 1,
      OFFLINE: 1,
      DEGRADED: 1,
      RECONNECTING: 1,
      FAILED: 1
    };
    let rust = null;
    let rustSozinho = false;
    let ouvindoRust = false;
    function ouveRust() {
      if (ouvindoRust) return true;
      try {
        if (!window.__TAURI__ || !window.__TAURI__.event || !window.__TAURI__.event.listen) return false;
        const p = window.__TAURI__.event.listen("zaplite://conn-state", (ev) => {
          const d = ev && ev.payload || {};
          const st = typeof d.state === "string" && ESTADOS[d.state] ? d.state : null;
          if (!st) return;
          const rs = typeof d.reason === "string" ? d.reason.slice(0, 160) : "";
          const at = parseInt(d.attempts, 10);
          rustSozinho = /^watchdog:/.test(rs) || !foiNossa(st + "|" + rs);
          rust = { state: st, reason: rs, attempts: isFinite(at) ? at : 0, ts: Date.now() };
          console.log("[ZapLite/conn] rust:", st, "|", rs, rustSozinho ? "(decis\xE3o do app)" : "(eco)");
          sinaliza();
        });
        if (p && typeof p.catch === "function") p.catch(() => {
          ouvindoRust = false;
        });
        ouvindoRust = true;
        return true;
      } catch (_) {
        return false;
      }
    }
    const ROTULO = {
      CONNECTED: "conectado",
      STARTING: "carregando\u2026",
      // M3: a tela de login não está "falhando" — está esperando um humano.
      NEEDS_AUTH: "escaneie o QR no celular",
      OFFLINE: "sem conex\xE3o \u2014 recuperando",
      DEGRADED: "conex\xE3o degradada \u2014 recuperando",
      RECONNECTING: "reconectando",
      // M2: o rótulo antigo ("reabra o ZapLite") pedia ao usuário exatamente o
      // que este app existe para evitar. FAILED agora é descanso com prazo.
      FAILED: "sem conex\xE3o \u2014 descansando antes de tentar de novo"
    };
    const GRAVIDADE = {
      CONNECTED: 0,
      STARTING: 1,
      NEEDS_AUTH: 2,
      DEGRADED: 3,
      OFFLINE: 3,
      RECONNECTING: 3,
      FAILED: 4
    };
    const COR = ["#22d3aa", "#f5c451", "#f5c451", "#f5c451", "#ef6461"];
    const BASE_BADGE = "position:fixed;left:10px;bottom:10px;z-index:2147483003;pointer-events:none;border-radius:999px;box-sizing:border-box;font:600 11.5px system-ui,-apple-system,sans-serif;";
    function sinaliza() {
      try {
        if (!document.body) return;
        const rEst = rust && rust.state;
        const gJs = GRAVIDADE[state] || 0;
        const gRs = rEst ? GRAVIDADE[rEst] || 0 : -1;
        const doRust = gRs > gJs;
        const efetivo = doRust ? rEst : state;
        const grav = gRs > gJs ? gRs : gJs;
        let el = document.getElementById("zl-conn-badge");
        if (!el) {
          el = document.createElement("div");
          el.id = "zl-conn-badge";
          el.setAttribute("aria-live", "polite");
          document.body.appendChild(el);
        }
        el.title = "ZapLite \u2014 p\xE1gina: " + state + " \xB7 app: " + (rEst || "\u2014");
        if (grav === 0) {
          el.style.cssText = BASE_BADGE + "width:7px;height:7px;padding:0;opacity:.3;background:" + COR[0] + ";";
          el.textContent = "";
          return;
        }
        el.style.cssText = BASE_BADGE + "padding:5px 10px;max-width:52vw;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:#04120e;opacity:.96;box-shadow:0 4px 16px rgba(0,0,0,.32);background:" + (COR[grav] || COR[3]) + ";";
        const seg = Math.round((Date.now() - (doRust ? rust.ts : since)) / 1e3);
        const tent = doRust ? rust.attempts : attempts;
        const espera = Math.round((aguardandoAte - Date.now()) / 1e3);
        el.textContent = "ZapLite \u2022 " + (ROTULO[efetivo] || efetivo) + (doRust && rustSozinho ? " \xB7 o app est\xE1 agindo" : "") + (tent ? " \xB7 tentativa " + tent : "") + (espera > 1 ? " \xB7 aguardando " + espera + "s" : "") + (seg > 4 ? " \xB7 " + seg + "s" : "");
      } catch (_) {
      }
    }
    function socketsImplicados(now) {
      const alvos = /* @__PURE__ */ new Set();
      socketsPresos(now).forEach((p) => alvos.add(p.ws));
      live.forEach((r, w) => {
        try {
          if (w.readyState !== NativeWS.OPEN) return;
          if (now - r.rx > SILENCE_MS) {
            alvos.add(w);
            return;
          }
          if (r.tx && r.tx > r.rx && now - r.tx > UNANSWERED_MS) alvos.add(w);
        } catch (_) {
        }
      });
      return [...alvos];
    }
    function cutucaReconexao() {
      try {
        window.dispatchEvent(new Event("offline"));
        window.dispatchEvent(new Event("online"));
      } catch (_) {
      }
    }
    function nivel1() {
      const agora = Date.now();
      const alvos = socketsImplicados(agora);
      cutucaReconexao();
      if (!alvos.length) {
        console.log("[ZapLite/conn] n\xEDvel 1 brando: nenhum socket implicado, nada foi fechado");
        return "brando (nenhum socket implicado)";
      }
      alvos.forEach((w) => {
        try {
          w.close();
        } catch (_) {
        }
      });
      return alvos.length + " de " + live.size + " sockets fechados (implicados)";
    }
    function ehFalhaComprovada(target, cenario, why) {
      if (target !== "OFFLINE" && target !== "DEGRADED") return false;
      if (cenario === "envio-preso") return true;
      return why === "websocket fechado sem retomada" || why.indexOf("fila de envio sem progresso") === 0;
    }
    function pedeRecuperacao(nivel, cenario, why, comprovada) {
      pedindo = true;
      invoke("conn_recovery", {
        nivel,
        cenario,
        reason: why,
        comprovada: !!comprovada
      }).then((v) => {
        semPonte = false;
        const a = parseInt(v && v.attempts || 0, 10);
        if (isFinite(a) && a >= 0) attempts = Math.min(a, MAX_ATTEMPTS);
        const ms = parseInt(v && v.esperaMs || 0, 10);
        const espera = isFinite(ms) && ms > 0 ? Math.min(ms, 30 * 6e4) : 0;
        nextAttemptAt = Date.now() + espera;
        if (!v || !v.permitido) {
          aguardandoAte = nextAttemptAt;
          aguardandoMotivo = v && typeof v.motivo === "string" ? v.motivo.slice(0, 160) : "recupera\xE7\xE3o negada";
          if (v && v.convergiu && state !== "FAILED") {
            setState("FAILED", "convergiu \u2014 " + aguardandoMotivo);
          }
          sinaliza();
          return;
        }
        aguardandoAte = 0;
        aguardandoMotivo = "";
        const motivo = "n\xEDvel " + nivel + ", tentativa " + attempts + " (contada pelo Rust) \u2014 " + why;
        if (state !== "RECONNECTING") {
          setState("RECONNECTING", motivo);
        } else {
          reason = motivo;
          since = Date.now();
          sendTransition("RECONNECTING", "RECONNECTING", motivo, since);
          sinaliza();
        }
        if (nivel === 1) nivel1();
        else {
          try {
            location.reload();
          } catch (_) {
          }
        }
      }).catch(() => {
        semPonte = true;
        attempts = Math.min(attempts + 1, MAX_ATTEMPTS);
        nextAttemptAt = Date.now() + backoffDe(attempts);
        nivel1();
      }).finally(() => {
        pedindo = false;
      });
    }
    function evaluate() {
      if (evaluating) return;
      evaluating = true;
      try {
        evaluateInner();
      } catch (e) {
        console.warn("[ZapLite/conn] avalia\xE7\xE3o falhou", e);
      }
      evaluating = false;
    }
    function agenda() {
      if (agendado) return;
      agendado = setTimeout(() => {
        agendado = 0;
        evaluate();
      }, DEBOUNCE_MS);
    }
    function evaluateInner() {
      const now = Date.now();
      const abertos = openSockets();
      if (abertos > 0) lastOpenTs = now;
      const prontoAgora = appReady();
      if (prontoAgora) naoProntoTicks = 0;
      else if (state === "CONNECTED" || state === "DEGRADED") naoProntoTicks++;
      else naoProntoTicks = 99;
      const pronto = prontoAgora || naoProntoTicks <= 2;
      const carregando = loadingScreen();
      const loginAgora = loginScreen();
      if (loginAgora) {
        loginTicks++;
        if (authDesde == null) authDesde = now;
      } else {
        loginTicks = 0;
        authDesde = null;
      }
      if (pronto || loginAgora) semUiDesde = null;
      else if (semUiDesde == null) semUiDesde = now;
      const presos = socketsPresos(now);
      if (pendingOutgoing()) {
        if (pendingSince == null) pendingSince = now;
      } else pendingSince = null;
      const socketDown = hadSocket && abertos === 0 && now - lastOpenTs > SOCKET_GRACE_MS;
      const banner = offlineBanner();
      const rxIdade = lastRx ? now - lastRx : Infinity;
      const semResposta = txSemResposta ? now - txSemResposta : 0;
      if (!navigator.onLine || socketDown || banner || presos.length) ultimaQueda = now;
      let porCarregamento = false;
      let cenario = "socket";
      let target, why;
      if (!navigator.onLine) {
        target = "OFFLINE";
        why = "navigator.onLine=false";
      } else if (banner) {
        target = "OFFLINE";
        why = banner;
      } else if (socketDown && pronto && !carregando) {
        target = "OFFLINE";
        why = "websocket fechado sem retomada";
      } else if (pronto && presos.length) {
        target = "DEGRADED";
        why = "fila de envio sem progresso h\xE1 " + (presos[0].ms / 1e3).toFixed(1) + "s, " + presos[0].bytes + " bytes presos (recebe mas n\xE3o envia)";
      } else if (pronto && abertos > 0 && txSemResposta && semResposta > UNANSWERED_MS) {
        target = "DEGRADED";
        why = "socket aberto sem resposta h\xE1 " + Math.round(semResposta / 1e3) + "s (recebe mas n\xE3o envia)";
      } else if (pronto && abertos > 0 && rxIdade > SILENCE_MS) {
        target = "DEGRADED";
        why = "socket aberto e mudo h\xE1 " + Math.round(rxIdade / 1e3) + "s (socket zumbi)";
      } else if (pendingSince != null && now - pendingSince > PENDING_MS) {
        target = "DEGRADED";
        why = "mensagem de sa\xEDda presa com rel\xF3gio >" + PENDING_MS / 1e3 + "s" + (ultimoIconePendente ? " [status: " + ultimoIconePendente + "]" : "");
        cenario = "envio-preso";
      } else if (pronto && abertos > 0 && rxIdade <= SILENCE_MS) {
        target = "CONNECTED";
        why = "interface pronta, socket aberto e tr\xE1fego recente";
      } else if (loginTicks >= LOGIN_TICKS_MIN) {
        const idade = now - (authDesde || now);
        const vivo = abertos > 0 && rxIdade < SILENCE_MS;
        const forte = algumVisivel(LOGIN_SEL);
        const suspeito = !vivo || !forte && ultimaQueda > 0 && now - ultimaQueda < QUEDA_RECENTE_MS;
        if (suspeito && idade > AUTH_SUSPEITO_MS) {
          porCarregamento = true;
          cenario = "login-apos-queda";
          target = "DEGRADED";
          why = "tela de login h\xE1 " + Math.round(idade / 1e3) + "s logo ap\xF3s sinais de queda (poss\xEDvel sess\xE3o derrubada)";
        } else {
          target = "NEEDS_AUTH";
          why = suspeito ? "tela de login vis\xEDvel ap\xF3s sinais de queda (aguardando " + Math.round((AUTH_SUSPEITO_MS - idade) / 1e3) + "s antes de tentar)" : "tela de login vis\xEDvel (QR/vincular aparelho) \u2014 esperando voc\xEA escanear, sem recarregar";
        }
      } else {
        const teto = carregando ? LOADING_MAX_MS : STARTING_MAX_MS;
        const idade = now - (semUiDesde || now);
        if (idade > teto) {
          porCarregamento = true;
          cenario = "carregamento";
          target = "DEGRADED";
          why = "sem interface h\xE1 " + Math.round(idade / 1e3) + "s" + (carregando ? " (tela de carregamento travada)" : "") + " \u2014 teto de carregamento estourado";
        } else {
          target = "STARTING";
          why = carregando ? "carregando (tela do WhatsApp)" : pronto ? "interface pronta, socket reabrindo" : "aguardando interface";
        }
      }
      const ruim = target === "OFFLINE" || target === "DEGRADED";
      if (ruim) ultimaQueda = now;
      if (target !== cand) {
        cand = target;
        candDesde = now;
      }
      const maduro = target === "CONNECTED" || target === state || now - candDesde >= CONFIRMA_MS;
      sinaliza();
      if (!ruim) {
        if (state !== target && maduro && !(state === "RECONNECTING" && target === "STARTING")) {
          setState(target, why);
        }
        return;
      }
      if (state === "FAILED") {
        if (now - failedDesde < FAILED_REST_MS) return;
        setState(target, "descanso de " + Math.round(FAILED_REST_MS / 1e3) + "s terminou \u2014 o app volta a tentar sozinho");
      }
      if (!maduro) return;
      if (state !== target && state !== "RECONNECTING") setState(target, why);
      if (!restaurado) return;
      if (attempts >= MAX_ATTEMPTS) {
        setState("FAILED", "circuit breaker: " + attempts + " tentativas seguidas sem sucesso");
        return;
      }
      if (pedindo) return;
      const comprovada = ehFalhaComprovada(target, cenario, why);
      if (now < nextAttemptAt) {
        if (!comprovada) return;
        if (now - ultimoPedidoComprovado < PEDIDO_COMPROVADO_MIN_MS) return;
      }
      if (comprovada) ultimoPedidoComprovado = now;
      let nivel = porCarregamento ? 2 : attempts <= 2 ? 1 : 2;
      if (semPonte && nivel === 2) nivel = 1;
      pedeRecuperacao(nivel, cenario, why, comprovada);
    }
    const tBoot = Date.now();
    ouveRust();
    restauraContador().then(() => {
      ouveRust();
      sendTransition("BOOT", "STARTING", "script de conex\xE3o injetado", tBoot);
    });
    const PULSO_MS = 1e3;
    const PAUSA_MIN_MS = 2e3;
    let ultimoPulso = Date.now();
    let pausaMaxMs = 0;
    setInterval(() => {
      const agora = Date.now();
      const salto = agora - ultimoPulso - PULSO_MS;
      ultimoPulso = agora;
      if (salto > PAUSA_MIN_MS) pausaMaxMs = Math.max(pausaMaxMs, salto);
    }, PULSO_MS);
    function temRascunho() {
      try {
        const main = document.getElementById("main");
        if (!main) return false;
        const box = main.querySelector('div[contenteditable="true"][data-tab]');
        if (!box) return false;
        return (box.innerText || box.textContent || "").trim().length > 0;
      } catch (_) {
        return false;
      }
    }
    setInterval(evaluate, TICK_MS);
    setInterval(amostraBuffers, FAST_TICK_MS);
    let sondaPronto = setInterval(() => {
      if (!document.getElementById("pane-side")) return;
      clearInterval(sondaPronto);
      sondaPronto = 0;
      evaluate();
    }, 100);
    window.addEventListener("online", agenda);
    window.addEventListener("offline", agenda);
    document.addEventListener("visibilitychange", agenda);
    setInterval(() => {
      flushFila();
      if (!ouvindoRust) ouveRust();
      const pausaMs = Math.round(pausaMaxMs);
      invoke("conn_heartbeat", {
        state,
        attempts,
        pausedMs: pausaMs,
        draft: temRascunho()
      }).then(() => {
        semPonte = false;
        pausaMaxMs = Math.max(0, pausaMaxMs - pausaMs);
      }).catch(() => {
        semPonte = true;
      });
    }, HEARTBEAT_MS);
    function simulaQueda(origem) {
      blockUntil = Date.now() + SIM_DROP_MS;
      if (live.size === 0) {
        hadSocket = true;
        lastOpenTs = Date.now() - SOCKET_GRACE_MS;
      }
      live.forEach((_r, w) => {
        try {
          w.close();
        } catch (_) {
        }
      });
      console.log("[ZapLite/conn] queda simulada por " + SIM_DROP_MS + "ms (" + origem + ")");
    }
    window.addEventListener(
      "keydown",
      (e) => {
        if (!e.isTrusted) return;
        if (e.ctrlKey && e.altKey && e.shiftKey && (e.key === "D" || e.key === "d")) {
          e.preventDefault();
          simulaQueda("atalho " + SIM_CHORD);
        }
      },
      true
    );
    window.__ZAPLITE_CONN__ = {
      get info() {
        const now = Date.now();
        return {
          state,
          since,
          attempts,
          reason,
          socketsAbertos: openSockets(),
          lastRx,
          lastTx,
          txSemResposta,
          bufferPreso: bufferPreso(),
          presos: socketsPresos(now).map((p) => ({ bytes: p.bytes, ms: p.ms })),
          proximaTentativaEm: Math.max(0, nextAttemptAt - now),
          aguardandoEm: Math.max(0, aguardandoAte - now),
          aguardandoMotivo,
          implicados: socketsImplicados(now).length,
          sockets: live.size,
          failedHaMs: failedDesde ? now - failedDesde : 0,
          restaurado,
          semPonte,
          pedindo,
          fila: fila.length,
          // sinais crus, p/ auditoria — leitura, nunca ação
          login: loginScreen(),
          banner: offlineBanner(),
          pronto: appReady(),
          authIdadeMs: authDesde ? now - authDesde : 0,
          quedaHaMs: ultimaQueda ? now - ultimaQueda : -1,
          candidato: cand,
          candidatoHaMs: cand ? now - candDesde : 0,
          rust,
          rustSozinho,
          ouvindoRust
        };
      },
      simulateDrop() {
        console.warn(
          "[ZapLite/conn] simulateDrop() desativado no bundle de produ\xE7\xE3o: era nega\xE7\xE3o de servi\xE7o acion\xE1vel por qualquer script da p\xE1gina. Use " + SIM_CHORD + " (evento confi\xE1vel: teclado do usu\xE1rio ou CDP Input.dispatchKeyEvent)."
        );
        return "desativado: use " + SIM_CHORD + " com evento confi\xE1vel";
      }
    };
  }

  // src-tauri/injection/src/midia.js
  var AUD_MIME = /^audio\//i;
  var AUD_MAX_BLOBS = 24;
  var AUD_ESPERA_MS = 2e4;
  var AUD = { blobs: /* @__PURE__ */ new Map(), ordem: [], play: null, capturando: false };
  function lembrarBlob(url, blob) {
    AUD.blobs.set(url, { blob, ts: Date.now() });
    AUD.ordem.push(url);
    while (AUD.ordem.length > AUD_MAX_BLOBS) {
      const velho = AUD.ordem.shift();
      if (velho !== url) AUD.blobs.delete(velho);
    }
  }
  function instalarCapturaDeAudio() {
    try {
      URL.createObjectURL = new Proxy(URL.createObjectURL, {
        apply(alvo, self, args) {
          const url = Reflect.apply(alvo, self, args);
          try {
            const o = args[0];
            if (o && typeof o.arrayBuffer === "function" && AUD_MIME.test(String(o.type || ""))) {
              lembrarBlob(url, o);
            }
          } catch (_) {
          }
          return url;
        }
      });
      HTMLMediaElement.prototype.play = new Proxy(HTMLMediaElement.prototype.play, {
        apply(alvo, self, args) {
          try {
            if (AUD.capturando) self.muted = true;
            AUD.play = { el: self, ts: Date.now() };
          } catch (_) {
          }
          return Reflect.apply(alvo, self, args);
        }
      });
    } catch (e) {
      console.error("[ZapLite] n\xE3o consegui instalar a captura de \xE1udio:", e);
    }
  }
  function cliqueReal(alvo) {
    if (!alvo) return;
    const r = alvo.getBoundingClientRect();
    const x = r.left + r.width / 2;
    const y = r.top + r.height / 2;
    const passos = [
      ["pointerover", 0],
      ["pointerdown", 1],
      ["mousedown", 1],
      ["pointerup", 0],
      ["mouseup", 0],
      ["click", 0]
    ];
    for (const [tipo, botoes] of passos) {
      const Ctor = tipo.indexOf("pointer") === 0 && window.PointerEvent ? PointerEvent : MouseEvent;
      try {
        alvo.dispatchEvent(
          new Ctor(tipo, {
            bubbles: true,
            cancelable: true,
            composed: true,
            view: window,
            clientX: x,
            clientY: y,
            button: 0,
            buttons: botoes,
            pointerId: 1,
            isPrimary: true
          })
        );
      } catch (_) {
      }
    }
  }
  var AUD_SINAL_SELS = [
    "audio",
    '[data-testid="ptt-status"]',
    '[data-icon="ptt-status"]',
    '[data-testid="audio-player-frame-spinner"]',
    '[data-testid^="audio-player"]',
    'button[aria-label*="eproduzir mensagem de voz"]',
    'button[aria-label*="ausar mensagem de voz"]',
    'button[aria-label*="lay voice"]'
  ];
  var AUD_CTRL_SELS = [
    'button[aria-label*="eproduzir"]',
    // pt-BR (medido)
    'button[aria-label*="lay voice"]',
    // en
    'button[aria-label*="lay audio"]',
    '[data-icon="audio-play"]',
    '[data-icon="play"]',
    '[data-testid="audio-player-frame-spinner"]'
    // enquanto ainda baixa
  ];
  var AUD_PAUSA_SELS = ['button[aria-label*="ausar"]', 'button[aria-label*="ause"]'];
  function primeiro(bolha, sels) {
    if (!bolha) return null;
    for (const s of sels) {
      const el = bolha.querySelector(s);
      if (el) return el.closest("button") || el;
    }
    return null;
  }
  var controleDeAudio = (bolha) => primeiro(bolha, AUD_CTRL_SELS);
  var ehBolhaDeAudio = (bolha) => !!primeiro(bolha, AUD_SINAL_SELS);
  function esperarBytes(marca, ms) {
    return new Promise((resolve) => {
      const t0 = Date.now();
      const olhar = () => {
        if (AUD.play && AUD.play.ts >= marca) {
          const el = AUD.play.el;
          const src = el && (el.src || el.currentSrc) || "";
          const g = AUD.blobs.get(src);
          if (g || src) return resolve({ el, src, blob: g && g.blob });
        }
        for (let i = AUD.ordem.length - 1; i >= 0; i--) {
          const g = AUD.blobs.get(AUD.ordem[i]);
          if (g && g.ts >= marca) return resolve({ el: AUD.play && AUD.play.el, src: AUD.ordem[i], blob: g.blob });
        }
        if (Date.now() - t0 >= ms) return resolve({});
        setTimeout(olhar, 100);
      };
      olhar();
    });
  }
  async function blobDoAudio(bolha) {
    const el = bolha && bolha.querySelector("audio,video");
    const src0 = el && (el.src || el.currentSrc);
    if (src0) {
      const g = AUD.blobs.get(src0);
      if (g) return g.blob;
      return await (await fetch(src0)).blob();
    }
    const ctrl = controleDeAudio(bolha);
    if (!ctrl) {
      const tocando = primeiro(bolha, AUD_PAUSA_SELS) && AUD.play && AUD.play.el;
      const src = tocando && (AUD.play.el.src || AUD.play.el.currentSrc);
      if (src) {
        const g = AUD.blobs.get(src);
        return g ? g.blob : await (await fetch(src)).blob();
      }
      throw new Error("esta mensagem n\xE3o tem player de \xE1udio (nenhum controle encontrado na bolha).");
    }
    const marca = Date.now();
    AUD.capturando = true;
    let achado = {};
    try {
      cliqueReal(ctrl);
      achado = await esperarBytes(marca, AUD_ESPERA_MS);
    } finally {
      AUD.capturando = false;
      try {
        const p = achado.el || AUD.play && AUD.play.el;
        if (p) {
          p.pause();
          p.currentTime = 0;
          p.muted = false;
        }
      } catch (_) {
      }
    }
    if (achado.blob) return achado.blob;
    if (achado.src) return await (await fetch(achado.src)).blob();
    throw new Error(
      "pedi para reproduzir e os bytes do \xE1udio n\xE3o apareceram em " + Math.round(AUD_ESPERA_MS / 1e3) + "s."
    );
  }
  function paraBase64(bytes) {
    let s = "";
    const PEDACO = 32768;
    for (let i = 0; i < bytes.length; i += PEDACO) {
      s += String.fromCharCode.apply(null, bytes.subarray(i, i + PEDACO));
    }
    return btoa(s);
  }
  function formatarTamanho(n) {
    if (!n) return "";
    if (n < 1024) return n + " B";
    if (n < 1024 * 1024) return (n / 1024).toFixed(0) + " KB";
    return (n / 1024 / 1024).toFixed(1) + " MB";
  }
  function mostrarProgresso(titulo, texto, pct) {
    const p = showPanel(titulo, texto);
    const corpo = p.querySelector(".zl-panel-body");
    const bar = document.createElement("div");
    bar.className = "zl-bar";
    const i = document.createElement("i");
    i.style.width = Math.max(0, Math.min(100, Math.round(pct || 0))) + "%";
    bar.appendChild(i);
    corpo.appendChild(bar);
    return p;
  }
  function fecharPainel() {
    const p = document.getElementById("zl-panel");
    if (p) p.remove();
  }
  function avisarSalvo(caminho, bytes) {
    const tam = bytes ? "\n" + formatarTamanho(bytes) : "";
    showPanel("Arquivo salvo", caminho + tam, [
      [
        "Abrir arquivo",
        () => invoke("abrir_arquivo", { caminho }).catch((e) => showPanel("Erro", e.message))
      ],
      [
        "Abrir a pasta",
        () => invoke("revelar_arquivo", { caminho }).catch((e) => showPanel("Erro", e.message))
      ]
    ]);
  }
  var _ouvindoGravacao = false;
  function ouvirEventosDeGravacao() {
    if (_ouvindoGravacao) return;
    if (!window.__TAURI__ || !window.__TAURI__.event) return;
    _ouvindoGravacao = true;
    const ev = window.__TAURI__.event;
    ev.listen("zaplite://save-progress", (e) => {
      const p = e && e.payload || {};
      if (typeof p.pct === "number") mostrarProgresso("Salvando arquivo", "Gravando no disco\u2026", p.pct);
    }).catch(() => {
    });
    ev.listen("zaplite://midia-salva", (e) => {
      const p = e && e.payload || {};
      if (p.erro) return showPanel("N\xE3o deu para salvar", p.erro);
      if (p.cancelado) {
        return showPanel(
          "Download descartado",
          "Voc\xEA fechou a janela sem escolher onde salvar \u201C" + (p.nome || "arquivo") + "\u201D. O arquivo tempor\xE1rio foi apagado \u2014 nada ficou no disco."
        );
      }
      avisarSalvo(p.path, p.bytes);
    }).catch(() => {
    });
  }
  async function bytesComProgresso(blob, titulo) {
    const total = blob.size || 0;
    if (!blob.stream || total < 4 * 1024 * 1024) {
      return new Uint8Array(await blob.arrayBuffer());
    }
    const leitor = blob.stream().getReader();
    const partes = [];
    let lido = 0;
    for (; ; ) {
      const passo = await leitor.read();
      if (passo.done) break;
      partes.push(passo.value);
      lido += passo.value.length;
      mostrarProgresso(titulo, "Preparando o arquivo\u2026", lido * 100 / total);
    }
    const out = new Uint8Array(lido);
    let off = 0;
    for (const p of partes) {
      out.set(p, off);
      off += p.length;
    }
    return out;
  }
  async function paraBase64Async(bytes, titulo) {
    let s = "";
    const PEDACO = 32768;
    let desde = Date.now();
    for (let i = 0; i < bytes.length; i += PEDACO) {
      s += String.fromCharCode.apply(null, bytes.subarray(i, i + PEDACO));
      if (Date.now() - desde > 16) {
        mostrarProgresso(titulo, "Preparando o arquivo\u2026", i * 100 / bytes.length);
        await new Promise((r) => setTimeout(r, 0));
        desde = Date.now();
      }
    }
    return btoa(s);
  }
  var EXT_POR_MIME = {
    "image/jpeg": "jpg",
    "image/png": "png",
    "image/webp": "webp",
    "image/gif": "gif",
    "video/mp4": "mp4",
    "video/webm": "webm",
    "video/quicktime": "mov",
    "audio/ogg": "ogg",
    "audio/mpeg": "mp3",
    "audio/mp4": "m4a",
    "application/pdf": "pdf",
    // MEDIDO na prova da onda 2: o primeiro export de conversa saiu como
    // `...-092429.plain`, porque o palpite `mime.split("/")[1]` transforma
    // `text/plain` em "plain". Extensão errada não é cosmética — é o Windows
    // não sabendo com que programa abrir o arquivo que o usuário acabou de
    // salvar. Os dois tipos que o exportador produz entram no mapa.
    "text/plain": "txt",
    "application/json": "json",
    "text/csv": "csv"
  };
  function nomeSugerido(blob, prefixo) {
    const mime = String(blob && blob.type || "").split(";")[0].trim().toLowerCase();
    const ext = EXT_POR_MIME[mime] || (mime.split("/")[1] || "bin").replace(/[^a-z0-9]/g, "");
    const d = /* @__PURE__ */ new Date();
    const p = (n) => String(n).padStart(2, "0");
    const carimbo = d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + "-" + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds());
    return (prefixo || "zaplite") + "-" + carimbo + "." + ext;
  }
  async function salvarArquivo(blob, prefixo) {
    ouvirEventosDeGravacao();
    const titulo = "Salvando arquivo";
    mostrarProgresso(titulo, "Preparando o arquivo\u2026", 0);
    const bytes = await bytesComProgresso(blob, titulo);
    const b64 = await paraBase64Async(bytes, titulo);
    mostrarProgresso(titulo, "Escolha onde salvar na janela do Windows\u2026", 100);
    const r = await invoke("save_media", { dataB64: b64, filename: nomeSugerido(blob, prefixo) });
    if (!r || r.cancelado) {
      fecharPainel();
      return null;
    }
    avisarSalvo(r.path, r.bytes);
    return r.path;
  }
  async function wav16kMono(blob) {
    const buf = await blob.arrayBuffer();
    const Off = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    if (!Off) throw new Error("sem OfflineAudioContext nesta webview");
    let dados = await new Off(1, 1, 16e3).decodeAudioData(buf.slice(0));
    if (dados.sampleRate !== 16e3) {
      const off = new Off(1, Math.max(1, Math.ceil(dados.duration * 16e3)), 16e3);
      const fonte = off.createBufferSource();
      fonte.buffer = dados;
      fonte.connect(off.destination);
      fonte.start();
      dados = await off.startRendering();
    }
    const n = dados.length;
    const canais = dados.numberOfChannels;
    const wav = new Uint8Array(44 + n * 2);
    const dv = new DataView(wav.buffer);
    const txt = (p, s) => {
      for (let i = 0; i < s.length; i++) wav[p + i] = s.charCodeAt(i);
    };
    txt(0, "RIFF");
    dv.setUint32(4, 36 + n * 2, true);
    txt(8, "WAVE");
    txt(12, "fmt ");
    dv.setUint32(16, 16, true);
    dv.setUint16(20, 1, true);
    dv.setUint16(22, 1, true);
    dv.setUint32(24, 16e3, true);
    dv.setUint32(28, 16e3 * 2, true);
    dv.setUint16(32, 2, true);
    dv.setUint16(34, 16, true);
    txt(36, "data");
    dv.setUint32(40, n * 2, true);
    const c0 = dados.getChannelData(0);
    const c1 = canais > 1 ? dados.getChannelData(1) : null;
    for (let i = 0; i < n; i++) {
      let v = c1 ? (c0[i] + c1[i]) / 2 : c0[i];
      v = v < -1 ? -1 : v > 1 ? 1 : v;
      dv.setInt16(44 + i * 2, v < 0 ? v * 32768 : v * 32767, true);
    }
    return wav;
  }
  function contextoDaConversa() {
    const partes = [];
    const titulo = document.querySelector("#main header span[title]");
    if (titulo) partes.push(titulo.getAttribute("title") || titulo.textContent || "");
    try {
      const bolhas = bolhasVisiveis().slice(-25);
      for (const b of bolhas) {
        const t = (textoDaBolha(b) || "").trim();
        if (t && t.length < 220) partes.push(t);
      }
    } catch (_) {
    }
    let ctx = partes.filter(Boolean).join(". ").replace(/\s+/g, " ").trim();
    if (ctx.length > 800) ctx = ctx.slice(ctx.length - 800);
    return ctx;
  }
  function segundosDaBolha(bolha) {
    try {
      const m = /(?:^|\s)(\d{1,2}):([0-5]\d)(?::([0-5]\d))?(?:\s|$)/.exec(bolha.textContent || "");
      if (!m) return 0;
      return m[3] ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) : Number(m[1]) * 60 + Number(m[2]);
    } catch (_) {
      return 0;
    }
  }
  async function transcreverBolha(bolha, maxSeg) {
    const blob = await blobDoAudio(bolha);
    let b64;
    try {
      const wav = await wav16kMono(blob);
      if (maxSeg && (wav.length - 44) / 2 / 16e3 > maxSeg) {
        const err = new Error("\xE1udio mais longo que o limite de " + maxSeg + "s");
        err.zlLongoDemais = true;
        throw err;
      }
      b64 = paraBase64(wav);
    } catch (e) {
      if (e && e.zlLongoDemais) throw e;
      console.warn("[ZapLite] decodifica\xE7\xE3o na p\xE1gina falhou:", e);
      b64 = paraBase64(new Uint8Array(await blob.arrayBuffer()));
    }
    return await invoke("transcribe_audio", { audioB64: b64, prompt: contextoDaConversa() });
  }
  function mostrarTranscricaoNaBolha(bolha, texto, marca) {
    if (!bolha || bolha.querySelector(".zl-tr-txt")) return null;
    const out = document.createElement("div");
    out.className = "zl-recovered zl-tr-out";
    const txt = document.createElement("span");
    txt.className = "zl-tr-txt";
    txt.textContent = (marca || "\u{1F4DD} ") + texto;
    out.appendChild(txt);
    const cp = document.createElement("button");
    cp.className = "zl-tr-copy";
    cp.textContent = "Copiar";
    cp.title = "Copiar a transcri\xE7\xE3o";
    cp.onclick = async (ev) => {
      ev.stopPropagation();
      try {
        await navigator.clipboard.writeText(texto);
      } catch (_) {
        const r = document.createRange();
        r.selectNodeContents(txt);
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(r);
      }
      cp.textContent = "Copiado!";
      setTimeout(() => {
        cp.textContent = "Copiar";
      }, 1400);
    };
    out.appendChild(cp);
    bolha.appendChild(out);
    return out;
  }

  // src-tauri/injection/src/links.js
  var LINK_ESQUEMA = /^(https?:|mailto:|tel:)/i;
  function ehLinkDoWhatsApp(url) {
    try {
      const h = new URL(url, location.href).hostname.toLowerCase();
      return h === "web.whatsapp.com" || h.endsWith(".whatsapp.com") || h.endsWith(".whatsapp.net");
    } catch (_) {
      return false;
    }
  }
  var RASCUNHO_CHAVE = "zaplite:rascunho-de-link";
  var RASCUNHO_TTL = 3 * 60 * 1e3;
  function telefoneValido(bruto) {
    const d = String(bruto || "").replace(/\D+/g, "");
    return d.length >= 8 && d.length <= 15 ? d : null;
  }
  function codigoValido(bruto) {
    const c = String(bruto || "").trim();
    return c && c.length <= 64 && /^[A-Za-z0-9_-]+$/.test(c) ? c : null;
  }
  function textoDeLink(bruto) {
    const entrada = String(bruto || "");
    let saida = "";
    for (let i = 0; i < entrada.length && saida.length < 4096; i++) {
      const c = entrada.charCodeAt(i);
      const quebra = c === 10 || c === 9;
      if (c < 32 && !quebra || c === 127 || c === 65279) continue;
      saida += entrada[i];
    }
    return saida;
  }
  function alvoDeLinkWeb(href) {
    let u;
    try {
      u = new URL(href, location.href);
    } catch (_) {
      return null;
    }
    if (u.protocol !== "https:" && u.protocol !== "http:") return null;
    const host = u.hostname.toLowerCase();
    const texto = textoDeLink(u.searchParams.get("text") || "");
    if (host === "wa.me" || host === "www.wa.me") {
      const p = telefoneValido(u.pathname.replace(/^\/+/, "").split("/")[0]);
      return p ? { phone: p, code: "", text: texto } : null;
    }
    if (host === "api.whatsapp.com" || host === "web.whatsapp.com") {
      if (!/^\/send\/?$/.test(u.pathname)) return null;
      const p = telefoneValido(u.searchParams.get("phone") || "");
      return p ? { phone: p, code: "", text: texto } : null;
    }
    if (host === "chat.whatsapp.com") {
      const c = codigoValido(u.pathname.replace(/^\/+/, "").split("/")[0]);
      return c ? { phone: "", code: c, text: texto } : null;
    }
    return null;
  }
  function abrirAlvoWhatsapp(alvo) {
    if (!alvo) return;
    const phone = telefoneValido(alvo.phone);
    const code = codigoValido(alvo.code);
    if (!phone && !code) return;
    const texto = textoDeLink(alvo.text);
    const jaEstamos = phone && /^\/send\/?$/.test(location.pathname) && telefoneValido(new URLSearchParams(location.search).get("phone")) === phone;
    if (texto) {
      try {
        sessionStorage.setItem(
          RASCUNHO_CHAVE,
          JSON.stringify({ texto, ts: Date.now() })
        );
      } catch (_) {
      }
    }
    if (jaEstamos) return preencherRascunhoPendente();
    const destino = phone ? "https://web.whatsapp.com/send?phone=" + encodeURIComponent(phone) : "https://web.whatsapp.com/accept?code=" + encodeURIComponent(code);
    console.log("[ZapLite] abrindo conversa pedida por link:", phone || "convite " + code);
    location.assign(destino);
  }
  async function preencherRascunhoPendente() {
    let pend = null;
    try {
      const bruto = sessionStorage.getItem(RASCUNHO_CHAVE);
      if (!bruto) return;
      sessionStorage.removeItem(RASCUNHO_CHAVE);
      pend = JSON.parse(bruto);
    } catch (_) {
      return;
    }
    if (!pend || !pend.texto || Date.now() - (pend.ts || 0) > RASCUNHO_TTL) return;
    const box = await until(
      () => {
        const main = document.getElementById("main");
        return main && main.querySelector('div[contenteditable="true"][data-tab]');
      },
      6e4
    );
    if (!box) {
      console.warn("[ZapLite] a conversa do link n\xE3o abriu; o rascunho n\xE3o foi escrito");
      return;
    }
    if ((box.innerText || box.textContent || "").trim()) return;
    try {
      box.focus();
      document.execCommand("insertText", false, textoDeLink(pend.texto));
      console.log("[ZapLite] rascunho do link escrito na caixa (N\xC3O enviado)");
    } catch (e) {
      console.warn("[ZapLite] n\xE3o consegui escrever o rascunho do link:", e);
    }
  }
  function instalarLinksProfundos() {
    if (!window.__TAURI__ || !window.__TAURI__.event) return;
    window.__TAURI__.event.listen("zaplite://deep-link", (ev) => {
      const p = ev && ev.payload;
      if (p && typeof p === "object") abrirAlvoWhatsapp(p);
    }).catch(() => {
    });
    invoke("take_pending_deeplink").then((alvo) => {
      if (alvo) abrirAlvoWhatsapp(alvo);
    }).catch(() => {
    });
  }
  function instalarAberturaDeLinks() {
    document.addEventListener(
      "click",
      (e) => {
        if (e.defaultPrevented || e.button !== 0) return;
        if (e.ctrlKey || e.shiftKey || e.altKey || e.metaKey) return;
        const a = e.target && e.target.closest && e.target.closest("a[href]");
        if (!a) return;
        const bruto = a.getAttribute("href") || "";
        if (!LINK_ESQUEMA.test(bruto)) return;
        const url = a.href;
        const alvoLocal = alvoDeLinkWeb(url);
        if (alvoLocal) {
          e.preventDefault();
          e.stopPropagation();
          abrirAlvoWhatsapp(alvoLocal);
          return;
        }
        if (ehLinkDoWhatsApp(url)) return;
        e.preventDefault();
        e.stopPropagation();
        invoke("open_external", { url }).catch(() => {
          try {
            window.open(url, "_blank", "noopener");
          } catch (_) {
          }
        });
      },
      true
    );
  }

  // src-tauri/injection/src/boot.js
  async function boot() {
    try {
      const body = await until(() => document.body, 3e4);
      if (!body) {
        console.error("[ZapLite] body nunca apareceu; abortando.");
        return;
      }
      montarDock();
      mountHeaderButton();
      ouvirEventosDeGravacao();
      instalarAberturaDeLinks();
      preencherRascunhoPendente();
      instalarLinksProfundos();
      await applyAll();
      const guard = new MutationObserver(() => {
        if (!document.getElementById("zl-dock")) {
          montarDock();
          applyAll();
        }
        if (!document.getElementById("zl-hdr")) mountHeaderButton();
      });
      guard.observe(document.body, { childList: true, subtree: true });
      window.addEventListener("keydown", (e) => {
        if (e.ctrlKey && e.shiftKey && (e.key === "Z" || e.key === "z")) {
          e.preventDefault();
          invoke("open_settings").catch(() => {
          });
        }
      });
      console.log(
        "[ZapLite] pronto. Ponte nativa:",
        !!window.__TAURI__,
        "| m\xF3dulos ligados:",
        Object.entries(settings.modules || {}).filter(([, v]) => v).map(([k]) => k).join(", ") || "nenhum"
      );
    } catch (e) {
      console.error("[ZapLite] falha no boot:", e);
    }
  }

  // src-tauri/injection/src/modulos/envio-nao-salvo.js
  function registrarEnvioNaoSalvo() {
    reg({
      id: "unsavedSend",
      apply() {
        addAct(ensureDock(), "zl-unsaved", "\u260E", "Enviar p/ n\xFAmero n\xE3o salvo", "", () => {
          const raw = prompt("N\xFAmero com DDI e DDD (s\xF3 d\xEDgitos). Ex: 5511999998888");
          if (!raw) return;
          const num = raw.replace(/\D/g, "");
          if (num.length < 10) return alert("N\xFAmero inv\xE1lido.");
          location.href = "https://web.whatsapp.com/send?phone=" + num;
        });
      },
      revert() {
        dropAct("zl-unsaved");
      }
    });
  }

  // src-tauri/injection/src/modulos/anti-apagadas.js
  var AD_MAX_ENTRADAS = 600;
  var AD_MAX_TEXTO = 4096;
  var AD_VARREDURA_MS = 500;
  var AD_INICIAL_TENTATIVAS = 12;
  var AD_INICIAL_INTERVALO = 600;
  function registrarAntiApagadas() {
    reg({
      id: "antiDelete",
      _store: /* @__PURE__ */ new Map(),
      /** A6 — consulta pública do que foi guardado. O `_store` existia mas não
          havia como perguntar nada a ele: o texto só aparecia se a varredura
          conseguisse pendurar a tarja na hora certa. Agora o menu do botão
          direito pergunta aqui. Devolve string ou "". */
      textoGuardado(bolha) {
        const id = idDaBolha(bolha);
        return id && this._store.get(id) || "";
      },
      /** Pendura a tarja "(recuperada)" nesta bolha, se ainda não estiver lá. */
      revelarNaBolha(bolha, texto) {
        if (!bolha || !texto || bolha.querySelector(".zl-recovered")) return false;
        const tag = document.createElement("div");
        tag.className = "zl-recovered";
        tag.textContent = "\u{1F575}\uFE0F (recuperada) " + texto;
        bolha.appendChild(tag);
        return true;
      },
      apply() {
        if (this._hooked) return;
        this._hooked = true;
        const store = this._store;
        const guarda = (id, texto) => {
          if (!id) return;
          if (store.has(id)) store.delete(id);
          store.set(id, texto.length > AD_MAX_TEXTO ? texto.slice(0, AD_MAX_TEXTO) : texto);
          while (store.size > AD_MAX_ENTRADAS) {
            store.delete(store.keys().next().value);
          }
        };
        const capturar = (row) => {
          const txt = textoDaBolha(row);
          if (txt) guarda(idDaBolha(row), txt);
        };
        const marcarApagadas = () => {
          bolhasVisiveis().forEach((row) => {
            if (row.querySelector(".zl-recovered")) return;
            if (!ehApagada(row)) return;
            const id = idDaBolha(row);
            const original = id && store.get(id);
            if (original) {
              const tag = document.createElement("div");
              tag.className = "zl-recovered";
              tag.textContent = "\u{1F575}\uFE0F (recuperada) " + original;
              row.appendChild(tag);
            }
          });
        };
        const pedirVarredura = throttleComCauda(marcarApagadas, AD_VARREDURA_MS);
        this._pedirVarredura = pedirVarredura;
        const obs = new MutationObserver((muts) => {
          for (const m of muts) {
            for (const node of m.addedNodes) {
              if (!(node instanceof HTMLElement)) continue;
              bolhasEm(node).forEach(capturar);
            }
          }
          pedirVarredura();
        });
        obs.observe(document.body, { childList: true, subtree: true });
        this._obs = obs;
        let tentativa = 0;
        const varreduraInicial = () => {
          const rows = bolhasVisiveis();
          rows.forEach(capturar);
          pedirVarredura();
          if (rows.length === 0 && ++tentativa < AD_INICIAL_TENTATIVAS) {
            this._inicial = setTimeout(varreduraInicial, AD_INICIAL_INTERVALO);
          } else {
            this._inicial = null;
          }
        };
        varreduraInicial();
      },
      revert() {
        document.querySelectorAll(".zl-recovered").forEach((e) => e.remove());
      }
    });
  }

  // src-tauri/injection/src/modulos/transcrever.js
  function registrarTranscrever() {
    reg({
      id: "transcribe",
      apply() {
        if (this._timer) return;
        const inject = () => {
          bolhasVisiveis().forEach((bubble) => {
            if (bubble.querySelector(".zl-tr-btn") || !ehBolhaDeAudio(bubble)) return;
            const b = document.createElement("button");
            b.className = "zl-tr-btn";
            b.textContent = "\u{1F4DD} Transcrever";
            b.onclick = async () => {
              b.textContent = "\u23F3 ...";
              try {
                mostrarTranscricaoNaBolha(bubble, await transcreverBolha(bubble));
                b.remove();
              } catch (e) {
                b.textContent = "\u{1F4DD} Transcrever";
                if (ehFaltaDeInstalacao(e)) avisarInstalacaoDaTranscricao(e);
                else showPanel("Transcri\xE7\xE3o", e && e.message || String(e));
              }
            };
            (bubble.querySelector(BOLHA_MIOLO) || bubble).appendChild(b);
          });
        };
        this._timer = setInterval(inject, 1500);
      },
      revert() {
        clearInterval(this._timer);
        this._timer = null;
        document.querySelectorAll(".zl-tr-btn").forEach((e) => e.remove());
      }
    });
  }

  // src-tauri/injection/src/ia.js
  async function ai(system, prompt2, extra) {
    return invoke("ai_complete", {
      system,
      prompt: prompt2,
      imageB64: extra && extra.image || null,
      mediaType: extra && extra.mediaType || null
    });
  }
  function collectVisibleMessages(limit = 200) {
    const rows = bolhasVisiveis().slice(-limit);
    return rows.map((r) => {
      const t = textoDaBolha(r);
      return t ? `${ehDeSaida(r) ? "Voc\xEA" : "Contato"}: ${t}` : null;
    }).filter(Boolean).join("\n");
  }
  function cfgIa() {
    const c = settings && settings.ia || {};
    const num = (v, padrao, min, max) => {
      const n = Number(v);
      return Number.isFinite(n) && n >= min && n <= max ? Math.round(n) : padrao;
    };
    const idioma = String(c.traduzirPara || "").trim();
    return {
      traduzirPara: idioma ? idioma.slice(0, 40) : "portugu\xEAs do Brasil",
      digestHoras: num(c.digestHoras, 12, 1, 48),
      digestMaxConversas: num(c.digestMaxConversas, 40, 1, 200),
      digestIncluirAberta: c.digestIncluirAberta !== false
    };
  }
  async function imagemEmBase64(img) {
    const src = img && img.src || "";
    if (!src) throw new Error("n\xE3o achei os bytes desta imagem na p\xE1gina.");
    const blob = await (await fetch(src)).blob();
    const b64 = await new Promise((resolve, reject) => {
      const fr = new FileReader();
      fr.onload = () => resolve(String(fr.result).split(",")[1]);
      fr.onerror = () => reject(new Error("n\xE3o consegui ler os bytes da imagem."));
      fr.readAsDataURL(blob);
    });
    return { b64, mediaType: blob.type || "image/jpeg" };
  }

  // src-tauri/injection/src/modulos/resumir.js
  function registrarResumir() {
    reg({
      id: "summarize",
      apply() {
        addAct(ensureDock(), "zl-sum", "\u2211", "Resumir esta conversa", "", async (b) => {
          const conv = collectVisibleMessages();
          if (!conv) return alert("Abra uma conversa primeiro.");
          showPanel("Resumo da conversa", "Resumindo\u2026");
          try {
            const r = await ai(
              "Voc\xEA resume conversas de WhatsApp em portugu\xEAs do Brasil, de forma objetiva, em t\xF3picos curtos. Destaque decis\xF5es, pend\xEAncias e perguntas em aberto.",
              "Resuma:\n\n" + conv
            );
            showPanel("Resumo da conversa", r);
          } catch (e) {
            showPanel("Resumo da conversa", "Falhou: " + (e.message || e));
          }
        });
      },
      revert() {
        dropAct("zl-sum");
      }
    });
  }

  // src-tauri/injection/src/modulos/rascunho-resposta.js
  function registrarRascunhoResposta() {
    reg({
      id: "draftReply",
      apply() {
        addAct(ensureDock(), "zl-draft", "\u270D", "Sugerir uma resposta", "", async () => {
          const conv = collectVisibleMessages(30);
          if (!conv) return alert("Abra uma conversa primeiro.");
          showPanel("Rascunho", "Escrevendo\u2026");
          try {
            const tone = settings.aiTone || "direto, amig\xE1vel e claro";
            const r = await ai(
              `Voc\xEA sugere UMA resposta curta de WhatsApp em portugu\xEAs do Brasil, no tom ${tone}. Responda apenas com o texto da mensagem, sem aspas.`,
              "Contexto:\n" + conv + "\n\nSugira minha pr\xF3xima resposta."
            );
            const box = document.querySelector('div[contenteditable="true"][data-tab]');
            if (box) {
              box.focus();
              document.execCommand("insertText", false, r.trim());
              const p = document.getElementById("zl-panel");
              if (p) p.remove();
            } else {
              showPanel("Rascunho", r);
            }
          } catch (e) {
            showPanel("Rascunho", "Falhou: " + (e.message || e));
          }
        });
      },
      revert() {
        dropAct("zl-draft");
      }
    });
  }

  // src-tauri/injection/src/modulos/velocidade-audio.js
  function registrarVelocidadeAudio() {
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
      }
    });
  }

  // src-tauri/injection/src/modulos/sempre-no-topo.js
  function registrarSempreNoTopo() {
    reg({
      id: "alwaysOnTop",
      apply() {
        invoke("set_always_on_top", { value: true });
      },
      revert() {
        invoke("set_always_on_top", { value: false });
      }
    });
  }

  // src-tauri/injection/src/modulos/tema.js
  function registrarTema() {
    reg({
      id: "theme",
      apply() {
        const accent = settings.theme && settings.theme.accent || "#7c3aed";
        const radius = settings.theme && settings.theme.radius || "14px";
        css(
          `:root{--zl-accent:${accent};--zl-radius:${radius}}
         [data-icon="status-refreshed"] , span[data-icon="status-outline"]{filter:hue-rotate(0)}
         .zl-fab{background:var(--zl-accent)!important}
         header ._ak8i, .app-wrapper-web{--wa-accent:var(--zl-accent)}`,
          "zl-theme"
        );
      },
      revert() {
        dropCss("zl-theme");
      }
    });
  }

  // src-tauri/injection/src/modulos/declutter.js
  function registrarDeclutter() {
    reg({
      id: "declutter",
      apply() {
        const hide = [];
        if (settings.hide?.status) hide.push('[aria-label*="Status"]', '[data-icon="status-refreshed"]');
        if (settings.hide?.channels) hide.push('[aria-label*="Canais"]', '[aria-label*="Channels"]');
        if (settings.hide?.communities) hide.push('[aria-label*="Comunidades"]', '[aria-label*="Communities"]');
        css(hide.length ? hide.join(",") + "{display:none!important}" : "", "zl-declutter");
      },
      revert() {
        dropCss("zl-declutter");
      }
    });
  }

  // src-tauri/injection/src/modulos/blur-privacidade.js
  function registrarBlurPrivacidade() {
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
      }
    });
  }

  // src-tauri/injection/src/modulos/nsfw-blur.js
  var NSFW_MIN_PX = 40;
  var NSFW_VARREDURA_MS = 400;
  function registrarNsfwBlur() {
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
          } catch (_) {
          }
          const r = el.getBoundingClientRect();
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
          bolhasVisiveis().forEach((b) => midiasDe(b).forEach(marcar));
          if (!(settings.nsfw && settings.nsfw.lista === false)) {
            midiasDe(document.querySelector("#pane-side")).forEach(marcar);
          }
          midiasDe(document.querySelector('[data-testid="media-viewer"]')).forEach(marcar);
          const modal = document.querySelector("[data-animate-modal-body]");
          if (modal) midiasDe(modal).forEach(marcar);
        };
        const pedir = throttleComCauda(varrer, NSFW_VARREDURA_MS);
        self._pedir = pedir;
        self._obs = new MutationObserver(pedir);
        self._obs.observe(document.body, { childList: true, subtree: true });
        self._timer = setInterval(varrer, 1500);
        self._clique = (e) => {
          const alvo = e.target && e.target.closest && e.target.closest(".zl-nsfw-alvo");
          if (alvo) alvo.classList.add("zl-nsfw-livre");
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
      }
    });
  }

  // src-tauri/injection/src/modulos/auto-transcrever.js
  var AT_VARREDURA_MS = 2500;
  var AT_MAX_SEG_PADRAO = 180;
  function registrarAutoTranscrever() {
    reg({
      id: "autoTranscribe",
      _feitos: /* @__PURE__ */ new Set(),
      apply() {
        if (this._timer) return;
        const self = this;
        self._fila = [];
        self._ocupado = false;
        self._desligado = false;
        self._conversa = null;
        const limite = () => {
          const v = Number(settings.transcricao && settings.transcricao.autoMaxSeg || 0);
          return v > 0 ? v : AT_MAX_SEG_PADRAO;
        };
        const chaveDaConversa = () => {
          const t = document.querySelector("#main header span[title]");
          return t && (t.getAttribute("title") || t.textContent) || "";
        };
        const marcarFeito = (b) => {
          const id = idDaBolha(b);
          if (id) self._feitos.add(id);
        };
        const jaFeito = (b) => {
          const id = idDaBolha(b);
          if (id && self._feitos.has(id)) return true;
          return !!b.querySelector(".zl-tr-txt");
        };
        const varrer = () => {
          if (self._desligado) return;
          const chave = chaveDaConversa();
          if (!chave) return;
          const audios = bolhasVisiveis().filter((b) => ehBolhaDeAudio(b) && !ehDeSaida(b));
          if (chave !== self._conversa) {
            self._conversa = chave;
            audios.forEach(marcarFeito);
            return;
          }
          audios.forEach((b) => {
            if (jaFeito(b)) return;
            if (self._fila.indexOf(b) >= 0) return;
            const seg = segundosDaBolha(b);
            if (seg && seg > limite()) {
              marcarFeito(b);
              console.log("[ZapLite] \xE1udio de " + seg + "s acima do limite: transcri\xE7\xE3o autom\xE1tica pulada.");
              return;
            }
            self._fila.push(b);
          });
          bombear();
        };
        const bombear = async () => {
          if (self._ocupado || self._desligado) return;
          const bolha = self._fila.shift();
          if (!bolha) return;
          if (!document.body.contains(bolha) || jaFeito(bolha)) {
            setTimeout(bombear, 0);
            return;
          }
          self._ocupado = true;
          marcarFeito(bolha);
          const espera = document.createElement("div");
          espera.className = "zl-recovered zl-tr-espera";
          espera.textContent = "\u23F3 transcrevendo\u2026";
          (bolha.querySelector(BOLHA_MIOLO) || bolha).appendChild(espera);
          try {
            const texto = await transcreverBolha(bolha, limite());
            espera.remove();
            mostrarTranscricaoNaBolha(bolha, texto);
            const botao = bolha.querySelector(".zl-tr-btn");
            if (botao) botao.remove();
          } catch (e) {
            espera.remove();
            if (ehFaltaDeInstalacao(e)) {
              self._desligado = true;
              self._fila.length = 0;
              clearInterval(self._timer);
              self._timer = null;
              avisarInstalacaoDaTranscricao(e);
            } else if (!(e && e.zlLongoDemais)) {
              console.warn("[ZapLite] transcri\xE7\xE3o autom\xE1tica falhou:", e && e.message || e);
            }
          } finally {
            self._ocupado = false;
          }
          if (!self._desligado) setTimeout(bombear, 250);
        };
        self._timer = setInterval(varrer, AT_VARREDURA_MS);
        varrer();
      },
      revert() {
        clearInterval(this._timer);
        this._timer = null;
        this._desligado = true;
        if (this._fila) this._fila.length = 0;
        document.querySelectorAll(".zl-tr-espera").forEach((e) => e.remove());
      }
    });
  }

  // src-tauri/injection/src/lista.js
  function linhasDaLista() {
    const pane = document.querySelector("#pane-side");
    if (!pane) return [];
    try {
      return [...pane.querySelectorAll('[role="listitem"], [role="row"]')];
    } catch (_) {
      return [];
    }
  }
  function nomeDaLinha(row) {
    const t = row.querySelector('[data-testid="cell-frame-title"] span[title]') || row.querySelector('[role="gridcell"][aria-colindex="2"] span[title]');
    return t ? (t.getAttribute("title") || t.textContent || "").trim() : "";
  }
  function horaDaLinha(row) {
    const el = row.querySelector('[data-testid="cell-frame-primary-detail"]') || row.querySelector('[role="gridcell"][aria-colindex="2"] [data-testid*="detail"]');
    const t = el ? (el.textContent || "").trim() : "";
    return t.length <= 24 ? t : "";
  }
  function rotuloIndicaNovo(rotulo, desde, agora) {
    const t = String(rotulo || "").trim();
    if (!t) return null;
    const m = t.match(/^(\d{1,2}):(\d{2})\s*([apAP])\.?\s*[mM]?\.?$|^(\d{1,2}):(\d{2})$/);
    if (!m) return false;
    const h0 = m[1] !== void 0 ? +m[1] : +m[4];
    const min = m[2] !== void 0 ? +m[2] : +m[5];
    if (!(h0 >= 0 && h0 <= 23 && min >= 0 && min <= 59)) return null;
    let h = h0;
    const suf = (m[3] || "").toLowerCase();
    if (suf === "p" && h < 12) h += 12;
    if (suf === "a" && h === 12) h = 0;
    const dDesde = new Date(desde);
    const dAgora = new Date(agora);
    if (dDesde.toDateString() !== dAgora.toDateString()) return true;
    const alvo = new Date(agora);
    alvo.setHours(h, min, 0, 0);
    return alvo.getTime() >= desde - 9e4;
  }
  function limparTexto(s) {
    return (s || "").replace(/[\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, "").replace(/\s+/g, " ").trim();
  }
  function previaDaLinha(row) {
    const sec = row.querySelector('[data-testid="cell-frame-secondary"]');
    const alvo = sec && (sec.querySelector("span[title]") || sec.querySelector("span")) || null;
    if (alvo) return limparTexto(alvo.getAttribute("title") || alvo.textContent);
    const spans = [...row.querySelectorAll("span")];
    return spans.length > 1 ? limparTexto(spans[spans.length - 1].textContent) : "";
  }
  function textoSemIcone(n) {
    if (!n) return "";
    if (n.nodeType !== 1) return n.textContent || "";
    try {
      const c = n.cloneNode(true);
      c.querySelectorAll('svg, [aria-hidden="true"], [data-testid="chat-msg-symbol"]').forEach(
        (x) => x.remove()
      );
      return c.textContent || "";
    } catch (_) {
      return n.textContent || "";
    }
  }
  function autorDaLinha(row) {
    try {
      const sec = row.querySelector('[data-testid="cell-frame-secondary"]');
      if (!sec) return "";
      const host = sec.querySelector('[data-testid="last-msg-status"]');
      if (!host) return "";
      const kids = [...host.childNodes];
      let sep = -1;
      for (let i = 0; i < kids.length && i < 5; i++) {
        const t = textoSemIcone(kids[i]).replace(/[\s\u00a0]/g, "");
        if (t === ":") {
          sep = i;
          break;
        }
        if (t.length > 48) break;
      }
      if (sep < 1) return "";
      return limparTexto(kids.slice(0, sep).map(textoSemIcone).join("")).replace(/:$/, "").trim().slice(0, 60);
    } catch (_) {
      return "";
    }
  }
  function chatIdDaLinha(row) {
    if (!row) return "";
    try {
      const k = Object.keys(row).find((x) => x.startsWith("__reactFiber$"));
      if (!k) return "";
      let f = row[k];
      for (let i = 0; i < 8 && f; i++) {
        if (typeof f.key === "string" && f.key.startsWith("chat-")) return f.key.slice(5);
        f = f.return;
      }
    } catch (_) {
    }
    return "";
  }
  function linhaSelecionada() {
    return linhasDaLista().find(
      (r) => r.querySelector('[aria-selected="true"]') || r.getAttribute("aria-selected") === "true"
    ) || null;
  }
  function chatIdAberto() {
    return chatIdDaLinha(linhaSelecionada());
  }
  function nomeDaConversaAberta() {
    try {
      const h = document.querySelector("#main header");
      if (h) {
        const t = h.querySelector('[data-testid="conversation-info-header-chat-title"]') || h.querySelector("span[title]");
        const s = t ? (t.getAttribute("title") || t.textContent || "").trim() : "";
        if (s) return s;
      }
    } catch (_) {
    }
    const sel = linhaSelecionada();
    return sel ? nomeDaLinha(sel) : "";
  }

  // src-tauri/injection/src/modulos/notificacoes.js
  function registrarNotificacoes() {
    reg({
      id: "smartNotify",
      _seen: /* @__PURE__ */ new Map(),
      // id ESTÁVEL da conversa -> última prévia notificada
      _primed: false,
      // ignora a primeira varredura (senão notifica tudo ao abrir)
      _desde: 0,
      // V2: instante em que este módulo começou a observar
      _conhecidas: /* @__PURE__ */ new Set(),
      // V2: conversas que já apareceram numa varredura anterior
      // U1(b): id da conversa -> silenciada no WhatsApp, do jeito que a última
      // observação CONFIÁVEL viu. Um sumiço momentâneo do sino (menção pendente,
      // linha ainda renderizando) não pode desfazer isto. Ver `mudoResistente`.
      _mudos: /* @__PURE__ */ new Map(),
      _unlisten: null,
      // devolvido pelo listen(); sem guardar, cada ciclo somava um listener
      _reabrir: null,
      // Y2: timer da nova tentativa de abrir a conversa clicada
      _conferir: null,
      // Z1: timer da conferência "a conversa abriu mesmo?"
      _rolagemOriginal: null,
      // Z1: onde o usuário deixou a lista antes da varredura
      _ultimoAlvo: "",
      // Y2: dedupe entre o evento vivo e o pedido pendente
      _ultimoAlvoTs: 0,
      apply() {
        if (this._started) return;
        this._started = true;
        const self = this;
        this._desde = Date.now();
        try {
          let Silent = function() {
            return { close() {
            }, onclick: null, onclose: null };
          };
          const Native = window.Notification;
          Silent.permission = "granted";
          Silent.requestPermission = () => Promise.resolve("granted");
          Object.defineProperty(window, "Notification", {
            value: Silent,
            writable: true,
            configurable: true
          });
          self._native = Native;
        } catch (e) {
          console.warn("[ZapLite] n\xE3o consegui silenciar a notifica\xE7\xE3o nativa", e);
        }
        async function avatarAsData(img) {
          try {
            if (!img || !img.src) return "";
            const r = await fetch(img.src);
            const b = await r.blob();
            if (b.size > 3e5) return "";
            return await new Promise((res) => {
              const fr = new FileReader();
              fr.onload = () => res(fr.result);
              fr.onerror = () => res("");
              fr.readAsDataURL(b);
            });
          } catch (_) {
            return "";
          }
        }
        const SINAIS_MUDO = [
          '[data-testid*="mute" i]',
          '[data-icon*="mute" i]',
          '[data-icon*="notifications-off" i]',
          '[aria-label*="ilenciad" i]',
          // pt/es: "Conversa silenciada" / "silenciado"
          '[aria-label*="mute" i]'
          // en: "muted"
        ].join(",");
        const RE_ICONE_MUDO = /(^|[-_])(notifications?-off|muted?|silenc)/i;
        function sinalDeEstado(el) {
          try {
            if (!el) return false;
            if (el.querySelector("svg") || el.tagName.toLowerCase() === "svg") return true;
            return (el.textContent || "").trim() === "";
          } catch (_) {
            return false;
          }
        }
        function algumSinal(row, seletor, reIcone) {
          try {
            for (const el of row.querySelectorAll(seletor)) {
              if (sinalDeEstado(el)) return true;
            }
            if (reIcone) {
              for (const t of row.querySelectorAll("svg > title")) {
                if (reIcone.test((t.textContent || "").trim())) return true;
              }
            }
          } catch (_) {
          }
          return false;
        }
        function mudoDaLinha(row) {
          return algumSinal(row, SINAIS_MUDO, RE_ICONE_MUDO);
        }
        function linhaLegivel(row) {
          try {
            return !!(row.querySelector('[data-testid="cell-frame-title"]') && row.querySelector('[data-testid="cell-frame-secondary"], [data-testid="cell-frame-container"]'));
          } catch (_) {
            return false;
          }
        }
        const MUDO_MEM_MAX = 2e3;
        function lembrarMudo(id, valor) {
          const m = self._mudos;
          if (m.has(id)) m.delete(id);
          m.set(id, valor);
          while (m.size > MUDO_MEM_MAX) m.delete(m.keys().next().value);
        }
        function mudoResistente(row, chatId) {
          const agora = mudoDaLinha(row);
          if (!chatId) return agora;
          if (agora) {
            lembrarMudo(chatId, true);
            return true;
          }
          if (linhaLegivel(row) && !mencaoDaLinha(row)) {
            lembrarMudo(chatId, false);
            return false;
          }
          return self._mudos.get(chatId) === true;
        }
        function relogioDaLinha(row) {
          try {
            const el = row.querySelector('[data-testid="cell-frame-primary-detail"]') || row.querySelector('[role="gridcell"][aria-colindex="2"] [data-testid*="detail"]');
            if (!el) return "";
            const fontes = [el, el.parentElement].filter(Boolean);
            for (const f of fontes) {
              for (const attr of ["title", "aria-label", "datetime"]) {
                const v = f.getAttribute && f.getAttribute(attr);
                const m = v && String(v).match(/\b(\d{1,2}):(\d{2})\b/);
                if (m && +m[1] <= 23 && +m[2] <= 59) return m[1] + ":" + m[2];
              }
            }
          } catch (_) {
          }
          return "";
        }
        const SINAIS_MENCAO = [
          '[data-icon*="mention" i]',
          '[data-testid*="mention" i]',
          '[data-icon*="alternate-email" i]',
          '[aria-label*="mencion" i]',
          // pt: "Você foi mencionado"
          '[aria-label*="men\xE7" i]',
          '[aria-label*="mention" i]'
        ].join(",");
        const RE_ICONE_MENCAO = /(^|[-_])(mention|alternate-email)/i;
        function mencaoDaLinha(row) {
          return algumSinal(row, SINAIS_MENCAO, RE_ICONE_MENCAO);
        }
        async function scan() {
          const rows = linhasDaLista();
          if (!rows.length) return;
          for (const row of rows) {
            const sender = nomeDaLinha(row);
            if (!sender) continue;
            const chatId = chatIdDaLinha(row);
            const mudo = mudoResistente(row, chatId);
            const badge = row.querySelector(
              '[aria-label*="\xE3o lida"], [aria-label*="unread"], [aria-label*="no le\xEDdo"]'
            );
            const key = chatId || sender;
            const jaConhecida = self._conhecidas.has(key);
            if (!jaConhecida) {
              if (self._conhecidas.size > 5e3) self._conhecidas.clear();
              self._conhecidas.add(key);
            }
            if (!badge) {
              self._seen.delete(key);
              continue;
            }
            const preview = previaDaLinha(row);
            if (!preview) continue;
            if (self._seen.get(key) === preview) continue;
            self._seen.set(key, preview);
            if (!self._primed) continue;
            const hora = horaDaLinha(row);
            const novo = rotuloIndicaNovo(hora, self._desde, Date.now());
            if (novo === false) continue;
            if (novo === null && !jaConhecida) continue;
            const isOpen = !!row.querySelector('[aria-selected="true"]');
            const skipFocused = settings.notify && settings.notify.skipWhenFocused !== false;
            if (skipFocused && document.hasFocus() && isOpen) continue;
            let author = autorDaLinha(row);
            let body = preview;
            if (!author) {
              const m = preview.match(/^([^:]{1,28}):\s(.+)$/);
              if (m) {
                author = m[1];
                body = m[2];
              }
            }
            const relogio = relogioDaLinha(row);
            const grupo = /@g\.us$/.test(chatId);
            const mencao = mencaoDaLinha(row);
            const avatar = await avatarAsData(row.querySelector("img"));
            invoke("show_toast", {
              toast: {
                id: String(Date.now()) + Math.random().toString(36).slice(2, 7),
                sender,
                author,
                body,
                avatar,
                chat_id: chatId,
                muted: mudo,
                time: hora,
                clock: relogio,
                is_group: grupo,
                mention_mark: mencao
              }
            }).catch((e) => console.warn("[ZapLite] toast", e));
          }
          if (!self._primed) self._primed = true;
          if (Date.now() - (self._ultimoReport || 0) > 15e3) {
            self._ultimoReport = Date.now();
            const chats = [];
            for (const row of rows) {
              const id = chatIdDaLinha(row);
              if (!id) continue;
              chats.push({
                id,
                name: nomeDaLinha(row),
                group: /@g\.us$/.test(id),
                muted: mudoResistente(row, id),
                // M4: NÍVEL do marcador de menção. Serve só para o Rust saber que
                // a menção FOI LIDA (marcador sumiu) mesmo quando nenhuma
                // mensagem nova chegou naquele intervalo — sem isso a próxima
                // menção do mesmo grupo não seria uma subida de borda.
                mention: mencaoDaLinha(row)
              });
            }
            if (chats.length) invoke("report_chats", { chats }).catch(() => {
            });
          }
        }
        this._timer = setInterval(scan, 1200);
        scan();
        this._linhaDoChat = function(chatId) {
          if (!chatId) return null;
          return linhasDaLista().find((r) => chatIdDaLinha(r) === chatId) || null;
        };
        const ABRIR_TENTATIVAS = 30;
        const ABRIR_INTERVALO = 400;
        const REPETIDO_MS = 4e3;
        const ESPERAR_RENDER = 3;
        function cliqueDeVerdade(linha) {
          cliqueReal(linha.querySelector('[role="gridcell"][aria-colindex="2"]') || linha);
        }
        this._chatAberto = function() {
          const sel = linhaSelecionada();
          return sel ? chatIdDaLinha(sel) : "";
        };
        this._abrirConversa = function(chatId, tentativa) {
          if (!chatId) return;
          const t = tentativa || 0;
          if (t === 0) {
            const agora = Date.now();
            if (self._ultimoAlvo === chatId && agora - (self._ultimoAlvoTs || 0) < REPETIDO_MS) {
              return;
            }
            self._ultimoAlvo = chatId;
            self._ultimoAlvoTs = agora;
          }
          const pane = document.querySelector("#pane-side");
          if (t === 0) self._rolagemOriginal = pane ? pane.scrollTop : null;
          const linha = self._linhaDoChat(chatId);
          if (linha) {
            cliqueDeVerdade(linha);
            self._conferir = setTimeout(() => {
              const aberto = self._chatAberto();
              if (aberto === chatId) {
                if (self._rolagemOriginal != null && pane) pane.scrollTop = self._rolagemOriginal;
                return;
              }
              console.warn("[ZapLite] cliquei na linha da conversa e ela n\xE3o abriu");
              showPanel(
                "Conversa n\xE3o aberta",
                "O ZapLite achou a conversa do toast na lista, clicou nela e o WhatsApp n\xE3o abriu. Isso costuma significar que a estrutura da lista mudou. Abra a conversa manualmente e, se repetir, avise."
              );
            }, 1400);
            return;
          }
          if (pane && t >= ESPERAR_RENDER) {
            const antes = pane.scrollTop;
            pane.scrollTop = t === ESPERAR_RENDER ? 0 : antes + Math.max(240, pane.clientHeight - 80);
            if (t > ESPERAR_RENDER && pane.scrollTop === antes) {
              return self._desistirDeAbrir(pane);
            }
          }
          if (t + 1 < ABRIR_TENTATIVAS) {
            self._reabrir = setTimeout(
              () => self._abrirConversa(chatId, t + 1),
              ABRIR_INTERVALO
            );
            return;
          }
          self._desistirDeAbrir(pane);
        };
        this._desistirDeAbrir = function(pane) {
          if (pane && self._rolagemOriginal != null) pane.scrollTop = self._rolagemOriginal;
          self._rolagemOriginal = null;
          console.warn("[ZapLite] conversa do toast n\xE3o apareceu na lista; nada aberto");
          showPanel(
            "Conversa n\xE3o aberta",
            "O ZapLite n\xE3o conseguiu abrir a conversa do toast que voc\xEA clicou. Ela pode estar arquivada, fora da lista filtrada, ou a p\xE1gina ainda estava se recuperando. Abra a conversa manualmente."
          );
        };
        if (window.__TAURI__ && window.__TAURI__.event) {
          window.__TAURI__.event.listen("zaplite://open-chat", (ev) => {
            const p = ev.payload || {};
            const chatId = typeof p === "string" ? "" : p.chatId;
            invoke("take_pending_chat").catch(() => {
            });
            self._abrirConversa(chatId, 0);
          }).then((un) => {
            if (!self._started) un();
            else self._unlisten = un;
          }).catch(() => {
          });
          invoke("take_pending_chat").then((chatId) => {
            if (chatId && self._started) self._abrirConversa(chatId, 0);
          }).catch(() => {
          });
        }
      },
      revert() {
        clearInterval(this._timer);
        this._timer = null;
        clearTimeout(this._reabrir);
        this._reabrir = null;
        clearTimeout(this._conferir);
        this._conferir = null;
        this._started = false;
        this._primed = false;
        this._seen.clear();
        if (this._unlisten) {
          try {
            this._unlisten();
          } catch (_) {
          }
          this._unlisten = null;
        }
        if (this._native) {
          try {
            Object.defineProperty(window, "Notification", {
              value: this._native,
              writable: true,
              configurable: true
            });
          } catch (_) {
          }
        }
        invoke("close_all_toasts").catch(() => {
        });
      }
    });
  }

  // src-tauri/injection/src/modulos/golpe.js
  var SISTEMA = "Voc\xEA ajuda algu\xE9m a avaliar uma mensagem recebida no WhatsApp. Voc\xEA N\xC3O abre links nem consulta nada: s\xF3 l\xEA o texto. Responda em portugu\xEAs do Brasil, em no m\xE1ximo 6 linhas curtas, neste formato:\nSinais de alerta: (lista curta, ou 'nenhum evidente')\nSinais de que pode ser leg\xEDtima: (lista curta, ou 'nenhum evidente')\nO que n\xE3o d\xE1 para saber s\xF3 pelo texto: (uma linha)\nNUNCA declare que algo \xE9 seguro nem garanta que \xE9 golpe. Nunca pe\xE7a dados da pessoa.";
  var AVISO_TOPO = "OPINI\xC3O DE UM MODELO DE IA \u2014 n\xE3o \xE9 veredito.\nEle leu s\xF3 este texto: n\xE3o abriu o link, n\xE3o checou o n\xFAmero, n\xE3o conhece o remetente.\nErra nos dois sentidos. Na d\xFAvida, confirme por outro canal que voc\xEA j\xE1 usava antes.\n----------------------------------------";
  var AVISO_RODAPE = "----------------------------------------\nNenhum link foi aberto para produzir esta an\xE1lise.\nRegra que vale mais do que a resposta acima: ningu\xE9m leg\xEDtimo pede c\xF3digo de\nverifica\xE7\xE3o, senha ou PIX por mensagem, com pressa.";
  async function analisarGolpe(texto) {
    return await ai(SISTEMA, "Mensagem recebida:\n\n" + texto);
  }
  async function checarGolpe(texto) {
    if (!texto || !texto.trim()) throw new Error("n\xE3o h\xE1 texto nesta mensagem para analisar.");
    showPanel("Parece golpe? \u2014 opini\xE3o da IA", AVISO_TOPO + "\n\nAnalisando\u2026");
    const r = await analisarGolpe(texto);
    showPanel("Parece golpe? \u2014 opini\xE3o da IA", AVISO_TOPO + "\n\n" + r + "\n\n" + AVISO_RODAPE);
    return r;
  }
  function registrarGolpe() {
    reg({
      id: "scamDetect",
      apply() {
        addAct(ensureDock(), "zl-golpe", "\u{1F6E1}", "Checar a \xFAltima recebida", "", async () => {
          const b = ultimaBolha((x) => !ehDeSaida(x) && !!textoDaBolha(x));
          if (!b) {
            return showPanel(
              "Parece golpe? \u2014 opini\xE3o da IA",
              "N\xE3o achei nenhuma mensagem recebida com texto na conversa aberta."
            );
          }
          try {
            b.scrollIntoView({ block: "center" });
          } catch (_) {
          }
          try {
            await checarGolpe(textoDaBolha(b));
          } catch (e) {
            showPanel("Parece golpe? \u2014 opini\xE3o da IA", "Falhou: " + (e && e.message || e));
          }
        });
      },
      revert() {
        dropAct("zl-golpe");
      }
    });
  }

  // src-tauri/injection/src/modulos/ocr.js
  var SISTEMA2 = "Voc\xEA transcreve todo o texto vis\xEDvel de uma imagem, preservando a ordem e as quebras de linha. Responda s\xF3 com o texto, sem coment\xE1rios. Se n\xE3o houver texto nenhum, responda exatamente: (sem texto na imagem)";
  async function textoDaImagem(img) {
    const { b64, mediaType } = await imagemEmBase64(img);
    return await ai(SISTEMA2, "Extraia o texto desta imagem.", { image: b64, mediaType });
  }
  async function ocrDaBolha(bolha) {
    const img = imagemDaBolha(bolha);
    if (!img) throw new Error("esta mensagem n\xE3o tem imagem.");
    showPanel("Texto da imagem", "Lendo\u2026");
    const t = await textoDaImagem(img);
    showPanel("Texto da imagem", t);
    mostrarTranscricaoNaBolha(bolha, t, "\u{1F524} ");
    return t;
  }
  function registrarOcr() {
    reg({
      id: "ocr",
      apply() {
        addAct(ensureDock(), "zl-ocr", "\u{1F524}", "Ler texto da \xFAltima imagem", "", async () => {
          const b = ultimaBolha((x) => !!imagemDaBolha(x));
          if (!b) {
            return showPanel(
              "Texto da imagem",
              "N\xE3o achei nenhuma imagem na conversa aberta.\n\nO WhatsApp s\xF3 decifra a m\xEDdia que est\xE1 na tela: role at\xE9 a imagem antes de pedir."
            );
          }
          try {
            b.scrollIntoView({ block: "center" });
          } catch (_) {
          }
          try {
            await ocrDaBolha(b);
          } catch (e) {
            showPanel("Texto da imagem", "Falhou: " + (e && e.message || e));
          }
        });
      },
      revert() {
        dropAct("zl-ocr");
      }
    });
  }

  // src-tauri/injection/src/modulos/traduzir.js
  var IDIOMA_PADRAO = "portugu\xEAs do Brasil";
  async function traduzir(texto, idioma) {
    const alvo = idioma || cfgIa().traduzirPara;
    return await ai(
      `Voc\xEA traduz mensagens de WhatsApp para ${alvo}. Responda S\xD3 com a tradu\xE7\xE3o, sem aspas, sem coment\xE1rios e sem explicar. Se a mensagem j\xE1 estiver nesse idioma, responda com ela mesma.`,
      texto
    );
  }
  async function traduzirBolha(bolha) {
    const texto = textoDaBolha(bolha);
    if (!texto) throw new Error("esta mensagem n\xE3o tem texto para traduzir.");
    const alvo = cfgIa().traduzirPara;
    showPanel("Tradu\xE7\xE3o \u2192 " + alvo, "Traduzindo\u2026");
    const t = await traduzir(texto, alvo);
    showPanel("Tradu\xE7\xE3o \u2192 " + alvo, t);
    mostrarTranscricaoNaBolha(bolha, t, "\u{1F310} ");
    return t;
  }
  function registrarTraduzir() {
    reg({
      id: "translate",
      apply() {
        addAct(ensureDock(), "zl-tr-lang", "\u{1F310}", "Traduzir a \xFAltima recebida", "", async () => {
          const b = ultimaBolha((x) => !ehDeSaida(x) && !!textoDaBolha(x));
          if (!b) {
            return showPanel(
              "Tradu\xE7\xE3o",
              "N\xE3o achei nenhuma mensagem recebida com texto na conversa aberta.\n\nAbra a conversa e role at\xE9 a mensagem \u2014 s\xF3 o que est\xE1 na tela pode ser lido."
            );
          }
          try {
            b.scrollIntoView({ block: "center" });
          } catch (_) {
          }
          try {
            await traduzirBolha(b);
          } catch (e) {
            showPanel("Tradu\xE7\xE3o", "Falhou: " + (e && e.message || e));
          }
        });
      },
      revert() {
        dropAct("zl-tr-lang");
      }
    });
  }

  // src-tauri/injection/src/modulos/menu-contexto.js
  function registrarMenuContexto() {
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
          const r = m.getBoundingClientRect();
          m.style.left = Math.min(x, innerWidth - r.width - 8) + "px";
          m.style.top = Math.min(y, innerHeight - r.height - 8) + "px";
        }
        self._close = fecha;
        document.addEventListener("click", fecha);
        document.addEventListener("scroll", fecha, true);
        self._handler = (ev) => {
          const bolha = bolhaDe(ev.target);
          if (!bolha) return;
          ev.preventDefault();
          ev.stopPropagation();
          const texto = textoDaBolha(bolha);
          const audio = ehBolhaDeAudio(bolha);
          const img = imagemDaBolha(bolha);
          const video = bolha.querySelector('video[src^="blob:"], video source[src^="blob:"]');
          const itens = [];
          if (ehApagada(bolha)) {
            const ad = moduloPorId("antiDelete");
            const guardado = ad ? ad.textoGuardado(bolha) : "";
            if (guardado) {
              itens.push([
                "\u{1F575}",
                "Ver mensagem apagada",
                () => {
                  if (ad) ad.revelarNaBolha(bolha, guardado);
                  showPanel("Mensagem apagada", guardado);
                }
              ]);
            } else if (!on("antiDelete")) {
              itens.push([
                "\u{1F575}",
                "Mensagem apagada (m\xF3dulo desligado)",
                () => showPanel(
                  "Mensagem apagada",
                  "O m\xF3dulo Anti-apagadas est\xE1 desligado, ent\xE3o o ZapLite n\xE3o guardou o texto desta mensagem.\n\nLigue-o no Painel para que as pr\xF3ximas mensagens apagadas possam ser lidas.",
                  [["Abrir o Painel", () => invoke("open_settings", { secao: "mods" }).catch(() => {
                  })]]
                )
              ]);
            } else {
              itens.push([
                "\u{1F575}",
                "Mensagem apagada (sem c\xF3pia)",
                () => showPanel(
                  "Mensagem apagada",
                  "Esta mensagem foi apagada antes de o ZapLite v\xEA-la na tela \u2014 o texto original nunca chegou aqui, ent\xE3o n\xE3o h\xE1 o que mostrar.\n\nO ZapLite s\xF3 guarda o que passou pela conversa aberta com ele rodando."
                )
              ]);
            }
          }
          if (audio) {
            itens.push([
              "\u{1F4DD}",
              "Transcrever este \xE1udio",
              guarded(async () => {
                showPanel("Transcri\xE7\xE3o", "Transcrevendo\u2026");
                try {
                  showPanel("Transcri\xE7\xE3o", await transcreverBolha(bolha));
                } catch (e) {
                  if (ehFaltaDeInstalacao(e)) return avisarInstalacaoDaTranscricao(e);
                  throw e;
                }
              }, "Transcri\xE7\xE3o")
            ]);
          }
          if (img) {
            if (on("ocr")) {
              itens.push([
                "\u{1F524}",
                "Extrair texto da imagem",
                guarded(() => ocrDaBolha(bolha), "Texto da imagem")
              ]);
            }
            itens.push([
              "\u{1F4BE}",
              "Salvar imagem\u2026",
              guarded(async () => {
                await salvarArquivo(await (await fetch(img.src)).blob(), "zaplite-imagem");
              }, "Salvar imagem")
            ]);
          }
          if (video) {
            itens.push([
              "\u{1F4BE}",
              "Salvar v\xEDdeo\u2026",
              guarded(async () => {
                const src = video.src || video.getAttribute && video.getAttribute("src") || "";
                if (!src) throw new Error("n\xE3o achei os bytes deste v\xEDdeo na p\xE1gina.");
                await salvarArquivo(await (await fetch(src)).blob(), "zaplite-video");
              }, "Salvar v\xEDdeo")
            ]);
          }
          if (texto) {
            itens.push([
              "\u29C9",
              "Copiar texto",
              () => navigator.clipboard.writeText(texto).catch(() => {
              })
            ]);
            if (on("translate")) {
              itens.push([
                "\u{1F310}",
                "Traduzir para " + cfgIa().traduzirPara,
                guarded(() => traduzirBolha(bolha), "Tradu\xE7\xE3o")
              ]);
            }
            itens.push([
              "\u270D",
              "Responder com sugest\xE3o da IA",
              guarded(async () => {
                showPanel("Rascunho", "Escrevendo\u2026");
                const tom = settings.aiTone || "direto, amig\xE1vel e claro";
                const r = await ai(
                  `Voc\xEA sugere UMA resposta curta de WhatsApp em portugu\xEAs do Brasil, no tom ${tom}. Responda apenas com o texto da mensagem.`,
                  "Responder a esta mensagem:\n" + texto
                );
                const cx = document.querySelector('div[contenteditable="true"][data-tab]');
                if (cx) {
                  cx.focus();
                  document.execCommand("insertText", false, r.trim());
                  const p = document.getElementById("zl-panel");
                  if (p) p.remove();
                } else showPanel("Rascunho", r);
              }, "Sugest\xE3o")
            ]);
            if (on("scamDetect")) {
              itens.push([
                "\u{1F6E1}",
                "Isso parece golpe?",
                guarded(() => checarGolpe(texto), "Parece golpe? \u2014 opini\xE3o da IA")
              ]);
            }
          }
          if (!itens.length) return;
          const titulo = texto ? texto.slice(0, 40) : audio ? "Mensagem de voz" : "M\xEDdia";
          abre(ev.clientX, ev.clientY, titulo, itens);
        };
        document.addEventListener("contextmenu", self._handler, true);
      },
      revert() {
        if (this._handler) document.removeEventListener("contextmenu", this._handler, true);
        if (this._close) this._close();
        dropCss("zl-ctx-style");
        this._on = false;
      }
    });
  }

  // src-tauri/injection/src/modulos/resumo-diario.js
  var PREVIA_MAX = 160;
  var ABERTA_MAX = 4e3;
  function montarEscopo() {
    const cfg = cfgIa();
    const agora = Date.now();
    const desde = agora - cfg.digestHoras * 3600 * 1e3;
    const todas = linhasDaLista();
    const dentro = [];
    for (const row of todas) {
      const nome = nomeDaLinha(row);
      if (!nome) continue;
      if (rotuloIndicaNovo(horaDaLinha(row), desde, agora) !== true) continue;
      const previa = previaDaLinha(row);
      if (!previa) continue;
      const autor = autorDaLinha(row);
      dentro.push({
        nome,
        hora: horaDaLinha(row),
        autor,
        previa: previa.slice(0, PREVIA_MAX)
      });
      if (dentro.length >= cfg.digestMaxConversas) break;
    }
    let aberta = null;
    if (cfg.digestIncluirAberta) {
      const texto = collectVisibleMessages();
      if (texto) {
        const linha = linhaSelecionada();
        aberta = {
          nome: linha && nomeDaLinha(linha) || "conversa aberta",
          texto: texto.length > ABERTA_MAX ? texto.slice(-ABERTA_MAX) : texto,
          mensagens: texto.split("\n").length,
          cortado: texto.length > ABERTA_MAX
        };
      }
    }
    const partes = [];
    if (dentro.length) {
      partes.push(
        "\xDALTIMA MENSAGEM DE CADA CONVERSA COM MOVIMENTO NAS \xDALTIMAS " + cfg.digestHoras + "H (s\xF3 a pr\xE9via que a lista mostra):"
      );
      dentro.forEach((c) => {
        partes.push(
          "- [" + (c.hora || "?") + "] " + c.nome + ": " + (c.autor ? c.autor + " \u2014 " : "") + c.previa
        );
      });
    }
    if (aberta) {
      partes.push("");
      partes.push(
        "CONVERSA ABERTA (" + aberta.nome + ") \u2014 mensagens vis\xEDveis" + (aberta.cortado ? ", cortadas nas mais recentes" : "") + ":"
      );
      partes.push(aberta.texto);
    }
    return {
      horas: cfg.digestHoras,
      linhasCarregadas: todas.length,
      conversas: dentro,
      aberta,
      limite: cfg.digestMaxConversas,
      payload: partes.join("\n")
    };
  }
  async function resumirEscopo(escopo) {
    return await ai(
      "Voc\xEA resume, em portugu\xEAs do Brasil, o movimento do dia no WhatsApp de algu\xE9m. Escreva no m\xE1ximo 10 linhas, agrupadas por conversa, come\xE7ando pelo que parece pedir resposta. Destaque perguntas em aberto, combinados e prazos. Voc\xEA recebe, na maior parte, apenas a PR\xC9VIA da \xFAltima mensagem de cada conversa: n\xE3o invente o que n\xE3o est\xE1 escrito e diga 'sem contexto' quando a pr\xE9via n\xE3o permitir concluir nada.",
      "Resuma o dia:\n\n" + escopo.payload
    );
  }
  function textoDoEscopo(e) {
    const l = [];
    l.push("Janela: \xFAltimas " + e.horas + " h.");
    l.push(
      "Conversas com movimento na janela: " + e.conversas.length + (e.conversas.length >= e.limite ? " (teto de " + e.limite + " atingido)" : "")
    );
    l.push(
      "Linhas carregadas na lista agora: " + e.linhasCarregadas + " \u2014 a lista do WhatsApp \xE9 virtualizada e o ZapLite n\xE3o a rola sozinho, ent\xE3o conversas ainda n\xE3o renderizadas ficam de fora."
    );
    l.push(
      e.aberta ? "Conversa aberta: " + e.aberta.nome + " (" + e.aberta.mensagens + " mensagens vis\xEDveis)" : "Conversa aberta: nenhuma (ou sem mensagens vis\xEDveis)."
    );
    l.push("");
    if (!e.conversas.length && !e.aberta) {
      l.push("N\xE3o h\xE1 nada para resumir: nenhuma conversa carregada tem r\xF3tulo de hora dentro da janela.");
      return l.join("\n");
    }
    l.push("Entram no resumo:");
    e.conversas.forEach((c) => l.push("  \xB7 " + c.nome + "  [" + (c.hora || "?") + "]"));
    l.push("");
    l.push("Nada foi enviado a modelo nenhum ainda. S\xE3o " + e.payload.length + " caracteres, UMA chamada.");
    return l.join("\n");
  }
  function registrarResumoDiario() {
    reg({
      id: "dailyDigest",
      apply() {
        addAct(ensureDock(), "zl-digest", "\u{1F5D3}", "Resumo do dia", "", () => {
          let e;
          try {
            e = montarEscopo();
          } catch (err) {
            return showPanel("Resumo do dia", "Falhou ao montar o escopo: " + (err && err.message || err));
          }
          const acoes = [];
          if (e.conversas.length || e.aberta) {
            acoes.push([
              "Ver o texto exato",
              () => showPanel("Resumo do dia \u2014 o que seria enviado", e.payload, [
                ["Voltar", () => showPanel("Resumo do dia", textoDoEscopo(e), acoes)]
              ])
            ]);
            acoes.push([
              "Resumir (1 chamada)",
              async () => {
                showPanel("Resumo do dia", "Resumindo " + e.conversas.length + " conversas\u2026");
                try {
                  showPanel("Resumo do dia", await resumirEscopo(e));
                } catch (err) {
                  showPanel("Resumo do dia", "Falhou: " + (err && err.message || err));
                }
              }
            ]);
          }
          showPanel("Resumo do dia", textoDoEscopo(e), acoes);
        });
      },
      revert() {
        dropAct("zl-digest");
      }
    });
  }

  // src-tauri/injection/src/modulos/notas.js
  var ID_ACT = "zl-nota";
  var timer = null;
  var idsComNota = [];
  async function recarregarIds() {
    try {
      idsComNota = await invoke("note_ids") || [];
    } catch (e) {
      console.warn("[ZapLite] note_ids:", e.message);
      idsComNota = [];
    }
  }
  function pintarCabecalho() {
    const header = document.querySelector("#main header");
    if (!header) {
      const velho = document.getElementById("zl-nota-hdr");
      if (velho) velho.remove();
      return;
    }
    let b = document.getElementById("zl-nota-hdr");
    if (!b) {
      b = document.createElement("button");
      b.id = "zl-nota-hdr";
      b.type = "button";
      b.textContent = "\u{1F4DD}";
      b.onclick = (e) => {
        e.stopPropagation();
        abrirEditor();
      };
      (header.querySelector("div:last-child") || header).appendChild(b);
    } else if (!header.contains(b)) {
      (header.querySelector("div:last-child") || header).appendChild(b);
    }
    const id = chatIdAberto();
    const tem = !!id && idsComNota.indexOf(id) >= 0;
    b.classList.toggle("tem", tem);
    b.title = tem ? "Esta conversa tem uma nota sua (clique para ver)" : "Escrever uma nota sobre esta conversa";
  }
  function pintarLista() {
    for (const row of linhasDaLista()) {
      const tem = idsComNota.indexOf(chatIdDaLinha(row)) >= 0;
      const ja = row.querySelector(":scope > .zl-nota-dot");
      if (tem && !ja) {
        const d = document.createElement("span");
        d.className = "zl-nota-dot";
        d.title = "Voc\xEA tem uma nota sobre esta conversa";
        if (getComputedStyle(row).position === "static") row.style.position = "relative";
        row.appendChild(d);
      } else if (!tem && ja) {
        ja.remove();
      }
    }
  }
  function pintar() {
    pintarCabecalho();
    pintarLista();
  }
  function limparMarcas() {
    const b = document.getElementById("zl-nota-hdr");
    if (b) b.remove();
    document.querySelectorAll(".zl-nota-dot").forEach((d) => d.remove());
  }
  async function abrirEditor() {
    const id = chatIdAberto();
    if (!id) {
      return showPanel(
        "Notas por contato",
        "Nenhuma conversa aberta. Abra a conversa sobre a qual voc\xEA quer anotar \u2014 a nota fica presa ao identificador dela, n\xE3o ao nome (nome muda, id n\xE3o)."
      );
    }
    let texto = "";
    try {
      texto = await invoke("note_get", { chatId: id }) || "";
    } catch (e) {
      return showPanel("N\xE3o deu para ler a nota", e.message);
    }
    const form = document.createElement("div");
    form.className = "zl-form";
    const ta = document.createElement("textarea");
    ta.value = texto;
    ta.placeholder = "O que voc\xEA quer lembrar sobre esta conversa\u2026";
    ta.spellcheck = false;
    const lim = document.createElement("div");
    lim.className = "zl-lim";
    lim.textContent = "Fica s\xF3 nesta m\xE1quina, no settings.json, presa ao id da conversa (" + id + "). N\xE3o vai para o WhatsApp, n\xE3o vira mensagem e a outra pessoa nunca fica sabendo.";
    form.appendChild(ta);
    form.appendChild(lim);
    const nome = nomeDaConversaAberta();
    const p = showPanel("Nota \u2014 " + (nome || "conversa aberta"), form, [
      [
        "Salvar",
        async () => {
          try {
            await invoke("note_set", { chatId: id, texto: ta.value });
            await recarregarIds();
            pintar();
            showPanel(
              "Nota salva",
              ta.value.trim() ? "Guardada nesta m\xE1quina para \u201C" + (nome || id) + "\u201D." : "A nota estava vazia, ent\xE3o foi apagada."
            );
          } catch (e) {
            showPanel("N\xE3o deu para salvar a nota", e.message);
          }
        }
      ],
      [
        "Apagar",
        async () => {
          try {
            await invoke("note_set", { chatId: id, texto: "" });
            await recarregarIds();
            pintar();
            showPanel("Nota apagada", "Nada mais guardado para \u201C" + (nome || id) + "\u201D.");
          } catch (e) {
            showPanel("N\xE3o deu para apagar a nota", e.message);
          }
        }
      ]
    ]);
    setTimeout(() => ta.focus(), 0);
    return p;
  }
  function registrarNotas() {
    reg({
      id: "contactNotes",
      label: "Notas por contato",
      apply() {
        addAct(ensureDock(), ID_ACT, "\u{1F4DD}", "Nota desta conversa", "", abrirEditor);
        if (timer) return;
        recarregarIds().then(pintar);
        timer = setInterval(pintar, 1500);
      },
      revert() {
        dropAct(ID_ACT);
        if (timer) {
          clearInterval(timer);
          timer = null;
        }
        limparMarcas();
      }
    });
  }

  // src-tauri/injection/src/modulos/respostas-rapidas.js
  var ID_ACT2 = "zl-qr";
  function atalhosCadastrados() {
    const bruto = settings && settings.quickReplies;
    if (!Array.isArray(bruto)) return [];
    return bruto.map((r) => ({
      atalho: String(r && r.atalho || "").trim(),
      texto: String(r && r.texto || "")
    })).filter((r) => r.atalho && r.texto);
  }
  function acharAtalho(antes, atalhos, exigeEspaco) {
    const s = String(antes || "");
    const m = exigeEspaco ? s.match(/(^|\s)(\/[\w-]+)[ \u00a0]$/) : s.match(/(^|\s)(\/[\w-]+)$/);
    if (!m) return null;
    const alvo = m[2].toLowerCase();
    const lista = Array.isArray(atalhos) ? atalhos : [];
    for (const r of lista) {
      const a = String(r && r.atalho || "").trim().toLowerCase();
      if (a !== alvo) continue;
      const texto = String(r && r.texto || "");
      if (!texto) return null;
      const tamanho = m[0].length - m[1].length;
      return { inicio: s.length - tamanho, fim: s.length, texto };
    }
    return null;
  }
  function ehCaixaDeMensagem(el) {
    if (!el || el.nodeType !== 1) return false;
    try {
      if (el.getAttribute("contenteditable") !== "true") return false;
      const main = document.querySelector("#main");
      if (!main || !main.contains(el)) return false;
      return !!el.closest("footer");
    } catch (_) {
      return false;
    }
  }
  function escreverNaCaixa(no, inicio, fim, texto) {
    const sel = window.getSelection();
    if (!sel) return false;
    const r = document.createRange();
    r.setStart(no, inicio);
    r.setEnd(no, fim);
    sel.removeAllRanges();
    sel.addRange(r);
    return document.execCommand("insertText", false, texto);
  }
  function planejarExpansao(alvo, exigeEspaco) {
    if (!ehCaixaDeMensagem(alvo)) return null;
    const sel = window.getSelection();
    if (!sel || !sel.isCollapsed || !sel.anchorNode) return null;
    const no = sel.anchorNode;
    if (no.nodeType !== 3) return null;
    if (!alvo.contains(no)) return null;
    const off = sel.anchorOffset;
    const antes = (no.textContent || "").slice(0, off);
    const achado = acharAtalho(antes, atalhosCadastrados(), exigeEspaco);
    if (!achado || achado.inicio < 0) return null;
    const esperado = antes.slice(achado.inicio);
    return function escrever() {
      if (!no.parentNode) return;
      if ((no.textContent || "").slice(achado.inicio, off) !== esperado) return;
      escreverNaCaixa(no, achado.inicio, off, achado.texto);
    };
  }
  var ouvindo = false;
  function aoDigitar(ev) {
    if (!ev.isTrusted) return;
    const alvo = ev.target;
    if (ev.type === "keydown") {
      if (ev.key !== "Tab" || ev.shiftKey || ev.ctrlKey || ev.altKey) return;
      const escrever2 = planejarExpansao(alvo, false);
      if (!escrever2) return;
      ev.preventDefault();
      setTimeout(escrever2, 0);
      return;
    }
    if (ev.inputType && ev.inputType.indexOf("delete") === 0) return;
    const escrever = planejarExpansao(alvo, true);
    if (escrever) setTimeout(escrever, 0);
  }
  function listar() {
    const lista = atalhosCadastrados();
    if (!lista.length) {
      return showPanel(
        "Respostas r\xE1pidas",
        "Nenhum atalho cadastrado ainda.\n\nCadastre no Painel do ZapLite, aba M\xD3DULOS, no bloco \u201CRespostas r\xE1pidas\u201D. Depois \xE9 s\xF3 digitar o atalho na caixa de mensagem e apertar espa\xE7o (ou Tab): o texto entra na caixa \u2014 o ZapLite NUNCA envia por conta pr\xF3pria.",
        [["Abrir o Painel", () => invoke("open_settings", { secao: "modulos" }).catch(() => {
        })]]
      );
    }
    const corpo = lista.map((r) => r.atalho + "\n    " + r.texto.replace(/\n/g, "\n    ")).join("\n\n");
    return showPanel(
      "Respostas r\xE1pidas (" + lista.length + ")",
      corpo + "\n\n\u2014\u2014\u2014\nDigite o atalho na caixa de mensagem e aperte espa\xE7o ou Tab. A expans\xE3o escreve na caixa e para por a\xED: enviar continua sendo voc\xEA.",
      [["Editar no Painel", () => invoke("open_settings", { secao: "modulos" }).catch(() => {
      })]]
    );
  }
  function registrarRespostasRapidas() {
    reg({
      id: "quickReplies",
      label: "Respostas r\xE1pidas",
      apply() {
        addAct(ensureDock(), ID_ACT2, "\u26A1", "Respostas r\xE1pidas", "", listar);
        if (ouvindo) return;
        ouvindo = true;
        document.addEventListener("keydown", aoDigitar, true);
        document.addEventListener("input", aoDigitar, true);
      },
      revert() {
        dropAct(ID_ACT2);
        if (!ouvindo) return;
        ouvindo = false;
        document.removeEventListener("keydown", aoDigitar, true);
        document.removeEventListener("input", aoDigitar, true);
      }
    });
  }

  // src-tauri/injection/src/modulos/lembretes.js
  var ID_ACT3 = "zl-lembretes";
  var PASSO_MS = 2e4;
  var pendentes = [];
  var timer2 = null;
  function proximoDisparo(texto, agora) {
    const t = String(texto || "").trim().toLowerCase().replace(/\s+/g, "");
    const m = t.match(/^(\d{1,2})(?::(\d{2}))?h?$/);
    if (!m) return 0;
    const h = +m[1];
    const min = m[2] === void 0 ? 0 : +m[2];
    if (!(h >= 0 && h <= 23 && min >= 0 && min <= 59)) return 0;
    const base = new Date(agora);
    const alvo = new Date(agora);
    alvo.setHours(h, min, 0, 0);
    if (alvo.getTime() <= base.getTime()) alvo.setDate(alvo.getDate() + 1);
    return alvo.getTime();
  }
  function daquiAMinutos(texto, agora) {
    const t = String(texto || "").trim().toLowerCase().replace(/^em\s+/, "");
    const m = t.match(/^(\d{1,4})\s*(m|min|minutos?)?$/);
    if (!m) return 0;
    const n = +m[1];
    if (!(n >= 1 && n <= 1440)) return 0;
    return agora + n * 6e4;
  }
  var hhmm = (ms) => {
    const d = new Date(ms);
    const p = (n) => String(n).padStart(2, "0");
    const hoje = (/* @__PURE__ */ new Date()).toDateString() === d.toDateString();
    return (hoje ? "" : p(d.getDate()) + "/" + p(d.getMonth() + 1) + " ") + p(d.getHours()) + ":" + p(d.getMinutes());
  };
  function carregar() {
    const bruto = settings && settings.reminders || [];
    pendentes = (Array.isArray(bruto) ? bruto : []).map((r) => ({
      id: String(r && r.id || ""),
      quando: Number(r && r.quando || 0),
      texto: String(r && r.texto || ""),
      conversa: String(r && r.conversa || "")
    })).filter((r) => r.id && r.quando > 0 && r.texto);
  }
  async function gravar() {
    try {
      await invoke("save_module_data", { chave: "reminders", valor: pendentes });
    } catch (e) {
      showPanel(
        "O lembrete N\xC3O foi guardado",
        "Ele vale enquanto o app estiver aberto, mas some se voc\xEA reiniciar.\n\n" + e.message
      );
    }
  }
  async function disparar(r, atrasado) {
    const quando = hhmm(r.quando);
    const corpo = r.texto + (r.conversa ? "\n\nConversa: " + r.conversa : "") + (atrasado ? "\n\n(era para " + quando + " \u2014 o app estava fechado na hora)" : "");
    try {
      await invoke("show_toast", {
        toast: {
          id: "lembrete-" + r.id,
          sender: "Lembrete do ZapLite",
          author: "",
          body: corpo,
          avatar: "",
          // vazio de propósito: ver o cabeçalho deste arquivo
          chat_id: "",
          muted: false,
          time: quando,
          clock: "",
          is_group: false,
          mention_mark: false
        }
      });
    } catch (e) {
      showPanel("Lembrete \u2014 " + quando, corpo + "\n\n(o aviso flutuante falhou: " + e.message + ")");
    }
  }
  async function conferir() {
    const agora = Date.now();
    const vencidos = pendentes.filter((r) => r.quando <= agora);
    if (!vencidos.length) return;
    pendentes = pendentes.filter((r) => r.quando > agora);
    await gravar();
    for (const r of vencidos) await disparar(r, agora - r.quando > 2 * PASSO_MS);
  }
  function abrir() {
    const form = document.createElement("div");
    form.className = "zl-form";
    const texto = document.createElement("input");
    texto.type = "text";
    texto.placeholder = "O que lembrar (ex.: responder o or\xE7amento)";
    const hora = document.createElement("input");
    hora.type = "text";
    hora.placeholder = "Quando: 15h, 15:30, ou \u201Cem 20\u201D (minutos)";
    const conversa = nomeDaConversaAberta();
    const marcar = document.createElement("label");
    const cx = document.createElement("input");
    cx.type = "checkbox";
    cx.checked = !!conversa;
    cx.disabled = !conversa;
    marcar.appendChild(cx);
    marcar.appendChild(
      document.createTextNode(
        conversa ? "Citar a conversa aberta (\u201C" + conversa + "\u201D) no texto do lembrete" : "Nenhuma conversa aberta para citar"
      )
    );
    const lim = document.createElement("div");
    lim.className = "zl-lim";
    lim.textContent = "LIMITA\xC7\xC3O: o lembrete s\xF3 dispara com o ZapLite ABERTO \u2014 o rel\xF3gio \xE9 desta p\xE1gina, n\xE3o do Windows. Se a hora passar com o app fechado, ele aparece na pr\xF3xima vez que voc\xEA abrir, marcado como atrasado. O aviso n\xE3o abre a conversa (abrir mandaria recibo de leitura); ele s\xF3 diz qual \xE9.";
    form.appendChild(texto);
    form.appendChild(hora);
    form.appendChild(marcar);
    form.appendChild(lim);
    if (pendentes.length) {
      const lista = document.createElement("div");
      lista.className = "zl-lista";
      pendentes.slice().sort((a, b) => a.quando - b.quando).forEach((r) => {
        const li = document.createElement("div");
        li.className = "zl-item";
        const s = document.createElement("span");
        s.textContent = hhmm(r.quando) + " \u2014 " + r.texto;
        const x = document.createElement("button");
        x.className = "zl-x2";
        x.textContent = "cancelar";
        x.onclick = async () => {
          pendentes = pendentes.filter((o) => o.id !== r.id);
          await gravar();
          abrir();
        };
        li.appendChild(s);
        li.appendChild(x);
        lista.appendChild(li);
      });
      form.appendChild(lista);
    }
    const p = showPanel("Lembretes (" + pendentes.length + " pendente" + (pendentes.length === 1 ? "" : "s") + ")", form, [
      [
        "Criar lembrete",
        async () => {
          const oque = texto.value.trim();
          if (!oque) return showPanel("Falta o texto", "Escreva o que voc\xEA quer lembrar.");
          const agora = Date.now();
          const quando = proximoDisparo(hora.value, agora) || daquiAMinutos(hora.value, agora);
          if (!quando) {
            return showPanel(
              "N\xE3o entendi o hor\xE1rio",
              "Escreva \u201C15h\u201D, \u201C15:30\u201D ou \u201Cem 20\u201D (minutos). Foi digitado: \u201C" + hora.value + "\u201D."
            );
          }
          pendentes.push({
            id: String(agora) + Math.random().toString(36).slice(2, 7),
            quando,
            texto: oque,
            conversa: cx.checked ? conversa : ""
          });
          await gravar();
          showPanel(
            "Lembrete criado",
            "\u201C" + oque + "\u201D \xE0s " + hhmm(quando) + ".\n\nVale s\xF3 com o ZapLite aberto. Fechou o app antes da hora, o aviso aparece atrasado na pr\xF3xima abertura."
          );
        }
      ]
    ]);
    setTimeout(() => texto.focus(), 0);
    return p;
  }
  function registrarLembretes() {
    reg({
      id: "reminders",
      label: "Lembretes",
      apply() {
        addAct(ensureDock(), ID_ACT3, "\u23F0", "Lembretes", "", abrir);
        carregar();
        if (timer2) return;
        timer2 = setInterval(conferir, PASSO_MS);
        setTimeout(conferir, 4e3);
      },
      revert() {
        dropAct(ID_ACT3);
        if (timer2) {
          clearInterval(timer2);
          timer2 = null;
        }
      }
    });
  }

  // src-tauri/injection/src/modulos/acoes-massa.js
  var ID_ACT4 = "zl-massa";
  var ACOES = [
    {
      chave: "naolida",
      rotulo: "Marcar como N\xC3O lida",
      re: /marcar como n[ãa]o.?lida|mark as unread/i,
      recibo: false,
      nota: "N\xE3o abre a conversa e n\xE3o manda recibo de leitura."
    },
    {
      chave: "arquivar",
      rotulo: "Arquivar",
      re: /arquivar conversa|arquivar|archive/i,
      nao: /desarquivar|unarchive/i,
      recibo: false,
      nota: "N\xE3o abre a conversa e n\xE3o manda recibo de leitura. D\xE1 para desarquivar depois."
    },
    {
      chave: "lida",
      rotulo: "Marcar como lida",
      re: /marcar como lida|mark as read/i,
      nao: /n[ãa]o.?lida|unread/i,
      recibo: true,
      nota: "ATEN\xC7\xC3O: marcar como lida \xE9 o mesmo que ler \u2014 o WhatsApp manda RECIBO DE LEITURA para quem escreveu (o segundo tique fica azul, se a pessoa n\xE3o desligou isso). \xC9 irrevers\xEDvel."
    }
  ];
  async function itensDoMenu(row) {
    const alvo = row.querySelector('[role="gridcell"][aria-colindex="2"]') || row;
    const antes = /* @__PURE__ */ new Set([...document.querySelectorAll('li,[role="button"],[role="menuitem"]')]);
    const r = alvo.getBoundingClientRect();
    alvo.dispatchEvent(
      new MouseEvent("contextmenu", {
        bubbles: true,
        cancelable: true,
        composed: true,
        view: window,
        clientX: r.left + Math.min(60, r.width / 2),
        clientY: r.top + r.height / 2,
        button: 2,
        buttons: 2
      })
    );
    const novos = await until(
      () => {
        const v = [...document.querySelectorAll('li,[role="button"],[role="menuitem"]')].filter(
          (e) => !antes.has(e) && (e.textContent || "").trim()
        );
        return v.length ? v : null;
      },
      2e3,
      50
    );
    return novos || [];
  }
  async function fecharMenu() {
    for (const t of ["keydown", "keyup"]) {
      try {
        document.dispatchEvent(
          new KeyboardEvent(t, { key: "Escape", code: "Escape", keyCode: 27, bubbles: true })
        );
      } catch (_) {
      }
    }
    await wait(120);
    if (document.querySelector('[role="menuitem"]')) {
      try {
        document.body.dispatchEvent(
          new MouseEvent("mousedown", { bubbles: true, cancelable: true, clientX: 2, clientY: 2 })
        );
        document.body.dispatchEvent(
          new MouseEvent("mouseup", { bubbles: true, cancelable: true, clientX: 2, clientY: 2 })
        );
      } catch (_) {
      }
    }
    await wait(120);
  }
  function rotuloDoItem(el) {
    return limparTexto(textoSemIcone(el));
  }
  function casar(itens, acao) {
    for (const el of itens) {
      const t = rotuloDoItem(el);
      if (!t || t.length > 60) continue;
      if (!acao.re.test(t)) continue;
      if (acao.nao && acao.nao.test(t)) continue;
      return { el, texto: t };
    }
    return null;
  }
  async function executar(acao, escolhidas) {
    const feitos = [];
    const faltaram = [];
    for (let i = 0; i < escolhidas.length; i++) {
      const { id, nome } = escolhidas[i];
      showPanel(
        acao.rotulo,
        "Conversa " + (i + 1) + " de " + escolhidas.length + "\u2026\n" + nome + "\n\nNenhuma conversa \xE9 aberta: a a\xE7\xE3o sai pelo menu do bot\xE3o direito da linha."
      );
      const row = linhasDaLista().find((r) => chatIdDaLinha(r) === id);
      if (!row) {
        faltaram.push(nome + " \u2014 a linha saiu da lista (ela \xE9 virtualizada)");
        continue;
      }
      const itens = await itensDoMenu(row);
      const item = casar(itens, acao);
      if (!item) {
        await fecharMenu();
        faltaram.push(
          nome + " \u2014 o WhatsApp n\xE3o ofereceu \u201C" + acao.rotulo + "\u201D no menu desta conversa"
        );
        continue;
      }
      cliqueReal(item.el);
      feitos.push(nome);
      await wait(320);
    }
    showPanel(
      acao.rotulo + " \u2014 resultado",
      "Feitas: " + feitos.length + " de " + escolhidas.length + (feitos.length ? "\n  \xB7 " + feitos.join("\n  \xB7 ") : "") + (faltaram.length ? "\n\nN\xE3o deu em " + faltaram.length + ":\n  \xB7 " + faltaram.join("\n  \xB7 ") : "") + "\n\nNenhuma conversa foi aberta por este m\xF3dulo" + (acao.recibo ? ", mas \u201Cmarcar como lida\u201D manda recibo de leitura por si s\xF3." : ", ent\xE3o nenhum recibo de leitura saiu daqui.")
    );
  }
  async function conferir2(escolhidas) {
    const { id, nome } = escolhidas[0];
    const row = linhasDaLista().find((r) => chatIdDaLinha(r) === id);
    if (!row) return showPanel("Conferir a\xE7\xF5es", "A linha de \u201C" + nome + "\u201D saiu da lista.");
    const itens = await itensDoMenu(row);
    const rotulos = itens.map(rotuloDoItem).filter((t) => t && t.length <= 60);
    await fecharMenu();
    const achadas = ACOES.map(
      (a) => (casar(itens, a) ? "  ok    " : "  FALTA ") + a.rotulo
    ).join("\n");
    showPanel(
      "A\xE7\xF5es que o WhatsApp oferece",
      "Menu do bot\xE3o direito de \u201C" + nome + "\u201D (aberto e fechado, nada foi clicado):\n\n" + (rotulos.length ? rotulos.map((t) => "  \xB7 " + t).join("\n") : "  (nenhum item apareceu)") + "\n\nDo que este m\xF3dulo usa:\n" + achadas
    );
  }
  function abrir2() {
    const linhas = linhasDaLista().map((r) => ({ id: chatIdDaLinha(r), nome: nomeDaLinha(r) || "(sem nome)" })).filter((x) => x.id);
    if (!linhas.length) {
      return showPanel("A\xE7\xF5es em massa", "Nenhuma conversa renderizada na lista agora.");
    }
    const form = document.createElement("div");
    form.className = "zl-form";
    const aviso = document.createElement("div");
    aviso.className = "zl-lim";
    aviso.textContent = "S\xF3 aparecem aqui as conversas RENDERIZADAS: a lista do WhatsApp \xE9 virtualizada e o ZapLite n\xE3o a rola sozinho. Role a lista antes de abrir esta janela para alcan\xE7ar mais. Nenhuma a\xE7\xE3o daqui ABRE conversa \u2014 abrir mandaria recibo de leitura para quem escreveu.";
    const lista = document.createElement("div");
    lista.className = "zl-lista";
    const caixas = [];
    linhas.forEach((x) => {
      const l = document.createElement("label");
      const c = document.createElement("input");
      c.type = "checkbox";
      l.appendChild(c);
      l.appendChild(document.createTextNode(x.nome));
      lista.appendChild(l);
      caixas.push({ c, x });
    });
    const todas = document.createElement("label");
    const ct = document.createElement("input");
    ct.type = "checkbox";
    ct.onchange = () => caixas.forEach((k) => k.c.checked = ct.checked);
    todas.appendChild(ct);
    todas.appendChild(document.createTextNode("marcar todas as " + linhas.length + " vis\xEDveis"));
    form.appendChild(aviso);
    form.appendChild(todas);
    form.appendChild(lista);
    const escolhidas = () => caixas.filter((k) => k.c.checked).map((k) => k.x);
    const exigir = (fn) => async () => {
      const e = escolhidas();
      if (!e.length) return showPanel("A\xE7\xF5es em massa", "Nenhuma conversa marcada.");
      await fn(e);
    };
    const acoes = [["Conferir a\xE7\xF5es (n\xE3o executa)", exigir(conferir2)]];
    for (const a of ACOES) {
      acoes.push([
        a.rotulo,
        exigir(async (e) => {
          showPanel(
            "Confirmar: " + a.rotulo,
            a.nota + "\n\nConversas (" + e.length + "):\n  \xB7 " + e.map((x) => x.nome).join("\n  \xB7 ") + "\n\nNada acontece at\xE9 voc\xEA clicar no bot\xE3o abaixo.",
            [[a.recibo ? "Sim, e eu aceito o recibo de leitura" : "Confirmar", () => executar(a, e)]]
          );
        })
      ]);
    }
    return showPanel("A\xE7\xF5es em massa (" + linhas.length + " conversas vis\xEDveis)", form, acoes);
  }
  function registrarAcoesEmMassa() {
    reg({
      id: "bulkUnread",
      label: "A\xE7\xF5es em massa",
      apply() {
        addAct(ensureDock(), ID_ACT4, "\u2611", "A\xE7\xF5es em massa", "", abrir2);
      },
      revert() {
        dropAct(ID_ACT4);
      }
    });
  }

  // src-tauri/injection/src/modulos/exportar.js
  var ID_ACT5 = "zl-exportar";
  function analisarPrePlainText(pre) {
    const s = String(pre || "").trim();
    const m = s.match(/^\[([^\],]+),\s*([^\]]+)\]\s*(.*?):\s*$/);
    if (!m) return { hora: "", data: "", autor: "" };
    return { hora: m[1].trim(), data: m[2].trim(), autor: m[3].trim() };
  }
  function linhaDeExportacao(msg) {
    const carimbo = msg.data || msg.hora ? "[" + [msg.hora, msg.data].filter(Boolean).join(", ") + "] " : "";
    const quem = msg.autor ? msg.autor + ": " : "";
    return carimbo + quem + (msg.texto || "");
  }
  function tipoDeMidia(bolha) {
    try {
      if (imagemDaBolha(bolha)) return "imagem";
      if (bolha.querySelector("video")) return "v\xEDdeo";
      if (bolha.querySelector('audio,[data-testid="ptt-status"],[data-icon="ptt-status"]')) return "\xE1udio";
      if (bolha.querySelector('[data-icon="document"],[data-testid="document-thumb"]')) return "documento";
    } catch (_) {
    }
    return "";
  }
  function coletarMensagens() {
    const out = [];
    for (const bolha of bolhasVisiveis()) {
      const pre = bolha.querySelector("[data-pre-plain-text]");
      const meta = analisarPrePlainText(pre && pre.getAttribute("data-pre-plain-text"));
      let texto = (textoDaBolha(bolha) || "").trim();
      const midia = tipoDeMidia(bolha);
      if (!texto && midia) texto = "<" + midia + ">";
      if (!texto && ehApagada(bolha)) texto = "<mensagem apagada>";
      if (!texto) continue;
      out.push({
        id: idDaBolha(bolha),
        hora: meta.hora,
        data: meta.data,
        autor: meta.autor || (ehDeSaida(bolha) ? "Voc\xEA" : ""),
        saida: ehDeSaida(bolha),
        midia,
        texto
      });
    }
    return out;
  }
  var AVISO = "S\xF3 o que est\xE1 RENDERIZADO na tela. A lista de mensagens do WhatsApp \xE9 virtualizada e o ZapLite n\xE3o rola a conversa sozinho \u2014 role at\xE9 onde quiser antes de exportar e o n\xFAmero abaixo sobe. Nada \xE9 enviado a servidor nenhum: o arquivo vai direto para o disco.";
  function nomeSemAcentoNemBarra(s) {
    return String(s || "conversa").normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^\w\- ]+/g, "").trim().replace(/\s+/g, "-").slice(0, 48) || "conversa";
  }
  async function exportar(formato) {
    const msgs = coletarMensagens();
    if (!msgs.length) {
      return showPanel(
        "Exportar conversa",
        "Nenhuma mensagem renderizada. Abra uma conversa e role at\xE9 o trecho que voc\xEA quer salvar."
      );
    }
    const nome = nomeDaConversaAberta() || "conversa";
    const cabecalho = "Conversa: " + nome + "\nExportado pelo ZapLite em " + (/* @__PURE__ */ new Date()).toLocaleString() + "\nMensagens capturadas: " + msgs.length + "\nLIMITE: " + AVISO + "\n----------------------------------------------------------------------\n";
    const prefixo = "zaplite-" + nomeSemAcentoNemBarra(nome);
    let blob;
    if (formato === "json") {
      blob = new Blob(
        [
          JSON.stringify(
            {
              conversa: nome,
              exportadoEm: (/* @__PURE__ */ new Date()).toISOString(),
              mensagensCapturadas: msgs.length,
              limitacao: AVISO,
              mensagens: msgs
            },
            null,
            2
          )
        ],
        { type: "application/json" }
      );
    } else {
      blob = new Blob([cabecalho + msgs.map(linhaDeExportacao).join("\n") + "\n"], {
        type: "text/plain;charset=utf-8"
      });
    }
    await salvarArquivo(blob, prefixo);
  }
  function abrir3() {
    const msgs = coletarMensagens();
    const nome = nomeDaConversaAberta();
    const form = document.createElement("div");
    form.className = "zl-form";
    const cab = document.createElement("div");
    cab.textContent = nome ? "Conversa aberta: " + nome + "\nMensagens renderizadas agora: " + msgs.length : "Nenhuma conversa aberta.";
    cab.style.whiteSpace = "pre-wrap";
    const lim = document.createElement("div");
    lim.className = "zl-lim";
    lim.textContent = AVISO;
    form.appendChild(cab);
    form.appendChild(lim);
    return showPanel("Exportar conversa", form, [
      ["Salvar .txt", () => exportar("txt")],
      ["Salvar .json", () => exportar("json")]
    ]);
  }
  function registrarExportar() {
    reg({
      id: "exportChat",
      label: "Exportar conversa",
      apply() {
        addAct(ensureDock(), ID_ACT5, "\u2B73", "Exportar conversa", "", abrir3);
      },
      revert() {
        dropAct(ID_ACT5);
      }
    });
  }

  // src-tauri/injection/src/modulos/baixar-massa.js
  var ID_ACT6 = "zl-baixar";
  var PAUSA_MS = 120;
  var AVISO2 = "S\xF3 as m\xEDdias RENDERIZADAS e J\xC1 CARREGADAS. A conversa \xE9 virtualizada (o ZapLite n\xE3o a rola sozinho) e uma m\xEDdia que ainda n\xE3o foi aberta na tela n\xE3o tem arquivo para ler \u2014 role at\xE9 onde quiser e deixe as miniaturas carregarem antes de baixar. Nada sai da m\xE1quina: os arquivos v\xE3o direto para a pasta que voc\xEA escolher.";
  var EXT_POR_MIME2 = {
    "image/jpeg": "jpg",
    "image/png": "png",
    "image/webp": "webp",
    "image/gif": "gif",
    "video/mp4": "mp4",
    "video/webm": "webm",
    "video/quicktime": "mov",
    "audio/ogg": "ogg",
    "audio/mpeg": "mp3",
    "audio/mp4": "m4a",
    "application/pdf": "pdf"
  };
  function midiasVisiveis() {
    const out = [];
    const vistos = {};
    bolhasVisiveis().forEach((bolha, i) => {
      const cands = [];
      const img = imagemDaBolha(bolha);
      if (img) cands.push(["imagem", img.src]);
      try {
        bolha.querySelectorAll("video").forEach((v) => {
          const src = v.currentSrc || v.src || (v.querySelector("source") || {}).src || "";
          if (src) cands.push(["video", src]);
        });
        bolha.querySelectorAll("audio").forEach((a) => {
          const src = a.currentSrc || a.src || "";
          if (src) cands.push(["audio", src]);
        });
      } catch (_) {
      }
      for (const [tipo, url] of cands) {
        if (!url || url.indexOf("blob:") !== 0) continue;
        if (vistos[url]) continue;
        vistos[url] = true;
        out.push({
          tipo,
          url,
          ordem: i + 1,
          id: idDaBolha(bolha),
          saida: ehDeSaida(bolha)
        });
      }
    });
    return out;
  }
  function progresso(titulo, texto, pct) {
    const p = showPanel(titulo, texto);
    const corpo = p.querySelector(".zl-panel-body");
    const bar = document.createElement("div");
    bar.className = "zl-bar";
    const i = document.createElement("i");
    i.style.width = Math.max(0, Math.min(100, Math.round(pct || 0))) + "%";
    bar.appendChild(i);
    corpo.appendChild(bar);
    return p;
  }
  async function base64De(url) {
    const r = await fetch(url);
    if (!r.ok) throw new Error("a p\xE1gina recusou o arquivo (HTTP " + r.status + ")");
    const b = await r.blob();
    const bytes = new Uint8Array(await b.arrayBuffer());
    let s = "";
    const PEDACO = 32768;
    for (let i = 0; i < bytes.length; i += PEDACO) {
      s += String.fromCharCode.apply(null, bytes.subarray(i, i + PEDACO));
      if (i % (PEDACO * 32) === 0) await wait(0);
    }
    const mime = String(b.type || "").split(";")[0].trim().toLowerCase();
    return { b64: btoa(s), ext: EXT_POR_MIME2[mime] || (mime.split("/")[1] || "bin").replace(/[^a-z0-9]/g, ""), bytes: bytes.length };
  }
  async function baixar() {
    const itens = midiasVisiveis();
    if (!itens.length) {
      return showPanel(
        "Download em massa",
        "Nenhuma m\xEDdia carregada na conversa aberta agora.\n\n" + AVISO2
      );
    }
    let pasta;
    try {
      const r = await invoke("escolher_pasta");
      if (!r || r.cancelado) return showPanel("Download em massa", "Voc\xEA fechou a janela sem escolher a pasta. Nada foi baixado.");
      pasta = r.pasta;
    } catch (e) {
      return showPanel("N\xE3o deu para escolher a pasta", e.message);
    }
    const carimbo = (/* @__PURE__ */ new Date()).toISOString().slice(0, 16).replace(/[-:T]/g, "");
    let ok = 0;
    let total = 0;
    const falhas = [];
    let ultimo = "";
    for (let i = 0; i < itens.length; i++) {
      const it = itens[i];
      progresso(
        "Baixando m\xEDdias",
        "Arquivo " + (i + 1) + " de " + itens.length + " (" + it.tipo + ")\nPasta: " + pasta,
        i * 100 / itens.length
      );
      try {
        const { b64, ext, bytes } = await base64De(it.url);
        const nome = "zaplite-" + carimbo + "-" + String(it.ordem).padStart(3, "0") + "-" + it.tipo + "." + ext;
        const r = await invoke("save_media_em", { pasta, dataB64: b64, filename: nome });
        ok++;
        total += bytes;
        ultimo = r && r.path || "";
      } catch (e) {
        falhas.push("#" + it.ordem + " (" + it.tipo + "): " + (e && e.message || String(e)));
      }
      await wait(PAUSA_MS);
    }
    const kb = total > 1024 * 1024 ? (total / 1024 / 1024).toFixed(1) + " MB" : Math.round(total / 1024) + " KB";
    showPanel(
      "Download em massa \u2014 resultado",
      "Baixadas: " + ok + " de " + itens.length + " (" + kb + ")\nPasta: " + pasta + (falhas.length ? "\n\nFalharam " + falhas.length + ":\n  \xB7 " + falhas.join("\n  \xB7 ") : "") + "\n\n" + AVISO2,
      ultimo ? [["Abrir a pasta", () => invoke("revelar_arquivo", { caminho: ultimo }).catch((e) => showPanel("Erro", e.message))]] : null
    );
  }
  function abrir4() {
    const itens = midiasVisiveis();
    const nome = nomeDaConversaAberta();
    const conta = itens.reduce((a, i) => {
      a[i.tipo] = (a[i.tipo] || 0) + 1;
      return a;
    }, {});
    const form = document.createElement("div");
    form.className = "zl-form";
    const cab = document.createElement("div");
    cab.style.whiteSpace = "pre-wrap";
    cab.textContent = nome ? "Conversa aberta: " + nome + "\nM\xEDdias prontas para baixar: " + itens.length + (itens.length ? " (" + Object.keys(conta).map((k) => conta[k] + " " + k).join(", ") + ")" : "") : "Nenhuma conversa aberta.";
    const lim = document.createElement("div");
    lim.className = "zl-lim";
    lim.textContent = AVISO2;
    form.appendChild(cab);
    form.appendChild(lim);
    return showPanel("Download em massa", form, [["Escolher pasta e baixar", baixar]]);
  }
  function registrarBaixarMassa() {
    reg({
      id: "bulkDownload",
      label: "Download em massa",
      apply() {
        addAct(ensureDock(), ID_ACT6, "\u2913", "Baixar m\xEDdias da conversa", "", abrir4);
      },
      revert() {
        dropAct(ID_ACT6);
      }
    });
  }

  // src-tauri/injection/src/main.js
  connCore();
  registrarEnvioNaoSalvo();
  registrarAntiApagadas();
  instalarCapturaDeAudio();
  registrarTranscrever();
  registrarResumir();
  registrarRascunhoResposta();
  registrarVelocidadeAudio();
  registrarSempreNoTopo();
  registrarTema();
  registrarDeclutter();
  registrarBlurPrivacidade();
  registrarNsfwBlur();
  registrarAutoTranscrever();
  registrarNotificacoes();
  registrarMenuContexto();
  registrarTraduzir();
  registrarOcr();
  registrarGolpe();
  registrarResumoDiario();
  registrarRespostasRapidas();
  registrarAcoesEmMassa();
  registrarNotas();
  registrarLembretes();
  registrarBaixarMassa();
  registrarExportar();
  window.__ZAPLITE_RELOAD__ = applyAll;
  boot();
})();
})();

