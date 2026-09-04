/* Empacota src-tauri/injection/src/ no ÚNICO arquivo que o Rust embute:
   src-tauri/injection/bundle.js (`include_str!` em lib.rs).
   Roda antes de `tauri build` e de `tauri dev` (ver package.json).

   O alvo não é um <script> comum: é o `initialization_script` do WebView2,
   entregue como string terminada em NUL a uma página de TERCEIRO
   (web.whatsapp.com). Daí as quatro restrições que este script confere depois
   de empacotar, e que valem mais do que qualquer preferência de estilo:

     1. UM arquivo só, sem `import`/`require` em tempo de execução — não há
        rede nem resolvedor de módulos do outro lado da injeção;
     2. sem `eval`/`new Function` — a CSP da página não é nossa;
     3. NENHUM caractere de controle literal. Um `\0` no meio do fonte não é
        erro de sintaxe, mas CORTA o script na injeção: o app sobe, a página
        carrega e nada do bundle roda. Já aconteceu (ver build.rs, que falha o
        build pelo mesmo motivo — aqui a checagem é só mais cedo e mais barata);
     4. saída determinística: o mesmo fonte tem que dar o mesmo bundle, senão
        `--conferir` não serve para nada.

   `node scripts/empacotar.mjs --conferir` não escreve: compara o bundle.js
   que está no disco com o que os módulos produzem AGORA e falha se estiverem
   diferentes. É o que impede alguém de publicar um bundle desatualizado. */

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { RAIZ, morrer } from "./comum.mjs";

const INJECAO = join(RAIZ, "src-tauri", "injection");
const ENTRADA = join(INJECAO, "src", "main.js");
const SAIDA = join(INJECAO, "bundle.js");
const ESBUILD = join(RAIZ, "node_modules", "esbuild", "bin", "esbuild");

/* O invólucro externo é NOSSO, não do esbuild: a guarda de reentrada tem que
   ser a PRIMEIRA coisa a rodar (antes do gancho de WebSocket), e o corpo do
   módulo de entrada é justamente a última coisa que um empacotador emite. */
const ABERTURA = `/* ============================================================================
   ZapLite — bundle injetado no WhatsApp Web.

   ARQUIVO GERADO. Não edite: edite os módulos em src-tauri/injection/src/ e
   rode \`npm run empacotar\`. Ele está no git porque o Rust o embute com
   \`include_str!\` e o build.rs o confere.
   ============================================================================ */
(function () {
  "use strict";
  if (window.__ZAPLITE__) return;
  window.__ZAPLITE__ = true;
`;
const FECHAMENTO = `})();
`;

function empacotar() {
  if (!existsSync(ESBUILD)) {
    morrer("esbuild não encontrado em node_modules. Rode `npm install`.");
  }
  const args = [
    ESBUILD,
    ENTRADA,
    "--bundle",
    "--format=iife",
    // Nada de eliminação de código morto: o bundle antigo levava tudo o que
    // estava escrito, e "o empacotador decidiu que isto não é usado" é
    // exatamente o tipo de diferença silenciosa que esta refatoração não pode
    // introduzir.
    "--tree-shaking=false",
    "--charset=ascii",
    "--legal-comments=none",
    "--log-level=warning",
    `--banner:js=${ABERTURA}`,
    `--footer:js=${FECHAMENTO}`,
  ];
  try {
    return execFileSync(process.execPath, args, {
      cwd: RAIZ,
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
      stdio: ["ignore", "pipe", "inherit"],
    });
  } catch (e) {
    morrer("o esbuild recusou os módulos em injection/src/ (erro acima).");
  }
}

/** As quatro restrições da injeção. Falhar aqui custa uma linha; falhar na
    injeção custa um app que sobe e não faz nada. */
function conferirRestricoes(js) {
  const linhas = js.split("\n");
  for (let n = 0; n < linhas.length; n++) {
    const chars = [...linhas[n]];
    for (let c = 0; c < chars.length; c++) {
      const cp = chars[c].codePointAt(0);
      const controle = (cp < 0x20 && cp !== 0x09) || cp === 0x7f;
      if (controle || cp === 0xfeff) {
        morrer(
          `bundle.js:${n + 1}:${c + 1}: caractere de controle literal ` +
            `U+${cp.toString(16).toUpperCase().padStart(4, "0")} na saída. ` +
            "Ele CORTA o script na injeção do WebView2."
        );
      }
    }
  }
  for (const [re, oque] of [
    [/(^|[^.\w$])eval\s*\(/, "eval("],
    [/new\s+Function\s*\(/, "new Function("],
    [/(^|[^.\w$])import\s*\(/, "import( dinâmico"],
    [/^\s*(import|export)\s/m, "import/export de topo"],
    [/(^|[^.\w$])require\s*\(/, "require("],
  ]) {
    const m = js.match(re);
    if (m) {
      const linha = js.slice(0, m.index).split("\n").length;
      morrer(`bundle.js:${linha}: a saída contém ${oque}, que não sobrevive à injeção.`);
    }
  }
}

const conferir = process.argv.includes("--conferir");
const js = empacotar();
conferirRestricoes(js);

if (conferir) {
  const atual = existsSync(SAIDA) ? readFileSync(SAIDA, "utf8") : "";
  if (atual !== js) {
    morrer(
      "src-tauri/injection/bundle.js está DESATUALIZADO em relação a\n" +
        "  src-tauri/injection/src/. Rode `npm run empacotar` e confira o diff."
    );
  }
  console.log("> bundle.js confere com os módulos em injection/src/");
} else {
  const antes = existsSync(SAIDA) ? readFileSync(SAIDA, "utf8") : "";
  if (antes === js) {
    console.log("> bundle.js já estava em dia (nada a escrever)");
  } else {
    writeFileSync(SAIDA, js, "utf8");
    console.log(`> bundle.js gerado (${js.length} bytes, ${js.split("\n").length} linhas)`);
  }
}
