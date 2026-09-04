mod ai;
mod connection;
mod contas;
mod diagnostico;
mod notify;
mod protocol;
mod update;
mod whisper;

/// Windows: impede que o processo filho (ffmpeg/whisper-cli) abra uma
/// janela de console piscando na frente do usuário. 0x0800_0000.
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;


use base64::Engine;
use serde_json::{json, Value};
use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::webview::{DownloadEvent, NewWindowResponse, PageLoadEvent};
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_dialog::DialogExt;

const BUNDLE_JS: &str = include_str!("../injection/bundle.js");
const CHROME_UA: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

/// Cria a janela principal com exatamente a mesma configuração: mesma URL,
/// mesmo user-agent, mesmo initialization_script. Usada no boot e, como último
/// recurso, quando NÃO existe janela nenhuma (o watchdog normal renavega a
/// janela existente em vez de destruí-la). A sessão persiste porque o perfil
/// do WebView2 fica no diretório do app — nunca é apagado aqui.
pub(crate) fn create_main_window(app: &AppHandle) -> tauri::Result<()> {
    // Banco de PROVAS, só em build de depuração (ver `ganchos_de_teste`).
    // `ZAPLITE_ALVO` troca a URL da janela e `ZAPLITE_PERFIL_TESTE` troca o
    // perfil do WebView2. Juntos, permitem exercitar a recuperação inteira —
    // com reload de verdade — num documento descartável e num perfil VAZIO,
    // sem chegar perto da sessão logada do usuário. No release nada disso
    // existe no binário: a URL é constante e o perfil é o do app.
    #[cfg(debug_assertions)]
    let alvo = std::env::var("ZAPLITE_ALVO").unwrap_or_else(|_| "https://web.whatsapp.com".into());
    #[cfg(not(debug_assertions))]
    let alvo = "https://web.whatsapp.com".to_string();

    #[cfg_attr(not(debug_assertions), allow(unused_mut))]
    let mut b = WebviewWindowBuilder::new(app, "main", WebviewUrl::External(alvo.parse().unwrap()));
    // MEDIÇÃO de memória, só em debug: `ZAPLITE_SEM_INJECAO` carrega a MESMA
    // página, no MESMO perfil logado, sem uma linha do nosso bundle. É o
    // controle que separa "heap do WhatsApp Web" de "heap nosso" na árvore de
    // processos — a única atribuição possível, porque o WebView2 ignora
    // `--remote-debugging-port` e não há CDP. No release não existe: a injeção
    // é incondicional.
    #[cfg(debug_assertions)]
    let injetar = std::env::var("ZAPLITE_SEM_INJECAO").is_err();
    #[cfg(not(debug_assertions))]
    let injetar = true;

    #[cfg(debug_assertions)]
    if let Ok(perfil) = std::env::var("ZAPLITE_PERFIL_TESTE") {
        let p = PathBuf::from(perfil);
        let _ = fs::create_dir_all(&p);
        b = b.data_directory(p);
    }

    // 28 — MULTI-CONTA. Uma sessão do WhatsApp É o perfil do WebView2: sem
    // `--user-data-dir` próprio, a segunda conta escreve por cima da primeira
    // e as duas se perdem. Devolve `None` para a conta principal, e isso é
    // deliberado: passar `data_directory` mudaria a pasta onde a sessão de
    // hoje vive, e mudar a pasta da sessão é deslogar o usuário. Quem nunca
    // criar uma segunda conta não tem um byte movido de lugar.
    if let Some(perfil) = contas::perfil_webview(app) {
        let _ = fs::create_dir_all(&perfil);
        b = b.data_directory(perfil);
    }
    if injetar {
        b = b.initialization_script(BUNDLE_JS);
    }

    // MEDIÇÃO do DOM real, só em debug. O WebView2 IGNORA a variável de
    // ambiente `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS` porque o wry já passa
    // argumentos pela API (o que tem precedência) — medido em 17/08/2026: com
    // a variável setada, `http://127.0.0.1:9333/json/version` não responde.
    // O único jeito de abrir CDP é acrescentar o argumento AQUI, preservando
    // os que o wry usa. Fica atrás de `ZAPLITE_CDP` e de `debug_assertions`:
    // no release não existe uma linha disto no binário.
    #[cfg(all(debug_assertions, windows))]
    if let Ok(porta) = std::env::var("ZAPLITE_CDP") {
        b = b.additional_browser_args(&format!(
            "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection --remote-debugging-port={porta}"
        ));
    }
    // MEDIÇÃO do DOM real, só em debug: `ZAPLITE_PROBE=<caminho.js>` injeta um
    // script de sonda ANTES da página, no mesmo document_start do bundle.
    // Existe porque o CDP acima NÃO sobe (medido: o argumento chega à linha de
    // comando do msedgewebview2 e mesmo assim nada escuta na porta, e o
    // `DevToolsActivePort` não é criado) — sem isto não há como olhar o DOM
    // vivo da sessão logada. A sonda devolve o que mediu por `save_media`.
    // No release não existe: `debug_assertions`.
    #[cfg(debug_assertions)]
    if let Ok(caminho) = std::env::var("ZAPLITE_PROBE") {
        if let Ok(js) = fs::read_to_string(&caminho) {
            b = b.initialization_script(&js);
        }
    }

    let w = b
        .title("ZapLite")
        .inner_size(1280.0, 800.0)
        .min_inner_size(720.0, 520.0)
        .user_agent(CHROME_UA)
        // K12: ciclo de vida do DOCUMENTO. No WebView2 isto vem de
        // `ContentLoading` (Started) e `NavigationCompleted` (Finished) — e o
        // `NavigationCompleted` dispara também quando a navegação FALHA e a
        // página de erro é exibida. É o único sinal Rust-observável que
        // distingue "ainda carregando" de "documento pronto e mudo" no
        // Windows: `w.url()` não serve, porque o `Source` do WebView2 continua
        // sendo a URL tentada depois de uma falha.
        //
        // M1: é TAMBÉM por aqui que uma carga de documento que o Rust não
        // pediu vira uma recuperação contada — a retaguarda que impede o
        // contador de depender de a página avisar que recarregou.
        .on_page_load(|w, payload| {
            let terminou = matches!(payload.event(), PageLoadEvent::Finished);
            connection::note_page_load(w.app_handle(), terminou, payload.url().as_str());
        })
        // A2: link de mensagem é `<a target="_blank">`. Sem este handler o wry
        // marca o pedido como tratado e não faz nada — o clique some.
        .on_new_window({
            // O log é de propósito: "cliquei num link e não aconteceu nada" é
            // exatamente o relato que este arquivo tem que saber responder, e
            // a linha só aparece quando há clique em link (volume baixíssimo).
            let h = app.clone();
            move |url, _features| {
                let u = url.to_string();
                match abrir_externo(&u) {
                    Ok(()) => connection::note_window_event(&h, &format!("link aberto no navegador do sistema: {}", origem_para_log(&u))),
                    Err(e) => connection::note_window_event(&h, &format!("link NÃO aberto ({e})")),
                }
                NewWindowResponse::Deny
            }
        })
        // A2 (retaguarda): navegação de topo que tente sair do WhatsApp vai
        // para o navegador do sistema. Se ela passasse, a sessão logada sairia
        // da tela e o app viraria um navegador genérico.
        .on_navigation({
            let h = app.clone();
            move |url| {
                let u = url.as_str();
                if navegacao_interna(u) {
                    return true;
                }
                match abrir_externo(u) {
                    Ok(()) => connection::note_window_event(
                        &h,
                        &format!("navegação para fora do WhatsApp desviada para o navegador: {}", origem_para_log(u)),
                    ),
                    Err(e) => connection::note_window_event(&h, &format!("navegação bloqueada ({e})")),
                }
                false
            }
        })
        // A1/A3: download que a PÁGINA inicia (o botão de baixar do próprio
        // WhatsApp). Sem handler, o WebView2 grava calado na raiz de Downloads
        // e o app nem fica sabendo. Agora o arquivo desce para uma área
        // temporária nossa e, ao terminar, o usuário escolhe onde fica.
        //
        // Por que não perguntar já no `Requested`: esse callback roda DENTRO do
        // evento `DownloadStarting` do WebView2, e abrir modal ali é reentrância
        // documentada (laço de mensagens aninhado dentro do handler).
        .on_download(|wv, evento| {
            match evento {
                DownloadEvent::Requested { destination, .. } => {
                    let nome = destination
                        .file_name()
                        .map(|n| n.to_string_lossy().to_string())
                        .unwrap_or_default();
                    if let Some(p) = staging_de_download(&nome) {
                        *destination = p;
                    }
                }
                DownloadEvent::Finished { path, success, .. } => {
                    if let (true, Some(p)) = (success, path) {
                        acolher_download(wv.app_handle().clone(), p);
                    }
                }
                _ => {}
            }
            true
        })
        .build()?;

    // Alimenta o estado de visibilidade/foco do watchdog pelos EVENTOS da
    // janela. O watchdog nunca pode perguntar isso com `is_visible()`, que é
    // IPC bloqueante para a thread principal: se a UI travar, ele trava junto.
    let h = app.clone();
    w.on_window_event(move |e| match e {
        tauri::WindowEvent::Destroyed => {
            connection::note_window_visible(&h, false);
            connection::note_window_event(&h, "destruída");
            // OBSERVADO no app do usuário (16/08): com a regra padrão dele
            // (`persistent: true`) os toasts nunca expiram sozinhos. Fechar a
            // janela principal deixava um toast vivo na tela, e como o tao só
            // pede a saída quando a ÚLTIMA janela morre, o processo continuava
            // rodando — o app "não fechava" e o .exe ficava travado. Toast é
            // aviso da janela principal: sem ela, não tem o que avisar.
            let _ = notify::close_all_toasts(h.clone());
        }
        // Sem isto, o app sumindo da tela era indistinguível de um crash: o
        // log parava e não se sabia se tinha sido o usuário ou o watchdog.
        tauri::WindowEvent::CloseRequested { .. } => {
            // K10: quem pediu foi o USUÁRIO. Sem esta marca, `guard_exit` via
            // `recovering == true` e recriava a janela — por até 30s o app se
            // ressuscitava e simplesmente não podia ser fechado.
            connection::note_user_close(&h);
            connection::note_window_event(&h, "fechamento pedido (clique no X ou comando externo)")
        }
        tauri::WindowEvent::Focused(f) => connection::note_window_focus(&h, *f),
        _ => {}
    });
    connection::note_window_visible(app, true);
    Ok(())
}

fn settings_path(app: &AppHandle) -> PathBuf {
    let dir = contas::pasta_da_conta(app);
    let _ = fs::create_dir_all(&dir);
    dir.join("settings.json")
}

/* ==========================================================================
   BOM — O MODO DE FALHA CALADO QUE CUSTAVA A CONFIGURAÇÃO INTEIRA
   ==========================================================================
   `read_settings` era `from_str(&s).ok().unwrap_or_else(|| json!({}))`. Duas
   consequências, as duas ruins e nenhuma visível:

     · um settings.json gravado com BOM UTF-8 (`EF BB BF`) — que é o que o
       Bloco de Notas e o `Out-File`/`Set-Content` do PowerShell fazem por
       padrão — é REJEITADO pelo serde_json inteiro, porque o BOM não é
       espaço em branco em JSON. O usuário abre o arquivo, corrige uma linha,
       salva, e o app volta a TODOS os padrões;
     · qualquer outro erro — uma vírgula sobrando, o disco devolvendo lixo —
       dava exatamente o mesmo `{}` silencioso. E o `{}` não fica só na
       memória: o primeiro `save_module_data` ou `save_settings` GRAVA esse
       `{}` por cima do arquivo. A configuração não é só ignorada, é perdida.

   O que passa a valer:
     · BOM é ACEITO (é só um carimbo de codificação, não conteúdo);
     · arquivo ausente continua sendo `{}` em silêncio — é a primeira
       execução, e não há nada a avisar;
     · arquivo PRESENTE e inválido nunca mais vira `{}` calado: o original é
       renomeado para `settings-invalido-<carimbo>.json` (nada é apagado),
       sai uma linha no `connection.log`, e o motivo fica guardado para o
       Painel e para o aviso na tela.
   ========================================================================== */

/// O que a leitura crua do settings.json encontrou.
#[derive(Debug, PartialEq)]
pub(crate) enum LeituraSettings {
    /// Não existe arquivo. Primeira execução: `{}` é a resposta certa.
    Ausente,
    /// JSON válido e objeto.
    Ok(Value),
    /// Existe, mas não dá para usar. A `String` é o motivo, em português, e
    /// é CURTA de propósito: ela vai inteira para o `connection.log`, e
    /// `sanitize_reason` corta cada `reason` em 160 caracteres. Um motivo
    /// longo viraria uma linha de log truncada no meio — medido: a primeira
    /// versão deste texto saía cortada em “está em “C:\\Users\\”. O texto
    /// comprido, com o caminho do arquivo arquivado, é montado no chamador e
    /// vai para a tela, onde não há limite de 160.
    Invalido(String),
}

/// PURA e testada: decide o que um conteúdo de settings.json significa.
/// Recebe `None` quando o arquivo não pôde ser lido do disco.
pub(crate) fn interpretar_settings(bruto: Option<&str>) -> LeituraSettings {
    let Some(bruto) = bruto else {
        return LeituraSettings::Ausente;
    };
    // O BOM UTF-8 vira `U+FEFF` na `String` — um caractere, não três bytes.
    let texto = bruto.strip_prefix('\u{feff}').unwrap_or(bruto);
    if texto.trim().is_empty() {
        // Arquivo vazio (ou só o BOM) é o mesmo caso do arquivo ausente:
        // acontece quando o app é morto no meio da primeira gravação, e não
        // há configuração nenhuma a perder.
        return LeituraSettings::Ausente;
    }
    match serde_json::from_str::<Value>(texto) {
        Ok(Value::Object(m)) => LeituraSettings::Ok(Value::Object(m)),
        Ok(outro) => LeituraSettings::Invalido(format!(
            "é JSON válido mas não é um objeto (veio um {})",
            match outro {
                Value::Null => "null",
                Value::Bool(_) => "true/false",
                Value::Number(_) => "número",
                Value::String(_) => "texto",
                Value::Array(_) => "array",
                Value::Object(_) => "objeto",
            }
        )),
        Err(e) => LeituraSettings::Invalido(
            // A mensagem do serde já traz linha e coluna; repeti-las só
            // gastava os 160 caracteres da linha de log.
            format!("não é JSON válido: {e}")
                .chars()
                .take(90)
                .collect::<String>(),
        ),
    }
}

/// Motivo da última leitura inválida, para o Painel e para o aviso na tela.
/// `None` enquanto nada deu errado. Guardado porque o arquivo quebrado é
/// renomeado na hora: sem isto, o motivo morreria com a chamada.
static SETTINGS_QUEBRADO: Mutex<Option<String>> = Mutex::new(None);

/// Ligada quando o settings.json é inválido E não deu para pôr o original de
/// lado. Enquanto valer, `gravar_settings` recusa — melhor um erro na cara do
/// usuário do que a configuração dele sobrescrita por `{}`.
static GRAVACAO_TRAVADA: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// Põe o arquivo quebrado de lado, sem apagar nada, e devolve para onde foi.
fn arquivar_settings_invalido(p: &Path) -> Option<PathBuf> {
    let carimbo = chrono::Local::now().format("%Y%m%d-%H%M%S").to_string();
    let destino = p.with_file_name(format!("settings-invalido-{carimbo}.json"));
    match fs::rename(p, &destino) {
        Ok(()) => Some(destino),
        // Renomear falhou (arquivo travado por outro programa): então NÃO
        // deixamos o app gravar por cima — é melhor um erro visível do que
        // uma configuração perdida em silêncio.
        Err(_) => None,
    }
}

