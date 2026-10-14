//! "Sign in with ChatGPT" — usar a cota do plano ChatGPT (Plus/Pro) nos
//! módulos de IA, sem chave de API.
//!
//! É o fluxo OFICIAL da OpenAI para apps open-source ("token sharing"), e
//! não o login do Codex CLI pego emprestado. Contrato seguido à risca
//! (developers.openai.com/siwc/token-sharing-open-source/*):
//!   * registro dinâmico: o primeiro login manda `client_id=dynamic_agent_client`
//!     + `agent_name_hint` + `ext_agent_host_id`, e o retorno traz o
//!     `client_id` emitido (`oaiapp_…`), que é guardado e reusado;
//!   * PKCE S256, `state` e `nonce` novos a cada tentativa, sem segredo de cliente;
//!   * retorno SÓ em `http://127.0.0.1:<porta>/auth/callback` (nunca `localhost`);
//!   * inferência em `POST https://api.openai.com/v1/responses` com
//!     `store:false` e `stream:true` — nunca no `backend-api` do ChatGPT;
//!   * renovação com `grant_type=refresh_token`, serializada, guardando o
//!     refresh token rotativo novo a cada vez.
//!
//! O refresh token é segredo: mora em `chatgptRefreshToken`, que está em
//! `ai::CAMPOS_DE_CHAVE` (cifrado com DPAPI no disco, nunca vai para a página).
//! O access token (1 h) fica só em memória.
use crate::ai::{self, Config, Resposta};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::net::TcpListener;
use std::sync::atomic::Ordering;
use std::time::{Duration, Instant};
use tauri::AppHandle;

const AUTORIZAR: &str = "https://auth.openai.com/api/accounts/authorize";
const TOKEN: &str = "https://auth.openai.com/api/accounts/oauth/token";
const DESCOBERTA: &str = "https://auth.openai.com/.well-known/openid-configuration";
const EMISSOR: &str = "https://auth.openai.com";
pub const RECURSO: &str = "https://api.openai.com/v1";
const RESPOSTAS: &str = "https://api.openai.com/v1/responses";
const MODELOS: &str = "https://api.openai.com/v1/models";
const CLIENTE_DINAMICO: &str = "dynamic_agent_client";
pub const ESCOPOS: &str = "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct";
pub const ESCOPO_DO_PLANO: &str = "chatgpt.tokens.use.direct";
const PORTA_PREFERIDA: u16 = 1455;
const CAMINHO_RETORNO: &str = "/auth/callback";

/* --------------------------------------------------------------------------
   Peças PURAS — testadas.
   -------------------------------------------------------------------------- */

fn aleatorio_hex(bytes: usize) -> String {
    (0..bytes).map(|_| format!("{:02x}", rand::random::<u8>())).collect()
}

/// `ext_agent_host_id` no formato que a OpenAI aceita: `urn:uuid:` + UUIDv4
/// (RFC 9562 §5.4). Texto livre é recusado com `invalid_authorize_request` —
/// foi o erro do primeiro teste real. Opaco: nada da pessoa entra nele.
pub fn novo_host_id() -> String {
    let mut b: [u8; 16] = rand::random();
    b[6] = (b[6] & 0x0f) | 0x40; // versão 4
    b[8] = (b[8] & 0x3f) | 0x80; // variante RFC 4122
    let h: String = b.iter().map(|x| format!("{x:02x}")).collect();
    format!("urn:uuid:{}-{}-{}-{}-{}", &h[0..8], &h[8..12], &h[12..16], &h[16..20], &h[20..32])
}

/// As três formas documentadas. Qualquer outra (como o `zaplite-<hex>` das
/// primeiras builds) é trocada antes do login.
pub fn host_id_valido(h: &str) -> bool {
    h.starts_with("urn:uuid:") || h.starts_with("urn:ietf:params:oauth:jwk-thumbprint:") || h.starts_with("did:key:")
}

/// Corpo `application/x-www-form-urlencoded`.
pub fn formulario(pares: &[(&str, &str)]) -> String {
    pares.iter().map(|(k, v)| format!("{}={}", ai::percent(k), ai::percent(v))).collect::<Vec<_>>().join("&")
}

pub struct Pedido<'a> {
    pub client_id: &'a str,
    pub host_id: &'a str,
    pub redirect: &'a str,
    pub state: &'a str,
    pub nonce: &'a str,
    pub desafio: &'a str,
    pub email: &'a str,
}

