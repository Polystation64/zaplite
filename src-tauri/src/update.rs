//! U1–U5 — atualização automática ASSINADA, com aviso e consentimento.
//!
//! O que este módulo garante, e por quê:
//!
//! * **A assinatura é o eixo.** O instalador é baixado de um domínio comum, sem
//!   nada de especial protegendo o arquivo. Quem tomar o domínio (ou o DNS, ou
//!   um proxy no caminho) consegue servir QUALQUER binário. A única coisa que
//!   separa "atualizar o ZapLite" de "instalar um executável de estranho na
//!   máquina dos amigos do usuário" é a verificação minisign: o
//!   `tauri-plugin-updater` chama `verify_signature(bytes, sig, pubkey)` no
//!   FIM de `Update::download`, antes de devolver um único byte para
//!   `install`. Nada toca o disco antes disso. A chave pública fica embutida em
//!   `tauri.conf.json`; a privada NUNCA entra no repositório.
//!
//! * **Nunca silencioso.** A checagem só olha; instalar é decisão do usuário,
//!   por botão. Trocar o app no meio de uma conversa é exatamente o que não
//!   pode acontecer.
//!
//! * **Nunca atrapalha.** Endpoint fora do ar, DNS quebrado, JSON inválido,
//!   máquina sem rede: tudo vira uma linha no `connection.log` e um estado
//!   "não deu para verificar". O app segue igual.
//!
//! * **A origem remota não enxerga nada disto.** Os comandos abaixo são
//!   citados APENAS em `capabilities/default.json` (janela `settings`, conteúdo
//!   local). A capability de `web.whatsapp.com` não cita nenhum deles, e o
//!   plugin do updater não é exposto ao frontend: quem fala com ele é o Rust.
//!
//! O endereço do manifesto mora em `tauri.conf.json` →
//! `plugins.updater.endpoints`. É o ÚNICO lugar para trocar quando a estrutura
//! do site mudar (o script de publicação lê o mesmo campo para montar a URL do
//! instalador).

use std::sync::Mutex;
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_updater::UpdaterExt;

/// Folga antes da checagem automática. O boot do app é disputado: WebView2
/// subindo, WhatsApp Web carregando, bundle injetando, sessão restaurando.
/// Uma requisição HTTP a mais no meio disso não muda nada de útil e pode
/// competir por rede justo quando a página está sincronizando. Depois de dois
/// minutos o app já está parado esperando o usuário.
const ATRASO_CHECAGEM_BOOT: Duration = Duration::from_secs(120);

/// Teto para a requisição do manifesto. Endpoint pendurado não pode deixar uma
/// task viva para sempre.
const TIMEOUT_MANIFESTO: Duration = Duration::from_secs(20);

/// Evento de progresso do download, ouvido pelo Painel.
const EVENTO_PROGRESSO: &str = "zl-update-progresso";
/// Evento de "achei uma versão nova", ouvido pelo Painel (se estiver aberto).
const EVENTO_ACHADO: &str = "zl-update-achado";

/// Janela do Painel. É a única que recebe os eventos: a janela principal é o
/// WhatsApp Web, origem remota, e não tem nada a ver com isto.
const JANELA_PAINEL: &str = "settings";

// ---------------------------------------------------------------------------
// Estado
// ---------------------------------------------------------------------------

/// O que o Painel precisa saber para desenhar a aba sem ir à rede.
#[derive(Debug, Clone, Default, Serialize)]
pub struct Estado {
    /// Versão que está rodando agora.
    pub versao_atual: String,
    /// Versão anunciada pelo manifesto, se houver uma maior que a atual.
    pub versao_nova: Option<String>,
    /// Notas da versão, como vieram do manifesto. `None` quando o manifesto não
    /// traz texto — nesse caso o Painel mostra só o número. Nunca inventamos
    /// notas.
    pub notas: Option<String>,
    /// Data de publicação anunciada (texto, como veio).
    pub data: Option<String>,
    /// Tamanho do instalador em bytes, quando o servidor responde ao HEAD.
    pub tamanho: Option<u64>,
    /// Última falha de verificação, em português, para o Painel mostrar de
    /// forma discreta. Falha aqui NUNCA é erro de comando.
    pub falha: Option<String>,
    /// Já houve pelo menos uma checagem nesta sessão?
    pub verificou: bool,
    /// Download em andamento (impede dois cliques em "instalar agora").
    pub baixando: bool,
}