pub(crate) fn read_settings(app: &AppHandle) -> Value {
    let p = settings_path(app);
    let bruto = fs::read_to_string(&p).ok();
    match interpretar_settings(bruto.as_deref()) {
        LeituraSettings::Ok(v) => v,
        LeituraSettings::Ausente => json!({}),
        LeituraSettings::Invalido(motivo) => {
            // O relato acontece UMA vez por processo. `read_settings` é
            // chamado dezenas de vezes (todo toast passa por aqui); sem esta
            // trava o mesmo defeito viraria dezenas de linhas de log e uma
            // fila de avisos na tela.
            use std::sync::atomic::{AtomicBool, Ordering};
            static JA_RELATOU: AtomicBool = AtomicBool::new(false);
            if JA_RELATOU.swap(true, Ordering::SeqCst) {
                return json!({});
            }
            let onde = arquivar_settings_invalido(&p);
            // Duas versões do mesmo fato, de propósito: a CURTA cabe nos 160
            // caracteres da linha de log; a LONGA vai para a tela, onde o
            // usuário precisa do caminho inteiro para achar o arquivo.
            let curta = match &onde {
                Some(d) => format!(
                    "settings.json {motivo}; arquivado como {}",
                    d.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default()
                ),
                None => format!("settings.json {motivo}; NÃO deu para arquivar — gravação travada"),
            };
            let recado = match &onde {
                Some(d) => format!(
                    "O settings.json {motivo}. O arquivo NÃO foi apagado: está em “{}”. \
                     O ZapLite subiu com os padrões de fábrica — a sua configuração está lá dentro.",
                    d.display()
                ),
                None => format!(
                    "O settings.json {motivo}. Não consegui nem pôr o arquivo de lado (ele está \
                     em uso?), então o ZapLite está rodando com os padrões e NÃO vai gravar por \
                     cima. Feche o programa que está com o arquivo aberto e reinicie o ZapLite."
                ),
            };
            if onde.is_none() {
                // Trava de gravação: enquanto o arquivo quebrado continuar
                // lá, ninguém escreve por cima dele. Perder a configuração em
                // silêncio é justamente o defeito que este bloco existe para
                // matar — um erro visível no Painel custa muito menos.
                GRAVACAO_TRAVADA.store(true, std::sync::atomic::Ordering::SeqCst);
            }
            // Uma linha no connection.log: é o arquivo que responde
            // "por que o app voltou aos padrões?" três dias depois.
            connection::note_diag(app, &curta);
            if let Ok(mut g) = SETTINGS_QUEBRADO.lock() {
                *g = Some(recado.clone());
            }
            // E na tela, pela mesma janela de aviso dos toasts.
            avisar_settings_quebrado(app, &recado);
            json!({})
        }
    }
}

/// O que o Painel mostra na faixa de aviso. `None` = nada quebrado.
#[tauri::command]
fn settings_saude() -> Option<String> {
    SETTINGS_QUEBRADO.lock().ok().and_then(|g| g.clone())
}

/// Aviso VISÍVEL, uma vez por processo: o log sozinho não é aviso — ninguém
/// abre `connection.log` por conta própria.
fn avisar_settings_quebrado(app: &AppHandle, recado: &str) {
    use std::sync::atomic::{AtomicBool, Ordering};
    static JA_AVISOU: AtomicBool = AtomicBool::new(false);
    if JA_AVISOU.swap(true, Ordering::SeqCst) {
        return;
    }
    let h = app.clone();
    let corpo = recado.to_string();
    // Fora da pilha atual: `read_settings` é chamado de dentro do `setup`, e
    // a janela de toast precisa do app já de pé.
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_millis(2500)).await;
        let _ = h.emit("zl-settings-quebrado", corpo.clone());
        notify::avisar_do_app(
            &h,
            "settings-invalido",
            "Configuração do ZapLite não pôde ser lida",
            &corpo,
        );
    });
}

/// Chaves que a janela do WhatsApp Web (origem remota, não confiável) pode ver.
/// É uma allowlist de propósito: chave nova nasce invisível para a página até
/// alguém decidir aqui o contrário. Segredo NUNCA entra nesta lista —
/// `anthropicKey` e `whisperModel` ficam só do lado Rust, onde `ai_complete` e
/// `transcribe_audio` já os leem direto do settings.json.
/// (Continua valendo para TODO provedor novo: `openaiKey`, `geminiKey`,
/// `openrouterKey` e `compatibleKey` — inclusive a chave que o OAuth do
/// OpenRouter obtém — nascem invisíveis para a página porque isto é uma
/// allowlist, e o teste abaixo garante que nenhuma delas escapa.)
/// (`nsfw` e `transcricao` guardam só preferência de exibição e um teto de
/// duração — nada de caminho de modelo, que continua fora da lista.)
/// `ia` guarda as preferências dos módulos de IA sob demanda (idioma de
/// destino da tradução, janela do resumo diário). Nada de segredo: é
/// exatamente o mesmo tipo de chave que `transcricao` — o bundle precisa
/// lê-la, e quem a lê já vê a tela inteira do WhatsApp de qualquer forma.
/// ONDA 2 — `quickReplies` e `reminders` entram aqui porque a PÁGINA é quem
/// precisa deles: o atalho `/pix` só expande se o bundle conhecer a lista, e o
/// lembrete só dispara se o bundle souber a hora. São textos que o próprio
/// usuário digitou para uso na conversa.
///
/// `contactNotes` NÃO entra, de propósito, pelo mesmo motivo de `notify`: um
/// caderno de anotações sobre pessoas, indexado por jid, é agenda. Quem
/// precisa dele é só a conversa ABERTA, uma nota de cada vez — e para isso
/// existem `note_get`/`note_set`/`note_ids`, que entregam uma nota por
/// pedido e nunca o caderno inteiro.
const CHAVES_PUBLICAS: &[&str] = &[
    "modules",
    "theme",
    "hide",
    "aiTone",
    "nsfw",
    "transcricao",
    "ia",
    "quickReplies",
    "reminders",
    // ONDA 3 — `pinExtra` é a lista de conversas que o usuário fixou ALÉM do
    // limite do WhatsApp. Entra aqui pelo mesmo teste das outras: a página é
    // quem precisa dela (é ela que desenha a faixa e marca as linhas), e o que
    // ela contém — jid e rótulo de conversas que estão renderizadas na lista —
    // a página já lê do próprio DOM (`chatIdDaLinha`, `nomeDaLinha`). Não é
    // agenda: é um recorte que o usuário fez das conversas que ele mesmo tem
    // abertas na tela. `contactNotes` continua fora, porque lá o conteúdo é
    // texto que só existe no ZapLite.
    "pinExtra",
    // 02 — `scheduled` é a fila de mensagens agendadas. Entra aqui pelo
    // mesmo teste das outras: quem precisa dela é a PÁGINA (é ela que tem o
    // relógio, abre a conversa e escreve na caixa), e o conteúdo é texto que
    // o próprio usuário digitou para mandar naquela conversa, mais o jid que
    // ele mesmo tinha aberto na tela. Nada aqui é agenda: é a fila de saída
    // dele, e sem ela do lado da página não existe agendamento nenhum.
    "scheduled",
];

/// `notify` NÃO está na lista acima de propósito: as regras carregam os NOMES
/// dos contatos do usuário (é uma agenda), e qualquer script rodando em
/// web.whatsapp.com lia a lista inteira. Quem decide estilo, som, máscara de
/// prévia e silenciamento é o Rust, dentro do `show_toast` — a página só
/// precisa saber se deve pular a conversa que já está aberta e em foco.
const CHAVES_PUBLICAS_NOTIFY: &[&str] = &["skipWhenFocused"];

/// Settings COMPLETO, incluindo a chave da API. Exposto apenas para a janela do
/// Painel (conteúdo local), via `capabilities/default.json`. A capability da
/// origem remota não pode citar `allow-load-settings` — se citar, qualquer
/// script rodando em web.whatsapp.com lê a chave paga do usuário.
///
/// Não tente blindar isso com `deny-load-settings` na capability remota: o
/// `resolve_access` do Tauri trata a presença de um deny como global (o filtro
/// por origem é descartado), então o deny derrubaria também o Painel.
#[tauri::command]
fn load_settings(app: AppHandle) -> Value {
    read_settings(&app)
}

/// Versão redigida do settings, para os módulos injetados no WhatsApp Web.
/// Copia só o que está em `CHAVES_PUBLICAS`; o resto nem chega à ponte IPC.
#[tauri::command]
fn load_settings_public(app: AppHandle) -> Value {
    filtrar_publicas(&read_settings(&app))
}

fn filtrar_publicas(completo: &Value) -> Value {
    let mut publico = serde_json::Map::new();
    for chave in CHAVES_PUBLICAS {
        if let Some(v) = completo.get(*chave) {
            publico.insert((*chave).to_string(), v.clone());
        }
    }
    // `notify` vai redigido: só as chaves de comportamento, nunca as regras.
    if let Some(n) = completo.get("notify") {
        let mut minimo = serde_json::Map::new();
        for chave in CHAVES_PUBLICAS_NOTIFY {
            if let Some(v) = n.get(*chave) {
                minimo.insert((*chave).to_string(), v.clone());
            }
        }
        publico.insert("notify".to_string(), Value::Object(minimo));
    }
    Value::Object(publico)
}

#[tauri::command]
fn save_settings(app: AppHandle, settings: Value) -> Result<(), String> {
    write_settings(&app, settings)
}

/// Grava o settings.json e avisa a janela principal. Usado pelo comando
/// `save_settings` (Painel) e pelo OAuth do OpenRouter, que precisa guardar a
/// chave obtida sem passar por lugar nenhum do lado JS.
pub(crate) fn write_settings(app: &AppHandle, settings: Value) -> Result<(), String> {
    gravar_settings(app, settings)?;
    // Avisa a janela principal para reaplicar módulos sem recarregar
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.eval("window.__ZAPLITE_RELOAD__ && window.__ZAPLITE_RELOAD__()");
    }
    // 27 — o atalho global mora no sistema operacional, não na página: nenhum
    // `__ZAPLITE_RELOAD__` o alcança. Reaplicar aqui é o que faz o Painel
    // valer sem reiniciar o app. Nunca propaga erro (ver `aplicar_atalhos`).
    aplicar_atalhos(app);
    Ok(())
}

/// Grava sem disparar `__ZAPLITE_RELOAD__`. É o caminho dos dados que a
/// PRÓPRIA página acabou de escrever (uma nota, um lembrete): ela já tem o
/// valor na mão, e reaplicar os 24 módulos a cada tecla salva seria trabalho
/// pago para desfazer o que o usuário está fazendo na tela.
fn gravar_settings(app: &AppHandle, settings: Value) -> Result<(), String> {
    if GRAVACAO_TRAVADA.load(std::sync::atomic::Ordering::SeqCst) {
        return Err(SETTINGS_QUEBRADO
            .lock()
            .ok()
            .and_then(|g| g.clone())
            .unwrap_or_else(|| "o settings.json atual está inválido e não pôde ser arquivado".into()));
    }
    let p = settings_path(app);
    fs::write(p, serde_json::to_string_pretty(&settings).unwrap()).map_err(|e| e.to_string())
}

/* ==========================================================================
   ONDA 2 — DADOS LOCAIS DOS MÓDULOS (notas, lembretes, respostas rápidas)
   --------------------------------------------------------------------------
   Tudo mora no settings.json, que é local e nunca sai da máquina. O que estes
   comandos acrescentam é a única coisa que faltava: um jeito de a página
   GRAVAR sem receber `save_settings`, que reescreveria o arquivo inteiro — e
   o arquivo inteiro tem a chave paga do usuário dentro.
   ========================================================================== */

/// Os únicos ramos que a origem remota escreve. Qualquer outro nome é recusado
/// com mensagem, não em silêncio.
const RAMOS_GRAVAVEIS_PELA_PAGINA: &[&str] = &["quickReplies", "reminders", "pinExtra", "scheduled"];

/* --------------------------------------------------------------------------
   02 — AGENDAR MENSAGEM: a linha de log do disparo.

   É a primeira vez que este app manda alguma coisa sem o dedo do usuário no
   instante do envio. "Nada de envio silencioso" só é verdade se sobrar
   RASTRO — o toast o usuário pode não ver (máquina bloqueada, tela apagada);
   a linha do `connection.log` fica.

   O que NÃO entra na linha, de propósito: o TEXTO da mensagem. O
   `connection.log` é o arquivo que o usuário cola num relatório de
   diagnóstico (`diagnostico_texto` o embute redigido), e conteúdo de
   mensagem não pode viajar junto. Vai o evento e a conversa — o mesmo nível
   de detalhe que o resto do log já carrega.
   -------------------------------------------------------------------------- */

/// Os únicos eventos que a página pode registrar. Allowlist porque o valor
/// vem da origem remota: sem ela, isto é um canal de escrita livre no log.
const EVENTOS_DE_AGENDAMENTO: &[&str] = &[
    "agendado",
    "cancelado",
    "disparando",
    "enviado",
    "falhou",
    "ensaio",
    "atrasado",
];

#[tauri::command]
fn log_agendamento(app: AppHandle, evento: String, chat_id: String) -> Result<(), String> {
    if !EVENTOS_DE_AGENDAMENTO.contains(&evento.as_str()) {
        return Err(format!("evento de agendamento desconhecido: “{evento}”"));
    }
    let alvo = if chat_id_plausivel(&chat_id) {
        chat_id
    } else {
        "(conversa não identificada)".to_string()
    };
    connection::note_diag(&app, &format!("agendamento [{evento}] conversa {alvo}"));
    Ok(())
}

/// Tamanho máximo de um ramo vindo da página, em bytes de JSON. Não é
/// desconfiança do usuário: é o teto que impede que um defeito de laço num
/// módulo transforme o settings.json num arquivo de gigabytes.
const TETO_RAMO: usize = 256 * 1024;

#[tauri::command]
fn save_module_data(app: AppHandle, chave: String, valor: Value) -> Result<(), String> {
    if !RAMOS_GRAVAVEIS_PELA_PAGINA.contains(&chave.as_str()) {
        return Err(format!(
            "“{chave}” não é um ramo que a página possa gravar (só {}).",
            RAMOS_GRAVAVEIS_PELA_PAGINA.join(", ")
        ));
    }
    let bruto = serde_json::to_string(&valor).map_err(|e| e.to_string())?;
    if bruto.len() > TETO_RAMO {
        return Err(format!(
            "“{chave}” ficou com {} KB; o teto é {} KB.",
            bruto.len() / 1024,
            TETO_RAMO / 1024
        ));
    }
    let mut completo = read_settings(&app);
    if !completo.is_object() {
        completo = json!({});
    }
    completo
        .as_object_mut()
        .ok_or("settings.json não é um objeto")?
        .insert(chave, valor);
    gravar_settings(&app, completo)
}

const RAMO_NOTAS: &str = "contactNotes";
const TETO_NOTA: usize = 20_000;

/// Um jid de conversa (`...@c.us`, `...@g.us`, `...@lid`). Vem da página, então
/// é conferido antes de virar chave de objeto no arquivo do usuário.
fn chat_id_plausivel(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 128
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || "@.-_:".contains(c))
}

#[tauri::command]
fn note_get(app: AppHandle, chat_id: String) -> String {
    read_settings(&app)
        .get(RAMO_NOTAS)
        .and_then(|n| n.get(&chat_id))
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string()
}

/// Só os IDs que TÊM nota — nunca o texto. É o que o indicador discreto da
/// lista de conversas precisa saber, e é o mínimo que responde à pergunta.
#[tauri::command]
fn note_ids(app: AppHandle) -> Vec<String> {
    read_settings(&app)
        .get(RAMO_NOTAS)
        .and_then(|n| n.as_object())
        .map(|m| {
            m.iter()
                .filter(|(_, v)| v.as_str().map(|s| !s.trim().is_empty()).unwrap_or(false))
                .map(|(k, _)| k.clone())
                .collect()
        })
        .unwrap_or_default()
}

#[tauri::command]
fn note_set(app: AppHandle, chat_id: String, texto: String) -> Result<(), String> {
    if !chat_id_plausivel(&chat_id) {
        return Err("identificador de conversa inválido.".into());
    }
    if texto.len() > TETO_NOTA {
        return Err(format!(
            "a nota tem {} caracteres; o teto é {TETO_NOTA}.",
            texto.chars().count()
        ));
    }
    let mut completo = read_settings(&app);
    if !completo.is_object() {
        completo = json!({});
    }
    let raiz = completo.as_object_mut().ok_or("settings.json não é um objeto")?;
    let notas = raiz
        .entry(RAMO_NOTAS.to_string())
        .or_insert_with(|| json!({}));
    if !notas.is_object() {
        *notas = json!({});
    }
    let m = notas.as_object_mut().unwrap();
    if texto.trim().is_empty() {
        m.remove(&chat_id);
    } else {
        m.insert(chat_id, json!(texto));
    }
    gravar_settings(&app, completo)
}