pub fn url_de_autorizacao(p: &Pedido) -> String {
    let mut pares: Vec<(&str, &str)> = vec![("client_id", p.client_id)];
    // `agent_name_hint` só no PRIMEIRO registro; omitir na reautorização.
    if p.client_id == CLIENTE_DINAMICO {
        pares.push(("agent_name_hint", "ZapLite"));
    }
    pares.extend([
        ("ext_agent_host_id", p.host_id),
        ("response_type", "code"),
        ("redirect_uri", p.redirect),
        ("scope", ESCOPOS),
        ("resource", RECURSO),
        ("state", p.state),
        ("nonce", p.nonce),
        ("code_challenge", p.desafio),
        ("code_challenge_method", "S256"),
    ]);
    if !p.email.is_empty() {
        pares.push(("login_hint", p.email));
    }
    format!("{AUTORIZAR}?{}", formulario(&pares))
}

/// Parâmetros da query de `GET /auth/callback?...`. `None` se a requisição
/// não é para o caminho de retorno (favicon, preconnect).
pub fn ler_callback(linha_de_requisicao: &str) -> Option<HashMap<String, String>> {
    let alvo = linha_de_requisicao.split_whitespace().nth(1)?;
    let (caminho, query) = alvo.split_once('?').unwrap_or((alvo, ""));
    if caminho != CAMINHO_RETORNO {
        return None;
    }
    let mut m = HashMap::new();
    for par in query.split('&').filter(|p| !p.is_empty()) {
        let (k, v) = par.split_once('=').unwrap_or((par, ""));
        m.insert(ai::despercent(k), ai::despercent(v));
    }
    Some(m)
}

/// O que o retorno decide, já validado. `client_id` é o emitido.
#[derive(Debug, PartialEq)]
pub struct Retorno {
    pub code: String,
    pub client_id: Option<String>,
}

pub fn validar_callback(q: &HashMap<String, String>, state: &str, client_id_atual: &str) -> Result<Retorno, String> {
    // `state` PRIMEIRO: um retorno que não é desta tentativa não decide nada.
    if q.get("state").map(String::as_str) != Some(state) {
        return Err("O retorno do login não corresponde a esta tentativa (state). Tente de novo.".into());
    }
    if let Some(e) = q.get("error") {
        return Err(if e == "access_denied" {
            "Você não autorizou o ZapLite no ChatGPT. Nada foi alterado.".into()
        } else {
            format!("O ChatGPT recusou o login: {e} {}", q.get("error_description").map(String::as_str).unwrap_or(""))
        });
    }
    let code = q.get("code").filter(|c| !c.is_empty()).ok_or("O retorno do login veio sem código.")?;
    let emitido = q.get("client_id").filter(|c| !c.is_empty()).cloned();
    // Reautorização: um client_id DIFERENTE do guardado é rejeitado.
    if client_id_atual != CLIENTE_DINAMICO {
        if let Some(c) = &emitido {
            if c != client_id_atual {
                return Err("O ChatGPT devolveu um cliente diferente do registrado. Por segurança, nada foi salvo.".into());
            }
        }
    }
    Ok(Retorno { code: code.clone(), client_id: emitido })
}

/// Claims do JWT, SEM verificar assinatura. Aceitável aqui pela regra do
/// OpenID Connect Core §3.1.3.7: o `id_token` chega pela troca DIRETA com o
/// endpoint de token, por TLS validado — a conexão autentica o emissor. As
/// demais checagens (iss, aud, exp, nonce) são feitas em `conferir_id_token`.
pub fn claims(jwt: &str) -> Option<Value> {
    use base64::Engine;
    let meio = jwt.split('.').nth(1)?;
    let bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD.decode(meio.trim_end_matches('=')).ok()?;
    serde_json::from_slice(&bytes).ok()
}

pub fn conferir_id_token(c: &Value, client_id: &str, nonce: &str, agora: u64) -> Result<(), String> {
    if c["iss"].as_str() != Some(EMISSOR) {
        return Err("id_token de um emissor inesperado.".into());
    }
    let aud_ok = match &c["aud"] {
        Value::String(s) => s == client_id,
        Value::Array(a) => a.iter().any(|x| x.as_str() == Some(client_id)),
        _ => false,
    };
    if !aud_ok {
        return Err("id_token não é para este cliente (aud).".into());
    }
    if c["exp"].as_u64().map_or(true, |e| e <= agora) {
        return Err("id_token expirado.".into());
    }
    if c["nonce"].as_str() != Some(nonce) {
        return Err("id_token não corresponde a esta tentativa (nonce).".into());
    }
    Ok(())
}

