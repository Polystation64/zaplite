//! B2 — relatório de diagnóstico em texto, pronto para colar num e-mail.
//!
//! O caminho antigo era "abrir pasta": o amigo tinha de achar o
//! `connection.log`, anexar e torcer para ser o arquivo certo. Aqui o app monta
//! o texto inteiro e o Painel só copia.
//!
//! # Por que existe uma etapa de REDAÇÃO
//!
//! O `connection.log` é técnico por construção, mas isso é convenção, não
//! garantia — e a auditoria que precedeu este módulo achou vazamento REAL no
//! log da máquina de desenvolvimento:
//!
//! * `lib.rs` (`open_external`) registra **a URL inteira** de todo link que o
//!   usuário abre a partir de uma conversa — `.../p/DcZqtvEDoX_/?igsi=…` é
//!   conteúdo de mensagem, ponto final;
//! * linhas antigas com prefixo `ZDBG` (instrumentação já removida do bundle,
//!   mas ainda presente no arquivo de quem atualizou) carregavam **nome de
//!   contato, trecho de mensagem e JID** (`5511…-149…@g.us`).
//!
//! Um relatório que copia o log cru manda essas coisas junto. Então nada aqui
//! confia no formato: cada linha é reconstruída campo a campo a partir de uma
//! ALLOWLIST, e o texto livre que sobra passa por três máscaras (endereço de
//! internet, identificador de conversa, número longo). É allowlist de
//! propósito — campo novo no log nasce invisível para o relatório até alguém
//! decidir aqui o contrário.
//!
//! Segredo (chave de API, token) nunca chega perto: o relatório lê o
//! `settings.json` apenas para responder *se* IA e Whisper estão configurados,
//! e o valor da chave não é lido em lugar nenhum deste arquivo.

use serde_json::Value;
use tauri::{AppHandle, Manager};

/// Quantas linhas do fim do log entram no relatório.
const LINHAS_DO_LOG: usize = 200;

/// Teto por linha de texto livre. O escritor do log já corta `reason` em 160,
/// mas as linhas do próprio app (`src":"app"`) não passam por lá.
const TETO_TEXTO: usize = 240;

/// Campos que o relatório reconhece numa linha do `connection.log`. Qualquer
/// outra chave é DESCARTADA — inclusive uma que uma versão futura do app venha
/// a escrever sem passar por esta revisão.
const CAMPOS: &[&str] = &["ts", "src", "state", "prev", "attempts", "note", "reason"];

/// Prefixos de instrumentação que comprovadamente carregavam texto raspado da
/// página. Não dá para higienizar nome próprio, então a linha inteira sai.
const MARCADORES_DE_PAGINA: &[&str] = &["ZDBG", "CENSO"];

/// Endereços que são do próprio app/serviço e podem aparecer no relatório. O
/// resto vira `<endereço removido>` — um link que o usuário abriu a partir de
/// uma conversa é conteúdo da conversa.
const ORIGENS_CONHECIDAS: &[&str] = &[
    "web.whatsapp.com",
    "alexandreieva.tech",
    "localhost",
    "127.0.0.1",
    "ipc.localhost",
    "tauri.localhost",
    "asset.localhost",
    "zaplite-sonda.invalido",
];

/// Sufixos de identificador de conversa do WhatsApp.
const SUFIXOS_JID: &[&str] = &[
    "@g.us",
    "@c.us",
    "@lid",
    "@s.whatsapp.net",
    "@broadcast",
    "@newsletter",
];

/* ------------------------------------------------------------------------ */
/* Máscaras (funções PURAS, para poderem ser testadas)                       */
/* ------------------------------------------------------------------------ */

fn origem_conhecida(host: &str) -> bool {
    let host = host.split(':').next().unwrap_or(host).to_ascii_lowercase();
    let host = host.strip_prefix("www.").unwrap_or(&host).to_string();
    ORIGENS_CONHECIDAS
        .iter()
        .any(|o| host == *o || host.ends_with(&format!(".{o}")))
}