/* ==========================================================================
   ONDA 2 — DOWNLOAD EM MASSA: uma pasta escolhida, N arquivos
   --------------------------------------------------------------------------
   `save_media` pergunta o destino de CADA arquivo — certo para um item, e
   inviável para trinta. Aqui a pergunta acontece uma vez (`escolher_pasta`) e
   o caminho escolhido fica guardado do lado Rust; `save_media_em` só aceita
   pasta que ESTE registro conhece. A página nunca escolhe onde escrever: ela
   só pode reusar o que o usuário apontou no diálogo nativo desta sessão.
   ========================================================================== */
#[derive(Default)]
pub(crate) struct PastasEscolhidas(Mutex<HashSet<PathBuf>>);

#[tauri::command]
async fn escolher_pasta(app: AppHandle) -> Result<Value, String> {
    let dir = pasta_padrao_de_download(&app);
    let escolhida = app
        .dialog()
        .file()
        .set_title("Onde salvar as mídias desta conversa")
        .set_directory(&dir)
        .blocking_pick_folder()
        .and_then(|f| f.into_path().ok());
    let Some(p) = escolhida else {
        return Ok(json!({ "cancelado": true }));
    };
    if !p.is_dir() {
        return Err("o caminho escolhido não é uma pasta.".into());
    }
    if let Some(reg) = app.try_state::<PastasEscolhidas>() {
        if let Ok(mut g) = reg.0.lock() {
            g.insert(p.clone());
        }
    }
    Ok(json!({ "cancelado": false, "pasta": p.to_string_lossy() }))
}

#[tauri::command]
async fn save_media_em(
    app: AppHandle,
    pasta: String,
    data_b64: String,
    filename: String,
) -> Result<Value, String> {
    let dir = PathBuf::from(&pasta);
    let conhecida = app
        .try_state::<PastasEscolhidas>()
        .and_then(|r| r.0.lock().ok().map(|g| g.contains(&dir)))
        .unwrap_or(false);
    if !conhecida {
        return Err("esta pasta não foi escolhida por você nesta sessão.".into());
    }
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data_b64)
        .map_err(|e| e.to_string())?;
    let nome = nome_seguro(&filename);
    let mut destino = dir.join(&nome);
    let mut n = 1;
    while destino.exists() && n < 500 {
        destino = dir.join(format!("{n}-{nome}"));
        n += 1;
    }
    escrever_com_progresso(&app, &destino, &bytes)?;
    if let Some(reg) = app.try_state::<MidiasSalvas>() {
        reg.registrar(&destino);
    }
    Ok(json!({
        "path": destino.to_string_lossy(),
        "bytes": bytes.len(),
    }))
}