/// Corpo da Responses API. `store:false` e `stream:true` são obrigatórios
/// para o uso do plano, e a instrução de sistema vai em `instructions`: itens
/// `{role:"system"}` são REJEITADOS nesta rota ("Preview limitations").
pub fn corpo_da_resposta(modelo: &str, system: &str, prompt: &str, image_b64: Option<&str>, media_type: Option<&str>) -> Value {
    let mut conteudo = vec![json!({ "type": "input_text", "text": prompt })];
    if let Some(img) = image_b64 {
        let mt = media_type.unwrap_or("image/jpeg");
        conteudo.push(json!({ "type": "input_image", "image_url": format!("data:{mt};base64,{img}") }));
    }
    let mut corpo = json!({
        "model": modelo,
        "input": [{ "role": "user", "content": conteudo }],
        "store": false,
        "stream": true
    });
    if !system.trim().is_empty() {
        corpo["instructions"] = json!(system);
    }
    corpo
}

/// Mensagem em português para cada código documentado em "Errors and recovery".
pub fn erro_legivel(status: u16, codigo: &str, mensagem: &str) -> String {
    match codigo {
        "subscription_sharing_usage_limit_exceeded" => "Você atingiu o limite de uso do seu plano do ChatGPT. Veja o uso em ChatGPT › Configurações › Uso; o ZapLite não tenta de novo sozinho.".into(),
        "subscription_sharing_usage_unavailable" => "O ChatGPT não conseguiu conferir o uso do seu plano agora. Tente de novo em instantes.".into(),
        "subscription_sharing_user_not_eligible" => "O uso do plano do ChatGPT não está disponível para esta conta (precisa de Plus ou Pro, e a política do workspace precisa permitir).".into(),
        "subscription_sharing_invalid_user" => "O ChatGPT não conseguiu validar sua conta. Se continuar, saia e entre de novo no Painel.".into(),
        "subscription_sharing_route_not_supported" | "chatpass_v2_scope_not_authorized" | "chatpass_v2_invalid_authorization_context" => {
            format!("O ChatGPT recusou o pedido por configuração ({codigo}). Saia e entre de novo no Painel; se persistir, é defeito do ZapLite.")
        }
        _ if status == 401 => "O ChatGPT não aceitou o login. Se continuar, saia e entre de novo no Painel.".into(),
        _ => format!("ChatGPT respondeu {status}{}: {}", if codigo.is_empty() { String::new() } else { format!(" ({codigo})") }, ai::truncar(mensagem, 300)),
    }
}

fn erro_do_corpo(status: u16, corpo: &str) -> String {
    let v: Value = serde_json::from_str(corpo).unwrap_or(Value::Null);
    let e = if v["error"].is_object() { &v["error"] } else { &v };
    erro_legivel(status, e["code"].as_str().unwrap_or(""), e["message"].as_str().unwrap_or(corpo))
}

/// Lê o stream SSE da Responses API. Só é sucesso com `response.completed`.
pub fn ler_stream(sse: &str) -> Result<Resposta, String> {
    let mut deltas = String::new();
    for bloco in sse.split("\n\n") {
        let dados: String = bloco
            .lines()
            .filter_map(|l| l.strip_prefix("data:"))
            .map(str::trim_start)
            .collect::<Vec<_>>()
            .join("\n");
        if dados.is_empty() || dados == "[DONE]" {
            continue;
        }
        let Ok(ev) = serde_json::from_str::<Value>(&dados) else { continue };
        match ev["type"].as_str().unwrap_or("") {
            "response.output_text.delta" => deltas.push_str(ev["delta"].as_str().unwrap_or("")),
            "response.completed" => {
                let r = &ev["response"];
                let mut texto = String::new();
                for item in r["output"].as_array().into_iter().flatten() {
                    for c in item["content"].as_array().into_iter().flatten() {
                        if c["type"].as_str() == Some("output_text") {
                            texto.push_str(c["text"].as_str().unwrap_or(""));
                        }
                    }
                }
                if texto.trim().is_empty() {
                    texto = deltas.clone();
                }
                if texto.trim().is_empty() {
                    return Err("O ChatGPT concluiu sem texto na resposta.".into());
                }
                return Ok(Resposta { texto, modelo: r["model"].as_str().unwrap_or("").to_string() });
            }
            "response.failed" => {
                let e = &ev["response"]["error"];
                return Err(erro_legivel(200, e["code"].as_str().unwrap_or(""), e["message"].as_str().unwrap_or("falhou")));
            }
            "response.incomplete" => {
                let motivo = ev["response"]["incomplete_details"]["reason"].as_str().unwrap_or("sem motivo informado");
                return Err(format!("O ChatGPT interrompeu a resposta ({motivo})."));
            }
            "error" => {
                let e = if ev["error"].is_object() { &ev["error"] } else { &ev };
                return Err(erro_legivel(200, e["code"].as_str().unwrap_or(""), e["message"].as_str().unwrap_or("erro")));
            }
            _ => {}
        }
    }
    Err("A conexão com o ChatGPT caiu antes de a resposta terminar. Tente de novo.".into())
}