#[derive(Default)]
pub struct UpdateState(Mutex<Estado>);

impl UpdateState {
    fn ler(&self) -> Estado {
        self.0.lock().unwrap_or_else(|e| e.into_inner()).clone()
    }
    fn mexer<F: FnOnce(&mut Estado)>(&self, f: F) -> Estado {
        let mut g = self.0.lock().unwrap_or_else(|e| e.into_inner());
        f(&mut g);
        g.clone()
    }
}

/// Progresso do download, em bytes. `total` só existe quando o servidor manda
/// `Content-Length`.
#[derive(Debug, Clone, Serialize)]
struct Progresso {
    baixado: u64,
    total: Option<u64>,
}

// ---------------------------------------------------------------------------
// Registro no log
// ---------------------------------------------------------------------------

/// Tudo que o atualizador faz vira linha no `connection.log` — é o arquivo que
/// o usuário manda junto com um relato de bug.
fn log(app: &AppHandle, msg: &str) {
    crate::connection::note_window_event(app, &format!("atualizador: {msg}"));
}

// ---------------------------------------------------------------------------
// Checagem
// ---------------------------------------------------------------------------

/// Monta o updater. Em build de DEPURAÇÃO — e só nela — aceita um endpoint
/// alternativo por variável de ambiente, para poder exercitar o ciclo inteiro
/// contra um servidor local sem depender do site existir.
///
/// No release isto nem compila: uma variável de ambiente não é controle de
/// acesso, e o endpoint de produção não pode ser desviado por quem consegue
/// definir uma variável no ambiente do processo. (O plugin, por sinal, também
/// recusa endpoint sem `https` em release — ver `config::validate_endpoints`.)
fn construir(app: &AppHandle) -> Result<tauri_plugin_updater::Updater, String> {
    #[allow(unused_mut)]
    let mut b = app.updater_builder().timeout(TIMEOUT_MANIFESTO);

    #[cfg(debug_assertions)]
    if let Ok(alt) = std::env::var("ZAPLITE_UPDATE_ENDPOINT") {
        match tauri::Url::parse(&alt) {
            Ok(u) => {
                log(app, &format!("[debug] endpoint substituído por {u}"));
                b = b.endpoints(vec![u]).map_err(|e| e.to_string())?;
            }
            Err(e) => log(app, &format!("[debug] ZAPLITE_UPDATE_ENDPOINT ilegível: {e}")),
        }
    }

    b.build().map_err(|e| e.to_string())
}

/// Pergunta o tamanho do instalador com um HEAD. É informação de conforto ("vai
/// baixar 2,4 MB"), não requisito: servidor que não responde ao HEAD, ou não
/// manda `Content-Length`, simplesmente deixa o campo vazio.
async fn tamanho_do_instalador(url: &str) -> Option<u64> {
    let cli = reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .build()
        .ok()?;
    let r = cli.head(url).send().await.ok()?;
    if !r.status().is_success() {
        return None;
    }
    r.headers()
        .get(reqwest::header::CONTENT_LENGTH)?
        .to_str()
        .ok()?
        .parse()
        .ok()
}