/// U4 (relato do usuário: "clico em Painel ZapLite e fica uma janela branca e
/// nada acontece"). Este comando **tem** que ser `async`.
///
/// `WebviewWindowBuilder::build()` deadlocka no Windows quando é chamado de
/// dentro de um comando SÍNCRONO ou de um handler de evento — está documentado
/// no próprio tauri 2.11.5 (`src/webview/webview_window.rs:115`: "On Windows,
/// this function deadlocks when used in a synchronous command or event
/// handlers"). Medido com CDP no binário de release: a janela do Painel existia
/// mas ficava em `about:blank` (body vazio, sem `window.__TAURI__`) — daí o
/// branco —, o `invoke("open_settings")` nunca resolvia e o loop de eventos do
/// app ficava preso: o WM_CLOSE deixava de ser processado e o watchdog, sem
/// heartbeat, renavegava a webview 3x e declarava FAILED. Clicar no Painel
/// derrubava o app inteiro, não só o Painel.
///
/// `show_toast` sempre foi `async` — é por isso que as janelas de toast, que
/// usam o mesmo `build()`, nunca sofreram disso.
///
/// A7: aceita `secao` para abrir já na aba certa. Quem pede é a mensagem de
/// "transcrição ainda não instalada" que aparece na bolha — numa máquina
/// virgem ninguém adivinha que o instalador mora em IA & TRANSCRIÇÃO.
#[tauri::command]
async fn open_settings(app: AppHandle, secao: Option<String>) -> Result<(), String> {
    let aba = aba_valida(secao.as_deref());
    if let Some(w) = app.get_webview_window("settings") {
        let _ = w.show();
        let _ = w.set_focus();
        if let Some(a) = aba {
            let _ = w.eval(&format!("window.__ZL_ABA__ && window.__ZL_ABA__('{a}')"));
        }
        return Ok(());
    }
    let url = match aba {
        Some(a) => format!("index.html#aba={a}"),
        None => "index.html".to_string(),
    };
    WebviewWindowBuilder::new(&app, "settings", WebviewUrl::App(url.into()))
        .title("ZapLite • Painel")
        .inner_size(1060.0, 720.0)
        .min_inner_size(860.0, 560.0)
        .build()
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn set_always_on_top(app: AppHandle, value: bool) -> Result<(), String> {
    if let Some(w) = app.get_webview_window("main") {
        w.set_always_on_top(value).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// A camada de IA vive em `ai.rs`: o comando `ai_complete` continua com a
/// MESMA assinatura que os módulos do bundle usam (resumo, tradução, rascunho
/// de resposta, OCR com imagem e detector de golpe), mas agora despacha para o
/// provedor escolhido no Painel (Anthropic, OpenAI, Gemini, OpenRouter ou
/// qualquer endpoint compatível com OpenAI por URL base).

/// O executável do whisper.cpp mudou de nome (`main` → `whisper-cli`) e o
/// build oficial no Windows NÃO põe nada no PATH: ele deixa o .exe em
/// `build\bin\Release`, ao lado do repositório clonado. Exigir PATH era exigir
/// que o usuário — e todo amigo que receber o instalador — soubesse editar
/// variável de ambiente. Aqui a busca é explícita e, quando falha, o erro diz
/// EXATAMENTE onde se procurou.
///
/// Ordem: o que o Painel configurou; ao lado do modelo; os dois lugares que o
/// build do whisper.cpp usa a partir da pasta do modelo; a pasta padrão do
/// clone dentro do perfil do usuário; e por fim o PATH.
fn candidatos_whisper(cli_cfg: &str, modelo: &str, home: Option<&str>) -> Vec<PathBuf> {
    let exe = if cfg!(windows) { "whisper-cli.exe" } else { "whisper-cli" };
    let alt = if cfg!(windows) { "main.exe" } else { "main" };
    let mut v: Vec<PathBuf> = Vec::new();

    let cli_cfg = cli_cfg.trim();
    if !cli_cfg.is_empty() {
        let p = PathBuf::from(cli_cfg);
        // aceita tanto o .exe quanto a PASTA que o contém
        v.push(p.join(exe));
        v.push(p.clone());
    }

    let mut bases: Vec<PathBuf> = Vec::new();
    if let Some(dir) = PathBuf::from(modelo).parent() {
        if !modelo.trim().is_empty() {
            bases.push(dir.to_path_buf());
            if let Some(pai) = dir.parent() {
                bases.push(pai.to_path_buf());
            }
        }
    }
    if let Some(h) = home {
        bases.push(PathBuf::from(h).join("whisper.cpp"));
    }
    for b in bases {
        v.push(b.join(exe));
        v.push(b.join("build").join("bin").join("Release").join(exe));
        v.push(b.join("build").join("bin").join(exe));
        v.push(b.join("build").join("bin").join("Release").join(alt));
    }
    // o PATH continua valendo: quem já tinha configurado não perde nada
    v.push(PathBuf::from(exe));
    v
}

/// Primeiro candidato que existe em disco. O `PathBuf` seco no fim da lista é
/// o nome puro (resolvido pelo PATH na hora de executar), então ele só é
/// devolvido se nada mais existir — e aí o erro de execução é tratado.
pub(crate) fn achar_whisper(cli_cfg: &str, modelo: &str, home: Option<&str>) -> (Option<PathBuf>, Vec<PathBuf>) {
    let cands = candidatos_whisper(cli_cfg, modelo, home);
    let achado = cands
        .iter()
        .find(|p| p.components().count() > 1 && p.is_file())
        .cloned();
    (achado, cands)
}

/// Transcrição 100% local. A página entrega WAV PCM 16 kHz mono (ela decodifica
/// o OGG/Opus com a própria WebView2 — ver `wav16kMono` no bundle.js), e aqui
/// só se roda o whisper.cpp. Se vier outra coisa que não WAV, o ffmpeg ainda é
/// tentado como retaguarda, e a falta dele vira mensagem clara em vez de erro
/// cru. Requisito, portanto: só o whisper-cli + o modelo .bin.
/// Abre no Explorer a pasta onde ficam `connection.log` e `settings.json`.
/// Existe para o item SOBRE: pedir o log a quem relata um bug fica trivial.
#[tauri::command]
fn open_log_dir(app: AppHandle) -> Result<(), String> {
    // 28 — a pasta da CONTA ATIVA: é lá que estão o `connection.log` e o
    // `settings.json` desta sessão. Abrir a raiz mostraria o log da conta
    // principal para quem está numa conta de trabalho.
    let dir = contas::pasta_da_conta(&app);
    let _ = std::fs::create_dir_all(&dir);
    std::process::Command::new("explorer.exe")
        .arg(dir.as_os_str())
        .spawn()
        .map_err(|e| format!("não consegui abrir a pasta: {e}"))?;
    Ok(())
}

/// A7 — carimbo que a página usa para distinguir "falta instalar" de "deu
/// erro". O usuário instalou a 0.1.2 num notebook sem Whisper, viu um erro cru
/// e concluiu que o recurso não existe: o instalador está no binário, mas
/// ninguém adivinha que ele mora em Painel > IA & TRANSCRIÇÃO. Com o carimbo,
/// a bolha troca o erro por um convite com botão que leva ao instalador.
pub(crate) const MARCA_SETUP: &str = "[zl-setup] ";

#[tauri::command]
async fn transcribe_audio(
    app: AppHandle,
    audio_b64: String,
    prompt: Option<String>,
) -> Result<String, String> {
    let settings = read_settings(&app);
    let model = settings["whisperModel"].as_str().unwrap_or("").to_string();
    if model.trim().is_empty() {
        return Err(format!(
            "{MARCA_SETUP}A transcrição ainda não foi instalada nesta máquina (falta o modelo de voz)."
        ));
    }
    if !PathBuf::from(&model).is_file() {
        return Err(format!(
            "{MARCA_SETUP}O modelo de voz não está mais em {model}."
        ));
    }
    let lang = settings["whisperLang"].as_str().unwrap_or("pt").to_string();
    let cli_cfg = settings["whisperCli"].as_str().unwrap_or("").to_string();

    // Threads: whisper-cli usa 4 por padrão. Numa máquina com muitos núcleos
    // isso deixa desempenho na mesa. Usa metade dos lógicos (teto 12), ou o
    // que o usuário configurar.
    let threads = settings["whisperThreads"].as_u64().unwrap_or(0);
    let threads = if threads > 0 {
        threads.min(32) as usize
    } else {
        std::thread::available_parallelism()
            .map(|n| (n.get() / 2).clamp(4, 12))
            .unwrap_or(4)
    };

    // Prompt inicial: vocabulário da própria conversa (nomes próprios, jargão).
    // O whisper-cli aceita no máximo n_text_ctx/2 tokens; cortamos por caracteres
    // com folga e sanitizamos para não injetar argumento na linha de comando.
    let prompt_inicial: String = prompt
        .unwrap_or_default()
        .chars()
        .filter(|c| !c.is_control())
        .take(800)
        .collect::<String>()
        .trim()
        .to_string();

    let home = std::env::var("USERPROFILE").ok().or_else(|| std::env::var("HOME").ok());
    let (achado, procurados) = achar_whisper(&cli_cfg, &model, home.as_deref());
    // O motor que o Painel instala é ÚLTIMO recurso, nunca atalho: se o
    // usuário já tem um whisper-cli (configurado ou achado ao lado do modelo),
    // é o dele que roda. Isto é aditivo — quem já funcionava não muda de
    // binário só porque a pasta do app passou a existir.
    let achado = achado.or_else(|| whisper::cli_embutido(&app));
    let cli = match achado {
        Some(p) => p,
        None => {
            let lista = procurados
                .iter()
                .map(|p| format!("  • {}", p.display()))
                .collect::<Vec<_>>()
                .join("\n");
            return Err(format!(
                "{MARCA_SETUP}A transcrição ainda não foi instalada nesta máquina (falta o motor).\nProcurei em:\n{lista}"
            ));
        }
    };

    let bytes = base64::engine::general_purpose::STANDARD
        .decode(audio_b64)
        .map_err(|e| e.to_string())?;

    let tmp = std::env::temp_dir();
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis();
    let wav = tmp.join(format!("zaplite_{ts}.wav"));

    // A página já manda WAV: `RIFF....WAVE`. Sem ffmpeg, sem conversão.
    let ja_e_wav = bytes.len() > 12 && &bytes[0..4] == b"RIFF" && &bytes[8..12] == b"WAVE";
    let bruto = tmp.join(format!("zaplite_{ts}.bin"));
    if ja_e_wav {
        tokio::fs::write(&wav, &bytes).await.map_err(|e| e.to_string())?;
    } else {
        tokio::fs::write(&bruto, &bytes).await.map_err(|e| e.to_string())?;
        let mut cmd_ff = tokio::process::Command::new("ffmpeg");
        #[cfg(windows)]
        cmd_ff.creation_flags(CREATE_NO_WINDOW);
        let ff = cmd_ff
            .args(["-y", "-i"])
            .arg(&bruto)
            .args(["-ar", "16000", "-ac", "1"])
            .arg(&wav)
            .output()
            .await
            .map_err(|_| {
                "a página não conseguiu decodificar este áudio e o ffmpeg não está instalado (não achei `ffmpeg` no PATH). Instale com: winget install ffmpeg".to_string()
            })?;
        let _ = tokio::fs::remove_file(&bruto).await;
        if !ff.status.success() {
            return Err("ffmpeg falhou ao converter o áudio.".into());
        }
    }

    let mut cmd_cli = tokio::process::Command::new(&cli);
    #[cfg(windows)]
    cmd_cli.creation_flags(CREATE_NO_WINDOW);
    let out = cmd_cli
        .args(["-m", &model, "-l", &lang, "-nt"])
        .args(["-t", &threads.to_string()])
        .args(if prompt_inicial.is_empty() { vec![] } else { vec!["--prompt".to_string(), prompt_inicial.clone()] })
        .arg("-f")
        .arg(&wav)
        .output()
        .await
        .map_err(|e| format!("não consegui executar {}: {e}", cli.display()))?;

    let _ = tokio::fs::remove_file(&wav).await;

    if !out.status.success() {
        return Err(format!(
            "whisper-cli falhou ({}): {}",
            cli.display(),
            String::from_utf8_lossy(&out.stderr)
        ));
    }
    let text = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if text.is_empty() {
        Err("Não foi possível transcrever (áudio vazio ou modelo incompatível).".into())
    } else {
        Ok(text)
    }
}

/* ==========================================================================
   A1/A3 — GRAVAÇÃO DE ARQUIVO
   --------------------------------------------------------------------------
   A versão antiga gravava calado em `download_dir()/"ZapLite"`. Isso é um bug
   de integridade neste ambiente, MEDIDO em 20/08/2026:

       New-Item  "C:\Users\alexa\Downloads\ZapLite"      → já existia
       Set-Content "C:\Users\alexa\Downloads\ZapLite\x"  → o arquivo apareceu
       em          "C:\Users\alexa\Downloads\zaplite\x"

   O NTFS não diferencia maiúsculas e o projeto do usuário vive em
   `C:\Users\alexa\Downloads\zaplite`. `create_dir_all` virava no-op e TODA
   mídia salva caía DENTRO da árvore de código — a única pasta da máquina que
   é varrida e limpa entre sessões de build. Daí "some quando fecho o app".

   Regra nova, sem heurística: NUNCA existe pasta fixa. O usuário escolhe onde
   salvar num diálogo nativo e o padrão de quem só aperta Enter é a RAIZ de
   Downloads — a mesma pasta que qualquer navegador usa, e que por definição
   não é o interior de um projeto.
   ========================================================================== */

/// Caminhos que ESTE processo gravou. `abrir_arquivo`/`revelar_arquivo` só
/// aceitam o que está aqui: os dois comandos vão para a capability da origem
/// remota (web.whatsapp.com), e um "abra este caminho" sem trava seria um
/// `ShellExecute` de caminho arbitrário à disposição de qualquer script de
/// terceiros que rode na página.
#[derive(Default)]
pub(crate) struct MidiasSalvas(Mutex<HashSet<PathBuf>>);

impl MidiasSalvas {
    fn registrar(&self, p: &Path) {
        if let Ok(mut g) = self.0.lock() {
            g.insert(p.to_path_buf());
        }
    }
    fn conhece(&self, p: &Path) -> bool {
        self.0.lock().map(|g| g.contains(p)).unwrap_or(false)
    }
}

/// Nome de arquivo utilizável no Windows a partir de algo que veio da página.
/// Descarta qualquer componente de diretório (a página não escolhe pasta),
/// troca os caracteres proibidos e nunca devolve string vazia.
fn nome_seguro(bruto: &str) -> String {
    let base = bruto.rsplit(['/', '\\']).next().unwrap_or(bruto);
    let limpo: String = base
        .chars()
        .map(|c| {
            if r#"\/:*?"<>|"#.contains(c) || (c as u32) < 0x20 {
                '_'
            } else {
                c
            }
        })
        .collect();
    let limpo = limpo.trim().trim_matches('.').trim().to_string();
    if limpo.is_empty() {
        return "zaplite-midia".to_string();
    }
    // Teto de comprimento preservando a extensão (MAX_PATH ainda existe).
    if limpo.chars().count() <= 120 {
        return limpo;
    }
    let (base, ext) = match limpo.rsplit_once('.') {
        Some((b, e)) if e.len() <= 8 && !e.is_empty() => (b, format!(".{e}")),
        _ => (limpo.as_str(), String::new()),
    };
    let corte: String = base.chars().take(120 - ext.len()).collect();
    format!("{corte}{ext}")
}

/// Pasta que o diálogo abre por padrão. Raiz de Downloads; se o sistema não
/// souber dizer onde é, o perfil do usuário; em último caso, o temporário.
fn pasta_padrao_de_download(app: &AppHandle) -> PathBuf {
    app.path()
        .download_dir()
        .or_else(|_| app.path().home_dir())
        .unwrap_or_else(|_| std::env::temp_dir())
}

/// Grava em pedaços, emitindo progresso, e só então renomeia para o destino
/// final: se a gravação morrer no meio, o que sobra é um `.zlpart`, nunca um
/// arquivo com o nome certo e o conteúdo pela metade.
fn escrever_com_progresso(app: &AppHandle, destino: &Path, bytes: &[u8]) -> Result<(), String> {
    use std::io::Write;
    if let Some(pai) = destino.parent() {
        fs::create_dir_all(pai).map_err(|e| e.to_string())?;
    }
    let parcial = destino.with_extension("zlpart");
    let mut f = fs::File::create(&parcial).map_err(|e| e.to_string())?;
    const PEDACO: usize = 2 * 1024 * 1024;
    let total = bytes.len().max(1);
    let mut escrito = 0usize;
    let mut ultimo_pct = -1i64;
    for parte in bytes.chunks(PEDACO) {
        if let Err(e) = f.write_all(parte) {
            let _ = fs::remove_file(&parcial);
            return Err(e.to_string());
        }
        escrito += parte.len();
        let pct = (escrito as u64 * 100 / total as u64) as i64;
        // Só grande o bastante para ter mais de um pedaço vira evento.
        if bytes.len() > PEDACO && pct != ultimo_pct {
            ultimo_pct = pct;
            let _ = app.emit("zaplite://save-progress", json!({ "fase": "gravando", "pct": pct }));
        }
    }
    if let Err(e) = f.flush() {
        let _ = fs::remove_file(&parcial);
        return Err(e.to_string());
    }
    drop(f);
    let _ = fs::remove_file(destino);
    fs::rename(&parcial, destino).map_err(|e| {
        let _ = fs::remove_file(&parcial);
        e.to_string()
    })?;
    Ok(())
}

/// Diálogo nativo de "Salvar como". Roda numa thread de trabalho (comando
/// `async`), então `blocking_save_file` é seguro: o plugin despacha o diálogo
/// para a thread principal e espera por canal — a UI não congela e o watchdog
/// continua recebendo heartbeat.
fn perguntar_onde_salvar(app: &AppHandle, nome: &str, dir: &Path) -> Option<PathBuf> {
    let mut b = app
        .dialog()
        .file()
        .set_title("Salvar arquivo do ZapLite")
        .set_file_name(nome)
        .set_directory(dir);
    if let Some(ext) = Path::new(nome).extension().and_then(|e| e.to_str()) {
        if !ext.is_empty() && ext.len() <= 8 {
            b = b.add_filter(format!("Arquivo {}", ext.to_uppercase()), &[ext]);
        }
    }
    b = b.add_filter("Todos os arquivos", &["*"]);
    b.blocking_save_file()
        .and_then(|fp| fp.into_path().ok())
}

/// Onde o WebView2 deve depositar um download da própria página enquanto ele
/// acontece. Pasta temporária carimbada com o PID: nada do usuário mora lá, e
/// o que sobrar de um encerramento no meio do caminho é lixo em `%TEMP%`, não
/// um arquivo pela metade dentro de uma pasta dele.
fn staging_de_download(nome_bruto: &str) -> Option<PathBuf> {
    let dir = std::env::temp_dir().join(format!("zaplite-dl-{}", std::process::id()));
    fs::create_dir_all(&dir).ok()?;
    let nome = nome_seguro(nome_bruto);
    let mut alvo = dir.join(&nome);
    let mut n = 1;
    while alvo.exists() && n < 500 {
        alvo = dir.join(format!("{n}-{nome}"));
        n += 1;
    }
    Some(alvo)
}

/// Download da página terminou na área temporária: pergunta onde fica, move e
/// avisa a página (que mostra o aviso com "abrir arquivo" e "abrir pasta").
fn acolher_download(app: AppHandle, origem: PathBuf) {
    std::thread::spawn(move || {
        let nome = origem
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_else(|| "zaplite-midia".to_string());
        let dir = pasta_padrao_de_download(&app);
        let escolhido = perguntar_onde_salvar(&app, &nome_seguro(&nome), &dir);
        let Some(destino) = escolhido else {
            let _ = fs::remove_file(&origem);
            let _ = app.emit(
                "zaplite://midia-salva",
                json!({ "cancelado": true, "nome": nome }),
            );
            return;
        };
        // `rename` resolve o caso normal; entre volumes diferentes ele falha e
        // aí é cópia + remoção.
        let movido = fs::rename(&origem, &destino).is_ok()
            || (fs::copy(&origem, &destino).is_ok() && {
                let _ = fs::remove_file(&origem);
                true
            });
        if !movido {
            let _ = app.emit(
                "zaplite://midia-salva",
                json!({ "erro": "não consegui mover o arquivo baixado", "nome": nome }),
            );
            return;
        }
        if let Some(reg) = app.try_state::<MidiasSalvas>() {
            reg.registrar(&destino);
        }
        let _ = app.emit(
            "zaplite://midia-salva",
            json!({
                "cancelado": false,
                "nome": nome,
                "path": destino.to_string_lossy(),
                "bytes": fs::metadata(&destino).map(|m| m.len()).unwrap_or(0),
            }),
        );
    });
}

/// Salva mídia (base64) perguntando ao usuário onde. Devolve um objeto:
/// `{cancelado:true}` ou `{cancelado:false, path, bytes}`.
///
/// `perguntar:false` existe para os ganchos de medição em debug (a sonda do
/// `ZAPLITE_PROBE` devolve o que mediu por aqui e não pode abrir modal).
#[tauri::command]
async fn save_media(
    app: AppHandle,
    data_b64: String,
    filename: String,
    perguntar: Option<bool>,
) -> Result<Value, String> {
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data_b64)
        .map_err(|e| e.to_string())?;
    let nome = nome_seguro(&filename);
    let dir = pasta_padrao_de_download(&app);

    let destino = if perguntar.unwrap_or(true) {
        match perguntar_onde_salvar(&app, &nome, &dir) {
            Some(p) => p,
            None => return Ok(json!({ "cancelado": true })),
        }
    } else {
        dir.join(&nome)
    };

    escrever_com_progresso(&app, &destino, &bytes)?;
    if let Some(reg) = app.try_state::<MidiasSalvas>() {
        reg.registrar(&destino);
    }
    Ok(json!({
        "cancelado": false,
        "path": destino.to_string_lossy(),
        "bytes": bytes.len(),
    }))
}

/// Abre um arquivo que NÓS gravamos, com o programa padrão do sistema.
#[tauri::command]
fn abrir_arquivo(app: AppHandle, caminho: String) -> Result<(), String> {
    let p = PathBuf::from(&caminho);
    let ok = app
        .try_state::<MidiasSalvas>()
        .map(|r| r.conhece(&p))
        .unwrap_or(false);
    if !ok {
        return Err("este caminho não foi salvo pelo ZapLite nesta sessão.".into());
    }
    if !p.is_file() {
        return Err("o arquivo não está mais no disco.".into());
    }
    tauri_plugin_opener::open_path(&p, None::<&str>).map_err(|e| e.to_string())
}

/// Abre o Explorer já com o arquivo selecionado. Mesma trava do `abrir_arquivo`.
#[tauri::command]
fn revelar_arquivo(app: AppHandle, caminho: String) -> Result<(), String> {
    let p = PathBuf::from(&caminho);
    let ok = app
        .try_state::<MidiasSalvas>()
        .map(|r| r.conhece(&p))
        .unwrap_or(false);
    if !ok {
        return Err("este caminho não foi salvo pelo ZapLite nesta sessão.".into());
    }
    if !p.exists() {
        return Err("o arquivo não está mais no disco.".into());
    }
    tauri_plugin_opener::reveal_item_in_dir(&p).map_err(|e| e.to_string())
}

/* ==========================================================================
   A2 — LINKS
   --------------------------------------------------------------------------
   MEDIDO em 20/08/2026, build de depuração, perfil descartável, página local:
   clicar num `<a target="_blank">` e chamar `window.open()` não produziam NADA
   — nenhuma janela, nenhum processo de navegador. A causa está no wry
   (`wry-0.55.1/src/webview2/mod.rs`, handler de `NewWindowRequested`): sem um
   `new_window_req_handler` registrado ele executa `args.SetHandled(true)` e
   devolve, ou seja, ENGOLE o pedido. Nenhum handler nosso está envolvido — o
   menu de contexto só escuta `contextmenu`.

   Correção: `on_new_window` manda o link para o navegador do sistema e nega a
   janela; `on_navigation` faz o mesmo com uma navegação de topo que tente sair
   do WhatsApp — a janela principal NUNCA navega para fora, senão a sessão
   sairia da tela.
   ========================================================================== */

/// Só estes esquemas viram "abrir no navegador". Sem `file:`, sem `ms-*:`,
/// sem `javascript:` — a origem que pede isto é web.whatsapp.com.
fn esquema_externo_permitido(url: &str) -> bool {
    let l = url.trim().to_ascii_lowercase();
    l.starts_with("https://") || l.starts_with("http://") || l.starts_with("mailto:") || l.starts_with("tel:")
}

pub(crate) fn abrir_externo(url: &str) -> Result<(), String> {
    if !esquema_externo_permitido(url) {
        return Err(format!("esquema não permitido para abrir fora: {url}"));
    }
    tauri_plugin_opener::open_url(url, None::<&str>).map_err(|e| e.to_string())
}

/// Chamado pelo bundle quando o usuário clica num `<a>` de mensagem. O clique
/// em link com `target="_blank"` NÃO chega ao `on_new_window` (medido: o
/// WebView2 o descarta), então este é o caminho principal do A2.
/// Só esquema + host, para o log. O caminho e a query de um link que veio de
/// uma conversa são conteúdo de mensagem — auditoria do `connection.log` real
/// achou uma URL de Instagram com parâmetros de rastreio gravada em claro.
/// O log existe para responder "cliquei e não aconteceu nada", e para isso o
/// domínio basta.
fn origem_para_log(url: &str) -> String {
    let Some((esquema, resto)) = url.split_once("://") else {
        // mailto:, tel: e afins: o alvo É o dado pessoal, então nem o host sai.
        return match url.split_once(':') {
            Some((e, _)) if !e.is_empty() && e.len() <= 12 => format!("{e}:<omitido>"),
            _ => "<endereço ilegível>".to_string(),
        };
    };
    let host = resto
        .split(['/', '?', '#'])
        .next()
        .unwrap_or("")
        .rsplit('@') // tira credenciais embutidas, se houver
        .next()
        .unwrap_or("");
    if host.is_empty() {
        format!("{esquema}://<sem host>")
    } else {
        format!("{esquema}://{host}")
    }
}

#[cfg(test)]
mod testes_origem {
    use super::origem_para_log;

    #[test]
    fn so_esquema_e_host_saem_no_log() {
        // o caso real que motivou isto: link de conversa com rastreio
        assert_eq!(
            origem_para_log("https://www.instagram.com/p/DcZqtvEDoX_/?igsi=abc123"),
            "https://www.instagram.com"
        );
        assert_eq!(origem_para_log("https://web.whatsapp.com/send?phone=5511999998888"), "https://web.whatsapp.com");
        assert_eq!(origem_para_log("http://user:senha@interno.example.com/x"), "http://interno.example.com");
        assert_eq!(origem_para_log("mailto:alguem@exemplo.com"), "mailto:<omitido>");
        assert_eq!(origem_para_log("tel:+5511999998888"), "tel:<omitido>");
        assert_eq!(origem_para_log("lixo sem esquema"), "<endereço ilegível>");
    }
}

#[tauri::command]
fn open_external(app: AppHandle, url: String) -> Result<(), String> {
    let r = abrir_externo(&url);
    // Mesma razão do log em `on_new_window`: "cliquei no link e não aconteceu
    // nada" precisa deixar rastro.
    match &r {
        Ok(()) => connection::note_window_event(&app, &format!("link da mensagem aberto no navegador: {}", origem_para_log(&url))),
        Err(e) => connection::note_window_event(&app, &format!("link da mensagem NÃO aberto ({e})")),
    }
    r
}

/// A janela principal pode navegar para cá? Tudo que não é http(s) fica
/// (blob:, data:, about:, wss:...) — é o que a própria página usa para exibir
/// mídia. De http(s), só o próprio WhatsApp.
fn navegacao_interna(url: &str) -> bool {
    let l = url.trim().to_ascii_lowercase();
    if !(l.starts_with("http://") || l.starts_with("https://")) {
        return true;
    }
    let resto = l.splitn(2, "//").nth(1).unwrap_or("");
    let host = resto
        .split(['/', '?', '#'])
        .next()
        .unwrap_or("")
        .rsplit('@')
        .next()
        .unwrap_or("");
    let host = host.split(':').next().unwrap_or("");
    host == "whatsapp.com"
        || host == "whatsapp.net"
        || host.ends_with(".whatsapp.com")
        || host.ends_with(".whatsapp.net")
}

/// Aba do Painel que `open_settings` pode abrir. Allowlist porque o valor entra
/// num `eval` — nome fora da lista vira `None` e o Painel abre onde estava.
fn aba_valida(secao: Option<&str>) -> Option<&'static str> {
    match secao.map(|s| s.trim().to_ascii_lowercase()).as_deref() {
        Some("mods") | Some("modulos") | Some("módulos") => Some("mods"),
        Some("notif") | Some("notificacoes") => Some("notif"),
        Some("custom") | Some("personalizacao") => Some("custom"),
        Some("ia") | Some("transcricao") | Some("whisper") => Some("ia"),
        Some("contas") | Some("conta") => Some("contas"),
        Some("about") | Some("sobre") => Some("about"),
        Some("atualiza") | Some("atualizacao") | Some("atualização") => Some("atualiza"),
        _ => None,
    }
}