/// Catálogo da conta: a lista vem em `models` (não em `data`, como na API
/// comum — foi o defeito do primeiro teste real: tudo filtrado, lista vazia).
/// Só entradas com `visibility == "list"`; vale o `slug`; a ordem é a do
/// servidor.
pub fn modelos_da_conta(v: &Value) -> Vec<String> {
    let lista = if v["models"].is_array() { &v["models"] } else { &v["data"] };
    lista
        .as_array()
        .into_iter()
        .flatten()
        .filter(|m| m["visibility"].as_str() == Some("list"))
        .filter_map(|m| m["slug"].as_str().or_else(|| m["id"].as_str()).map(str::to_string))
        .collect()
}

/* --------------------------------------------------------------------------
   Rede e estado.
   -------------------------------------------------------------------------- */

/// Access token em memória (1 h). Nunca vai para disco.
static ACESSO: std::sync::Mutex<Option<(String, Instant)>> = std::sync::Mutex::new(None);
/// "Serialize refreshes": dois pedidos de IA ao mesmo tempo não podem gastar
/// o mesmo refresh token rotativo.
static RENOVANDO: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

fn esquecer_acesso() {
    *ACESSO.lock().unwrap_or_else(|e| e.into_inner()) = None;
}

async fn post_form(url: &str, corpo: String) -> Result<(u16, String), String> {
    let res = ai::http_client()?
        .post(url)
        .header("content-type", "application/x-www-form-urlencoded")
        .body(corpo)
        .timeout(Duration::from_secs(30))
        .send()
        .await
        .map_err(|e| format!("Falha de rede ao falar com o ChatGPT: {e}"))?;
    let status = res.status().as_u16();
    Ok((status, res.text().await.map_err(|e| e.to_string())?))
}

/// Access token válido, renovando se preciso. Persiste o refresh token novo.
pub async fn token_de_acesso(app: &AppHandle) -> Result<String, String> {
    let _fila = RENOVANDO.lock().await;
    if let Some((t, ate)) = ACESSO.lock().unwrap_or_else(|e| e.into_inner()).as_ref() {
        if Instant::now() + Duration::from_secs(60) < *ate {
            return Ok(t.clone());
        }
    }
    let s = crate::read_settings(app);
    let refresh = s["chatgptRefreshToken"].as_str().unwrap_or("").to_string();
    let client_id = s["chatgptClientId"].as_str().unwrap_or("").to_string();
    if refresh.is_empty() || client_id.is_empty() {
        return Err("Entre com sua conta ChatGPT no Painel (IA & TRANSCRIÇÃO) antes de usar a IA.".into());
    }
    // `scope` omitido de propósito: mantém o que foi concedido.
    let corpo = formulario(&[
        ("grant_type", "refresh_token"),
        ("client_id", &client_id),
        ("refresh_token", &refresh),
        ("resource", RECURSO),
    ]);
    let (status, texto) = post_form(TOKEN, corpo).await?;
    let v: Value = serde_json::from_str(&texto).unwrap_or(Value::Null);
    if status != 200 {
        if v["error"].as_str() == Some("invalid_grant") {
            // Refresh inutilizável: descarta e pede login de novo. Nunca insiste.
            let _ = crate::atualizar_settings(app, false, |x| {
                x["chatgptRefreshToken"] = json!("");
                Ok(())
            });
            esquecer_acesso();
            return Err("Seu login do ChatGPT expirou. Entre de novo no Painel (IA & TRANSCRIÇÃO).".into());
        }
        return Err(erro_do_corpo(status, &texto));
    }
    guardar_tokens(app, &v, None)?;
    ACESSO.lock().unwrap_or_else(|e| e.into_inner()).as_ref().map(|(t, _)| t.clone()).ok_or_else(|| "O ChatGPT não devolveu access token.".into())
}

/// Access em memória; refresh (rotativo) e, no login, os dados da conta em
/// disco — tudo numa gravação só.
fn guardar_tokens(app: &AppHandle, v: &Value, extra: Option<&dyn Fn(&mut Value)>) -> Result<(), String> {
    let acesso = v["access_token"].as_str().filter(|s| !s.is_empty()).ok_or("O ChatGPT não devolveu access token.")?;
    let expira = v["expires_in"].as_u64().unwrap_or(3600);
    let novo_refresh = v["refresh_token"].as_str().unwrap_or("").to_string();
    crate::atualizar_settings(app, extra.is_some(), |x| {
        if !novo_refresh.is_empty() {
            x["chatgptRefreshToken"] = json!(novo_refresh);
        }
        if let Some(f) = extra {
            f(x);
        }
        Ok(())
    })?;
    *ACESSO.lock().unwrap_or_else(|e| e.into_inner()) = Some((acesso.to_string(), Instant::now() + Duration::from_secs(expira)));
    Ok(())
}