/// Toda URL perde o caminho e a query — é lá que mora o que identifica a
/// pessoa (`/send?phone=…`, `/p/DcZ…?igsi=…`). Se nem a origem for conhecida,
/// nada dela sobrevive.
pub(crate) fn mascarar_urls(t: &str) -> String {
    let mut out = String::with_capacity(t.len());
    let b = t.as_bytes();
    let mut i = 0usize;
    while i < b.len() {
        let resto = &t[i..];
        let esquema = if resto.starts_with("https://") {
            Some("https://")
        } else if resto.starts_with("http://") {
            Some("http://")
        } else {
            None
        };
        let Some(esquema) = esquema else {
            let c = t[i..].chars().next().unwrap();
            out.push(c);
            i += c.len_utf8();
            continue;
        };
        let depois = &resto[esquema.len()..];
        // A URL termina no primeiro caractere que nenhum navegador aceitaria
        // no meio dela.
        let fim = depois
            .find(|c: char| c.is_whitespace() || matches!(c, '"' | '\\' | '<' | '>' | '\'' | '|'))
            .unwrap_or(depois.len());
        let corpo = &depois[..fim];
        let host = corpo
            .split(|c| matches!(c, '/' | '?' | '#'))
            .next()
            .unwrap_or("");
        if !host.is_empty() && origem_conhecida(host) {
            out.push_str(esquema);
            out.push_str(host);
        } else {
            out.push_str("<endereço removido>");
        }
        i += esquema.len() + fim;
    }
    out
}

fn id_char(c: char) -> bool {
    c.is_ascii_alphanumeric() || c == '-' || c == '_'
}

/// `120363…@g.us`, `5511…-149…@g.us`, `2202…@lid` → `<conversa>`.
pub(crate) fn mascarar_jids(t: &str) -> String {
    let mut out = String::with_capacity(t.len());
    let mut i = 0usize;
    while i < t.len() {
        let c = t[i..].chars().next().unwrap();
        if c == '@' {
            if let Some(suf) = SUFIXOS_JID
                .iter()
                .find(|s| t[i..].to_ascii_lowercase().starts_with(&s.to_ascii_lowercase()))
            {
                // Come o identificador que já foi para a saída.
                while out.chars().next_back().is_some_and(id_char) {
                    out.pop();
                }
                out.push_str("<conversa>");
                i += suf.len();
                continue;
            }
        }
        out.push(c);
        i += c.len_utf8();
    }
    out
}

/// Número longo é telefone, JID ou id de mensagem. Durações e contadores do
/// log ficam bem abaixo de sete dígitos, então nada de diagnóstico se perde.
pub(crate) fn mascarar_numeros(t: &str) -> String {
    let mut out = String::with_capacity(t.len());
    let mut run = String::new();
    for c in t.chars() {
        if c.is_ascii_digit() {
            run.push(c);
            continue;
        }
        if run.len() >= 7 {
            out.push_str("<num>");
        } else {
            out.push_str(&run);
        }
        run.clear();
        out.push(c);
    }
    if run.len() >= 7 {
        out.push_str("<num>");
    } else {
        out.push_str(&run);
    }
    out
}

/// Ordem importa: a URL some primeiro (ela contém pontos e dígitos que as
/// outras máscaras picotariam sem necessidade).
pub(crate) fn limpar_texto(t: &str) -> String {
    let s = mascarar_urls(t);
    let s = mascarar_jids(&s);
    let mut s = mascarar_numeros(&s);
    if s.chars().count() > TETO_TEXTO {
        s = s.chars().take(TETO_TEXTO).collect::<String>() + "…";
    }
    s
}