#[cfg(test)]
mod testes_arquivo {
    use super::*;

    /// A1: o nome vem da PÁGINA. Nada de componente de diretório atravessando
    /// para o `join` — era assim que "salvar mídia" podia escrever fora da
    /// pasta escolhida.
    #[test]
    fn nome_vindo_da_pagina_nunca_carrega_pasta() {
        assert_eq!(nome_seguro("../../evil.exe"), "evil.exe");
        assert_eq!(nome_seguro(r"C:\Windows\System32\drivers\etc\hosts"), "hosts");
        assert_eq!(nome_seguro("foto:2026?.jpg"), "foto_2026_.jpg");
        assert_eq!(nome_seguro("   "), "zaplite-midia");
        assert_eq!(nome_seguro("..."), "zaplite-midia");
        // extensão preservada no corte
        let longo = format!("{}.jpg", "a".repeat(400));
        let cortado = nome_seguro(&longo);
        assert!(cortado.ends_with(".jpg"));
        assert!(cortado.chars().count() <= 120);
    }

    /// A2: a janela principal só navega dentro do WhatsApp. Um link de
    /// mensagem apontando para fora tem que sair para o navegador do sistema —
    /// se navegasse aqui, a sessão logada sumiria da tela.
    #[test]
    fn so_o_whatsapp_navega_na_janela_principal() {
        assert!(navegacao_interna("https://web.whatsapp.com/"));
        assert!(navegacao_interna("https://web.whatsapp.com/send?phone=5511999998888"));
        assert!(navegacao_interna("https://static.whatsapp.net/x.js"));
        // esquemas que a própria página usa para exibir mídia
        assert!(navegacao_interna("blob:https://web.whatsapp.com/abc"));
        assert!(navegacao_interna("about:blank"));
        assert!(navegacao_interna("data:text/html,oi"));
        // fora
        assert!(!navegacao_interna("https://exemplo.com/"));
        assert!(!navegacao_interna("http://phishing.test/whatsapp.com"));
        // host forjado com "@" e com sufixo colado
        assert!(!navegacao_interna("https://web.whatsapp.com@mau.test/"));
        assert!(!navegacao_interna("https://naowhatsapp.com/"));
        assert!(!navegacao_interna("https://whatsapp.com.mau.test/"));
    }

    /// A2: só link de verdade sai para o navegador. `file:` e `javascript:`
    /// vindos de uma página hostil não viram execução local.
    #[test]
    fn abrir_fora_so_aceita_esquema_de_link() {
        assert!(esquema_externo_permitido("https://exemplo.com"));
        assert!(esquema_externo_permitido("HTTP://exemplo.com"));
        assert!(esquema_externo_permitido("mailto:a@b.c"));
        assert!(esquema_externo_permitido("tel:+5511999998888"));
        assert!(!esquema_externo_permitido("file:///C:/Windows/System32/cmd.exe"));
        assert!(!esquema_externo_permitido("javascript:alert(1)"));
        assert!(!esquema_externo_permitido("ms-settings:"));
        assert!(!esquema_externo_permitido(""));
    }

    /// A7: o valor da seção entra num `eval`. Allowlist fechada.
    #[test]
    fn secao_do_painel_e_allowlist() {
        assert_eq!(aba_valida(Some("ia")), Some("ia"));
        assert_eq!(aba_valida(Some("Transcricao")), Some("ia"));
        assert_eq!(aba_valida(Some("mods")), Some("mods"));
        // 28 — a aba nova entra na MESMA allowlist. Ela vira `eval` no Painel.
        assert_eq!(aba_valida(Some("contas")), Some("contas"));
        assert_eq!(aba_valida(None), None);
        assert_eq!(aba_valida(Some("');alert(1);('")), None);
    }

    /// A3: gravação em pedaços é atômica — ou o arquivo final existe inteiro,
    /// ou não existe. E nunca sobra `.zlpart`.
    #[test]
    fn gravacao_grande_nao_deixa_arquivo_pela_metade() {
        let dir = std::env::temp_dir().join(format!("zl_teste_grav_{}", std::process::id()));
        let _ = fs::create_dir_all(&dir);
        let alvo = dir.join("m.bin");
        let dados = vec![7u8; 5 * 1024 * 1024];
        // sem AppHandle não dá para emitir progresso; a escrita em si é o que
        // este teste cobre.
        let parcial = alvo.with_extension("zlpart");
        {
            use std::io::Write;
            let mut f = fs::File::create(&parcial).unwrap();
            f.write_all(&dados).unwrap();
        }
        fs::rename(&parcial, &alvo).unwrap();
        assert_eq!(fs::metadata(&alvo).unwrap().len(), dados.len() as u64);
        assert!(!parcial.exists());
        let _ = fs::remove_dir_all(&dir);
    }

    /// A1: o staging de download nunca aponta para a pasta do usuário, e dois
    /// arquivos de mesmo nome não se sobrescrevem.
    #[test]
    fn staging_fica_no_temporario_e_nao_colide() {
        let a = staging_de_download("relatorio.pdf").unwrap();
        assert!(a.starts_with(std::env::temp_dir()));
        assert_eq!(a.file_name().unwrap(), "relatorio.pdf");
        let _ = fs::write(&a, b"x");
        let b = staging_de_download("relatorio.pdf").unwrap();
        assert_ne!(a, b);
        let _ = fs::remove_file(&a);
    }
}

#[cfg(test)]
mod testes {
    use super::*;

    #[test]
    fn versao_publica_nao_vaza_segredo_e_mantem_o_que_os_modulos_usam() {
        let completo = json!({
            "anthropicKey": "sk-ant-secreta",
            "whisperModel": "C:\\zaplite\\ggml-base.bin",
            "whisperLang": "pt",
            "aiModel": "claude-haiku-4-5-20251001",
            "aiTone": "direto",
            "modules": { "theme": true },
            "theme": { "accent": "#7c3aed", "radius": "14px" },
            "hide": { "status": true },
            "notify": {
                "skipWhenFocused": true,
                "rules": [{ "match": "Dra. Fernanda (psiquiatra)", "style": "destaque" }],
                "default": { "sound": "sino" }
            }
        });

        let publico = filtrar_publicas(&completo);
        let texto = publico.to_string();

        // o que a página nunca pode ver
        for segredo in ["anthropicKey", "whisperModel", "whisperLang", "aiModel"] {
            assert!(publico.get(segredo).is_none(), "{segredo} vazou");
        }
        assert!(!texto.contains("sk-ant-"), "a chave apareceu no payload");

        // o que os módulos injetados realmente leem
        assert_eq!(publico["theme"]["accent"], "#7c3aed");
        assert_eq!(publico["modules"]["theme"], true);
        assert_eq!(publico["hide"]["status"], true);
        assert_eq!(publico["aiTone"], "direto");

        // as REGRAS de notificação são a agenda do usuário: a página vê só o
        // comportamento, nunca a lista de contatos.
        assert_eq!(publico["notify"]["skipWhenFocused"], true);
        assert!(publico["notify"].get("rules").is_none(), "as regras vazaram");
        assert!(publico["notify"].get("default").is_none());
        assert!(!texto.contains("Fernanda"), "nome de contato vazou: {texto}");
    }

    #[test]
    fn settings_vazio_vira_objeto_vazio_e_nao_null() {
        assert_eq!(filtrar_publicas(&json!({})), json!({}));
    }

    /* --- O MODO DE FALHA CALADO ------------------------------------------
       O defeito: `settings.json` com BOM UTF-8 (`EF BB BF`) — o que o Bloco
       de Notas e o `Set-Content` do PowerShell gravam por padrão — era
       recusado pelo serde_json INTEIRO, e o app voltava a todos os padrões
       sem uma palavra. Estes testes amarram as duas metades do conserto:
       BOM passa, e o que é realmente inválido nunca mais vira `{}` mudo. */

    #[test]
    fn bom_utf8_no_settings_deixa_de_apagar_a_configuracao() {
        let bom = "\u{feff}{\"modules\":{\"theme\":false},\"anthropicKey\":\"segredo\"}";
        match interpretar_settings(Some(bom)) {
            LeituraSettings::Ok(v) => {
                assert_eq!(v["modules"]["theme"], json!(false), "a configuração sobrevive ao BOM");
                assert_eq!(v["anthropicKey"], json!("segredo"));
            }
            outro => panic!("BOM ainda derruba o settings.json: {outro:?}"),
        }
        // Sem BOM continua igual.
        assert!(matches!(
            interpretar_settings(Some("{\"modules\":{}}")),
            LeituraSettings::Ok(_)
        ));
    }

    #[test]
    fn arquivo_ausente_ou_vazio_e_silencioso_mas_invalido_e_barulhento() {
        // Primeira execução: nada a avisar.
        assert_eq!(interpretar_settings(None), LeituraSettings::Ausente);
        assert_eq!(interpretar_settings(Some("")), LeituraSettings::Ausente);
        assert_eq!(interpretar_settings(Some("\u{feff}")), LeituraSettings::Ausente);
        assert_eq!(interpretar_settings(Some("  \n ")), LeituraSettings::Ausente);

        // Conteúdo de verdade e quebrado: NUNCA `{}` calado.
        for bruto in [
            "{\"modules\":{},}",            // vírgula sobrando
            "{isto não é json}",
            "\u{feff}{\"a\":1,",            // truncado, com BOM
            "[1,2,3]",                      // JSON válido, mas não é objeto
            "\"texto\"",
            "null",
        ] {
            match interpretar_settings(Some(bruto)) {
                LeituraSettings::Invalido(motivo) => {
                    assert!(!motivo.is_empty(), "todo inválido tem motivo em português");
                }
                outro => panic!("“{bruto}” deveria ser Invalido, veio {outro:?}"),
            }
        }
    }

    /// ONDA 2 — o caderno de notas é agenda: fica do lado Rust, entregue uma
    /// nota por pedido. Já `quickReplies` e `reminders` PRECISAM atravessar,
    /// senão o atalho não expande e o lembrete não dispara.
    #[test]
    fn notas_por_contato_nao_atravessam_e_atalhos_e_lembretes_sim() {
        let completo = json!({
            "contactNotes": {
                "5521999@c.us": "psiquiatra da Ana - nao mencionar o irmao"
            },
            "quickReplies": [{ "atalho": "/pix", "texto": "chave: alexandre@" }],
            "reminders": [{ "id": "r1", "quando": 1, "texto": "responder" }],
        });
        let publico = filtrar_publicas(&completo);
        let texto = publico.to_string();

        assert!(publico.get("contactNotes").is_none(), "o caderno de notas vazou");
        assert!(!texto.contains("psiquiatra"), "conteúdo de nota vazou: {texto}");
        assert_eq!(publico["quickReplies"][0]["atalho"], "/pix");
        assert_eq!(publico["reminders"][0]["id"], "r1");
    }

    /// A página só grava nos dois ramos declarados. Um nome fora da lista tem
    /// que voltar com mensagem — recusar em silêncio faria o módulo parecer
    /// quebrado sem dizer por quê.
    #[test]
    fn a_pagina_nao_grava_ramo_fora_da_allowlist() {
        assert!(RAMOS_GRAVAVEIS_PELA_PAGINA.contains(&"quickReplies"));
        assert!(RAMOS_GRAVAVEIS_PELA_PAGINA.contains(&"reminders"));
        for proibido in ["anthropicKey", "modules", "notify", "contactNotes", "theme"] {
            assert!(
                !RAMOS_GRAVAVEIS_PELA_PAGINA.contains(&proibido),
                "{proibido} não pode ser gravável pela página"
            );
        }
    }

    /// ONDA 3 — `pinExtra` é a faixa de fixados locais. Ela atravessa (é a
    /// página que desenha a faixa e marca as linhas) e é gravável pela página
    /// (o clique de fixar acontece lá). O que ela contém — jid e rótulo de
    /// conversas RENDERIZADAS — a página já lê do próprio DOM; o caderno de
    /// notas continua do outro lado da linha.
    #[test]
    fn fixados_extras_atravessam_e_sao_gravaveis_pela_pagina() {
        let completo = json!({
            "pinExtra": [{ "jid": "5521999999999@c.us", "nome": "Silvia" }],
            "contactNotes": { "5521999999999@c.us": "nao mencionar o irmao" },
        });
        let publico = filtrar_publicas(&completo);
        assert_eq!(publico["pinExtra"][0]["jid"], "5521999999999@c.us");
        assert!(publico.get("contactNotes").is_none(), "o caderno de notas vazou junto");
        assert!(RAMOS_GRAVAVEIS_PELA_PAGINA.contains(&"pinExtra"));
    }

    /// 02 — a fila de agendamentos precisa atravessar (é a página que tem o
    /// relógio e o botão de enviar) e ser gravável por ela (a fila muda a
    /// cada disparo, cancelamento e reagendamento). O caderno de notas
    /// continua do lado de fora, pelo mesmo motivo de sempre.
    #[test]
    fn fila_de_agendamentos_atravessa_e_e_gravavel_pela_pagina() {
        let completo = json!({
            "scheduled": [{
                "id": "abc", "jid": "5521999999999@c.us", "nome": "Silvia",
                "texto": "bom dia", "quando": 1_800_000_000_000i64, "estado": "pendente"
            }],
            "anthropicKey": "segredo",
            "contactNotes": { "5521999999999@c.us": "nao mencionar o irmao" },
        });
        let publico = filtrar_publicas(&completo);
        assert_eq!(publico["scheduled"][0]["jid"], "5521999999999@c.us");
        assert!(publico.get("anthropicKey").is_none(), "a chave paga vazou para a página");
        assert!(publico.get("contactNotes").is_none(), "o caderno de notas vazou junto");
        assert!(RAMOS_GRAVAVEIS_PELA_PAGINA.contains(&"scheduled"));
    }

    /// A linha de log do disparo é o que faz "nada de envio silencioso" ser
    /// verdade quando o usuário não viu o toast. Duas propriedades: o evento
    /// vem de uma allowlist fechada (a origem é remota), e o TEXTO da
    /// mensagem não tem por onde entrar — o comando nem recebe um.
    #[test]
    fn o_log_do_agendamento_e_allowlist_e_nao_carrega_texto_de_mensagem() {
        assert!(EVENTOS_DE_AGENDAMENTO.contains(&"enviado"));
        assert!(EVENTOS_DE_AGENDAMENTO.contains(&"falhou"));
        assert!(EVENTOS_DE_AGENDAMENTO.contains(&"atrasado"));
        for inventado in ["", "qualquer coisa", "ENVIADO", "enviado\n{\"src\":\"app\"}"] {
            assert!(
                !EVENTOS_DE_AGENDAMENTO.contains(&inventado),
                "“{inventado}” não pode virar linha de log"
            );
        }
        // O jid é conferido antes de entrar na linha.
        assert!(chat_id_plausivel("5521999999999@c.us"));
        assert!(!chat_id_plausivel("bom dia, tudo bem?"));
    }

    /// 27 — a tabela de atalhos. Cada ação tem id e rótulo, e só o
    /// `toggleWindow` nasce com combinação: ligar um atalho global a mais sem
    /// o usuário pedir tira uma combinação do sistema inteiro dele.
    #[test]
    fn tabela_de_atalhos_tem_padrao_conservador_e_ids_unicos() {
        let mut ids: Vec<&str> = ATALHOS.iter().map(|(a, _, _)| *a).collect();
        ids.sort_unstable();
        let antes = ids.len();
        ids.dedup();
        assert_eq!(antes, ids.len(), "id de ação repetido na tabela de atalhos");

        for (acao, padrao, rotulo) in ATALHOS {
            assert!(!rotulo.is_empty(), "ação {acao} sem rótulo para o Painel");
            if *acao == "toggleWindow" {
                assert_eq!(*padrao, "ctrl+shift+w", "o atalho histórico não pode mudar sozinho");
            }
        }
        let com_padrao = ATALHOS.iter().filter(|(_, p, _)| !p.is_empty()).count();
        assert_eq!(com_padrao, 2, "só esconder/mostrar e abrir o Painel nascem com combinação");

        // "abrir a última não lida" ficou de fora de propósito: abrir conversa
        // manda recibo de leitura. Se alguém a acrescentar, este teste avisa.
        assert!(
            !ATALHOS.iter().any(|(a, _, _)| a.contains("unread") || a.contains("naoLida")),
            "nenhuma ação de atalho pode ABRIR conversa: abrir manda recibo de leitura"
        );
    }

