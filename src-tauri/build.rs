/// O bundle é injetado no WebView2 como `initialization_script`, e a API do
/// WebView2 recebe a string TERMINADA EM NUL. Um `\0` literal no meio do fonte
/// não é erro de sintaxe (o `node --check` passa, os testes passam), mas CORTA
/// o script naquele ponto na hora da injeção — e o que sobra é um bundle que
/// não chega ao `boot()`.
///
/// Foi exatamente o que aconteceu ao escrever uma classe de regex de controles
/// com os caracteres LITERAIS em vez de `\uXXXX`: o app subiu, a página
/// carregou, nenhum heartbeat saiu e o watchdog renavegou três vezes até
/// desistir. O sintoma ("bundle não rodou") não apontava para a causa em lugar
/// nenhum. Falhar aqui, no build, custa uma linha de erro em vez de uma tarde.
fn conferir_bundle_sem_controles() {
    let caminho = "injection/bundle.js";
    println!("cargo:rerun-if-changed={caminho}");
    let src = std::fs::read_to_string(caminho).expect("não consegui ler injection/bundle.js");
    for (n, linha) in src.lines().enumerate() {
        if let Some((col, c)) = linha
            .char_indices()
            .find(|(_, c)| (c.is_control() && *c != '\t') || *c == '\u{feff}')
        {
            panic!(
                "injection/bundle.js:{}:{}: caractere de controle literal U+{:04X} no fonte. \
                 Ele CORTA o script na injeção do WebView2. Escreva-o como escape \
                 (\\uXXXX) ou compare por `charCodeAt`.",
                n + 1,
                col + 1,
                c as u32
            );
        }
    }
}

fn main() {
    conferir_bundle_sem_controles();

    // Declarar os comandos aqui faz o tauri-build gerar uma permissão
    // `allow-<comando>` para cada um. Sem isso não há identificador para
    // citar na capability da origem remota (web.whatsapp.com), e todo
    // invoke vindo da página é rejeitado pelo ACL.
    tauri_build::try_build(
        tauri_build::Attributes::new().app_manifest(tauri_build::AppManifest::new().commands(&[
            "load_settings",
            "load_settings_public",
            "save_settings",
            // ONDA 2 — gravação ESTREITA a partir da página. `save_settings`
            // reescreve o arquivo inteiro (chave paga inclusa) e por isso
            // continua só no Painel; estes seis escrevem um ramo declarado,
            // uma nota por vez, ou um arquivo dentro de uma pasta que o
            // USUÁRIO apontou no diálogo nativo desta sessão.
            "save_module_data",
            "note_get",
            "note_ids",
            "note_set",
            "escolher_pasta",
            "save_media_em",
            "open_settings",
            "open_log_dir",
            // B2: só o Painel o cita (capabilities/default.json). A página do
            // WhatsApp Web não tem como pedir o log — nem redigido.
            "diagnostico_texto",
            "set_always_on_top",
            "ai_complete",
            // Só o Painel (conteúdo local) cita estes três — ver
            // capabilities/default.json. A origem remota NÃO os tem: nem
            // dispara OAuth, nem lê o estado da chave.
            "ai_status",
            "ai_test",
            "ai_oauth_openrouter",
            "transcribe_audio",
            "save_media",
            // A3: o aviso de "salvo" tem botão para abrir o arquivo e para
            // abrir a pasta. Os dois só aceitam caminho que ESTE processo
            // gravou (ver `MidiasSalvas` em lib.rs) — sem isso seriam um
            // ShellExecute de caminho arbitrário nas mãos da página.
            "abrir_arquivo",
            "revelar_arquivo",
            // A2: link de mensagem abre no navegador do sistema.
            "open_external",
            "show_toast",
            "get_toast",
            "close_toast",
            "close_all_toasts",
            "focus_chat",
            "take_pending_chat",
            // P1/P2: ligar e desligar o registro de `whatsapp://` é do PAINEL
            // (capabilities/default.json). A origem remota NÃO os cita: nada em
            // web.whatsapp.com mexe no registro do Windows. Só o
            // `take_pending_deeplink` vai para a capability remota, e ele
            // apenas LÊ um alvo que o próprio Rust montou a partir do argv.
            "protocolo_status",
            "protocolo_registrar",
            "protocolo_restaurar",
            "take_pending_deeplink",
            "snooze_toast",
            "pin_toast",
            "mute_chat",
            // W1(b): a página REPORTA a lista de conversas (capability remota);
            // só o Painel a LÊ (capabilities/default.json).
            "report_chats",
            "list_chats",
            "conn_heartbeat",
            "conn_transition",
            "conn_recovery",
            "get_connection_state",
            // Instalação do Whisper pelo Painel. Só o Painel (conteúdo local)
            // cita estes — ver capabilities/default.json. A origem remota NÃO
            // os tem: nada em web.whatsapp.com pode disparar um download de
            // 3 GB nem reescrever o caminho do modelo.
            "whisper_status",
            "whisper_progress",
            "whisper_cancel",
            "whisper_install_engine",
            "whisper_download_model",
            "whisper_use_model",
            "whisper_delete_model",
            // U2: atualização assinada. Só o Painel (conteúdo local) cita
            // estes — ver capabilities/default.json. A origem remota NÃO os
            // tem: nada em web.whatsapp.com pode disparar um download de
            // instalador nem trocar o executável do app.
            "atualizacao_estado",
            "atualizacao_procurar",
            "atualizacao_instalar",
        ])),
    )
    .expect("falha no tauri-build");
}