/// Troca a `key` (refresh token) da config pelo access token da hora.
pub async fn preparar(app: &AppHandle, mut cfg: Config) -> Result<Config, String> {
    if cfg.provider == ai::Provider::ChatGPT {
        cfg.key = token_de_acesso(app).await?;
        if cfg.model.is_empty() {
            return Err("Escolha um modelo do ChatGPT no Painel (botão \"buscar lista\").".into());
        }
    }
    Ok(cfg)
}

pub async fn executar(cfg: &Config, system: &str, prompt: &str, image_b64: Option<&str>, media_type: Option<&str>) -> Result<Resposta, String> {
    let modelo = if image_b64.is_some() && !cfg.vision_model.is_empty() { &cfg.vision_model } else { &cfg.model };
    let res = ai::http_client()?
        .post(RESPOSTAS)
        .header("authorization", format!("Bearer {}", cfg.key))
        .header("content-type", "application/json")
        .json(&corpo_da_resposta(modelo, system, prompt, image_b64, media_type))
        .timeout(Duration::from_secs(180))
        .send()
        .await
        .map_err(|e| format!("Falha de rede ao falar com o ChatGPT: {e}"))?;
    let status = res.status().as_u16();
    let texto = res.text().await.map_err(|e| format!("A conexão com o ChatGPT caiu no meio da resposta: {e}"))?;
    if status == 401 {
        esquecer_acesso(); // a próxima chamada renova
    }
    if !(200..300).contains(&status) {
        return Err(erro_do_corpo(status, &texto));
    }
    ler_stream(&texto)
}

pub async fn listar_modelos(cfg: &Config) -> Result<Vec<String>, String> {
    let res = ai::http_client()?
        .get(MODELOS)
        .header("authorization", format!("Bearer {}", cfg.key))
        .timeout(Duration::from_secs(20))
        .send()
        .await
        .map_err(|e| format!("Falha de rede ao listar os modelos do ChatGPT: {e}"))?;
    let status = res.status().as_u16();
    let texto = res.text().await.map_err(|e| e.to_string())?;
    if status != 200 {
        return Err(erro_do_corpo(status, &texto));
    }
    let v: Value = serde_json::from_str(&texto).map_err(|e| format!("Catálogo do ChatGPT não era JSON ({e})."))?;
    let m = modelos_da_conta(&v);
    if m.is_empty() {
        // Só a FORMA da resposta (chaves e quantidades), para diagnóstico.
        let chaves: Vec<String> = v.as_object().map(|o| o.keys().cloned().collect()).unwrap_or_default();
        let n = v["models"].as_array().or_else(|| v["data"].as_array()).map(|a| a.len()).unwrap_or(0);
        return Err(format!(
            "Sua conta do ChatGPT não listou nenhum modelo disponível (resposta com chaves [{}] e {n} entradas).",
            chaves.join(", ")
        ));
    }
    Ok(m)
}

/// Espera UM retorno em `/auth/callback`. Mesmo desenho do OpenRouter
/// (`ai::esperar_retorno`): accept não-bloqueante, 3 min, porta fecha no fim.
async fn esperar_callback(listener: TcpListener) -> Result<HashMap<String, String>, String> {
    listener.set_nonblocking(true).map_err(|e| format!("Não consegui configurar o servidor local: {e}"))?;
    let limite = Instant::now() + Duration::from_secs(180);
    loop {
        match listener.accept() {
            Ok((mut stream, _)) => {
                let _ = stream.set_nonblocking(false);
                let _ = stream.set_read_timeout(Some(Duration::from_secs(3)));
                let mut buf = [0u8; 8192];
                let n = stream.read(&mut buf).unwrap_or(0);
                let texto = String::from_utf8_lossy(&buf[..n]);
                match ler_callback(texto.lines().next().unwrap_or("")) {
                    Some(q) => {
                        let (t, c) = if q.contains_key("code") {
                            ("Conectado ao ChatGPT", "Pode fechar esta aba e voltar ao ZapLite.")
                        } else {
                            ("Login não concluído", "Pode fechar esta aba; o ZapLite mostra o motivo.")
                        };
                        let _ = stream.write_all(ai::pagina(t, c).as_bytes());
                        let _ = stream.flush();
                        return Ok(q);
                    }
                    None => {
                        let _ = stream.write_all(b"HTTP/1.1 204 No Content\r\nConnection: close\r\n\r\n");
                    }
                }
            }
            Err(ref e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                if Instant::now() >= limite {
                    return Err("Tempo esgotado esperando o login do ChatGPT (3 min). Clique de novo em \"Entrar com ChatGPT\".".into());
                }
                tokio::time::sleep(Duration::from_millis(150)).await;
            }
            Err(e) => return Err(format!("Servidor local do login falhou: {e}")),
        }
    }
}