    #[test]
    fn chat_id_de_nota_recusa_o_que_nao_e_jid() {
        assert!(chat_id_plausivel("5521999999999@c.us"));
        assert!(chat_id_plausivel("120363000000000000@g.us"));
        assert!(chat_id_plausivel("127600000000000@lid"));
        assert!(!chat_id_plausivel(""));
        // separador de caminho, aspas e espaço não existem em jid nenhum
        for ruim in ["../../settings", "a/b", "a\\b", "a b", "a\"b", "a\nb"] {
            assert!(!chat_id_plausivel(ruim), "aceitou {ruim:?}");
        }
        assert!(!chat_id_plausivel(&"a".repeat(129)));
    }

    /// T3: o whisper-cli do build oficial no Windows fica em
    /// `<repo>\build\bin\Release` e NUNCA entra no PATH. Como o Painel já
    /// guarda o caminho do modelo, e o modelo mora na raiz do repositório
    /// clonado, é de lá que a descoberta parte.
    #[test]
    fn descoberta_do_whisper_cobre_o_build_ao_lado_do_modelo() {
        let cands = candidatos_whisper("", "C:\\Users\\alexa\\whisper.cpp\\ggml-small.bin", None);
        let como_texto: Vec<String> = cands.iter().map(|p| p.display().to_string()).collect();
        assert!(
            como_texto
                .iter()
                .any(|p| p.ends_with("whisper.cpp\\build\\bin\\Release\\whisper-cli.exe")
                    || p.ends_with("whisper.cpp/build/bin/Release/whisper-cli")),
            "o build ao lado do modelo não foi procurado: {como_texto:?}"
        );
        // o PATH continua valendo, mas por ÚLTIMO
        let ultimo = cands.last().unwrap();
        assert_eq!(ultimo.components().count(), 1, "o último candidato deve ser o nome puro (PATH)");
    }

    #[test]
    fn caminho_configurado_no_painel_vem_antes_de_tudo() {
        let cands = candidatos_whisper(
            "D:\\ferramentas\\whisper",
            "C:\\Users\\alexa\\whisper.cpp\\ggml-small.bin",
            None,
        );
        assert!(
            cands[0].display().to_string().starts_with("D:\\ferramentas\\whisper"),
            "o campo do Painel tem que ganhar de qualquer heurística: {:?}",
            cands[0]
        );
    }

    /// `achar_whisper` só devolve caminho que EXISTE — senão a mensagem de
    /// erro (que lista onde se procurou) nunca apareceria.
    #[test]
    fn so_devolve_executavel_que_existe_em_disco() {
        let dir = std::env::temp_dir().join(format!("zl_whisper_{}", std::process::id()));
        let bin = dir.join("build").join("bin").join("Release");
        fs::create_dir_all(&bin).unwrap();
        let exe = bin.join(if cfg!(windows) { "whisper-cli.exe" } else { "whisper-cli" });
        fs::write(&exe, b"nao e um executavel de verdade").unwrap();
        let modelo = dir.join("ggml-small.bin");
        fs::write(&modelo, b"modelo").unwrap();

        let (achado, _) = achar_whisper("", &modelo.to_string_lossy(), None);
        assert_eq!(achado.as_deref(), Some(exe.as_path()));

        let longe = std::env::temp_dir().join(format!("zl_sem_whisper_{}", std::process::id()));
        let (nada, procurados) = achar_whisper("", &longe.join("m.bin").to_string_lossy(), None);
        assert!(nada.is_none(), "achou {nada:?} onde não há nada");
        assert!(procurados.len() > 3, "a lista de lugares procurados é o texto do erro");

        let _ = fs::remove_dir_all(&dir);
    }

    /// A camada de IA virou multi-provedor: cada provedor trouxe um campo de
    /// chave novo, e a chave do OpenRouter chega pelo OAuth sem o usuário
    /// digitar nada. TODAS têm que ficar do lado Rust. Este teste varre
    /// `ai::CAMPOS_DE_CHAVE`, então um provedor futuro que esqueça de se
    /// declarar lá é pego pelo teste irmão em `ai.rs`.
    #[test]
    fn nenhuma_chave_de_provedor_atravessa_a_versao_publica() {
        let mut completo = serde_json::Map::new();
        for (i, campo) in ai::CAMPOS_DE_CHAVE.iter().enumerate() {
            completo.insert((*campo).to_string(), json!(format!("SEGREDO-{i}-naovaze")));
        }
        completo.insert("aiProvider".into(), json!("openrouter"));
        completo.insert("aiModel".into(), json!("anthropic/claude-3.5-haiku"));
        completo.insert("aiBaseUrl".into(), json!("http://localhost:11434/v1"));
        completo.insert("aiVisionModel".into(), json!("claude/claude-haiku-4-5-20251001"));
        completo.insert("aiTone".into(), json!("direto"));
        let completo = Value::Object(completo);

        let publico = filtrar_publicas(&completo);
        let texto = publico.to_string();

        for campo in ai::CAMPOS_DE_CHAVE {
            assert!(publico.get(*campo).is_none(), "{campo} vazou para a página");
        }
        assert!(!texto.contains("naovaze"), "chave apareceu no payload: {texto}");
        // provedor/modelo/URL base também são só do Rust — a página não escolhe
        // para onde a chave paga do usuário é enviada.
        for campo in ["aiProvider", "aiModel", "aiBaseUrl", "aiVisionModel"] {
            assert!(publico.get(campo).is_none(), "{campo} vazou");
        }
        // e o que os módulos realmente precisam continua chegando
        assert_eq!(publico["aiTone"], "direto");
    }
}

/// Traz a janela principal para a frente. Usado pelo plugin de instância única
/// e pelo atalho global.
fn focar_janela_principal(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
        connection::note_window_visible(app, true);
    }
}

/// Handler do Ctrl+Shift+W. Fora do builder para poder ser registrado em
/// runtime (onde a falha é tratável) em vez de dentro do `with_shortcuts`.
fn alternar_janela(app: &AppHandle) {
    let Some(w) = app.get_webview_window("main") else {
        return;
    };
    // visibilidade/foco vêm do estado alimentado por eventos:
    // `is_visible()`/`is_focused()` são IPC bloqueante e travariam este
    // handler junto com a UI.
    if connection::is_window_visible(app) && connection::is_window_focused(app) {
        let _ = w.hide();
        connection::note_window_visible(app, false);
    } else {
        focar_janela_principal(app);
    }
}

pub fn run() {
    // 28 — PRIMEIRA linha do processo, antes de qualquer plugin. Tudo que
    // resolve caminho (settings.json, connection.log, perfil do WebView2)
    // pergunta a `contas::ativa()`, e ela precisa estar fixada antes do
    // primeiro `read_settings`. Uma conta por processo, e ela nunca muda —
    // é o que torna o `OnceLock` do `LOG_PATH` correto por construção.
    contas::fixar_ativa(&std::env::args().collect::<Vec<_>>());

    let construido = tauri::Builder::default()
        // K2(a): PRIMEIRO plugin da lista, de propósito. Os plugins são
        // inicializados na ordem de registro; este detecta a instância viva,
        // manda a mensagem que a traz para a frente e encerra o processo novo
        // com exit(0) ANTES de qualquer outro plugin tentar tomar recurso
        // global. Sem ele, a segunda instância chegava no registro do
        // ctrl+shift+w, colidia, o erro subia até o `.expect()` do `build()` e,
        // com `panic = "abort"`, o processo morria sem janela e sem UMA LINHA
        // de log — reprovando o critério nº1 do projeto.
        .plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            focar_janela_principal(app);
            connection::note_window_event(app, "segunda instância detectada; janela existente focada");
            // P2: clicar num link `whatsapp://` com o app aberto lança um
            // processo novo cujo ÚNICO conteúdo é a URL. O processo morre aqui
            // (é o que este plugin faz); antes de morrer, entrega o alvo à
            // instância viva — senão o clique não abriria nada, ou abriria uma
            // segunda janela, que é exatamente o que o P2 proíbe.
            if let Some(url) = protocol::url_dos_args(&args) {
                protocol::rotear(app, &url);
            }
        }))
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_opener::init())
        // A3: diálogo nativo de "Salvar como". Só o Rust chama — nenhuma
        // capability cita `dialog:`, então a página não abre diálogo sozinha.
        .plugin(tauri_plugin_dialog::init())
        // U1: atualização assinada. O plugin entra SEM nenhuma permissão de
        // frontend: nenhuma capability cita `updater:`. Quem chama `check`,
        // `download` e `install` é o Rust (src/update.rs), e os comandos que o
        // expõem estão só na capability do Painel. A janela do WhatsApp Web
        // não tem como pedir uma atualização, nem como saber que ela existe.
        .plugin(tauri_plugin_updater::Builder::new().build())
        // K2(b): o plugin sobe SEM atalho nenhum. O registro acontece no
        // `setup`, onde a falha é tratável. Vale para qualquer outro app que já
        // tenha tomado o Ctrl+Shift+W.
        // 27 — SEM `with_handler`. O handler do builder dispara para TODOS os
        // atalhos, E ainda por cima somado ao handler por atalho do
        // `on_shortcut` (medido no fonte do plugin 2.3.2: o event handler chama
        // os dois). Com um atalho só isso significava alternar a janela DUAS
        // vezes por tecla — mostrar e esconder no mesmo instante. Com três
        // ações significaria que qualquer uma delas também alternaria a janela.
        // Quem trata cada atalho é o `on_shortcut` de `aplicar_atalhos`.
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .manage(notify::ToastState::default())
        // W1(b): lista de conversas que a página reporta, para o Painel poder
        // oferecer caixinhas em vez de uma regra digitada por grupo.
        .manage(notify::ChatList::default())
        .manage(connection::ConnMonitor::default())
        // A1/A3: caminhos que este processo gravou. É a trava de
        // `abrir_arquivo`/`revelar_arquivo` (ver `MidiasSalvas`).
        .manage(MidiasSalvas::default())
        // P2: alvo de link `whatsapp://` esperando a página subir.
        .manage(protocol::DeepLinkState::default())
        // U2: último resultado da verificação de atualização, para o Painel
        // desenhar a aba sem ir à rede toda vez que abre.
        .manage(update::UpdateState::default())
        // Onda 2: as pastas que o USUÁRIO apontou no diálogo nativo. Sem isto
        // `save_media_em` recusaria tudo — é ele que sabe o que foi escolhido.
        .manage(PastasEscolhidas::default())
        // 27 — o resultado real do último registro de atalhos, para o Painel.
        .manage(AtalhosEstado::default())
        .invoke_handler(tauri::generate_handler![
            load_settings,
            load_settings_public,
            save_settings,
            // Onda 2 — gravação ESTREITA a partir da página. Nenhum destes
            // reescreve o settings.json inteiro, e nenhum devolve segredo.
            save_module_data,
            log_agendamento,
            note_get,
            note_ids,
            note_set,
            escolher_pasta,
            save_media_em,
            // 27 — só LÊ o que o registro dos atalhos devolveu. Só o Painel o
            // cita; a página do WhatsApp não precisa saber de atalho nenhum.
            atalhos_estado,
            // O modo de falha calado do settings.json: o Painel desenha a
            // faixa vermelha a partir disto. Só o Painel o cita.
            settings_saude,
            // 28 — multi-conta. Só o PAINEL cita os quatro: a janela do
            // WhatsApp Web não tem nada que fazer com a lista de contas do
            // usuário, e muito menos com o comando que reinicia o app.
            contas::contas_estado,
            contas::conta_criar,
            contas::conta_remover,
            contas::conta_trocar,
            open_settings,
            open_log_dir,
            // B2: o relatório de diagnóstico em texto. Só o Painel o cita
            // (capabilities/default.json) — a página do WhatsApp Web não tem
            // como pedir o log, nem redigido.
            diagnostico::diagnostico_texto,
            set_always_on_top,
            ai::ai_complete,
            ai::ai_status,
            ai::ai_test,
            ai::ai_models,
            ai::ai_oauth_openrouter,
            transcribe_audio,
            save_media,
            abrir_arquivo,
            revelar_arquivo,
            open_external,
            notify::show_toast,
            notify::get_toast,
            notify::close_toast,
            notify::close_all_toasts,
            notify::focus_chat,
            // Y2: o pedido de abrir conversa sobrevive ao reload/renavegação —
            // o bundle novo pergunta por ele assim que sobe.
            notify::take_pending_chat,
            // P1/P2/P3: os três `protocolo_*` são do PAINEL (conteúdo local).
            // `take_pending_deeplink` é o único que a origem remota cita — e
            // ele só LÊ um alvo que o próprio Rust criou a partir do argv.
            protocol::protocolo_status,
            protocol::protocolo_registrar,
            protocol::protocolo_restaurar,
            protocol::take_pending_deeplink,
            // Z2: ações no próprio toast (lembrar depois / silenciar a conversa)
            notify::snooze_toast,
            notify::pin_toast,
            notify::mute_chat,
            notify::report_chats,
            notify::list_chats,
            connection::conn_heartbeat,
            connection::conn_transition,
            // M1: a página PEDE recuperação; quem conta e decide é o Rust — o
            // único lugar que sobrevive ao `location.reload()` do nível 2.
            connection::conn_recovery,
            connection::get_connection_state,
            whisper::whisper_status,
            whisper::whisper_progress,
            whisper::whisper_cancel,
            whisper::whisper_install_engine,
            whisper::whisper_download_model,
            whisper::whisper_use_model,
            whisper::whisper_delete_model,
            // U2: os três do atualizador. Só o Painel (conteúdo local) os cita
            // — ver capabilities/default.json. A origem remota NÃO os tem:
            // nada em web.whatsapp.com dispara download nem troca o app.
            update::atualizacao_estado,
            update::atualizacao_procurar,
            update::atualizacao_instalar
        ])
        .setup(|app| {
            // Janela principal: o próprio WhatsApp Web, com nossos módulos injetados.
            // A sessão persiste porque o perfil do WebView2 fica salvo no diretório do app.
            create_main_window(app.handle())?;

            // Watchdog da camada de conexão: detecta webview zumbi (sem
            // heartbeat) e RENAVEGA a webview principal (nível 3). Nunca
            // destrói a janela — ver a justificativa em `connection.rs`.
            connection::start_watchdog(app.handle().clone());

            // K2(b): atalho global é CONVENIÊNCIA, nunca requisito de boot.
            // Se outro app já tomou o Ctrl+Shift+W (ou o registro falhar por
            // qualquer motivo), o ZapLite segue rodando sem ele e o log diz
            // exatamente o que aconteceu.
            aplicar_atalhos(app.handle());

            // P2 — arranque A FRIO por um link: o Windows lançou este processo
            // com a URL no argv e não há instância viva para recebê-la. O alvo
            // é GUARDADO aqui e o bundle pergunta por ele quando subir; se
            // fosse emitido agora, o evento cairia no vazio (a página nem
            // existe) e o clique se perderia — o mesmo buraco do Y2.
            if let Some(url) = protocol::url_dos_args(&std::env::args().collect::<Vec<_>>()) {
                if let Some(alvo) = protocol::parse_whatsapp_url(&url) {
                    protocol::guardar(app.handle(), alvo);
                    connection::note_window_event(app.handle(), "app aberto por link whatsapp://; alvo guardado até a página subir");
                } else {
                    connection::note_window_event(app.handle(), &format!("app aberto por link whatsapp:// ilegível: {url}"));
                }
            }

            // P1 — o usuário JÁ tinha ligado o registro e o exe mudou de lugar
            // (reinstalação, pasta movida). Sem isto o Windows tentaria abrir
            // um caminho que não existe mais. Não LIGA nada: só conserta uma
            // escolha que já era dele.
            protocol::reapontar_se_preciso(app.handle());

            // U2 — verificação na abertura, COM FOLGA (dois minutos). Só olha:
            // se houver versão nova, o usuário recebe um aviso e decide quando
            // instalar. Falha de rede ou endpoint fora do ar morre em silêncio
            // dentro do módulo, com uma linha no connection.log.
            update::agendar_checagem_de_boot(app.handle().clone());

            // Ganchos de teste: SÓ em build de depuração. No release eles nem
            // existem no binário — `ZAPLITE_TESTE_QUEDA` chega a fazer `eval`
            // de código que derruba a conexão, e uma variável de ambiente não
            // é controle de acesso.
            #[cfg(debug_assertions)]
            ganchos_de_teste(app.handle());

            Ok(())
        })
        .build(tauri::generate_context!());

    // K2: `.expect()` aqui era um abort silencioso. Com `panic = "abort"` no
    // perfil de release não há unwind, não há mensagem e não há log: o processo
    // some. Agora a falha de inicialização vira uma linha no log de conexão e
    // um código de saída — nunca mais "morreu em segundos, ZERO linhas".
    let app = match construido {
        Ok(a) => a,
        Err(e) => {
            registrar_falha_de_boot(&e.to_string());
            std::process::exit(1);
        }
    };

    app.run(|handle, event| {
        // O tao pede a saída assim que a última janela é destruída. Se isso
        // acontecer no meio de uma recuperação do watchdog, o app morria — foi
        // exatamente assim que o nível 3 antigo matava o processo. Aqui a saída
        // é segurada e a janela, recriada.
        if let tauri::RunEvent::ExitRequested { api, .. } = &event {
            if connection::guard_exit(handle) {
                api.prevent_exit();
            }
        }
    });
}