/// Reconstrói uma linha do log a partir da allowlist. `None` = linha
/// descartada (não é JSON, não é objeto, ou é instrumentação que raspava a
/// página).
pub(crate) fn redigir_linha(linha: &str) -> Option<String> {
    let linha = linha.trim();
    if linha.is_empty() {
        return None;
    }
    let v: Value = serde_json::from_str(linha).ok()?;
    let obj = v.as_object()?;

    let bruto = obj.get("reason").and_then(|r| r.as_str()).unwrap_or("");
    if MARCADORES_DE_PAGINA
        .iter()
        .any(|m| bruto.trim_start().starts_with(m))
    {
        return None;
    }

    let mut partes: Vec<String> = Vec::with_capacity(CAMPOS.len());
    for campo in CAMPOS {
        let Some(valor) = obj.get(*campo) else { continue };
        let texto = match valor {
            Value::String(s) => limpar_texto(s),
            Value::Null => continue,
            outro => limpar_texto(&outro.to_string()),
        };
        partes.push(format!("{campo}={texto}"));
    }
    if partes.is_empty() {
        return None;
    }
    Some(partes.join(" "))
}

/// As últimas `n` linhas do log, já redigidas.
pub(crate) fn redigir_log(conteudo: &str, n: usize) -> String {
    let linhas: Vec<&str> = conteudo.lines().collect();
    let inicio = linhas.len().saturating_sub(n);
    let saida: Vec<String> = linhas[inicio..]
        .iter()
        .filter_map(|l| redigir_linha(l))
        .collect();
    if saida.is_empty() {
        "(nenhuma linha legível)".to_string()
    } else {
        saida.join("\n")
    }
}

/* ------------------------------------------------------------------------ */
/* Coleta do ambiente                                                         */
/* ------------------------------------------------------------------------ */

#[cfg(windows)]
fn versao_windows() -> String {
    use winreg::enums::HKEY_LOCAL_MACHINE;
    use winreg::RegKey;
    let Ok(k) = RegKey::predef(HKEY_LOCAL_MACHINE)
        .open_subkey(r"SOFTWARE\Microsoft\Windows NT\CurrentVersion")
    else {
        return "desconhecida".into();
    };
    let nome: String = k.get_value("ProductName").unwrap_or_default();
    let display: String = k.get_value("DisplayVersion").unwrap_or_default();
    let build: String = k.get_value("CurrentBuild").unwrap_or_default();
    let ubr: u32 = k.get_value("UBR").unwrap_or(0);
    let mut s = if nome.is_empty() { "Windows".to_string() } else { nome };
    if !display.is_empty() {
        s.push(' ');
        s.push_str(&display);
    }
    if !build.is_empty() {
        s.push_str(&format!(" (build {build}.{ubr})"));
    }
    s
}

#[cfg(not(windows))]
fn versao_windows() -> String {
    "não é Windows".into()
}

fn sim_nao(b: bool) -> &'static str {
    if b {
        "sim"
    } else {
        "não"
    }
}

/// Só os ids ligados. O relatório NÃO reproduz o catálogo: o que interessa a
/// quem lê o e-mail é o que estava ativo quando quebrou.
fn modulos_ligados(settings: &Value) -> Vec<String> {
    let mut v: Vec<String> = settings["modules"]
        .as_object()
        .map(|m| {
            m.iter()
                .filter(|(_, val)| val.as_bool().unwrap_or(false))
                .map(|(k, _)| k.clone())
                .collect()
        })
        .unwrap_or_default();
    v.sort();
    v
}

/* ------------------------------------------------------------------------ */
/* Montagem                                                                   */
/* ------------------------------------------------------------------------ */

