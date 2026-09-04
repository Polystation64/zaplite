// Pedaços que o `build.mjs` e o `publicar.mjs` compartilham.
//
// A CHAVE PRIVADA: nenhum arquivo aqui — nem em qualquer outro lugar do
// repositório — contém a chave. Ela é sempre localizada pelo caminho em
// `TAURI_SIGNING_PRIVATE_KEY_PATH` e entregue à ferramenta da Tauri. Nada do
// conteúdo dela é impresso, guardado ou copiado.

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const RAIZ = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const CONF = join(RAIZ, "src-tauri", "tauri.conf.json");
export const NSIS = join(RAIZ, "src-tauri", "target", "release", "bundle", "nsis");
export const TAURI_JS = join(RAIZ, "node_modules", "@tauri-apps", "cli", "tauri.js");

export function morrer(msg) {
  console.error("\n  ERRO: " + msg + "\n");
  process.exit(1);
}

export function conf() {
  return JSON.parse(readFileSync(CONF, "utf8"));
}

/** Nome do instalador NSIS que o `tauri build` produz para esta versão. */
export function instaladorDe(versao) {
  return `ZapLite_${versao}_x64-setup.exe`;
}

/**
 * Onde está a chave privada. Nunca embutida: só o CAMINHO, e só por variável de
 * ambiente. Falhar aqui com a mensagem inteira é melhor do que produzir um
 * pacote sem assinatura que ninguém percebe até um amigo instalar qualquer
 * coisa vinda de um domínio sequestrado.
 */
export function caminhoDaChave({ obrigatoria = true } = {}) {
  const p = process.env.TAURI_SIGNING_PRIVATE_KEY_PATH;
  if (!p) {
    if (!obrigatoria) return null;
    morrer(
      "TAURI_SIGNING_PRIVATE_KEY_PATH não está definida.\n\n" +
        "  Ela deve apontar para o ARQUIVO da chave privada do atualizador, que mora\n" +
        "  fora do repositório. No PowerShell:\n\n" +
        '      $env:TAURI_SIGNING_PRIVATE_KEY_PATH = "$env:USERPROFILE\\.zaplite-keys\\zaplite-updater.key"\n\n' +
        "  Sem assinatura, quem controlar o domínio controla a máquina de quem instalou\n" +
        "  o ZapLite. Este passo não tem atalho."
    );
  }
  if (!existsSync(p)) {
    morrer(`TAURI_SIGNING_PRIVATE_KEY_PATH aponta para um arquivo que não existe: ${p}`);
  }
  return p;
}

/**
 * U3 — o texto da seção `## X.Y.Z` do CHANGELOG.md. Devolve `null` quando não
 * existe seção ou ela está vazia: nesse caso o manifesto sai SEM `notes` e o
 * aviso mostra só o número da versão. Nunca inventamos notas.
 */
export function notasDaVersao(versao) {
  const arq = join(RAIZ, "CHANGELOG.md");
  if (!existsSync(arq)) return null;
  const linhas = readFileSync(arq, "utf8").split(/\r?\n/);
  const alvo = "## " + versao;
  let dentro = false;
  const corpo = [];
  for (const l of linhas) {
    if (l.trimEnd() === alvo) {
      dentro = true;
      continue;
    }
    if (dentro && /^##\s/.test(l)) break;
    if (dentro) corpo.push(l);
  }
  const txt = corpo.join("\n").trim();
  return txt.length ? txt : null;
}