/// Uma checagem completa. Devolve o estado novo. **Nunca** propaga erro de
/// rede: falha vira `Estado.falha` e linha de log.
async fn checar(app: &AppHandle) -> Estado {
    let st = app.state::<UpdateState>();
    let atual = app.package_info().version.to_string();

    let updater = match construir(app) {
        Ok(u) => u,
        Err(e) => {
            log(app, &format!("não consegui montar o updater: {e}"));
            return st.mexer(|s| {
                s.versao_atual = atual.clone();
                s.verificou = true;
                s.falha = Some("não foi possível verificar agora".into());
            });
        }
    };

    match updater.check().await {
        Ok(Some(u)) => {
            let notas = u
                .body
                .as_deref()
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(str::to_string);
            let data = u.date.map(|d| d.date().to_string());
            let tamanho = tamanho_do_instalador(u.download_url.as_str()).await;
            log(
                app,
                &format!(
                    "versão {} disponível (rodando {}), notas: {}",
                    u.version,
                    atual,
                    if notas.is_some() { "sim" } else { "não" }
                ),
            );
            let novo = st.mexer(|s| {
                s.versao_atual = atual.clone();
                s.versao_nova = Some(u.version.clone());
                s.notas = notas.clone();
                s.data = data.clone();
                s.tamanho = tamanho;
                s.falha = None;
                s.verificou = true;
            });
            let _ = app.emit_to(JANELA_PAINEL, EVENTO_ACHADO, novo.clone());
            novo
        }
        Ok(None) => {
            log(app, &format!("nenhuma versão nova (rodando {atual})"));
            st.mexer(|s| {
                s.versao_atual = atual.clone();
                s.versao_nova = None;
                s.notas = None;
                s.data = None;
                s.tamanho = None;
                s.falha = None;
                s.verificou = true;
            })
        }
        Err(e) => {
            // Endpoint fora do ar, sem rede, JSON inválido, assinatura de
            // formato errado no manifesto — tudo cai aqui e tudo é inofensivo.
            log(app, &format!("checagem falhou: {e}"));
            st.mexer(|s| {
                s.versao_atual = atual.clone();
                s.verificou = true;
                s.falha = Some("não foi possível verificar agora".into());
            })
        }
    }
}

/// Checagem automática na abertura, com folga. Roda uma vez por sessão.
pub fn agendar_checagem_de_boot(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(ATRASO_CHECAGEM_BOOT).await;
        let e = checar(&app).await;
        if let Some(v) = e.versao_nova {
            avisar(&app, &v);
        }
    });
}

/// O aviso. Notificação nativa, sem botão de instalar: quem instala é o
/// usuário, no Painel, depois de ler as notas. Falha da notificação não é
/// problema de ninguém — o Painel mostra o mesmo estado quando for aberto.
fn avisar(app: &AppHandle, versao: &str) {
    use tauri_plugin_notification::NotificationExt;
    let r = app
        .notification()
        .builder()
        .title("ZapLite — atualização disponível")
        .body(&format!(
            "Versão {versao} pronta para instalar. Abra o Painel ZapLite › ATUALIZAÇÃO quando quiser."
        ))
        .show();
    if let Err(e) = r {
        log(app, &format!("não consegui mostrar a notificação: {e}"));
    }
}

// ---------------------------------------------------------------------------
// Comandos (SÓ o Painel os cita — ver capabilities/default.json)
// ---------------------------------------------------------------------------

/// O que já se sabe, sem tocar na rede. É o que o Painel chama ao abrir.
#[tauri::command]
pub fn atualizacao_estado(app: AppHandle) -> Estado {
    let st = app.state::<UpdateState>();
    st.mexer(|s| {
        if s.versao_atual.is_empty() {
            s.versao_atual = app.package_info().version.to_string();
        }
    })
}

/// Botão "procurar atualizações".
#[tauri::command]
pub async fn atualizacao_procurar(app: AppHandle) -> Estado {
    checar(&app).await
}

/// Botão "instalar agora". Baixa (com progresso), o plugin VERIFICA A
/// ASSINATURA e só então o instalador roda. Devolve erro em texto se algo der
/// errado — aqui o usuário pediu, então ele merece ver o motivo.
///
/// A checagem é refeita em vez de guardar o `Update` da checagem anterior: o
/// objeto carrega handles do app e o estado pode ter meia hora de idade. Uma
/// requisição a mais é barata; instalar algo que o manifesto já não anuncia,
/// não.
#[tauri::command]
pub async fn atualizacao_instalar(app: AppHandle) -> Result<(), String> {
    if app.state::<UpdateState>().ler().baixando {
        return Err("já existe um download em andamento".into());
    }
    app.state::<UpdateState>().mexer(|s| s.baixando = true);

    let resultado = baixar_e_instalar(&app).await;
    if resultado.is_err() {
        // Só no erro. No caminho feliz o processo está de saída (o instalador
        // assume), e zerar a flag aqui só serviria para o Painel piscar
        // "pronto para instalar" no meio da troca.
        app.state::<UpdateState>().mexer(|s| s.baixando = false);
    }
    resultado
}