/// Montagem PURA: recebe tudo já coletado. Existe separada do comando para o
/// teste poder alimentá-la com um settings que tem chave de API dentro e
/// provar que a chave não sai do outro lado.
pub(crate) fn montar(
    versao_app: &str,
    windows: &str,
    webview2: &str,
    conexao: &Value,
    settings: &Value,
    whisper_pronto: bool,
    whisper_motor: bool,
    ia: &Value,
    log_redigido: &str,
    linhas_pedidas: usize,
) -> String {
    let mods = modulos_ligados(settings);
    let lista = if mods.is_empty() {
        "(nenhum)".to_string()
    } else {
        mods.join(", ")
    };

    let ia_pronta = ia["ready"].as_bool().unwrap_or(false);
    let ia_provedor = ia["providerLabel"].as_str().unwrap_or("");
    let ia_modelo = ia["model"].as_str().unwrap_or("");
    let ia_linha = if ia_pronta {
        format!(
            "configurada — provedor {}, modelo {} (a chave NÃO vai neste relatório)",
            if ia_provedor.is_empty() { "?" } else { ia_provedor },
            if ia_modelo.is_empty() { "?" } else { ia_modelo }
        )
    } else {
        format!(
            "não configurada ({})",
            limpar_texto(ia["reason"].as_str().unwrap_or("sem provedor escolhido"))
        )
    };

    let c = conexao;
    let ms = |k: &str| c[k].as_u64().map(|v| format!("{v} ms")).unwrap_or_else(|| "—".into());

    format!(
        "ZapLite — diagnóstico\n\
         ============================================================\n\
         O QUE VAI NESTE TEXTO: versão do app, versão do Windows e do WebView2, estado da\n\
         conexão, quais módulos estão ligados, se IA e Whisper estão configurados (o valor\n\
         das chaves NÃO entra) e as últimas {linhas_pedidas} linhas técnicas do connection.log — sem\n\
         endereços de internet de terceiros, sem números longos e sem identificadores de\n\
         conversa. Nenhuma mensagem, nenhum contato e nenhuma chave de API são incluídos.\n\
         ============================================================\n\
         \n\
         --- APP ---\n\
         ZapLite {versao_app}\n\
         Windows: {windows}\n\
         WebView2: {webview2}\n\
         \n\
         --- CONEXÃO (agora) ---\n\
         estado: {estado} (há {since})\n\
         estado reportado pela página: {page}\n\
         tentativas contadas pelo Rust: {att} (a página reportou {attr})\n\
         idade do heartbeat: {hb}\n\
         recuperações no total: {reb} | na janela recente: {rec}\n\
         cenário: {cen} | recuperando agora: {recg}\n\
         janela visível: {vis} | com foco: {foc}\n\
         motivo do estado: {motivo}\n\
         \n\
         --- MÓDULOS LIGADOS ({n}) ---\n\
         {lista}\n\
         \n\
         --- IA E TRANSCRIÇÃO ---\n\
         IA: {ia_linha}\n\
         Whisper: {wp} (motor instalado pelo app: {wm})\n\
         \n\
         --- ÚLTIMAS LINHAS DO connection.log (redigidas) ---\n\
         {log_redigido}\n",
        linhas_pedidas = linhas_pedidas,
        versao_app = versao_app,
        windows = windows,
        webview2 = webview2,
        estado = c["state"].as_str().unwrap_or("?"),
        since = ms("since"),
        page = c["pageState"].as_str().unwrap_or("?"),
        att = c["attempts"].as_u64().unwrap_or(0),
        attr = c["attemptsReported"].as_u64().unwrap_or(0),
        hb = ms("heartbeatAgeMs"),
        reb = c["rebuilds"].as_u64().unwrap_or(0),
        rec = c["recoveriesInWindow"].as_u64().unwrap_or(0),
        cen = c["cenario"].as_str().unwrap_or("—"),
        recg = sim_nao(c["recovering"].as_bool().unwrap_or(false)),
        vis = sim_nao(c["visible"].as_bool().unwrap_or(false)),
        foc = sim_nao(c["focused"].as_bool().unwrap_or(false)),
        motivo = limpar_texto(c["reason"].as_str().unwrap_or("")),
        n = mods.len(),
        lista = lista,
        ia_linha = ia_linha,
        wp = if whisper_pronto { "pronto" } else { "não configurado" },
        wm = sim_nao(whisper_motor),
        log_redigido = log_redigido,
    )
}

