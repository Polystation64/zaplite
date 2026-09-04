import { bolhasVisiveis, ehDeSaida, idDaBolha, imagemDaBolha } from "../bolhas.js";
import { addAct, dropAct, ensureDock } from "../dock.js";
import { nomeDaConversaAberta } from "../lista.js";
import { reg, wait } from "../nucleo.js";
import { showPanel } from "../painel.js";
import { invoke } from "../ponte.js";

/* 20. DOWNLOAD EM MASSA ---------------------------------------------------
   Baixa as mídias já carregadas da conversa aberta, para uma pasta só.

   POR QUE NÃO É `save_media` N VEZES: `save_media` abre o diálogo de "salvar
   como" a CADA arquivo — certo para um item, insuportável para trinta. Aqui a
   pergunta acontece UMA vez (`escolher_pasta`, o mesmo diálogo nativo) e o
   caminho escolhido fica registrado do lado Rust; `save_media_em` só aceita
   pasta que o usuário apontou nesta sessão. A página nunca escolhe onde
   escrever.

   MESMA LIMITAÇÃO DO EXPORTAR, dita na tela: só o que está RENDERIZADO. A
   conversa é virtualizada e o ZapLite não a rola sozinho. E só o que já foi
   BAIXADO pela página: uma foto que ainda mostra o botão de download não tem
   `blob:` nenhum para ler, e ela é contada como não baixada, com o motivo.

   RITMO: um arquivo de cada vez, com uma pausa curta entre eles. Trinta
   `fetch` simultâneos de blobs de vídeo travam a página do WhatsApp inteira —
   e uma interface travada é indistinguível de um app quebrado.
   ------------------------------------------------------------------------ */

const ID_ACT = "zl-baixar";
const PAUSA_MS = 120;

const AVISO =
  "Só as mídias RENDERIZADAS e JÁ CARREGADAS. A conversa é virtualizada (o ZapLite não a rola " +
  "sozinho) e uma mídia que ainda não foi aberta na tela não tem arquivo para ler — role até " +
  "onde quiser e deixe as miniaturas carregarem antes de baixar. Nada sai da máquina: os " +
  "arquivos vão direto para a pasta que você escolher.";

const EXT_POR_MIME = {
  "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/gif": "gif",
  "video/mp4": "mp4", "video/webm": "webm", "video/quicktime": "mov",
  "audio/ogg": "ogg", "audio/mpeg": "mp3", "audio/mp4": "m4a", "application/pdf": "pdf",
};

/** As mídias que dá para baixar agora, na ordem da tela. */
export function midiasVisiveis() {
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
    } catch (_) {}
    for (const [tipo, url] of cands) {
      if (!url || url.indexOf("blob:") !== 0) continue;
      if (vistos[url]) continue;
      vistos[url] = true;
      out.push({
        tipo,
        url,
        ordem: i + 1,
        id: idDaBolha(bolha),
        saida: ehDeSaida(bolha),
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

/** Bytes de um `blob:` em base64, em pedaços, sem travar a interface. */
async function base64De(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error("a página recusou o arquivo (HTTP " + r.status + ")");
  const b = await r.blob();
  const bytes = new Uint8Array(await b.arrayBuffer());
  let s = "";
  const PEDACO = 0x8000;
  for (let i = 0; i < bytes.length; i += PEDACO) {
    s += String.fromCharCode.apply(null, bytes.subarray(i, i + PEDACO));
    if (i % (PEDACO * 32) === 0) await wait(0);
  }
  const mime = String(b.type || "").split(";")[0].trim().toLowerCase();
  return { b64: btoa(s), ext: EXT_POR_MIME[mime] || (mime.split("/")[1] || "bin").replace(/[^a-z0-9]/g, ""), bytes: bytes.length };
}

async function baixar() {
  const itens = midiasVisiveis();
  if (!itens.length) {
    return showPanel(
      "Download em massa",
      "Nenhuma mídia carregada na conversa aberta agora.\n\n" + AVISO
    );
  }
  let pasta;
  try {
    const r = await invoke("escolher_pasta");
    if (!r || r.cancelado) return showPanel("Download em massa", "Você fechou a janela sem escolher a pasta. Nada foi baixado.");
    pasta = r.pasta;
  } catch (e) {
    return showPanel("Não deu para escolher a pasta", e.message);
  }

  const carimbo = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, "");
  let ok = 0;
  let total = 0;
  const falhas = [];
  let ultimo = "";
  for (let i = 0; i < itens.length; i++) {
    const it = itens[i];
    progresso(
      "Baixando mídias",
      "Arquivo " + (i + 1) + " de " + itens.length + " (" + it.tipo + ")\nPasta: " + pasta,
      (i * 100) / itens.length
    );
    try {
      const { b64, ext, bytes } = await base64De(it.url);
      const nome =
        "zaplite-" + carimbo + "-" + String(it.ordem).padStart(3, "0") + "-" + it.tipo + "." + ext;
      const r = await invoke("save_media_em", { pasta, dataB64: b64, filename: nome });
      ok++;
      total += bytes;
      ultimo = (r && r.path) || "";
    } catch (e) {
      falhas.push("#" + it.ordem + " (" + it.tipo + "): " + ((e && e.message) || String(e)));
    }
    await wait(PAUSA_MS);
  }

  const kb = total > 1024 * 1024 ? (total / 1024 / 1024).toFixed(1) + " MB" : Math.round(total / 1024) + " KB";
  showPanel(
    "Download em massa — resultado",
    "Baixadas: " + ok + " de " + itens.length + " (" + kb + ")\nPasta: " + pasta +
      (falhas.length ? "\n\nFalharam " + falhas.length + ":\n  · " + falhas.join("\n  · ") : "") +
      "\n\n" + AVISO,
    ultimo
      ? [["Abrir a pasta", () => invoke("revelar_arquivo", { caminho: ultimo }).catch((e) => showPanel("Erro", e.message))]]
      : null
  );
}

function abrir() {
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
  cab.textContent = nome
    ? "Conversa aberta: " + nome + "\nMídias prontas para baixar: " + itens.length +
      (itens.length ? " (" + Object.keys(conta).map((k) => conta[k] + " " + k).join(", ") + ")" : "")
    : "Nenhuma conversa aberta.";
  const lim = document.createElement("div");
  lim.className = "zl-lim";
  lim.textContent = AVISO;
  form.appendChild(cab);
  form.appendChild(lim);
  return showPanel("Download em massa", form, [["Escolher pasta e baixar", baixar]]);
}

export function registrarBaixarMassa() {
  reg({
    id: "bulkDownload",
    label: "Download em massa",
    apply() {
      addAct(ensureDock(), ID_ACT, "⤓", "Baixar mídias da conversa", "", abrir);
    },
    revert() {
      dropAct(ID_ACT);
    },
  });
}