async fn baixar_e_instalar(app: &AppHandle) -> Result<(), String> {
    let updater = construir(app)?;
    let atualizacao = updater
        .check()
        .await
        .map_err(|e| {
            log(app, &format!("instalação: checagem falhou: {e}"));
            "não foi possível falar com o servidor de atualização".to_string()
        })?
        .ok_or_else(|| {
            log(app, "instalação: o manifesto não anuncia versão nova");
            "não há versão nova para instalar".to_string()
        })?;

    log(app, &format!("baixando {}", atualizacao.version));

    let mut baixado: u64 = 0;
    let bytes = atualizacao
        .download(
            |pedaco, total| {
                baixado += pedaco as u64;
                let _ = app.emit_to(
                    JANELA_PAINEL,
                    EVENTO_PROGRESSO,
                    Progresso { baixado, total },
                );
            },
            || {},
        )
        .await
        .map_err(|e| {
            // Este `Err` engloba o caso que mais importa: assinatura inválida.
            // O `download` só devolve bytes DEPOIS de `verify_signature`; se a
            // verificação reprova, nada é gravado e nada é executado.
            log(app, &format!("download/verificação falhou: {e}"));
            format!("o pacote baixado não passou na verificação de assinatura ({e})")
        })?;

    log(
        app,
        &format!(
            "assinatura conferida, {} bytes; chamando o instalador",
            bytes.len()
        ),
    );

    atualizacao.install(bytes).map_err(|e| {
        log(app, &format!("instalador falhou: {e}"));
        format!("não foi possível iniciar o instalador ({e})")
    })?;

    Ok(())
}

#[cfg(test)]
mod testes {
    use super::*;

    /// U2: o estado que vai para o Painel é feito de campos opcionais — o
    /// caminho "não deu para verificar" e o caminho "não tem novidade" precisam
    /// existir sem nenhum dado de versão nova.
    #[test]
    fn estado_sem_versao_nova_e_valido() {
        let e = Estado {
            versao_atual: "0.1.4".into(),
            verificou: true,
            falha: Some("não foi possível verificar agora".into()),
            ..Default::default()
        };
        let j = serde_json::to_value(&e).unwrap();
        assert_eq!(j["versao_nova"], serde_json::Value::Null);
        assert_eq!(j["notas"], serde_json::Value::Null);
        assert_eq!(j["falha"], "não foi possível verificar agora");
    }

    /// U3: notas vazias ou só espaço NÃO viram string vazia no Painel — viram
    /// ausência, e o aviso mostra só o número da versão. É a regra "não invente
    /// notas" no lado de cá.
    #[test]
    fn notas_em_branco_viram_ausencia() {
        let limpa = |s: Option<&str>| -> Option<String> {
            s.map(str::trim).filter(|x| !x.is_empty()).map(str::to_string)
        };
        assert_eq!(limpa(None), None);
        assert_eq!(limpa(Some("")), None);
        assert_eq!(limpa(Some("   \n ")), None);
        assert_eq!(limpa(Some(" corrige o toast ")), Some("corrige o toast".into()));
    }

    /// U5: o estado é o que atravessa para a janela do Painel. Ele não pode
    /// carregar nada além de informação de versão — nada de caminho de
    /// instalador local, nada de chave, nada de token.
    #[test]
    fn estado_nao_carrega_segredo_nem_caminho_local() {
        let e = Estado {
            versao_atual: "0.1.4".into(),
            versao_nova: Some("0.1.5".into()),
            notas: Some("nota".into()),
            data: Some("2026-08-21".into()),
            tamanho: Some(2_475_307),
            falha: None,
            verificou: true,
            baixando: false,
        };
        let mut campos: Vec<String> = serde_json::to_value(&e)
            .unwrap()
            .as_object()
            .unwrap()
            .keys()
            .cloned()
            .collect();
        campos.sort();
        assert_eq!(
            campos,
            vec![
                "baixando",
                "data",
                "falha",
                "notas",
                "tamanho",
                "verificou",
                "versao_atual",
                "versao_nova"
            ]
        );
    }
}