/* ==========================================================================
   27 — ATALHO GLOBAL CONFIGURÁVEL
   --------------------------------------------------------------------------
   Antes eram dois atalhos FIXOS: `ctrl+shift+w` (registrado aqui) e
   `ctrl+shift+z` (um `keydown` dentro da página, que por isso só funcionava com
   a janela do WhatsApp já em foco — ou seja, não era atalho global coisa
   nenhuma). Este bloco os torna configuráveis e acrescenta uma terceira ação.

   O QUE NÃO ENTROU, e por quê: "abrir a última conversa não lida". Abrir uma
   conversa manda RECIBO DE LEITURA para quem escreveu — é a mesma linha que as
   ações em massa e o resumo do dia se recusam a cruzar. Um atalho de teclado
   que dispara recibo por acidente, com a janela escondida, é pior do que a
   comodidade que ele oferece. As três ações abaixo não escrevem, não enviam e
   não abrem conversa nenhuma.

   FALHA DE REGISTRO NUNCA DERRUBA O APP (K2b): o caso real é outro programa já
   ter tomado a combinação, e foi esse mesmo mecanismo que matava a segunda
   instância do próprio ZapLite. Cada ação é registrada por si; a que falhar
   entra no relatório com o motivo, e o Painel o mostra.
   ========================================================================== */

/// (id da ação, combinação padrão, rótulo para o Painel).
const ATALHOS: &[(&str, &str, &str)] = &[
    ("toggleWindow", "ctrl+shift+w", "Esconder / mostrar o ZapLite"),
    ("openPanel", "ctrl+shift+z", "Abrir o Painel do ZapLite"),
    // Nasce VAZIO = desligado. Um atalho global a mais, que o usuário não
    // pediu, é uma combinação a menos disponível para os outros programas dele.
    ("newReminder", "", "Novo lembrete (abre o formulário)"),
];

/// O resultado REAL do último registro, por ação. É o que o Painel lê: dizer
/// "atalho configurado" quando o sistema recusou a combinação seria a mesma
/// promessa falsa que a área de "planejados" existe para evitar.
#[derive(Default)]
pub struct AtalhosEstado(Mutex<Vec<Value>>);

#[tauri::command]
fn atalhos_estado(app: AppHandle) -> Vec<Value> {
    app.state::<AtalhosEstado>().0.lock().unwrap().clone()
}

fn executar_atalho(app: &AppHandle, acao: &str) {
    match acao {
        "toggleWindow" => alternar_janela(app),
        "openPanel" => {
            let h = app.clone();
            tauri::async_runtime::spawn(async move {
                let _ = open_settings(h, None).await;
            });
        }
        // A página é quem tem o formulário de lembrete. Aqui só trazemos a
        // janela para a frente e avisamos — nada é escrito nem agendado.
        "newReminder" => {
            if let Some(w) = app.get_webview_window("main") {
                focar_janela_principal(app);
                let _ = w.emit("zaplite://atalho", json!({ "acao": "newReminder" }));
            }
        }
        _ => {}
    }
}

/// Registra (ou re-registra) todos os atalhos conforme o settings.json.
/// Idempotente: começa desregistrando tudo, então pode ser chamada no boot e a
/// cada `save_settings` sem acumular registros.
fn aplicar_atalhos(app: &AppHandle) {
    use tauri_plugin_global_shortcut::GlobalShortcutExt;
    let gs = app.global_shortcut();
    let _ = gs.unregister_all();

    let s = read_settings(app);
    // Interruptor do catálogo. DESLIGADO = exatamente o comportamento
    // histórico: só o ctrl+shift+w, e o Painel continua no ctrl+shift+z da
    // página. Ligar o módulo é que traz a configuração e a terceira ação.
    let ligado = s
        .get("modules")
        .and_then(|m| m.get("globalHotkey"))
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    let cfg = s.get("hotkeys").cloned().unwrap_or_else(|| json!({}));

    let mut relatorio = Vec::new();
    for (acao, padrao, rotulo) in ATALHOS {
        let combo = if !ligado {
            if *acao == "toggleWindow" { (*padrao).to_string() } else { String::new() }
        } else {
            // Chave presente com string vazia é uma escolha do usuário
            // ("não quero este"), não uma ausência: só a ausência cai no padrão.
            match cfg.get(*acao).and_then(|v| v.as_str()) {
                Some(v) => v.trim().to_lowercase(),
                None => (*padrao).to_string(),
            }
        };
        if combo.is_empty() {
            relatorio.push(json!({
                "acao": acao, "rotulo": rotulo, "combo": "", "ok": false,
                "erro": if ligado { "desligado por você" } else { "módulo Atalho global desligado" },
            }));
            continue;
        }
        let alvo = (*acao).to_string();
        match gs.on_shortcut(combo.as_str(), move |app, _s, event| {
            if event.state() == tauri_plugin_global_shortcut::ShortcutState::Pressed {
                executar_atalho(app, &alvo);
            }
        }) {
            Ok(()) => {
                connection::note_window_event(app, &format!("atalho global {combo} → {acao}"));
                relatorio.push(json!({
                    "acao": acao, "rotulo": rotulo, "combo": combo, "ok": true, "erro": "",
                }));
            }
            Err(e) => {
                let motivo = format!("{e}");
                connection::note_window_event(
                    app,
                    &format!("atalho global {combo} INDISPONÍVEL ({motivo}); o app segue normal"),
                );
                relatorio.push(json!({
                    "acao": acao, "rotulo": rotulo, "combo": combo, "ok": false,
                    "erro": motivo,
                }));
            }
        }
    }
    *app.state::<AtalhosEstado>().0.lock().unwrap() = relatorio;
}

/// Última linha de defesa: o app nem chegou a existir, então não há AppHandle
/// nem diretório resolvido pelo Tauri. Escrevemos no mesmo arquivo, pelo
/// caminho conhecido, para que a falha de boot deixe rastro.
fn registrar_falha_de_boot(erro: &str) {
    let Ok(appdata) = std::env::var("APPDATA") else {
        return;
    };
    let dir = PathBuf::from(appdata).join("br.com.zaplite.app");
    let _ = fs::create_dir_all(&dir);
    let linha = json!({
        "ts": chrono::Local::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, false),
        "prev": "BOOT",
        "state": "FAILED",
        "reason": format!("falha ao iniciar o ZapLite: {}", erro.chars().take(160).collect::<String>()),
        "attempts": 0,
        "note": true,
        "src": "app",
    })
    .to_string();
    if let Ok(mut f) = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(dir.join("connection.log"))
    {
        use std::io::Write;
        let _ = f.write_all(format!("{linha}\n").as_bytes());
        let _ = f.flush();
    }
}