/// B2 — o texto inteiro, pronto para o `navigator.clipboard` do Painel.
/// Só o Painel (conteúdo local) tem este comando na capability; a página do
/// WhatsApp Web não o enxerga.
#[tauri::command]
pub(crate) async fn diagnostico_texto(app: AppHandle) -> Result<String, String> {
    let versao = app.package_info().version.to_string();
    let webview2 = tauri::webview_version().unwrap_or_else(|_| "desconhecida".into());
    let conexao = crate::connection::get_connection_state(app.clone()).await;
    let settings = crate::read_settings(&app);
    let ia = crate::ai::ai_status(app.clone());
    let w = crate::whisper::whisper_status(app.clone());

    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    let bruto = std::fs::read_to_string(dir.join("connection.log")).unwrap_or_default();
    let log = redigir_log(&bruto, LINHAS_DO_LOG);

    Ok(montar(
        &versao,
        &versao_windows(),
        &webview2,
        &conexao,
        &settings,
        w["pronto"].as_bool().unwrap_or(false),
        w["motorInstalado"].as_bool().unwrap_or(false),
        &ia,
        &log,
        LINHAS_DO_LOG,
    ))
}

/* ------------------------------------------------------------------------ */
/* Testes                                                                     */
/* ------------------------------------------------------------------------ */

#[cfg(test)]
mod testes {
    use super::*;
    use serde_json::json;

    #[test]
    fn url_de_terceiro_some_inteira() {
        // Caso REAL colhido do connection.log da máquina de desenvolvimento:
        // `open_external` registra o link que o usuário abriu de uma conversa.
        let l = r#"{"src":"app","state":"CONNECTED","reason":"janela principal: link da mensagem aberto no navegador: https://www.instagram.com/p/DcZqtvEDoX_/?igsi=c2Mwc2p3MXU1NzA5"}"#;
        let out = redigir_linha(l).unwrap();
        assert!(out.contains("<endereço removido>"), "{out}");
        assert!(!out.contains("instagram"), "{out}");
        assert!(!out.contains("DcZqtvEDoX_"), "{out}");
        assert!(!out.contains("igsi"), "{out}");
    }

    #[test]
    fn origem_conhecida_mantem_so_a_origem() {
        let s = limpar_texto("renavegando para https://web.whatsapp.com/send?phone=5511999998888");
        assert!(s.contains("https://web.whatsapp.com"), "{s}");
        assert!(!s.contains("phone"), "{s}");
        assert!(!s.contains("5511999998888"), "{s}");
    }

    #[test]
    fn jid_e_telefone_somem() {
        let s = limpar_texto("pre=220224481677472@lid alvo=5511954952178-1490384139@g.us");
        assert!(!s.contains("220224481677472"), "{s}");
        assert!(!s.contains("5511954952178"), "{s}");
        assert!(!s.contains("@g.us"), "{s}");
        assert!(s.contains("<conversa>"), "{s}");
    }

    #[test]
    fn numeros_curtos_do_diagnostico_sobrevivem() {
        // Se as durações e contadores fossem mascarados, o relatório perderia
        // justamente o que serve para depurar.
        let s = limpar_texto("watchdog: 15s sem heartbeat; 33432 intervalos, média 6272ms");
        assert!(s.contains("15s"), "{s}");
        assert!(s.contains("33432"), "{s}");
        assert!(s.contains("6272ms"), "{s}");
    }

    #[test]
    fn instrumentacao_que_raspava_a_pagina_e_descartada() {
        // Linhas antigas (o `ZDBG` já saiu do bundle, mas segue no arquivo de
        // quem atualizou) carregavam nome de contato e trecho de mensagem —
        // não há como higienizar nome próprio, então a linha inteira sai.
        let l = r#"{"src":"page","state":"CONNECTED","reason":"ZDBG ABRE#0 Zelly Uniformes07/08/2026Você reagiu com a: oi"}"#;
        assert!(redigir_linha(l).is_none());
    }

