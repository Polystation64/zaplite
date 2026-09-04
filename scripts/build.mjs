// U1 — `npm run build`: instalador NSIS **e** o `.sig` do atualizador.
//
// `createUpdaterArtifacts: true` (tauri.conf.json) faz o bundler assinar o
// instalador no fim do build. Para isso ele precisa da chave privada; nós a
// passamos ao processo filho a partir do arquivo apontado por
// TAURI_SIGNING_PRIVATE_KEY_PATH. O conteúdo nunca é impresso, nunca é gravado
// e não sai do processo do build.
//
// Sem a variável, o build ainda roda — mas grita, e o instalador que sai dele
// NÃO serve para publicar. É o `npm run publicar` que verifica isso de novo.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { RAIZ, TAURI_JS, conf, caminhoDaChave, instaladorDe, morrer, NSIS } from "./comum.mjs";

const versao = conf().version;
const chave = caminhoDaChave({ obrigatoria: false });
const env = { ...process.env };

if (chave) {
  // A ferramenta da Tauri aceita a chave por conteúdo (TAURI_SIGNING_PRIVATE_KEY).
  // Lemos o arquivo aqui e entregamos só ao filho. `_PASSWORD` vazio evita que
  // o bundler pare esperando alguém digitar num build sem terminal.
  env.TAURI_SIGNING_PRIVATE_KEY = readFileSync(chave, "utf8").trim();
  env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD = process.env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD ?? "";
  console.log(`> assinando com a chave em ${chave}`);
} else {
  console.warn(
    "\n  AVISO: TAURI_SIGNING_PRIVATE_KEY_PATH não está definida.\n" +
      "  O build vai sair SEM assinatura e NÃO pode ser publicado.\n"
  );
}

execFileSync(process.execPath, [TAURI_JS, "build", ...process.argv.slice(2)], {
  cwd: RAIZ,
  env,
  stdio: "inherit",
});

if (chave) {
  const sig = join(NSIS, instaladorDe(versao) + ".sig");
  if (!existsSync(sig)) {
    morrer(
      `o build terminou mas não produziu ${sig}.\n` +
        "  Sem o .sig não há o que publicar. Confira `createUpdaterArtifacts` em\n" +
        "  src-tauri/tauri.conf.json e a chave em TAURI_SIGNING_PRIVATE_KEY_PATH."
    );
  }
  console.log(`> assinatura pronta: ${sig}`);
}