fn agora_unix() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

/* --------------------------------------------------------------------------
   Comandos do Painel.
   -------------------------------------------------------------------------- */

#[tauri::command]
pub async fn ai_oauth_chatgpt(app: AppHandle) -> Result<Value, String> {
    if ai::OAUTH_EM_ANDAMENTO.swap(true, Ordering::SeqCst) {
        return Err("Já existe um login em andamento. Conclua ou espere o tempo esgotar.".into());
    }
    let _trava = ai::Trava;

    let s = crate::read_settings(&app);
    // `ext_agent_host_id`: estável por máquina. Gerado uma vez e guardado.
    let host_id = match s["chatgptHostId"].as_str().filter(|h| host_id_valido(h)) {
        Some(h) => h.to_string(),
        None => {
            let h = novo_host_id();
            crate::atualizar_settings(&app, false, |x| {
                x["chatgptHostId"] = json!(h);
                Ok(())
            })?;
            h
        }
    };
    let client_id = s["chatgptClientId"].as_str().filter(|c| !c.is_empty()).unwrap_or(CLIENTE_DINAMICO).to_string();
    let email = s["chatgptEmail"].as_str().unwrap_or("").to_string();

    // O listener sobe ANTES de abrir o navegador. 1455 é a porta dos exemplos
    // da OpenAI; ocupada, qualquer outra (só a porta pode variar).
    let listener = TcpListener::bind(("127.0.0.1", PORTA_PREFERIDA))
        .or_else(|_| TcpListener::bind("127.0.0.1:0"))
        .map_err(|e| format!("Não consegui abrir o servidor local do login: {e}"))?;
    let porta = listener.local_addr().map_err(|e| e.to_string())?.port();
    let redirect = format!("http://127.0.0.1:{porta}{CAMINHO_RETORNO}");
    let state = aleatorio_hex(16);
    let nonce = aleatorio_hex(16);
    let verificador = ai::verificador_pkce();
    let url = url_de_autorizacao(&Pedido {
        client_id: &client_id,
        host_id: &host_id,
        redirect: &redirect,
        state: &state,
        nonce: &nonce,
        desafio: &ai::desafio_pkce(&verificador),
        email: &email,
    });
    {
        use tauri_plugin_opener::OpenerExt;
        app.opener().open_url(url, None::<&str>).map_err(|e| format!("Não consegui abrir o navegador: {e}"))?;
    }

    let q = esperar_callback(listener).await?;
    let ret = validar_callback(&q, &state, &client_id)?;
    let emitido = ret.client_id.clone().unwrap_or_else(|| client_id.clone());
    if emitido == CLIENTE_DINAMICO {
        return Err("O ChatGPT não informou o cliente registrado. Tente de novo.".into());
    }

    let (status, texto) = post_form(
        TOKEN,
        formulario(&[
            ("grant_type", "authorization_code"),
            ("client_id", &emitido),
            ("code", &ret.code),
            ("code_verifier", &verificador),
            ("redirect_uri", &redirect),
            ("resource", RECURSO),
        ]),
    )
    .await?;
    let v: Value = serde_json::from_str(&texto).unwrap_or(Value::Null);
    if status != 200 {
        if v["error"].as_str() == Some("invalid_grant") {
            return Err("O código do login expirou ou já foi usado. Clique de novo em \"Entrar com ChatGPT\".".into());
        }
        return Err(erro_do_corpo(status, &texto));
    }
    let idt = v["id_token"].as_str().and_then(claims).ok_or("O ChatGPT não devolveu id_token válido.")?;
    conferir_id_token(&idt, &emitido, &nonce, agora_unix())?;
    let escopos = v["scope"].as_str().unwrap_or("").to_string();
    let plano = escopos.split_whitespace().any(|e| e == ESCOPO_DO_PLANO);
    let novo_email = idt["email"].as_str().unwrap_or("").to_string();

    let emitido_c = emitido.clone();
    let email_c = novo_email.clone();
    guardar_tokens(&app, &v, Some(&move |x: &mut Value| {
        x["chatgptClientId"] = json!(emitido_c);
        x["chatgptEmail"] = json!(email_c);
        x["chatgptPlanUsage"] = json!(plano);
        if plano {
            x["aiProvider"] = json!("chatgpt");
        }
    }))?;

    if !plano {
        // Doc: mantém o login, marca uso do plano como indisponível e deixa o
        // usuário escolher outro caminho. Não troca o provedor.
        return Ok(json!({ "email": novo_email, "plano": false, "model": "" }));
    }

    // Modelo: o catálogo da conta decide. Mantém o atual se ele existe lá.
    let cfg = Config {
        provider: ai::Provider::ChatGPT,
        model: String::new(),
        key: token_atual().ok_or("O ChatGPT não devolveu access token.")?,
        base_url: String::new(),
        vision_model: String::new(),
    };
    let modelos = listar_modelos(&cfg).await.unwrap_or_default();
    let atual = crate::read_settings(&app)["aiModel"].as_str().unwrap_or("").to_string();
    let modelo = if modelos.contains(&atual) { atual } else { modelos.first().cloned().unwrap_or_default() };
    if !modelo.is_empty() {
        crate::atualizar_settings(&app, true, |x| {
            x["aiModel"] = json!(modelo);
            Ok(())
        })?;
    }
    Ok(json!({ "email": novo_email, "plano": true, "model": modelo, "modelos": modelos.len() }))
}