    #[test]
    fn campo_desconhecido_nao_entra() {
        // Allowlist: uma versão futura do log que passe a gravar `chatName`
        // não vaza por omissão.
        let l = r#"{"ts":"2026-01-01T00:00:00-03:00","state":"CONNECTED","chatName":"Fulano de Tal","body":"segredo"}"#;
        let out = redigir_linha(l).unwrap();
        assert!(!out.contains("Fulano"), "{out}");
        assert!(!out.contains("segredo"), "{out}");
        assert!(out.contains("state=CONNECTED"), "{out}");
    }

    #[test]
    fn linha_invalida_e_descartada_sem_panico() {
        assert!(redigir_linha("não é json").is_none());
        assert!(redigir_linha("").is_none());
        assert!(redigir_linha("[1,2,3]").is_none());
    }

    #[test]
    fn so_as_ultimas_n_linhas() {
        let mut c = String::new();
        for i in 0..500 {
            c.push_str(&format!("{{\"attempts\":{i},\"state\":\"CONNECTED\"}}\n"));
        }
        let out = redigir_log(&c, 200);
        assert_eq!(out.lines().count(), 200);
        assert!(out.contains("attempts=499"));
        assert!(!out.contains("attempts=299"));
    }

    /// A prova que o contrato de privacidade pede: um `settings.json` cheio de
    /// segredo entra, e nenhum pedaço dele sai no relatório.
    #[test]
    fn nenhum_segredo_do_settings_chega_ao_relatorio() {
        let settings = json!({
            "anthropicKey": "sk-ant-SEGREDO-AAA",
            "openaiKey": "sk-proj-SEGREDO-BBB",
            "geminiKey": "SEGREDO-CCC",
            "openrouterKey": "sk-or-SEGREDO-DDD",
            "compatibleKey": "SEGREDO-EEE",
            "whisperModel": "C:\\Users\\fulano\\ggml-base.bin",
            "modules": {"transcribe": true, "nsfwBlur": false, "theme": true}
        });
        // `ai_status` devolve `keyTail` (4 últimos caracteres). O relatório não
        // lê esse campo — este json prova que, mesmo presente, ele não sai.
        let ia = json!({
            "ready": true, "providerLabel": "Anthropic (Claude)",
            "model": "claude-haiku-4-5", "keyTail": "…-AAA", "reason": ""
        });
        let conexao = json!({"state":"CONNECTED","pageState":"CONNECTED","reason":"ok"});
        let txt = montar(
            "0.1.5",
            "Windows 11",
            "126.0.0.0",
            &conexao,
            &settings,
            true,
            true,
            &ia,
            "state=CONNECTED",
            200,
        );
        for proibido in [
            "SEGREDO", "sk-ant", "sk-proj", "sk-or", "…-AAA", "keyTail", "ggml-base", "fulano",
        ] {
            assert!(!txt.contains(proibido), "vazou {proibido:?} em:\n{txt}");
        }
        // e o que DEVE estar lá continua lá
        assert!(txt.contains("theme, transcribe"), "{txt}");
        assert!(txt.contains("Anthropic (Claude)"), "{txt}");
        assert!(!txt.contains("nsfwBlur"), "módulo desligado não é 'ligado'");
    }

    #[test]
    fn o_texto_diz_o_que_carrega() {
        // Quem manda tem direito de saber o que está mandando: a declaração é
        // parte do contrato, não enfeite.
        let txt = montar(
            "0.1.5",
            "Windows 11",
            "126",
            &json!({}),
            &json!({}),
            false,
            false,
            &json!({"ready": false, "reason": "sem provedor"}),
            "",
            200,
        );
        assert!(txt.contains("O QUE VAI NESTE TEXTO"), "{txt}");
        assert!(txt.contains("chaves"), "{txt}");
        assert!(txt.contains("Nenhuma mensagem"), "{txt}");
    }
}

