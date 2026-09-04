// U4 — passo de publicação reproduzível.
//
// A partir de um build JÁ FEITO (`npm run build`), este script:
//   1. confere que existe o instalador NSIS da versão que está em tauri.conf.json;
//   2. ASSINA esse instalador com a chave privada apontada por
//      TAURI_SIGNING_PRIVATE_KEY_PATH (o conteúdo da chave nunca entra aqui:
//      o caminho é repassado ao `tauri signer sign -f`);
//   3. lê as notas da versão no CHANGELOG.md — e omite o campo se não houver;
//   4. escreve `publicacao/latest.json` no formato que o plugin espera;
//   5. copia o instalador para a mesma pasta, pronta para subir ao site.
//
// A pasta `publicacao/` é descartável e não é versionada: ela é o que vai para
// https://alexandreieva.tech/zaplite/ .
//
// Para exercitar o ciclo contra um servidor local, defina ZAPLITE_PUBLICAR_BASE
// (ex.: http://127.0.0.1:8787/) e a URL do instalador no manifesto aponta para
// lá em vez do domínio. O endereço de PRODUÇÃO continua sendo um só, o de
// tauri.conf.json.

import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  RAIZ,
  NSIS,
  TAURI_JS,
  conf,
  caminhoDaChave,
  instaladorDe,
  morrer,
  notasDaVersao,
} from "./comum.mjs";

const c = conf();
const versao = c.version;

// O endpoint mora num lugar só. A URL do instalador é montada a partir dele,
// então trocar o endereço do site é trocar UMA linha em tauri.conf.json.
const endpoint = c?.plugins?.updater?.endpoints?.[0];
if (!endpoint) morrer("tauri.conf.json não tem plugins.updater.endpoints[0].");
const base = process.env.ZAPLITE_PUBLICAR_BASE || endpoint.replace(/[^/]*$/, "");

const chave = caminhoDaChave();

const nome = instaladorDe(versao);
const instalador = join(NSIS, nome);
if (!existsSync(instalador)) {
  morrer(
    `não achei o instalador da versão ${versao}:\n    ${instalador}\n\n` +
      "  Rode `npm run build` antes de publicar (e confira se a versão em\n" +
      "  src-tauri/tauri.conf.json é a que você quer lançar)."
  );
}

// --- assinatura ------------------------------------------------------------
// `-f` recebe o CAMINHO. A chave em si não passa por variável nem por
// argumento, e nada do conteúdo dela chega ao stdout deste processo.
console.log(`> assinando ${nome}`);
execFileSync(
  process.execPath,
  [TAURI_JS, "signer", "sign", "-f", chave, "-p", process.env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD ?? "", instalador],
  { cwd: RAIZ, stdio: ["ignore", "ignore", "inherit"] }
);

const arqSig = instalador + ".sig";
if (!existsSync(arqSig)) morrer(`a assinatura não foi gerada: ${arqSig}`);
const assinatura = readFileSync(arqSig, "utf8").trim();
if (!assinatura) morrer(`a assinatura em ${arqSig} está vazia.`);

// --- manifesto -------------------------------------------------------------
const notas = notasDaVersao(versao);
if (!notas) {
  console.warn(
    `> AVISO: CHANGELOG.md não tem seção "## ${versao}". O manifesto sai sem "notes"\n` +
      "         e o aviso vai mostrar só o número da versão."
  );
}

const manifesto = {
  version: versao,
  ...(notas ? { notes: notas } : {}),
  pub_date: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
  platforms: {
    "windows-x86_64": {
      signature: assinatura,
      url: base + nome,
    },
  },
};

const saida = join(RAIZ, "publicacao");
mkdirSync(saida, { recursive: true });
writeFileSync(join(saida, "latest.json"), JSON.stringify(manifesto, null, 2) + "\n", "utf8");
copyFileSync(instalador, join(saida, nome));

const mb = (statSync(instalador).size / (1024 * 1024)).toFixed(1);
console.log(`
  Pronto. Em ${saida}:

    latest.json                 versão ${versao}${notas ? "" : "  (SEM notas)"}
    ${nome}   ${mb} MB

  Suba os DOIS para ${base}
  (o manifesto que o app procura é ${endpoint})
`);