fn token_atual() -> Option<String> {
    ACESSO.lock().unwrap_or_else(|e| e.into_inner()).as_ref().map(|(t, _)| t.clone())
}

/// Sair: revoga o refresh token na OpenAI e apaga os tokens locais. Mantém
/// `chatgptClientId` e `chatgptHostId` — a doc pede reusar o registro no
/// próximo login da mesma conta nesta máquina.
#[tauri::command]
pub async fn ai_chatgpt_sair(app: AppHandle) -> Result<(), String> {
    let s = crate::read_settings(&app);
    let refresh = s["chatgptRefreshToken"].as_str().unwrap_or("").to_string();
    let client_id = s["chatgptClientId"].as_str().unwrap_or("").to_string();
    if !refresh.is_empty() && !client_id.is_empty() {
        let endpoint = async {
            let v: Value = ai::http_client()?.get(DESCOBERTA).timeout(Duration::from_secs(15)).send().await.map_err(|e| e.to_string())?.json().await.map_err(|e| e.to_string())?;
            v["revocation_endpoint"].as_str().map(str::to_string).ok_or_else(|| "sem revocation_endpoint".to_string())
        }
        .await;
        if let Ok(url) = endpoint {
            // 200 vazio é sucesso, inclusive para token já inválido. Falha de
            // rede não impede sair: os tokens locais somem de qualquer jeito.
            let _ = post_form(&url, formulario(&[("token", &refresh), ("token_type_hint", "refresh_token"), ("client_id", &client_id)])).await;
        }
    }
    esquecer_acesso();
    crate::atualizar_settings(&app, true, |x| {
        x["chatgptRefreshToken"] = json!("");
        x["chatgptPlanUsage"] = json!(false);
        Ok(())
    })?;
    Ok(())
}

#[cfg(test)]
mod testes {
    use super::*;

    #[test]
    fn primeiro_login_registra_dinamicamente_e_reautorizacao_nao() {
        let p = Pedido { client_id: CLIENTE_DINAMICO, host_id: "zaplite-ab", redirect: "http://127.0.0.1:1455/auth/callback",
            state: "s1", nonce: "n1", desafio: "d1", email: "" };
        let u = url_de_autorizacao(&p);
        assert!(u.starts_with("https://auth.openai.com/api/accounts/authorize?client_id=dynamic_agent_client&agent_name_hint=ZapLite&"));
        assert!(u.contains("redirect_uri=http%3A%2F%2F127.0.0.1%3A1455%2Fauth%2Fcallback"));
        assert!(u.contains("scope=openid%20profile%20email%20offline_access%20resource.invoke%20chatgpt.tokens.use.direct"));
        assert!(u.contains("resource=https%3A%2F%2Fapi.openai.com%2Fv1") && u.contains("code_challenge_method=S256"));
        assert!(!u.contains("login_hint"));
        let p2 = Pedido { client_id: "oaiapp_123", email: "a@b.com", ..p };
        let u2 = url_de_autorizacao(&p2);
        assert!(!u2.contains("agent_name_hint") && u2.contains("ext_agent_host_id=zaplite-ab") && u2.contains("login_hint=a%40b.com"));
    }

