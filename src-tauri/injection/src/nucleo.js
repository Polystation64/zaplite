import { montarDock } from "./dock.js";
import { invoke } from "./ponte.js";

export let settings = {};
export const on = (id) => settings.modules && settings.modules[id] === true;

/* --- utilidades de DOM / espera ------------------------------------------ */
export const wait = (ms) => new Promise((r) => setTimeout(r, ms));
export async function until(fn, timeout = 20000, step = 300) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const v = fn();
    if (v) return v;
    await wait(step);
  }
  return null;
}
// Fila de estilos pedidos antes da página existir. O initialization_script
// roda antes do documento, então documentElement pode ser null aqui.
const cssQueue = [];
export const css = (text, key) => {
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
export const flushCss = () => {
  while (cssQueue.length) {
    const [t, k] = cssQueue.shift();
    css(t, k);
  }
};
export const dropCss = (key) => {
  const el = document.getElementById(key);
  if (el) el.remove();
};

/* ========================================================================
   REGISTRO DE MÓDULOS
   Cada módulo: { id, label, apply(), revert() }
   apply() é idempotente. revert() desfaz efeitos visuais quando desligado.
   ======================================================================== */
const modules = [];
export const reg = (m) => modules.push(m);
/** Um módulo consultando outro (A6: o menu do botão direito pergunta ao
    anti-apagadas o que ele guardou). Sem isto seria uma segunda cópia do
    `_store` — e duas cópias divergem. */
export const moduloPorId = (id) => modules.filter((m) => m.id === id)[0] || null;

/* Y3 — throttle COM BORDA DE SAÍDA.
   O piso puro (`if (agora - ultima < MS) return;`) descarta o último lote da
   janela. Isso perdia exatamente o caso que o módulo existe para cobrir: a
   mutação do "Esta mensagem foi apagada" chegando dentro dos 500 ms e NENHUM
   lote depois — a linha nunca mais era reexaminada e a marcação nunca
   aparecia. Aqui o piso continua valendo (é ele que segura o custo da
   varredura do documento inteiro, que era a maior fonte de lixo do nosso
   lado); o que muda é que o lote de dentro da janela fica AGENDADO para o
   fim dela em vez de jogado fora. No máximo uma execução extra por janela:
   enquanto houver cauda pendente, novos pedidos não somam timer nenhum.
   Fora do bundle isto é testado por `bundle.test.js`. */
export function throttleComCauda(fn, ms) {
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
    if (cauda) return; // já existe borda de saída agendada
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

/* ========================================================================
   APLICAR / REAPLICAR conforme settings
   ======================================================================== */
// Padrão de fábrica. Módulos novos precisam ser MESCLADOS com o que já
// está salvo: se substituirmos tudo-ou-nada, quem já tem settings.json
// nunca recebe um módulo novo, porque a chave simplesmente não existe lá.
const MODULOS_PADRAO = {
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
};

export async function applyAll() {
  try {
    // load_settings_public, não load_settings: esta página é web.whatsapp.com,
    // e qualquer script de terceiros aqui dentro consegue chamar o mesmo
    // comando. O Rust devolve só as chaves de aparência/módulos — a chave da
    // API Anthropic nunca atravessa a ponte (quem precisa dela é o
    // ai_complete, que a lê do lado Rust).
    settings = (await invoke("load_settings_public")) || {};
  } catch (e) {
    console.warn("[ZapLite] load_settings_public falhou:", e.message);
    settings = {};
  }
  // o que o usuário salvou vence; o que ele nunca viu usa o padrão
  settings.modules = Object.assign({}, MODULOS_PADRAO, settings.modules || {});
  // O dock precisa existir ANTES do primeiro `m.apply()`: `applyAll` não é
  // chamado só pelo boot (o Rust dispara `__ZAPLITE_RELOAD__` ao salvar
  // settings, e o observer o chama ao remontar), e nesses caminhos o dock
  // pode não estar montado. Sem isto o primeiro módulo da lista recebia
  // `null` de `ensureDock()` e perdia o botão em silêncio.
  if (!document.getElementById("zl-dock")) {
    await until(() => document.body, 30000);
    montarDock();
  }
  for (const m of modules) {
    try {
      if (on(m.id)) m.apply();
      else m.revert();
    } catch (e) {
      console.warn("[ZapLite] módulo", m.id, e);
    }
  }
}