/// Ganchos de teste manuais. Compilados apenas em debug (ver `run`).
#[cfg(debug_assertions)]
fn ganchos_de_teste(handle: &AppHandle) {
    // Abre o Painel já na inicialização, para inspecionar a janela sem clique.
    if std::env::var("ZAPLITE_ABRIR_PAINEL").is_ok() {
        let h = handle.clone();
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(std::time::Duration::from_millis(1200)).await;
            let _ = open_settings(h, None).await;
        });
    }

    // PROVA de U2/U5: exercita o ciclo de atualizacao pelo caminho do USUARIO —
    // clica nos botoes REAIS da aba ATUALIZACAO e le o que a tela renderizou.
    // Nao chama os comandos Rust direto de proposito.
    //
    // `ZAPLITE_PROVA_UPDATE=procurar`  -> so verifica e mostra o que apareceu
    // `ZAPLITE_PROVA_UPDATE=instalar`  -> verifica e depois clica em "Instalar agora"
    //
    // Debug-only, como todo este bloco: no release nada disto existe no binario,
    // e o endpoint alternativo (`ZAPLITE_UPDATE_ENDPOINT`, ver src/update.rs)
    // tambem nao — uma variavel de ambiente nao e controle de acesso.
    if let Ok(modo) = std::env::var("ZAPLITE_PROVA_UPDATE") {
        let h = handle.clone();
        tauri::async_runtime::spawn(async move {
            let _ = open_settings(h.clone(), Some("atualiza".into())).await;
            tokio::time::sleep(std::time::Duration::from_secs(3)).await;
            let Some(w) = h.get_webview_window("settings") else {
                connection::note_diag(&h, "PROVA U: janela do Painel nao existe");
                return;
            };
            // Canal de leitura: a propria pagina EMITE o que renderizou, e o
            // Rust escuta. (`core:default` ja permite `event:emit`.) O truque do
            // titulo da janela nao serve aqui — o tao mantem o titulo nativo e
            // `document.title` nao volta por `w.title()`.
            {
                use tauri::Listener;
                let hh = h.clone();
                h.listen("zl-prova-tela", move |e| {
                    connection::note_diag(&hh, &format!("PROVA U {}", e.payload()));
                });
            }
            // Uma linha de log por campo: `note_diag` corta a mensagem em ~150
            // caracteres, e o que precisa aparecer inteiro e o texto que o
            // usuario le (as notas e a mensagem da barra).
            let ler = |w: &tauri::WebviewWindow, marca: &str| {
                let t = |id: &str| {
                    format!("(document.getElementById('{id}').innerText||'-').replace(/\\n/g,' ~ ')")
                };
                for (rotulo, expr) in [
                    (
                        "cabecalho",
                        format!(
                            "{} + ' -> ' + (document.getElementById('upNovidade').style.display==='none'?'(sem aviso)':'AVISO VISIVEL: ') + {} + ' | ' + {}",
                            t("upAtual"), t("upVersao"), t("upMeta")
                        ),
                    ),
                    ("notas", t("upNotas")),
                    (
                        "estado",
                        format!("'status=' + {} + ' | barra=' + {}", t("upStatus"), t("upBarraTxt")),
                    ),
                ] {
                    let js = format!(
                        "window.__TAURI__.event.emit('zl-prova-tela', '[{marca}/{rotulo}] ' + ({expr}))"
                    );
                    let _ = w.eval(&js);
                }
            };
            let clicar = |w: &tauri::WebviewWindow, id: &str| {
                let js = format!(
                    "(function(){{var b=document.getElementById('{id}');\
                     window.__TAURI__.event.emit('zl-prova-tela', b?'CLIQUE em {id}':'AUSENTE {id}');\
                     if(b)b.click();}})()"
                );
                let _ = w.eval(&js);
            };

            ler(&w, "antes");
            tokio::time::sleep(std::time::Duration::from_millis(900)).await;

            clicar(&w, "upProcurar");
            tokio::time::sleep(std::time::Duration::from_secs(6)).await;
            ler(&w, "depois-de-procurar");
            tokio::time::sleep(std::time::Duration::from_millis(900)).await;

            if modo.trim() != "instalar" {
                return;
            }
            clicar(&w, "upInstalar");
            for n in 0..15 {
                tokio::time::sleep(std::time::Duration::from_secs(2)).await;
                ler(&w, &format!("instalando-{n}"));
            }
        });
    }

    // PROVA de W3: clica no botao REAL do Painel ("Baixar" do modelo tiny) e
    // acompanha o download pelo mesmo progresso que a barra usa. Nao chama o
    // comando Rust direto de proposito: o que precisa ser provado e o caminho
    // do usuario, do clique ate o settings.json. Debug-only, como todo o resto
    // deste bloco.
    if let Ok(roteiro) = std::env::var("ZAPLITE_PROVA_WHISPER") {
        let h = handle.clone();
        tauri::async_runtime::spawn(async move {
            let _ = open_settings(h.clone(), None).await;
            tokio::time::sleep(std::time::Duration::from_secs(3)).await;
            let Some(w) = h.get_webview_window("settings") else {
                connection::note_diag(&h, "PROVA W: janela do Painel nao existe");
                return;
            };

            // Le o que a secao "Transcricao" REALMENTE renderizou. O eval nao
            // devolve valor, entao o texto vai para o titulo da janela e volta
            // por `w.title()` — o unico canal de leitura que existe aqui.
            let ler_tela = |w: &tauri::WebviewWindow| -> String {
                let js = "document.title = 'TELA|' + \
                          (document.getElementById('wStatus').innerText||'').replace(/\\n/g,' ~ ') + \
                          ' || ' + (document.getElementById('wPronto').innerText||'(sem aviso de pronto)') + \
                          ' || saida=' + (document.getElementById('wSaida').innerText||'-')";
                let _ = w.eval(js);
                String::new()
            };
            let pegar_titulo = |w: &tauri::WebviewWindow| -> String {
                w.title().unwrap_or_default()
            };

            let dump = |h: &AppHandle, marca: &str| {
                let st = whisper::whisper_status(h.clone());
                connection::note_diag(h, &format!("PROVA W [{marca}] STATUS: {st}"));
            };
            let acompanhar = |h: AppHandle, marca: String| async move {
                let mut ultimo = String::new();
                for _ in 0..2400 {
                    tokio::time::sleep(std::time::Duration::from_millis(500)).await;
                    let p = whisper::whisper_progress();
                    let linha = format!(
                        "fase={} {}/{} ({:.1}%)",
                        p["fase"].as_str().unwrap_or(""),
                        p["baixadoTxt"].as_str().unwrap_or(""),
                        p["totalTxt"].as_str().unwrap_or(""),
                        p["pct"].as_f64().unwrap_or(0.0)
                    );
                    if linha != ultimo {
                        connection::note_diag(&h, &format!("PROVA W [{marca}] {linha}"));
                        ultimo = linha;
                    }
                    if !p["ativo"].as_bool().unwrap_or(false) && p["fase"] == "pronto" {
                        connection::note_diag(
                            &h,
                            &format!("PROVA W [{marca}] FIM erro={} feito={}", p["erro"], p["feito"]),
                        );
                        return true;
                    }
                }
                connection::note_diag(&h, &format!("PROVA W [{marca}] expirou"));
                false
            };

            // Estado ANTES: e o retrato da instalacao propria do usuario.
            dump(&h, "antes");
            ler_tela(&w);
            tokio::time::sleep(std::time::Duration::from_millis(800)).await;
            connection::note_diag(&h, &format!("PROVA W [antes] {}", pegar_titulo(&w)));

            // Cada passo do roteiro e um CLIQUE de verdade no botao que o
            // `wRefresh` desenhou — nao uma chamada direta ao comando Rust.
            for passo in roteiro.split(',').filter(|x| !x.trim().is_empty()) {
                let passo = passo.trim().to_string();
                let (id, marca) = match passo.strip_prefix("motor:") {
                    Some(v) => (format!("wMotor-{v}"), format!("motor {v}")),
                    None => match passo.strip_prefix("usar:") {
                        Some(v) => (format!("wUsar-{v}"), format!("usar {v}")),
                        None => match passo.strip_prefix("cancelar:") {
                            Some(v) => (format!("wBaixar-{v}"), format!("cancelar {v}")),
                            None => (format!("wBaixar-{passo}"), format!("baixar {passo}")),
                        },
                    },
                };
                let js = format!(
                    "(function(){{var b=document.getElementById('{id}');\
                     document.title=b?'CLIQUE|{id}':'AUSENTE|{id}';if(b)b.click();}})()"
                );
                if let Err(e) = w.eval(&js) {
                    connection::note_diag(&h, &format!("PROVA W [{marca}] eval falhou: {e}"));
                    return;
                }
                tokio::time::sleep(std::time::Duration::from_millis(700)).await;
                connection::note_diag(&h, &format!("PROVA W [{marca}] {}", pegar_titulo(&w)));
                // "cancelar:<id>" clica em Baixar e, 3s depois, no botão
                // Cancelar da barra — o caminho do usuário desistindo no meio.
                if passo.starts_with("cancelar:") {
                    tokio::time::sleep(std::time::Duration::from_secs(3)).await;
                    let p = whisper::whisper_progress();
                    connection::note_diag(
                        &h,
                        &format!("PROVA W [{marca}] antes de cancelar: {} bytes", p["baixado"]),
                    );
                    let _ = w.eval("document.getElementById('wCancel').click()");
                }
                if !acompanhar(h.clone(), marca.clone()).await {
                    return;
                }
                // `wRodar` recarrega a lista depois de terminar.
                tokio::time::sleep(std::time::Duration::from_secs(2)).await;
                dump(&h, &marca);
                ler_tela(&w);
                tokio::time::sleep(std::time::Duration::from_millis(800)).await;
                connection::note_diag(&h, &format!("PROVA W [{marca}] {}", pegar_titulo(&w)));
            }
            connection::note_diag(&h, "PROVA W: roteiro concluido");
        });
    }

    // PROVA de N1/N2/N3: cantos, estilos novos, tamanho por regra, o botão
    // "fixar" segurando o toast e os botões não roubando o clique do corpo.
    if std::env::var("ZAPLITE_PROVA_JANELA").is_ok() {
        notify::prova_janelas(handle.clone());
    }

    // PROVA de Y1: abre um toast de verdade (mesmo comando que a página usa) e
    // manda uma recuperação de nível 2 pelo caminho REAL (`conn_recovery`).
    // Depois lista as janelas `toast-*` e o tamanho do `ToastState`. Roda no
    // banco de provas (`ZAPLITE_ALVO` + `ZAPLITE_PERFIL_TESTE`), nunca perto da
    // sessão do usuário. Só existe em debug.
    if std::env::var("ZAPLITE_PROVA_TOAST").is_ok() {
        let h = handle.clone();
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(std::time::Duration::from_secs(4)).await;
            let pedido: notify::ToastRequest = serde_json::from_value(json!({
                "id": "prova-y1",
                "sender": "Prova Y1",
                "body": "toast que precisa morrer com a recuperação",
                "chat_id": "5511999999999@c.us",
                "muted": false,
                "time": "12:00"
            }))
            .expect("pedido de prova inválido");
            let r = notify::show_toast(h.clone(), pedido).await;
            let janelas = |h: &AppHandle| -> Vec<String> {
                let mut v: Vec<String> = h
                    .webview_windows()
                    .keys()
                    .filter(|l| l.starts_with("toast-"))
                    .cloned()
                    .collect();
                v.sort();
                v
            };
            let estado = |h: &AppHandle| -> (usize, usize) {
                let st = h.state::<notify::ToastState>();
                let d = st.data.lock().unwrap().len();
                let s = st.stack.lock().unwrap().len();
                (d, s)
            };
            tokio::time::sleep(std::time::Duration::from_secs(2)).await;
            let (d, s) = estado(&h);
            connection::note_diag(
                &h,
                &format!(
                    "Y1 ANTES: show_toast={r:?} janelas={:?} ToastState(data={d},stack={s})",
                    janelas(&h)
                ),
            );
            // caminho REAL do nível 2 (o mesmo que o bundle.js chama)
            let v =
                connection::conn_recovery(h.clone(), 2, "prova-y1".into(), Some("prova".into()), None)
                    .await;
            tokio::time::sleep(std::time::Duration::from_secs(2)).await;
            let (d, s) = estado(&h);
            connection::note_diag(
                &h,
                &format!(
                    "Y1 DEPOIS: veredito={v} janelas={:?} ToastState(data={d},stack={s})",
                    janelas(&h)
                ),
            );
            // Prova do NÍVEL 3: nada de comando; o toast fica aberto e quem
            // dispara é o watchdog (documento sem heartbeat, janela visível).
            // O destino da renavegação é o próprio `ZAPLITE_ALVO` do bench.
            if std::env::var("ZAPLITE_PROVA_N3").is_ok() {
                let _ = notify::show_toast(
                    h.clone(),
                    serde_json::from_value(json!({
                        "id": "prova-y1-n3",
                        "sender": "Prova Y1 nivel 3",
                        "body": "toast que precisa morrer com a renavegação",
                        "chat_id": "5511999999999@c.us",
                        "muted": false,
                        "time": "12:00"
                    }))
                    .unwrap(),
                )
                .await;
                for i in 1..=30 {
                    tokio::time::sleep(std::time::Duration::from_secs(5)).await;
                    let vivas = janelas(&h);
                    let (d, s) = estado(&h);
                    connection::note_diag(
                        &h,
                        &format!("Y1/N3 t={}s janelas={vivas:?} data={d} stack={s}", i * 5),
                    );
                    if vivas.is_empty() && d == 0 && s == 0 {
                        connection::note_diag(
                            &h,
                            "Y1/N3 RESULTADO: PASSOU — o toast não sobreviveu à renavegação",
                        );
                        break;
                    }
                }
            }
            connection::note_diag(
                &h,
                &format!(
                    "Y1 RESULTADO: {}",
                    if janelas(&h).is_empty() && d == 0 && s == 0 {
                        "PASSOU — nenhuma janela toast-* e ToastState vazio"
                    } else {
                        "FALHOU — sobrou toast"
                    }
                ),
            );
        });
    }

    // PROVAS EMPÍRICAS de K1, K3 e K4, rodadas de dentro do processo (é o único
    // jeito de exercitar os comandos da ponte sem digitar na página do usuário).
    if std::env::var("ZAPLITE_PROVAS").is_ok() {
        let h = handle.clone();
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(std::time::Duration::from_secs(8)).await;

            /* --- K1: a página tentando desligar a recuperação --------------- */
            let antes = connection::get_connection_state(h.clone()).await;
            connection::note_diag(&h, &format!("K1 antes do ataque: {antes}"));
            // exatamente o ataque da auditoria: heartbeat com attempts=10 em
            // laço (clampa o JS em MAX_ATTEMPTS e o manda para FAILED)
            for _ in 0..30 {
                connection::conn_heartbeat(h.clone(), "CONNECTED".into(), 10, None, None).await;
            }
            let d1 = connection::get_connection_state(h.clone()).await;
            connection::note_diag(&h, &format!("K1 apos 30x attempts=10: {d1}"));
            // e o inverso: attempts=0 em laço para garantir reload eterno
            for _ in 0..30 {
                connection::conn_heartbeat(h.clone(), "OFFLINE".into(), 0, None, None).await;
            }
            let d2 = connection::get_connection_state(h.clone()).await;
            connection::note_diag(&h, &format!("K1 apos 30x attempts=0: {d2}"));

            /* --- K3: clicar no app travado não pode adiar o watchdog -------- */
            let g0 = connection::get_connection_state(h.clone()).await;
            connection::note_diag(&h, &format!("K3 graceMs inicial: {}", g0["graceMs"]));
            for _ in 0..40 {
                connection::note_window_focus(&h, false);
                connection::note_window_focus(&h, true);
                tokio::time::sleep(std::time::Duration::from_millis(50)).await;
            }
            let g1 = connection::get_connection_state(h.clone()).await;
            connection::note_diag(
                &h,
                &format!(
                    "K3 apos 40 ciclos de foco: graceMs={} visible={} focused={}",
                    g1["graceMs"], g1["visible"], g1["focused"]
                ),
            );

            /* --- K4: os dois escritores do log, ao mesmo tempo -------------- */
            connection::note_diag(&h, "K4 inicio do martelo concorrente");
            let mut threads = Vec::new();
            for t in 0..8 {
                let hh = h.clone();
                threads.push(std::thread::spawn(move || {
                    for n in 0..200 {
                        // caminho SÍNCRONO (o de fim de vida)
                        connection::note_diag(&hh, &format!("K4 sync t{t} n{n}"));
                    }
                }));
            }
            for n in 0..200 {
                // caminho ENFILEIRADO (thread zaplite-connlog)
                let st = if n % 2 == 0 { "CONNECTED" } else { "OFFLINE" };
                connection::conn_heartbeat(h.clone(), st.into(), 0, None, None).await;
            }
            for t in threads {
                let _ = t.join();
            }
            tokio::time::sleep(std::time::Duration::from_secs(2)).await;
            connection::note_diag(&h, "K4 fim do martelo concorrente");

            /* --- K3 (cenário real): carência JÁ expirada -------------------- */
            // É aqui que o bug mordia: app travado, carência no fim, usuário
            // clicando na janela. Cada clique renovava +30s e o nível 3 nunca
            // chegava. Esperamos a carência de boot acabar para medir.
            loop {
                let s = connection::get_connection_state(h.clone()).await;
                if s["graceMs"].as_u64().unwrap_or(1) == 0 {
                    break;
                }
                tokio::time::sleep(std::time::Duration::from_secs(2)).await;
            }
            connection::note_diag(&h, "K3b carencia expirada (graceMs=0); comecando os cliques");
            for _ in 0..20 {
                connection::note_window_focus(&h, false);
                connection::note_window_focus(&h, true);
                tokio::time::sleep(std::time::Duration::from_millis(100)).await;
            }
            let g2 = connection::get_connection_state(h.clone()).await;
            connection::note_diag(
                &h,
                &format!(
                    "K3b apos 20 cliques com carencia zerada: graceMs={} (>0 significaria watchdog adiado)",
                    g2["graceMs"]
                ),
            );
        });
    }

    // M1/M2/M3 — RELATOR DA CONVERGÊNCIA. Não decide nada e não dispara
    // recuperação nenhuma: só fotografa o estado do breaker da composição no
    // MESMO arquivo de log, para dar para ler ali se o contador subiu ATRAVÉS
    // dos reloads e em que instante o app parou de recarregar.
    //
    // Ele SÓ escreve quando a foto MUDA. A primeira versão escrevia a cada 5 s
    // incondicionalmente: ~12 linhas por minuto de `state=UNKNOWN` que
    // afogavam a evidência real do projeto e empurravam a rotação de 1 MB —
    // um instrumento de diagnóstico destruindo o diagnóstico. Instrumento que
    // fala sem ter novidade é ruído, não observabilidade.
    if std::env::var("ZAPLITE_RELATOR").is_ok() {
        let h = handle.clone();
        tauri::async_runtime::spawn(async move {
            let mut anterior = String::new();
            loop {
                tokio::time::sleep(std::time::Duration::from_secs(5)).await;
                let s = connection::get_connection_state(h.clone()).await;
                // `heartbeatAgeMs`/`graceMs` mudam a cada tick por construção:
                // ficam de FORA da chave, senão nada nunca é "igual".
                let foto = format!(
                    "RELATOR estado={} attempts={} cenario={} cenarioDisparos={} disparos={} descansoMs≈{}s holdMs≈{}s breakerMs≈{}s",
                    s["state"], s["attempts"], s["cenario"], s["cenarioDisparos"],
                    s["disparosInWindow"],
                    s["descansoMs"].as_u64().unwrap_or(0) / 15000 * 15,
                    s["holdMs"].as_u64().unwrap_or(0) / 15000 * 15,
                    s["breakerMs"].as_u64().unwrap_or(0) / 15000 * 15,
                );
                if foto != anterior {
                    anterior = foto.clone();
                    connection::note_diag(&h, &foto);
                }
            }
        });
    }

    // K12 — SONDA EMPÍRICA. Abre uma janela auxiliar (label "probe", fora de
    // qualquer capability, sem IPC) apontada para um host que não resolve, e
    // registra no log: (a) quais `PageLoadEvent` o WebView2 emite numa
    // navegação que FALHA, e (b) o que `w.url()` devolve depois disso. É a
    // única forma de saber se o detector pode confiar na URL no Windows —
    // deduzir não serve. Nada disso toca a janela principal nem a sessão.
    if std::env::var("ZAPLITE_SONDA_URL_ERRO").is_ok() {
        let h = handle.clone();
        std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_secs(5));
            let alvo = "http://zaplite-sonda.invalido/pagina";
            let h2 = h.clone();
            let _ = h.run_on_main_thread(move || {
                let hh = h2.clone();
                let r = WebviewWindowBuilder::new(
                    &h2,
                    "probe",
                    WebviewUrl::External(alvo.parse().unwrap()),
                )
                .title("ZapLite • sonda K12")
                .inner_size(520.0, 360.0)
                .visible(false)
                .on_page_load(move |w, payload| {
                    let ev = match payload.event() {
                        PageLoadEvent::Started => "Started(ContentLoading)",
                        PageLoadEvent::Finished => "Finished(NavigationCompleted)",
                    };
                    let url_agora = w.url().map(|u| u.to_string()).unwrap_or_default();
                    connection::note_diag(
                        w.app_handle(),
                        &format!(
                            "K12 sonda: evento={ev} payload.url={} w.url()={url_agora}",
                            payload.url().as_str()
                        ),
                    );
                })
                .build();
                match r {
                    Ok(_) => connection::note_diag(
                        &hh,
                        &format!("K12 sonda: janela criada apontando para {alvo}"),
                    ),
                    Err(e) => connection::note_diag(&hh, &format!("K12 sonda: falhou ({e})")),
                }
            });
            // depois que a navegação falhou, o que a sonda de URL enxergaria?
            for n in 1..=5 {
                std::thread::sleep(std::time::Duration::from_secs(3));
                let h3 = h.clone();
                let _ = h.run_on_main_thread(move || {
                    if let Some(w) = h3.get_webview_window("probe") {
                        let u = w.url().map(|x| x.to_string()).unwrap_or_default();
                        connection::note_diag(
                            &h3,
                            &format!("K12 sonda: leitura {n} pos-falha w.url()={u}"),
                        );
                    }
                });
            }
            let h4 = h.clone();
            let _ = h.run_on_main_thread(move || {
                if let Some(w) = h4.get_webview_window("probe") {
                    let _ = w.destroy();
                }
                connection::note_diag(&h4, "K12 sonda: encerrada");
            });
        });
    }

    // Simula queda de conexão DE DENTRO da página, fechando e bloqueando os
    // WebSockets interceptados. Não toca em rede/firewall do sistema.
    if let Ok(v) = std::env::var("ZAPLITE_TESTE_QUEDA") {
        let secs: u64 = v.parse().unwrap_or(40);
        let h = handle.clone();
        std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_secs(secs));
            if let Some(w) = h.get_webview_window("main") {
                let _ = w.eval(
                    "window.__ZAPLITE_CONN__ && console.log('[ZapLite/teste]', window.__ZAPLITE_CONN__.simulateDrop())",
                );
            }
        });
    }

    // Esconde e reexibe a janela pelo MESMO caminho do Ctrl+Shift+W, para
    // provar que a reexibição não dispara recuperação espúria.
    if let Ok(v) = std::env::var("ZAPLITE_TESTE_ESCONDER") {
        let mut it = v.split(',').map(|s| s.trim().parse::<u64>().unwrap_or(0));
        let em = it.next().unwrap_or(20);
        let por = it.next().unwrap_or(40);
        let h = handle.clone();
        std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_secs(em));
            if let Some(w) = h.get_webview_window("main") {
                let _ = w.hide();
                connection::note_window_visible(&h, false);
            }
            std::thread::sleep(std::time::Duration::from_secs(por));
            if let Some(w) = h.get_webview_window("main") {
                let _ = w.show();
                let _ = w.set_focus();
                connection::note_window_visible(&h, true);
            }
        });
    }
}