    #[test]
    fn callback_valida_state_primeiro_e_rejeita_cliente_trocado() {
        let q = ler_callback("GET /auth/callback?code=c%2B1&state=s1&client_id=oaiapp_9 HTTP/1.1").unwrap();
        assert_eq!(validar_callback(&q, "s1", CLIENTE_DINAMICO).unwrap(), Retorno { code: "c+1".into(), client_id: Some("oaiapp_9".into()) });
        assert!(validar_callback(&q, "outro", CLIENTE_DINAMICO).is_err(), "state errado");
        assert!(validar_callback(&q, "s1", "oaiapp_1").is_err(), "cliente diferente na reautorização");
        let negado = ler_callback("GET /auth/callback?error=access_denied&state=s1 HTTP/1.1").unwrap();
        assert!(validar_callback(&negado, "s1", CLIENTE_DINAMICO).unwrap_err().contains("não autorizou"));
        assert!(ler_callback("GET /favicon.ico HTTP/1.1").is_none());
        assert!(ler_callback("GET /callback?code=x HTTP/1.1").is_none(), "caminho exato /auth/callback");
    }

    #[test]
    fn id_token_confere_emissor_publico_validade_e_nonce() {
        use base64::Engine;
        let payload = json!({"iss":"https://auth.openai.com","aud":"oaiapp_9","exp":2000,"nonce":"n1","email":"a@b.com"});
        let jwt = format!("x.{}.y", base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(payload.to_string()));
        let c = claims(&jwt).unwrap();
        assert!(conferir_id_token(&c, "oaiapp_9", "n1", 1000).is_ok());
        assert!(conferir_id_token(&c, "oaiapp_X", "n1", 1000).is_err());
        assert!(conferir_id_token(&c, "oaiapp_9", "n2", 1000).is_err());
        assert!(conferir_id_token(&c, "oaiapp_9", "n1", 3000).is_err());
    }

    #[test]
    fn corpo_exige_store_falso_e_stream_verdadeiro() {
        let b = corpo_da_resposta("m", "sys", "oi", Some("QUJD"), Some("image/png"));
        assert_eq!((b["store"].as_bool(), b["stream"].as_bool()), (Some(false), Some(true)));
        assert_eq!(b["instructions"], "sys");
        assert_eq!(b["input"].as_array().unwrap().len(), 1, "nenhum item role=system");
        assert_eq!(b["input"][0]["role"], "user");
        assert_eq!(b["input"][0]["content"][1]["image_url"], "data:image/png;base64,QUJD");
    }

    #[test]
    fn stream_so_conta_com_completed_e_traduz_erros() {
        let ok = "event: response.output_text.delta\ndata: {\"type\":\"response.output_text.delta\",\"delta\":\"ol\"}\n\n\
                  event: response.completed\ndata: {\"type\":\"response.completed\",\"response\":{\"model\":\"m1\",\"output\":[{\"content\":[{\"type\":\"output_text\",\"text\":\"olá\"}]}]}}\n\n";
        assert_eq!(ler_stream(ok).unwrap(), Resposta { texto: "olá".into(), modelo: "m1".into() });
        let cortado = "data: {\"type\":\"response.output_text.delta\",\"delta\":\"ol\"}\n\n";
        assert!(ler_stream(cortado).unwrap_err().contains("caiu"));
        let limite = "data: {\"type\":\"response.failed\",\"response\":{\"error\":{\"code\":\"subscription_sharing_usage_limit_exceeded\",\"message\":\"x\"}}}\n\n";
        assert!(ler_stream(limite).unwrap_err().contains("limite de uso do seu plano"));
    }

    #[test]
    fn catalogo_so_mostra_visibilidade_list() {
        // formato documentado: `models`, ordem do servidor preservada
        let v = json!({"models":[{"slug":"z","visibility":"list"},{"slug":"b","visibility":"hide"},{"slug":"a","visibility":"list"}]});
        assert_eq!(modelos_da_conta(&v), vec!["z", "a"]);
        // retaguarda: `data`, se um dia vier no formato da API comum
        let v = json!({"data":[{"id":"c","visibility":"list"}]});
        assert_eq!(modelos_da_conta(&v), vec!["c"]);
    }

    #[test]
    fn host_id_e_urn_uuid_v4_e_o_formato_antigo_e_trocado() {
        let h = novo_host_id();
        assert!(h.starts_with("urn:uuid:") && host_id_valido(&h));
        let u = &h["urn:uuid:".len()..];
        let partes: Vec<&str> = u.split('-').collect();
        assert_eq!(partes.iter().map(|p| p.len()).collect::<Vec<_>>(), vec![8, 4, 4, 4, 12]);
        assert!(partes[2].starts_with('4'), "versão 4");
        assert!(matches!(partes[3].chars().next(), Some('8' | '9' | 'a' | 'b')), "variante");
        assert_ne!(novo_host_id(), h);
        assert!(!host_id_valido("zaplite-0123abcd"), "formato das primeiras builds");
    }

    #[test]
    fn formulario_codifica_tudo() {
        assert_eq!(formulario(&[("a b", "x&y=z")]), "a%20b=x%26y%3Dz");
    }
}
