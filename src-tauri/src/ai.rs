//! Camada de IA multi-provedor.
//!
//! `ai_complete` continua com a MESMA assinatura que os módulos do bundle já
//! usam (`{system, prompt, imageB64, mediaType}`); o que muda é que agora ele
//! despacha para o provedor configurado. Toda a diferença de formato — papel de
//! sistema, imagem, leitura da resposta, forma do erro — é normalizada aqui
//! dentro, no Rust. A página nunca vê chave nenhuma: `CHAVES_PUBLICAS`
//! (lib.rs) é uma allowlist, então cada campo novo de chave criado aqui nasce
//! invisível para a origem remota.

use base64::Engine;
use serde_json::{json, Value};
use std::io::{Read, Write};
use std::net::TcpListener;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};
use tauri::AppHandle;

// ---------------------------------------------------------------------------
// Provedores
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Provider {
    Anthropic,
    OpenAI,
    Gemini,
    OpenRouter,
    /// Qualquer endpoint que fale o dialeto `chat/completions` da OpenAI:
    /// Ollama, LM Studio, Groq, DeepSeek, vLLM, Together… inclusive local e
    /// sem chave nenhuma.
    Compatible,
    /// OmniRoute — roteador local (https://github.com/diegosouzapw/OmniRoute).
    /// Fala o dialeto da OpenAI em `http://localhost:20128/v1`, não pede chave
    /// e expõe apelidos `auto/*` que escolhem o modelo real por tarefa.
    OmniRoute,
}

/// URL base de fábrica do OmniRoute. Editável no Painel — a porta pode mudar.
pub const OMNIROUTE_BASE_PADRAO: &str = "http://localhost:20128/v1";

/// N4 — modelo usado quando a chamada leva IMAGEM (OCR, detector de golpe).
///
/// MEDIDO no endpoint real: os apelidos `auto/*` — inclusive `auto/best-vision`
/// — descartam as partes `image_url` antes de rotear, e o modelo responde
/// "não recebi nenhuma imagem". Um id concreto de modelo com visão recebe a
/// imagem e acerta. Por isso a chamada com imagem sai deste modelo concreto e
/// barato, e não do apelido. Trocável em `aiVisionModel` no settings.json
/// (campo "Modelo para imagem" no Painel), para quem tem outro catálogo.
pub const OMNIROUTE_MODELO_VISAO: &str = "claude/claude-haiku-4-5-20251001";

impl Provider {
    pub fn from_id(id: &str) -> Option<Provider> {
        match id.trim().to_ascii_lowercase().as_str() {
            "anthropic" => Some(Provider::Anthropic),
            "openai" => Some(Provider::OpenAI),
            "gemini" | "google" => Some(Provider::Gemini),
            "openrouter" => Some(Provider::OpenRouter),
            "compatible" | "compativel" | "openai-compatible" => Some(Provider::Compatible),
            "omniroute" | "omni-route" => Some(Provider::OmniRoute),
            _ => None,
        }
    }

    /// Provedores que falam o dialeto `chat/completions` da OpenAI.
    pub fn e_dialeto_openai(&self) -> bool {
        matches!(
            self,
            Provider::OpenAI | Provider::OpenRouter | Provider::Compatible | Provider::OmniRoute
        )
    }

    pub fn id(&self) -> &'static str {
        match self {
            Provider::Anthropic => "anthropic",
            Provider::OpenAI => "openai",
            Provider::Gemini => "gemini",
            Provider::OpenRouter => "openrouter",
            Provider::Compatible => "compatible",
            Provider::OmniRoute => "omniroute",
        }
    }

    pub fn label(&self) -> &'static str {
        match self {
            Provider::Anthropic => "Anthropic (Claude)",
            Provider::OpenAI => "OpenAI",
            Provider::Gemini => "Google Gemini",
            Provider::OpenRouter => "OpenRouter",
            Provider::Compatible => "Compatível com OpenAI (URL base)",
            Provider::OmniRoute => "OmniRoute (roteador local)",
        }
    }

    /// Campo do settings.json onde a chave desse provedor mora. É SEGREDO:
    /// nunca entra em `CHAVES_PUBLICAS`.
    pub fn key_field(&self) -> &'static str {
        match self {
            Provider::Anthropic => "anthropicKey",
            Provider::OpenAI => "openaiKey",
            Provider::Gemini => "geminiKey",
            Provider::OpenRouter => "openrouterKey",
            Provider::Compatible => "compatibleKey",
            Provider::OmniRoute => "omnirouteKey",
        }
    }

    pub fn default_model(&self) -> &'static str {
        match self {
            Provider::Anthropic => "claude-haiku-4-5-20251001",
            Provider::OpenAI => "gpt-4o-mini",
            Provider::Gemini => "gemini-2.0-flash",
            Provider::OpenRouter => "anthropic/claude-3.5-haiku",
            Provider::Compatible => "llama3.1",
            Provider::OmniRoute => "auto/best-fast",
        }
    }

    /// O modo compatível cobre servidor local (Ollama/LM Studio) e o OmniRoute
    /// roda na máquina do usuário: nenhum dos dois pede chave (mas aceitam uma,
    /// se o usuário configurar). Todos os outros pedem.
    pub fn requires_key(&self) -> bool {
        !matches!(self, Provider::Compatible | Provider::OmniRoute)
    }

    /// URL base de fábrica, quando o provedor tem uma. Só o OmniRoute tem:
    /// o modo compatível é genérico demais para chutar.
    pub fn default_base_url(&self) -> &'static str {
        match self {
            Provider::OmniRoute => OMNIROUTE_BASE_PADRAO,
            _ => "",
        }
    }

    /// A URL base é editável e significativa nestes dois — nos outros ela é
    /// resto de configuração antiga.
    pub fn usa_base_url(&self) -> bool {
        matches!(self, Provider::Compatible | Provider::OmniRoute)
    }
}

/// Todos os campos de chave existentes. Usado pelo teste que garante que
/// nenhum deles atravessa `load_settings_public`.
#[allow(dead_code)] // só os testes leem; existe para nenhum campo novo escapar deles
pub const CAMPOS_DE_CHAVE: &[&str] = &[
    "anthropicKey",
    "openaiKey",
    "geminiKey",
    "openrouterKey",
    "compatibleKey",
    "omnirouteKey",
];

#[allow(dead_code)] // idem
pub const TODOS_OS_PROVEDORES: &[Provider] = &[
    Provider::Anthropic,
    Provider::OpenAI,
    Provider::Gemini,
    Provider::OpenRouter,
    Provider::Compatible,
    Provider::OmniRoute,
];

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Config {
    pub provider: Provider,
    pub model: String,
    pub key: String,
    pub base_url: String,
    /// Modelo usado só quando a chamada leva imagem. Vazio = usa `model`.
    pub vision_model: String,
}

/// Lê o settings.json e decide qual provedor usar.
///
/// O4 — migração silenciosa: quem já tinha só `anthropicKey` configurada e
/// nunca escolheu provedor continua no Anthropic, sem tocar em nada.
pub fn resolve(settings: &Value) -> Result<Config, String> {
    let escolhido = settings["aiProvider"].as_str().unwrap_or("").trim();
    let anthropic_key = settings["anthropicKey"].as_str().unwrap_or("").trim();

    let provider = if escolhido.is_empty() {
        if anthropic_key.is_empty() {
            return Err(
                "Escolha um provedor de IA no Painel (aba IA) e configure a chave dele.".into(),
            );
        }
        Provider::Anthropic
    } else {
        Provider::from_id(escolhido)
            .ok_or_else(|| format!("Provedor de IA desconhecido: {escolhido}. Reescolha no Painel (aba IA)."))?
    };

    let model = settings["aiModel"]
        .as_str()
        .unwrap_or("")
        .trim()
        .to_string();
    let model = if model.is_empty() {
        provider.default_model().to_string()
    } else {
        model
    };

    let key = settings[provider.key_field()]
        .as_str()
        .unwrap_or("")
        .trim()
        .to_string();
    if provider.requires_key() && key.is_empty() {
        return Err(format!(
            "Configure a chave de {} no Painel (aba IA).",
            provider.label()
        ));
    }

    let base_url = settings["aiBaseUrl"]
        .as_str()
        .unwrap_or("")
        .trim()
        .trim_end_matches('/')
        .to_string();
    // O OmniRoute tem porta de fábrica: campo vazio não é erro, é o padrão.
    let base_url = if base_url.is_empty() {
        provider.default_base_url().to_string()
    } else {
        base_url
    };
    if provider == Provider::Compatible && base_url.is_empty() {
        return Err(
            "Informe a URL base do endpoint compatível no Painel (ex.: http://localhost:11434/v1)."
                .into(),
        );
    }

    // N4 — o modelo de imagem sai do campo "Modelo para imagem" do Painel, e
    // vale para QUALQUER provedor. Antes só o OmniRoute o lia, e isso deixava
    // um buraco medido nesta máquina: apontar o modo "Compatível com OpenAI"
    // para a MESMA porta do OmniRoute (que é o que a URL base padrão faz)
    // é uma configuração legítima e comum — e nela toda chamada com imagem ia
    // para o apelido `auto/*`, que descarta a imagem. O que continua exclusivo
    // do OmniRoute é o PADRÃO de fábrica: só nele sabemos, sem perguntar, que
    // id concreto existe no catálogo.
    let escolhido = settings["aiVisionModel"].as_str().unwrap_or("").trim();
    let vision_model = if !escolhido.is_empty() {
        escolhido.to_string()
    } else if provider == Provider::OmniRoute {
        OMNIROUTE_MODELO_VISAO.to_string()
    } else {
        String::new()
    };

    Ok(Config {
        provider,
        model,
        key,
        base_url,
        vision_model,
    })
}

// ---------------------------------------------------------------------------
// Montagem da requisição (função PURA — é o que os testes cobrem)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Requisicao {
    pub url: String,
    pub headers: Vec<(String, String)>,
    pub body: Value,
}

const MAX_TOKENS: u32 = 1024;

pub fn build_request(
    cfg: &Config,
    system: &str,
    prompt: &str,
    image_b64: Option<&str>,
    media_type: Option<&str>,
) -> Requisicao {
    let system = system.trim();
    let mime = media_type.unwrap_or("image/jpeg");

    match cfg.provider {
        Provider::Anthropic => {
            let mut content: Vec<Value> = Vec::new();
            if let Some(img) = image_b64 {
                content.push(json!({
                    "type": "image",
                    "source": { "type": "base64", "media_type": mime, "data": img }
                }));
            }
            content.push(json!({ "type": "text", "text": prompt }));

            let mut body = json!({
                "model": cfg.model,
                "max_tokens": MAX_TOKENS,
                "messages": [{ "role": "user", "content": content }]
            });
            if !system.is_empty() {
                body["system"] = json!(system);
            }
            Requisicao {
                url: "https://api.anthropic.com/v1/messages".into(),
                headers: vec![
                    ("x-api-key".into(), cfg.key.clone()),
                    ("anthropic-version".into(), "2023-06-01".into()),
                    ("content-type".into(), "application/json".into()),
                ],
                body,
            }
        }

        Provider::Gemini => {
            let mut parts: Vec<Value> = Vec::new();
            if let Some(img) = image_b64 {
                parts.push(json!({ "inline_data": { "mime_type": mime, "data": img } }));
            }
            parts.push(json!({ "text": prompt }));

            let mut body = json!({
                "contents": [{ "role": "user", "parts": parts }],
                "generationConfig": { "maxOutputTokens": MAX_TOKENS }
            });
            if !system.is_empty() {
                body["systemInstruction"] = json!({ "parts": [{ "text": system }] });
            }
            Requisicao {
                url: format!(
                    "https://generativelanguage.googleapis.com/v1beta/models/{}:generateContent",
                    cfg.model
                ),
                headers: vec![
                    ("x-goog-api-key".into(), cfg.key.clone()),
                    ("content-type".into(), "application/json".into()),
                ],
                body,
            }
        }

        // OpenAI, OpenRouter, "compatível" e OmniRoute falam o MESMO dialeto.
        Provider::OpenAI | Provider::OpenRouter | Provider::Compatible | Provider::OmniRoute => {
            let user_content: Value = match image_b64 {
                Some(img) => json!([
                    { "type": "image_url", "image_url": { "url": format!("data:{mime};base64,{img}") } },
                    { "type": "text", "text": prompt }
                ]),
                None => json!(prompt),
            };
            let mut messages: Vec<Value> = Vec::new();
            if !system.is_empty() {
                messages.push(json!({ "role": "system", "content": system }));
            }
            messages.push(json!({ "role": "user", "content": user_content }));

            // N4 — chamada COM imagem vai para um modelo que enxerga.
            let modelo = if image_b64.is_some() && !cfg.vision_model.trim().is_empty() {
                cfg.vision_model.trim().to_string()
            } else {
                cfg.model.clone()
            };

            // N1 — `stream` EXPLICITAMENTE falso. O OmniRoute faz streaming por
            // padrão e devolveria SSE (`data: …`), que não é JSON; os outros
            // três já se comportam assim e ignoram o campo.
            let mut body = json!({ "model": modelo, "messages": messages, "stream": false });
            // A OpenAI recusa `max_tokens` nos modelos novos (o-series/gpt-5);
            // Ollama e LM Studio não conhecem `max_completion_tokens`. Cada um
            // recebe o campo que entende.
            if cfg.provider == Provider::OpenAI {
                body["max_completion_tokens"] = json!(MAX_TOKENS);
            } else {
                body["max_tokens"] = json!(MAX_TOKENS);
            }

            let mut headers = vec![("content-type".to_string(), "application/json".to_string())];
            if !cfg.key.is_empty() {
                headers.push(("authorization".into(), format!("Bearer {}", cfg.key)));
            }
            if cfg.provider == Provider::OpenRouter {
                // Atribuição opcional do OpenRouter. Só o nome — nada de
                // `HTTP-Referer` inventado apontando para um site que não existe.
                headers.push(("X-Title".into(), "ZapLite".into()));
            }

            Requisicao {
                url: endpoint_chat(cfg),
                headers,
                body,
            }
        }
    }
}

fn base_openai(cfg: &Config) -> &str {
    match cfg.provider {
        Provider::OpenAI => "https://api.openai.com/v1",
        Provider::OpenRouter => "https://openrouter.ai/api/v1",
        _ => cfg.base_url.trim_end_matches('/'),
    }
}

fn endpoint_chat(cfg: &Config) -> String {
    let base = base_openai(cfg);
    // Se o usuário já colou o caminho completo, respeita.
    if base.ends_with("/chat/completions") {
        base.to_string()
    } else {
        format!("{}/chat/completions", base.trim_end_matches('/'))
    }
}

/// N3 — `GET /v1/models`, o catálogo do dialeto OpenAI. Tolera a URL base
/// colada com o caminho de chat já no fim.
pub fn endpoint_models(cfg: &Config) -> String {
    let base = base_openai(cfg);
    let base = base
        .trim_end_matches('/')
        .trim_end_matches("/chat/completions")
        .trim_end_matches('/');
    format!("{base}/models")
}

// ---------------------------------------------------------------------------
// Leitura da resposta (PURA)
// ---------------------------------------------------------------------------

pub fn extract_text(provider: Provider, data: &Value) -> String {
    match provider {
        Provider::Anthropic => juntar_textos(data["content"].as_array()),
        Provider::Gemini => {
            juntar_textos(data["candidates"][0]["content"]["parts"].as_array())
        }
        Provider::OpenAI | Provider::OpenRouter | Provider::Compatible | Provider::OmniRoute => {
            let c = &data["choices"][0]["message"]["content"];
            match c {
                Value::String(s) => s.clone(),
                // alguns servidores compatíveis devolvem o conteúdo em partes
                Value::Array(_) => juntar_textos(c.as_array()),
                _ => String::new(),
            }
        }
    }
}

/// Modelo que REALMENTE respondeu. Num roteador como o OmniRoute isso difere
/// do que foi pedido (`auto/best-fast` → `gpt-4.1-mini`) e é a informação útil.
/// Vazio quando o provedor não diz.
pub fn extract_model(provider: Provider, data: &Value) -> String {
    let campo = match provider {
        Provider::Gemini => &data["modelVersion"],
        _ => &data["model"],
    };
    campo.as_str().unwrap_or("").trim().to_string()
}

/// Lê a lista de `GET /v1/models` no formato OpenAI (`{"data":[{"id":…}]}`).
pub fn extract_models(data: &Value) -> Vec<String> {
    data["data"]
        .as_array()
        .map(|v| {
            v.iter()
                .filter_map(|m| m["id"].as_str())
                .filter(|s| !s.trim().is_empty())
                .map(|s| s.to_string())
                .collect()
        })
        .unwrap_or_default()
}

fn juntar_textos(blocos: Option<&Vec<Value>>) -> String {
    blocos
        .map(|bs| {
            bs.iter()
                .filter_map(|b| b["text"].as_str())
                .collect::<Vec<_>>()
                .join("\n")
        })
        .unwrap_or_default()
}

/// Mensagem de erro legível. Os quatro formatos convergem em `error.message`,
/// mas servidor local costuma inventar — por isso a cascata e o cru truncado
/// no fim. O que sai daqui sobe pelo `invoke` e aparece na tela do usuário.
pub fn extract_error(status: u16, corpo: &str) -> String {
    let data: Value = serde_json::from_str(corpo).unwrap_or(Value::Null);
    let candidatos = [
        data["error"]["message"].as_str(),
        data["error"]["metadata"]["raw"].as_str(),
        data["error"].as_str(),
        data["message"].as_str(),
        data["detail"].as_str(),
        data[0]["error"]["message"].as_str(),
    ];
    let detalhe = candidatos
        .iter()
        .find_map(|c| c.filter(|s| !s.trim().is_empty()))
        .map(|s| s.to_string())
        .unwrap_or_else(|| truncar(corpo.trim(), 400));
    let detalhe = if detalhe.is_empty() {
        "sem detalhe no corpo da resposta".to_string()
    } else {
        detalhe
    };
    format!("API retornou {status}: {detalhe}")
}

fn truncar(s: &str, n: usize) -> String {
    if s.chars().count() <= n {
        s.to_string()
    } else {
        let mut r: String = s.chars().take(n).collect();
        r.push('…');
        r
    }
}

/// Últimos 4 caracteres da chave, para o Painel mostrar estado sem exibir o
/// segredo. Chave curta demais vira só pontinhos.
pub fn mascarar(key: &str) -> String {
    let k = key.trim();
    if k.is_empty() {
        return String::new();
    }
    let n = k.chars().count();
    if n <= 4 {
        return "••••".into();
    }
    format!("••••{}", k.chars().skip(n - 4).collect::<String>())
}

// ---------------------------------------------------------------------------
// Execução
// ---------------------------------------------------------------------------

/// Resultado de uma chamada: o texto e o modelo que de fato respondeu.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Resposta {
    pub texto: String,
    /// Modelo REAL que respondeu (num roteador, ≠ do pedido). Pode vir vazio.
    pub modelo: String,
}

pub async fn executar(
    cfg: &Config,
    system: &str,
    prompt: &str,
    image_b64: Option<&str>,
    media_type: Option<&str>,
) -> Result<String, String> {
    Ok(executar_detalhado(cfg, system, prompt, image_b64, media_type)
        .await?
        .texto)
}

pub async fn executar_detalhado(
    cfg: &Config,
    system: &str,
    prompt: &str,
    image_b64: Option<&str>,
    media_type: Option<&str>,
) -> Result<Resposta, String> {
    let req = build_request(cfg, system, prompt, image_b64, media_type);

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(120))
        .build()
        .map_err(|e| format!("Falha ao criar cliente HTTP: {e}"))?;

    let mut rb = client.post(&req.url);
    for (k, v) in &req.headers {
        rb = rb.header(k.as_str(), v.as_str());
    }
    let res = rb
        .json(&req.body)
        .send()
        .await
        .map_err(|e| format!("Falha de rede ao falar com {} ({}): {e}", cfg.provider.label(), req.url))?;

    let status = res.status();
    let corpo = res
        .text()
        .await
        .map_err(|e| format!("Resposta ilegível: {e}"))?;

    if !status.is_success() {
        return Err(extract_error(status.as_u16(), &corpo));
    }

    let data: Value = serde_json::from_str(&corpo).map_err(|e| {
        // Sintoma clássico de streaming ligado (SSE), não de servidor quebrado.
        if corpo.trim_start().starts_with("data:") {
            format!(
                "O endpoint respondeu em streaming (SSE) em vez de JSON. \
                 Confira se ele aceita \"stream\": false: {}",
                truncar(corpo.trim(), 200)
            )
        } else {
            format!("Resposta não era JSON ({e}): {}", truncar(corpo.trim(), 300))
        }
    })?;

    let texto = extract_text(cfg.provider, &data);
    if texto.trim().is_empty() {
        return Err(format!(
            "O provedor respondeu sem texto utilizável: {}",
            truncar(corpo.trim(), 300)
        ));
    }
    Ok(Resposta {
        texto,
        modelo: extract_model(cfg.provider, &data),
    })
}

/// N3 — catálogo de modelos do provedor. Só faz sentido no dialeto OpenAI;
/// nos outros o Painel cai no campo livre.
pub async fn listar_modelos(cfg: &Config) -> Result<Vec<String>, String> {
    if !cfg.provider.e_dialeto_openai() {
        return Err(format!(
            "{} não publica catálogo de modelos neste formato.",
            cfg.provider.label()
        ));
    }
    let url = endpoint_models(cfg);
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(20))
        .build()
        .map_err(|e| format!("Falha ao criar cliente HTTP: {e}"))?;

    let mut rb = client.get(&url);
    if !cfg.key.is_empty() {
        rb = rb.header("authorization", format!("Bearer {}", cfg.key));
    }
    let res = rb
        .send()
        .await
        .map_err(|e| format!("Falha de rede ao listar modelos em {url}: {e}"))?;

    let status = res.status();
    let corpo = res
        .text()
        .await
        .map_err(|e| format!("Resposta ilegível: {e}"))?;
    if !status.is_success() {
        return Err(extract_error(status.as_u16(), &corpo));
    }
    let data: Value = serde_json::from_str(&corpo)
        .map_err(|e| format!("Catálogo não era JSON ({e}): {}", truncar(corpo.trim(), 200)))?;
    let mut modelos = extract_models(&data);
    if modelos.is_empty() {
        return Err("O endpoint respondeu, mas sem nenhum modelo na lista.".into());
    }
    modelos.sort();
    modelos.dedup();
    Ok(modelos)
}

// ---------------------------------------------------------------------------
// OAuth PKCE — OpenRouter
// ---------------------------------------------------------------------------
//
// É o ÚNICO dos provedores suportados com fluxo OAuth documentado para obter
// uma chave de usuário sem ele colar nada:
//   1. abre https://openrouter.ai/auth?callback_url=…&code_challenge=…&code_challenge_method=S256
//   2. o consentimento volta para um servidor efêmero em 127.0.0.1 com ?code=…
//   3. POST https://openrouter.ai/api/v1/auth/keys {code, code_verifier, code_challenge_method}
//      devolve {"key": "sk-or-…"}
// O consentimento abre no NAVEGADOR DO SISTEMA — nunca dentro da webview do
// WhatsApp, que roda a sessão real do usuário.

static OAUTH_EM_ANDAMENTO: AtomicBool = AtomicBool::new(false);

const OAUTH_TIMEOUT: Duration = Duration::from_secs(180);

/// Guarda que solta o "em andamento" mesmo se a função sair por `?`.
struct Trava;
impl Drop for Trava {
    fn drop(&mut self) {
        OAUTH_EM_ANDAMENTO.store(false, Ordering::SeqCst);
    }
}

fn verificador_pkce() -> String {
    use rand::Rng;
    const ALFABETO: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~";
    let mut rng = rand::rng();
    (0..64)
        .map(|_| ALFABETO[rng.random_range(0..ALFABETO.len())] as char)
        .collect()
}

pub fn desafio_pkce(verificador: &str) -> String {
    use sha2::{Digest, Sha256};
    let hash = Sha256::digest(verificador.as_bytes());
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(hash)
}

pub fn url_de_autorizacao(callback: &str, desafio: &str) -> String {
    format!(
        "https://openrouter.ai/auth?callback_url={}&code_challenge={}&code_challenge_method=S256",
        percent(callback),
        percent(desafio)
    )
}

/// Percent-encoding mínimo (não vale a pena uma dependência para isto).
fn percent(s: &str) -> String {
    let mut out = String::with_capacity(s.len() * 3);
    for b in s.as_bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(*b as char)
            }
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

/// Extrai `code` ou `error` da primeira linha de uma requisição HTTP
/// (`GET /callback?code=abc HTTP/1.1`). Devolve `None` se a linha não trouxer
/// nenhum dos dois — o navegador abre sockets de preconnect sem nada dentro.
pub fn ler_retorno(linha_de_requisicao: &str) -> Option<Result<String, String>> {
    let alvo = linha_de_requisicao.split_whitespace().nth(1)?;
    let query = alvo.split_once('?')?.1;
    let mut code = None;
    let mut erro = None;
    for par in query.split('&') {
        let (k, v) = par.split_once('=').unwrap_or((par, ""));
        match k {
            "code" => code = Some(despercent(v)),
            "error" | "error_description" => {
                if erro.is_none() || k == "error_description" {
                    erro = Some(despercent(v));
                }
            }
            _ => {}
        }
    }
    match (code, erro) {
        (Some(c), _) if !c.is_empty() => Some(Ok(c)),
        (_, Some(e)) => Some(Err(e)),
        _ => None,
    }
}

fn despercent(s: &str) -> String {
    let bytes = s.replace('+', " ").into_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let Ok(b) = u8::from_str_radix(
                std::str::from_utf8(&bytes[i + 1..i + 3]).unwrap_or("zz"),
                16,
            ) {
                out.push(b);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn pagina(titulo: &str, corpo: &str) -> String {
    let html = format!(
        "<!doctype html><html lang=pt-BR><meta charset=utf-8>\
         <title>ZapLite</title>\
         <body style=\"font:16px/1.6 system-ui;background:#0b0f14;color:#e6edf3;\
         display:flex;align-items:center;justify-content:center;height:100vh;margin:0\">\
         <div style=\"text-align:center;max-width:32rem;padding:2rem\">\
         <h1 style=\"font-size:1.25rem;margin:0 0 .5rem\">{titulo}</h1>\
         <p style=\"color:#8b949e;margin:0\">{corpo}</p></div>"
    );
    format!(
        "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
        html.len(),
        html
    )
}

/// Sobe o servidor efêmero, espera UM retorno e o derruba. Devolve o `code`.
/// Nunca bloqueia o loop de eventos do app: o accept é não-bloqueante e a
/// espera é `tokio::time::sleep`.
async fn esperar_retorno(listener: TcpListener) -> Result<String, String> {
    listener
        .set_nonblocking(true)
        .map_err(|e| format!("Não consegui configurar o servidor local: {e}"))?;
    let limite = Instant::now() + OAUTH_TIMEOUT;

    loop {
        match listener.accept() {
            Ok((mut stream, _)) => {
                let _ = stream.set_read_timeout(Some(Duration::from_secs(3)));
                let _ = stream.set_nonblocking(false);
                let mut buf = [0u8; 4096];
                let n = stream.read(&mut buf).unwrap_or(0);
                let texto = String::from_utf8_lossy(&buf[..n]);
                let primeira = texto.lines().next().unwrap_or("");

                match ler_retorno(primeira) {
                    Some(Ok(code)) => {
                        let _ = stream.write_all(
                            pagina(
                                "Conectado ao OpenRouter",
                                "Pode fechar esta aba e voltar ao ZapLite.",
                            )
                            .as_bytes(),
                        );
                        let _ = stream.flush();
                        // `listener` cai aqui: a porta deixa de escutar.
                        return Ok(code);
                    }
                    Some(Err(e)) => {
                        let _ = stream.write_all(
                            pagina("Autorização recusada", "Pode fechar esta aba.").as_bytes(),
                        );
                        let _ = stream.flush();
                        return Err(format!("O OpenRouter recusou a autorização: {e}"));
                    }
                    // preconnect / favicon / qualquer outra coisa: ignora
                    None => {
                        let _ = stream
                            .write_all(b"HTTP/1.1 204 No Content\r\nConnection: close\r\n\r\n");
                        let _ = stream.flush();
                    }
                }
            }
            Err(ref e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                if Instant::now() >= limite {
                    return Err(
                        "Tempo esgotado esperando a autorização do OpenRouter (3 min). \
                         Se você fechou a aba do navegador, é só clicar de novo em \
                         \"Conectar com OpenRouter\"."
                            .into(),
                    );
                }
                tokio::time::sleep(Duration::from_millis(150)).await;
            }
            Err(e) => return Err(format!("Servidor local do OAuth falhou: {e}")),
        }
    }
}

async fn trocar_code_por_chave(code: &str, verificador: &str) -> Result<String, String> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(|e| format!("Falha ao criar cliente HTTP: {e}"))?;
    let res = client
        .post("https://openrouter.ai/api/v1/auth/keys")
        .header("content-type", "application/json")
        .json(&json!({
            "code": code,
            "code_verifier": verificador,
            "code_challenge_method": "S256"
        }))
        .send()
        .await
        .map_err(|e| format!("Falha de rede ao trocar o código pela chave: {e}"))?;

    let status = res.status();
    let corpo = res.text().await.map_err(|e| e.to_string())?;
    if !status.is_success() {
        return Err(extract_error(status.as_u16(), &corpo));
    }
    let data: Value = serde_json::from_str(&corpo).map_err(|e| format!("Resposta inválida: {e}"))?;
    let chave = data["key"].as_str().unwrap_or("").trim().to_string();
    if chave.is_empty() {
        return Err("O OpenRouter não devolveu chave nenhuma.".into());
    }
    Ok(chave)
}

// ---------------------------------------------------------------------------
// Comandos Tauri
// ---------------------------------------------------------------------------

/// Chama o provedor de IA configurado. Assinatura INTOCADA — os módulos do
/// bundle (resumo, sugerir resposta, tradução, OCR, detector de golpe) não
/// mudam uma linha.
#[tauri::command]
pub async fn ai_complete(
    app: AppHandle,
    system: String,
    prompt: String,
    image_b64: Option<String>,
    media_type: Option<String>,
) -> Result<String, String> {
    let settings = crate::read_settings(&app);
    let cfg = resolve(&settings)?;
    if image_b64.is_some() {
        conferir_visao(&cfg)?;
    }
    executar(
        &cfg,
        &system,
        &prompt,
        image_b64.as_deref(),
        media_type.as_deref(),
    )
    .await
}

/// N4(b) — apelido `auto/*` recebendo imagem é uma resposta ERRADA com cara de
/// certa, e isso é pior do que uma falha.
///
/// Medido no endpoint real: o roteador descarta as partes de imagem ANTES de
/// escolher o modelo, e a resposta que volta é um educado "não recebi nenhuma
/// imagem". Quem chamou recebe `Ok(...)`, o painel mostra o texto, e o usuário
/// conclui que o OCR não funciona — sem nenhum erro em lugar nenhum. Aqui isso
/// vira falha, com o caminho de saída escrito por extenso.
pub fn conferir_visao(cfg: &Config) -> Result<(), String> {
    let modelo = if cfg.vision_model.trim().is_empty() {
        cfg.model.trim()
    } else {
        cfg.vision_model.trim()
    };
    if modelo.starts_with("auto/") {
        return Err(format!(
            "A imagem iria para o apelido `{modelo}`, e o roteador descarta a imagem antes de \
             escolher o modelo real — a resposta voltaria dizendo que nenhuma imagem chegou. \
             Preencha \"Modelo para imagem\" no Painel (aba IA) com um id concreto de modelo \
             com visao, por exemplo {OMNIROUTE_MODELO_VISAO}."
        ));
    }
    Ok(())
}

/// Estado da camada de IA para o Painel. NUNCA devolve a chave — só os
/// últimos 4 caracteres.
#[tauri::command]
pub fn ai_status(app: AppHandle) -> Value {
    let settings = crate::read_settings(&app);
    match resolve(&settings) {
        Ok(cfg) => json!({
            "ready": true,
            "provider": cfg.provider.id(),
            "providerLabel": cfg.provider.label(),
            "model": cfg.model,
            // A URL base só significa alguma coisa no modo compatível; nos
            // outros ela é resto de configuração antiga e confundiria o estado.
            "baseUrl": if cfg.provider.usa_base_url() { cfg.base_url } else { String::new() },
            "needsKey": cfg.provider.requires_key(),
            "canListModels": cfg.provider.e_dialeto_openai(),
            "visionModel": cfg.vision_model,
            "keyTail": mascarar(&cfg.key),
            "reason": ""
        }),
        Err(motivo) => {
            let escolhido = settings["aiProvider"].as_str().unwrap_or("").trim();
            let p = Provider::from_id(escolhido);
            json!({
                "ready": false,
                "provider": p.map(|p| p.id()).unwrap_or(""),
                "providerLabel": p.map(|p| p.label()).unwrap_or(""),
                "model": settings["aiModel"].as_str().unwrap_or(""),
                "baseUrl": if p.map(|p| p.usa_base_url()).unwrap_or(false) {
                    settings["aiBaseUrl"].as_str().unwrap_or("")
                } else {
                    ""
                },
                "needsKey": p.map(|p| p.requires_key()).unwrap_or(true),
                "canListModels": p.map(|p| p.e_dialeto_openai()).unwrap_or(false),
                "visionModel": settings["aiVisionModel"].as_str().unwrap_or(""),
                "keyTail": p.map(|p| mascarar(settings[p.key_field()].as_str().unwrap_or(""))).unwrap_or_default(),
                "reason": motivo
            })
        }
    }
}

/// Chamada mínima de verdade contra o provedor configurado. O erro exato sobe
/// para a tela.
#[tauri::command]
pub async fn ai_test(app: AppHandle) -> Result<String, String> {
    let settings = crate::read_settings(&app);
    let cfg = resolve(&settings)?;
    let r = executar_detalhado(
        &cfg,
        "Responda com uma única palavra.",
        "Diga: ok",
        None,
        None,
    )
    .await?;
    // Num roteador o modelo REAL é o que interessa: pedir `auto/best-fast` e
    // ver `gpt-4.1-mini` responder é a prova de que o roteamento funcionou.
    let modelo = if r.modelo.is_empty() || r.modelo == cfg.model {
        cfg.model.clone()
    } else {
        format!("{} → {}", cfg.model, r.modelo)
    };
    Ok(format!(
        "{} · {} respondeu: {}",
        cfg.provider.label(),
        modelo,
        truncar(r.texto.trim(), 80)
    ))
}

/// N3 — lista de modelos que o provedor publica, para o Painel oferecer em vez
/// de exigir que o usuário digite o nome. O erro sobe legível e a tela cai no
/// campo livre; nunca trava.
#[tauri::command]
pub async fn ai_models(app: AppHandle) -> Result<Vec<String>, String> {
    let settings = crate::read_settings(&app);
    let cfg = resolve(&settings)?;
    listar_modelos(&cfg).await
}

/// O2 — OAuth PKCE do OpenRouter. Devolve os últimos 4 caracteres da chave
/// obtida; a chave em si fica no settings.json, do lado Rust.
#[tauri::command]
pub async fn ai_oauth_openrouter(app: AppHandle) -> Result<Value, String> {
    if OAUTH_EM_ANDAMENTO.swap(true, Ordering::SeqCst) {
        return Err("Já existe uma autorização do OpenRouter em andamento. Conclua ou espere o tempo esgotar.".into());
    }
    let _trava = Trava;

    // Porta alta escolhida na hora pelo próprio sistema (:0).
    let listener = TcpListener::bind("127.0.0.1:0")
        .map_err(|e| format!("Não consegui abrir o servidor local do OAuth: {e}"))?;
    let porta = listener
        .local_addr()
        .map_err(|e| e.to_string())?
        .port();

    let verificador = verificador_pkce();
    let desafio = desafio_pkce(&verificador);
    let callback = format!("http://127.0.0.1:{porta}/callback");
    let url = url_de_autorizacao(&callback, &desafio);

    // NAVEGADOR DO SISTEMA. Nunca a webview do WhatsApp.
    {
        use tauri_plugin_opener::OpenerExt;
        app.opener()
            .open_url(url.clone(), None::<&str>)
            .map_err(|e| format!("Não consegui abrir o navegador: {e}"))?;
    }

    let code = esperar_retorno(listener).await?; // aqui o servidor já caiu
    let chave = trocar_code_por_chave(&code, &verificador).await?;

    let mut settings = crate::read_settings(&app);
    if !settings.is_object() {
        settings = json!({});
    }
    settings["openrouterKey"] = json!(chave);
    settings["aiProvider"] = json!("openrouter");
    let modelo_atual = settings["aiModel"].as_str().unwrap_or("").trim().to_string();
    // Modelo do provedor anterior não vale no OpenRouter (que usa "vendor/modelo").
    if modelo_atual.is_empty() || !modelo_atual.contains('/') {
        settings["aiModel"] = json!(Provider::OpenRouter.default_model());
    }
    crate::write_settings(&app, settings.clone())?;

    Ok(json!({
        "provider": "openrouter",
        "model": settings["aiModel"].as_str().unwrap_or(""),
        "keyTail": mascarar(&chave)
    }))
}

// ---------------------------------------------------------------------------
// Testes
// ---------------------------------------------------------------------------

#[cfg(test)]
mod testes {
    use super::*;

    fn cfg(p: Provider) -> Config {
        Config {
            provider: p,
            model: "M".into(),
            key: "K".into(),
            base_url: "http://localhost:11434/v1".into(),
            vision_model: String::new(),
        }
    }

    // ---------- O4: migração silenciosa ----------

    #[test]
    fn sem_provedor_escolhido_mas_com_chave_anthropic_assume_anthropic() {
        let c = resolve(&json!({ "anthropicKey": "sk-ant-x" })).unwrap();
        assert_eq!(c.provider, Provider::Anthropic);
        assert_eq!(c.model, "claude-haiku-4-5-20251001");
        assert_eq!(c.key, "sk-ant-x");
    }

    #[test]
    fn migracao_preserva_o_modelo_que_o_usuario_ja_tinha() {
        let c = resolve(&json!({ "anthropicKey": "sk-ant-x", "aiModel": "claude-opus-4-8" }))
            .unwrap();
        assert_eq!(c.provider, Provider::Anthropic);
        assert_eq!(c.model, "claude-opus-4-8");
    }

    #[test]
    fn settings_vazio_da_erro_legivel_e_nao_panica() {
        let e = resolve(&json!({})).unwrap_err();
        assert!(e.contains("Painel"), "{e}");
    }

    #[test]
    fn provedor_escolhido_sem_chave_reclama_do_provedor_certo() {
        let e = resolve(&json!({ "aiProvider": "openai", "anthropicKey": "sk-ant-x" })).unwrap_err();
        assert!(e.contains("OpenAI"), "{e}");
    }

    #[test]
    fn compativel_nao_exige_chave_mas_exige_url() {
        let e = resolve(&json!({ "aiProvider": "compatible" })).unwrap_err();
        assert!(e.contains("URL base"), "{e}");
        let c = resolve(&json!({
            "aiProvider": "compatible",
            "aiBaseUrl": "http://localhost:11434/v1/",
            "aiModel": "llama3.2"
        }))
        .unwrap();
        assert_eq!(c.key, "");
        assert_eq!(c.base_url, "http://localhost:11434/v1"); // barra final some
    }

    #[test]
    fn provedor_desconhecido_nao_vira_anthropic_silenciosamente() {
        let e = resolve(&json!({ "aiProvider": "skynet", "anthropicKey": "sk" })).unwrap_err();
        assert!(e.contains("desconhecido"), "{e}");
    }

    // ---------- O1: corpo montado por API ----------

    #[test]
    fn anthropic_mantem_exatamente_o_formato_que_ja_funcionava() {
        let r = build_request(&cfg(Provider::Anthropic), "sys", "oi", None, None);
        assert_eq!(r.url, "https://api.anthropic.com/v1/messages");
        assert!(r.headers.contains(&("x-api-key".into(), "K".into())));
        assert!(r
            .headers
            .contains(&("anthropic-version".into(), "2023-06-01".into())));
        assert_eq!(r.body["system"], "sys");
        assert_eq!(r.body["max_tokens"], 1024);
        assert_eq!(r.body["messages"][0]["content"][0]["type"], "text");
        assert_eq!(r.body["messages"][0]["content"][0]["text"], "oi");
    }

    #[test]
    fn anthropic_imagem_vai_como_bloco_base64() {
        let r = build_request(
            &cfg(Provider::Anthropic),
            "",
            "leia",
            Some("AAA"),
            Some("image/png"),
        );
        let img = &r.body["messages"][0]["content"][0];
        assert_eq!(img["type"], "image");
        assert_eq!(img["source"]["media_type"], "image/png");
        assert_eq!(img["source"]["data"], "AAA");
        // sistema vazio não vira campo vazio
        assert!(r.body.get("system").is_none());
    }

    #[test]
    fn openai_usa_chat_completions_com_role_system() {
        let r = build_request(&cfg(Provider::OpenAI), "sys", "oi", None, None);
        assert_eq!(r.url, "https://api.openai.com/v1/chat/completions");
        assert!(r
            .headers
            .contains(&("authorization".into(), "Bearer K".into())));
        assert_eq!(r.body["messages"][0]["role"], "system");
        assert_eq!(r.body["messages"][0]["content"], "sys");
        assert_eq!(r.body["messages"][1]["role"], "user");
        assert_eq!(r.body["messages"][1]["content"], "oi");
        // modelo novo da OpenAI recusa max_tokens
        assert_eq!(r.body["max_completion_tokens"], 1024);
        assert!(r.body.get("max_tokens").is_none());
    }

    #[test]
    fn openai_imagem_vai_como_data_uri_em_image_url() {
        let r = build_request(
            &cfg(Provider::OpenAI),
            "",
            "leia",
            Some("AAA"),
            Some("image/png"),
        );
        let parte = &r.body["messages"][0]["content"][0];
        assert_eq!(parte["type"], "image_url");
        assert_eq!(parte["image_url"]["url"], "data:image/png;base64,AAA");
        assert_eq!(r.body["messages"][0]["content"][1]["text"], "leia");
    }

    #[test]
    fn gemini_usa_generate_content_com_system_instruction_e_inline_data() {
        let mut c = cfg(Provider::Gemini);
        c.model = "gemini-2.0-flash".into();
        let r = build_request(&c, "sys", "leia", Some("AAA"), Some("image/webp"));
        assert_eq!(
            r.url,
            "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent"
        );
        assert!(r.headers.contains(&("x-goog-api-key".into(), "K".into())));
        // a chave NÃO vai na URL (query string acaba em log de proxy)
        assert!(!r.url.contains("K"));
        assert_eq!(r.body["systemInstruction"]["parts"][0]["text"], "sys");
        let p0 = &r.body["contents"][0]["parts"][0];
        assert_eq!(p0["inline_data"]["mime_type"], "image/webp");
        assert_eq!(p0["inline_data"]["data"], "AAA");
        assert_eq!(r.body["contents"][0]["parts"][1]["text"], "leia");
        assert_eq!(r.body["generationConfig"]["maxOutputTokens"], 1024);
    }

    #[test]
    fn openrouter_usa_o_dialeto_openai_com_atribuicao_e_max_tokens() {
        let r = build_request(&cfg(Provider::OpenRouter), "sys", "oi", None, None);
        assert_eq!(r.url, "https://openrouter.ai/api/v1/chat/completions");
        assert!(r.headers.iter().any(|(k, _)| k == "X-Title"));
        assert_eq!(r.body["max_tokens"], 1024);
    }

    #[test]
    fn compativel_respeita_a_url_base_e_dispensa_authorization_sem_chave() {
        let mut c = cfg(Provider::Compatible);
        c.key = String::new();
        let r = build_request(&c, "", "oi", None, None);
        assert_eq!(r.url, "http://localhost:11434/v1/chat/completions");
        assert!(!r.headers.iter().any(|(k, _)| k == "authorization"));
    }

    #[test]
    fn compativel_aceita_url_ja_completa_sem_duplicar_o_caminho() {
        let mut c = cfg(Provider::Compatible);
        c.base_url = "https://api.groq.com/openai/v1/chat/completions".into();
        assert_eq!(
            build_request(&c, "", "oi", None, None).url,
            "https://api.groq.com/openai/v1/chat/completions"
        );
    }

    // ---------- N1: streaming desligado no dialeto OpenAI ----------

    #[test]
    fn todo_dialeto_openai_manda_stream_falso_explicito() {
        for p in TODOS_OS_PROVEDORES.iter().filter(|p| p.e_dialeto_openai()) {
            let r = build_request(&cfg(*p), "sys", "oi", None, None);
            assert_eq!(r.body["stream"], false, "{} não desligou o stream", p.id());
        }
        // e os que NÃO falam esse dialeto não ganham o campo
        for p in [Provider::Anthropic, Provider::Gemini] {
            assert!(build_request(&cfg(p), "", "oi", None, None)
                .body
                .get("stream")
                .is_none());
        }
    }

    // ---------- N2/N4: OmniRoute ----------

    #[test]
    fn omniroute_dispensa_chave_e_tem_url_base_de_fabrica() {
        let c = resolve(&json!({ "aiProvider": "omniroute" })).unwrap();
        assert_eq!(c.provider, Provider::OmniRoute);
        assert_eq!(c.base_url, "http://localhost:20128/v1");
        assert_eq!(c.model, "auto/best-fast");
        assert_eq!(c.key, "");
        // mas aceita chave e URL do usuário quando existem
        let c = resolve(&json!({
            "aiProvider": "omniroute",
            "aiBaseUrl": "http://localhost:9999/v1/",
            "omnirouteKey": "sk-x"
        }))
        .unwrap();
        assert_eq!(c.base_url, "http://localhost:9999/v1");
        assert_eq!(c.key, "sk-x");
    }

    #[test]
    fn omniroute_troca_para_um_modelo_com_visao_quando_vai_imagem() {
        // O padrão sai do resolve, não de um literal solto no build_request.
        let c = resolve(&json!({ "aiProvider": "omniroute" })).unwrap();
        assert_eq!(c.vision_model, OMNIROUTE_MODELO_VISAO);
        // sem imagem: o modelo escolhido pelo usuário é respeitado
        assert_eq!(
            build_request(&c, "", "oi", None, None).body["model"],
            "auto/best-fast"
        );
        // com imagem: vai para um modelo que enxerga de verdade — os apelidos
        // `auto/*` descartam a imagem antes de rotear (medido no endpoint real)
        let r = build_request(&c, "", "leia", Some("AAA"), Some("image/png"));
        assert_eq!(r.body["model"], OMNIROUTE_MODELO_VISAO);
        assert!(!r.body["model"].as_str().unwrap().starts_with("auto/"));

        // e o usuário pode trocar esse modelo sem tocar no de texto
        let c = resolve(&json!({
            "aiProvider": "omniroute",
            "aiVisionModel": "claude/claude-sonnet-5"
        }))
        .unwrap();
        assert_eq!(
            build_request(&c, "", "leia", Some("AAA"), None).body["model"],
            "claude/claude-sonnet-5"
        );
        assert_eq!(build_request(&c, "", "oi", None, None).body["model"], "auto/best-fast");

        // nenhum outro provedor sofre essa troca: continuam com um modelo só
        let mut o = cfg(Provider::Compatible);
        o.model = "llava".into();
        assert_eq!(
            build_request(&o, "", "leia", Some("AAA"), None).body["model"],
            "llava"
        );
        assert_eq!(
            resolve(&json!({"aiProvider":"openai","openaiKey":"k"}))
                .unwrap()
                .vision_model,
            ""
        );
    }

    /// N4 — o campo "Modelo para imagem" vale para qualquer provedor.
    /// A configuração desta máquina é o caso real: modo "compatível" apontado
    /// para a porta do OmniRoute. Antes o campo era ignorado ali, e a imagem
    /// saía no apelido `auto/*`.
    #[test]
    fn modelo_de_imagem_vale_para_qualquer_provedor() {
        let base = json!({
            "aiProvider": "compatible",
            "aiBaseUrl": "http://localhost:20128/v1",
            "aiModel": "auto/best-fast"
        });
        // sem o campo: nada muda (não temos como adivinhar o catálogo)
        let c = resolve(&base).unwrap();
        assert_eq!(c.vision_model, "");
        // com o campo preenchido: é ele que recebe a imagem…
        let mut com = base.clone();
        com["aiVisionModel"] = json!("claude/claude-haiku-4-5-20251001");
        let c = resolve(&com).unwrap();
        assert_eq!(
            build_request(&c, "", "leia", Some("AAA"), Some("image/png")).body["model"],
            "claude/claude-haiku-4-5-20251001"
        );
        // …e o modelo de texto continua intocado
        assert_eq!(
            build_request(&c, "", "oi", None, None).body["model"],
            "auto/best-fast"
        );
    }

    /// N4(b) — mandar imagem para um apelido `auto/*` tem que FALHAR, e não
    /// devolver a resposta educada do roteador dizendo que nada chegou.
    #[test]
    fn imagem_para_apelido_auto_falha_com_saida_escrita() {
        let c = resolve(&json!({
            "aiProvider": "compatible",
            "aiBaseUrl": "http://localhost:20128/v1",
            "aiModel": "auto/best-fast"
        }))
        .unwrap();
        let e = conferir_visao(&c).unwrap_err();
        assert!(e.contains("auto/best-fast"), "{e}");
        assert!(e.contains("Modelo para imagem"), "{e}");
        assert!(e.contains(OMNIROUTE_MODELO_VISAO), "{e}");

        // com o campo preenchido, passa
        let c = resolve(&json!({
            "aiProvider": "compatible",
            "aiBaseUrl": "http://localhost:20128/v1",
            "aiModel": "auto/best-fast",
            "aiVisionModel": "claude/claude-haiku-4-5-20251001"
        }))
        .unwrap();
        assert!(conferir_visao(&c).is_ok());

        // e o OmniRoute, que já tem padrão de fábrica, nunca cai aqui
        assert!(conferir_visao(&resolve(&json!({ "aiProvider": "omniroute" })).unwrap()).is_ok());

        // provedor sem apelido nenhum: segue a vida
        let mut o = cfg(Provider::Compatible);
        o.model = "llava".into();
        assert!(conferir_visao(&o).is_ok());
    }

    // ---------- N3: catálogo de modelos ----------

    #[test]
    fn endpoint_de_modelos_sai_da_mesma_base_do_chat() {
        let mut c = cfg(Provider::OmniRoute);
        c.base_url = "http://localhost:20128/v1".into();
        assert_eq!(endpoint_models(&c), "http://localhost:20128/v1/models");
        // URL colada já com o caminho de chat não vira ".../chat/completions/models"
        c.base_url = "http://localhost:20128/v1/chat/completions".into();
        assert_eq!(endpoint_models(&c), "http://localhost:20128/v1/models");
        assert_eq!(
            endpoint_models(&cfg(Provider::OpenAI)),
            "https://api.openai.com/v1/models"
        );
    }

    #[test]
    fn le_a_lista_de_modelos_no_formato_openai() {
        let ids = extract_models(&json!({
            "object":"list",
            "data":[{"id":"auto/best-fast"},{"id":"auto/best-vision"},{"id":""}]
        }));
        assert_eq!(ids, vec!["auto/best-fast", "auto/best-vision"]);
        // resposta torta não panica
        assert!(extract_models(&json!({})).is_empty());
    }

    // ---------- leitura da resposta ----------

    #[test]
    fn le_o_modelo_que_realmente_respondeu() {
        assert_eq!(
            extract_model(
                Provider::OmniRoute,
                &json!({"model":"gpt-4.1-mini","choices":[]})
            ),
            "gpt-4.1-mini"
        );
        assert_eq!(
            extract_model(Provider::Gemini, &json!({"modelVersion":"gemini-2.0-flash"})),
            "gemini-2.0-flash"
        );
        assert_eq!(extract_model(Provider::OpenAI, &json!({})), "");
    }

    #[test]
    fn le_o_texto_de_cada_formato_de_resposta() {
        assert_eq!(
            extract_text(
                Provider::Anthropic,
                &json!({"content":[{"type":"text","text":"a"},{"type":"text","text":"b"}]})
            ),
            "a\nb"
        );
        assert_eq!(
            extract_text(
                Provider::OpenAI,
                &json!({"choices":[{"message":{"content":"resposta"}}]})
            ),
            "resposta"
        );
        assert_eq!(
            extract_text(
                Provider::Compatible,
                &json!({"choices":[{"message":{"content":[{"type":"text","text":"parte"}]}}]})
            ),
            "parte"
        );
        assert_eq!(
            extract_text(
                Provider::Gemini,
                &json!({"candidates":[{"content":{"parts":[{"text":"g"}]}}]})
            ),
            "g"
        );
        // resposta torta não panica
        assert_eq!(extract_text(Provider::OpenAI, &json!({})), "");
    }

    #[test]
    fn erro_chega_legivel_em_todos_os_formatos() {
        assert!(extract_error(401, r#"{"error":{"message":"chave inválida"}}"#)
            .contains("chave inválida"));
        assert!(extract_error(429, r#"{"message":"rate limit"}"#).contains("rate limit"));
        assert!(extract_error(404, r#"{"error":"model not found"}"#).contains("model not found"));
        // servidor local devolvendo HTML: cai no cru truncado, mas com o status
        let e = extract_error(502, "<html>Bad Gateway</html>");
        assert!(e.contains("502") && e.contains("Bad Gateway"), "{e}");
        assert!(extract_error(500, "").contains("500"));
    }

    // ---------- máscara ----------

    #[test]
    fn mascara_nunca_mostra_a_chave_inteira() {
        assert_eq!(mascarar("sk-or-v1-abcdefgh1234"), "••••1234");
        assert_eq!(mascarar("abc"), "••••");
        assert_eq!(mascarar(""), "");
        assert!(!mascarar("sk-ant-supersecreta").contains("supersecreta"));
    }

    // ---------- OAuth PKCE ----------

    #[test]
    fn desafio_pkce_bate_com_o_vetor_conhecido_do_rfc7636() {
        // RFC 7636, apêndice B
        assert_eq!(
            desafio_pkce("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"),
            "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"
        );
    }

    #[test]
    fn verificador_tem_tamanho_valido_e_nao_se_repete() {
        let a = verificador_pkce();
        let b = verificador_pkce();
        assert_eq!(a.len(), 64);
        assert_ne!(a, b);
        assert!(a.chars().all(|c| c.is_ascii_alphanumeric()
            || "-._~".contains(c)));
    }

    #[test]
    fn url_de_autorizacao_escapa_o_callback_e_pede_s256() {
        let u = url_de_autorizacao("http://127.0.0.1:54321/callback", "DESAFIO+/=");
        assert!(u.starts_with("https://openrouter.ai/auth?"));
        assert!(u.contains("callback_url=http%3A%2F%2F127.0.0.1%3A54321%2Fcallback"), "{u}");
        assert!(u.contains("code_challenge=DESAFIO%2B%2F%3D"), "{u}");
        assert!(u.contains("code_challenge_method=S256"));
    }

    #[test]
    fn ler_retorno_extrai_code_erro_e_ignora_ruido() {
        assert_eq!(
            ler_retorno("GET /callback?code=abc123 HTTP/1.1"),
            Some(Ok("abc123".into()))
        );
        assert_eq!(
            ler_retorno("GET /callback?state=x&code=a%2Bb HTTP/1.1"),
            Some(Ok("a+b".into()))
        );
        assert_eq!(
            ler_retorno("GET /callback?error=access_denied HTTP/1.1"),
            Some(Err("access_denied".into()))
        );
        // preconnect / favicon: não conclui o fluxo
        assert_eq!(ler_retorno("GET /favicon.ico HTTP/1.1"), None);
        assert_eq!(ler_retorno("GET /callback HTTP/1.1"), None);
        assert_eq!(ler_retorno(""), None);
        assert_eq!(ler_retorno("lixo"), None);
    }

    #[test]
    fn servidor_efemero_recebe_o_code_responde_e_encerra() {
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        rt.block_on(async {
            let listener = TcpListener::bind("127.0.0.1:0").unwrap();
            let porta = listener.local_addr().unwrap().port();

            let cliente = tokio::task::spawn_blocking(move || {
                // dá tempo do accept não-bloqueante entrar no loop
                std::thread::sleep(Duration::from_millis(80));
                let mut s = std::net::TcpStream::connect(("127.0.0.1", porta)).unwrap();
                s.write_all(b"GET /callback?code=CODIGO123 HTTP/1.1\r\nHost: x\r\n\r\n")
                    .unwrap();
                let mut resposta = String::new();
                let _ = s.read_to_string(&mut resposta);
                resposta
            });

            let code = esperar_retorno(listener).await.unwrap();
            assert_eq!(code, "CODIGO123");
            let resposta = cliente.await.unwrap();
            assert!(resposta.starts_with("HTTP/1.1 200 OK"), "{resposta}");
            assert!(resposta.contains("Conectado ao OpenRouter"));

            // O servidor caiu junto com o `listener`: a porta não escuta mais.
            assert!(
                std::net::TcpStream::connect_timeout(
                    &format!("127.0.0.1:{porta}").parse().unwrap(),
                    Duration::from_millis(300)
                )
                .is_err(),
                "a porta {porta} continuou escutando depois do fluxo"
            );
        });
    }

    #[test]
    fn servidor_efemero_devolve_erro_quando_o_usuario_recusa() {
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        rt.block_on(async {
            let listener = TcpListener::bind("127.0.0.1:0").unwrap();
            let porta = listener.local_addr().unwrap().port();
            tokio::task::spawn_blocking(move || {
                std::thread::sleep(Duration::from_millis(80));
                let mut s = std::net::TcpStream::connect(("127.0.0.1", porta)).unwrap();
                let _ = s.write_all(b"GET /callback?error=access_denied HTTP/1.1\r\n\r\n");
                let mut r = String::new();
                let _ = s.read_to_string(&mut r);
            });
            let e = esperar_retorno(listener).await.unwrap_err();
            assert!(e.contains("access_denied"), "{e}");
        });
    }

    // ---------- ponta a ponta contra um endpoint compatível de verdade ----------
    //
    // O modo "compatível com OpenAI" é o único provedor testável sem credencial
    // de ninguém: sobe um servidor HTTP local que fala `chat/completions`,
    // manda `executar` nele e confere o que chegou do outro lado e o que
    // voltou. Passa por reqwest, pelo JSON real e pelo parser da resposta.

    /// Servidor de UM tiro. Devolve (porta, handle com a requisição recebida).
    fn servidor_falso(
        status: &'static str,
        corpo_resposta: &'static str,
    ) -> (u16, std::thread::JoinHandle<String>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let porta = listener.local_addr().unwrap().port();
        let h = std::thread::spawn(move || {
            let (mut s, _) = listener.accept().unwrap();
            let _ = s.set_read_timeout(Some(Duration::from_secs(5)));
            let mut bruto = Vec::new();
            let mut buf = [0u8; 8192];
            loop {
                let n = s.read(&mut buf).unwrap_or(0);
                if n == 0 {
                    break;
                }
                bruto.extend_from_slice(&buf[..n]);
                let texto = String::from_utf8_lossy(&bruto).into_owned();
                if let Some((cab, corpo)) = texto.split_once("\r\n\r\n") {
                    let tam = cab
                        .lines()
                        .find_map(|l| {
                            l.to_ascii_lowercase()
                                .strip_prefix("content-length:")
                                .and_then(|v| v.trim().parse::<usize>().ok())
                        })
                        .unwrap_or(0);
                    if corpo.len() >= tam {
                        break;
                    }
                }
            }
            let _ = s.write_all(
                format!(
                    "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{corpo_resposta}",
                    corpo_resposta.len()
                )
                .as_bytes(),
            );
            let _ = s.flush();
            String::from_utf8_lossy(&bruto).into_owned()
        });
        (porta, h)
    }

    fn rt() -> tokio::runtime::Runtime {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
    }

    #[test]
    fn ponta_a_ponta_endpoint_compativel_local_com_imagem() {
        let (porta, servidor) = servidor_falso(
            "200 OK",
            r#"{"choices":[{"message":{"role":"assistant","content":"tudo certo"}}]}"#,
        );
        let cfg = Config {
            provider: Provider::Compatible,
            model: "llama3.2-vision".into(),
            key: String::new(), // servidor local: sem chave
            base_url: format!("http://127.0.0.1:{porta}/v1"),
            vision_model: String::new(),
        };
        let saida = rt()
            .block_on(executar(&cfg, "seja breve", "o que é isto?", Some("QUJD"), Some("image/png")))
            .unwrap();
        assert_eq!(saida, "tudo certo");

        let recebido = servidor.join().unwrap();
        assert!(recebido.starts_with("POST /v1/chat/completions "), "{recebido}");
        // sem chave, sem header de autorização
        assert!(!recebido.to_ascii_lowercase().contains("authorization:"), "{recebido}");
        let corpo: Value =
            serde_json::from_str(recebido.split_once("\r\n\r\n").unwrap().1).unwrap();
        assert_eq!(corpo["model"], "llama3.2-vision");
        assert_eq!(corpo["messages"][0]["role"], "system");
        assert_eq!(
            corpo["messages"][1]["content"][0]["image_url"]["url"],
            "data:image/png;base64,QUJD"
        );
        assert_eq!(corpo["max_tokens"], 1024);
    }

    #[test]
    fn ponta_a_ponta_erro_do_endpoint_chega_legivel_ao_usuario() {
        let (porta, servidor) = servidor_falso(
            "404 Not Found",
            r#"{"error":{"message":"model 'inexistente' not found, try pulling it first"}}"#,
        );
        let cfg = Config {
            provider: Provider::Compatible,
            model: "inexistente".into(),
            key: "chave-de-teste".into(),
            base_url: format!("http://127.0.0.1:{porta}/v1"),
            vision_model: String::new(),
        };
        let e = rt()
            .block_on(executar(&cfg, "", "oi", None, None))
            .unwrap_err();
        assert!(e.contains("404") && e.contains("not found, try pulling it first"), "{e}");
        let recebido = servidor.join().unwrap();
        assert!(
            recebido.to_ascii_lowercase().contains("authorization: bearer chave-de-teste"),
            "{recebido}"
        );
    }

    #[test]
    fn ponta_a_ponta_endpoint_fora_do_ar_nao_panica_e_diz_o_que_houve() {
        // porta fechada de propósito
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let porta = listener.local_addr().unwrap().port();
        drop(listener);
        let cfg = Config {
            provider: Provider::Compatible,
            model: "m".into(),
            key: String::new(),
            base_url: format!("http://127.0.0.1:{porta}/v1"),
            vision_model: String::new(),
        };
        let e = rt()
            .block_on(executar(&cfg, "", "oi", None, None))
            .unwrap_err();
        assert!(e.contains("Falha de rede"), "{e}");
        assert!(e.contains(&porta.to_string()), "{e}");
    }

    #[test]
    fn ponta_a_ponta_omniroute_com_imagem_pede_visao_e_reporta_o_modelo_roteado() {
        let (porta, servidor) = servidor_falso(
            "200 OK",
            r#"{"id":"chatcmpl-1","object":"chat.completion","model":"gpt-4.1-mini","choices":[{"index":0,"finish_reason":"stop","message":{"role":"assistant","content":"um gato"}}]}"#,
        );
        let cfg = Config {
            provider: Provider::OmniRoute,
            model: "auto/best-fast".into(),
            key: String::new(), // roteador local: sem chave
            base_url: format!("http://127.0.0.1:{porta}/v1"),
            vision_model: OMNIROUTE_MODELO_VISAO.into(),
        };
        let r = rt()
            .block_on(executar_detalhado(
                &cfg,
                "seja breve",
                "o que é isto?",
                Some("QUJD"),
                Some("image/png"),
            ))
            .unwrap();
        assert_eq!(r.texto, "um gato");
        assert_eq!(r.modelo, "gpt-4.1-mini"); // o REAL, não o pedido

        let recebido = servidor.join().unwrap();
        assert!(recebido.starts_with("POST /v1/chat/completions "), "{recebido}");
        assert!(!recebido.to_ascii_lowercase().contains("authorization:"), "{recebido}");
        let corpo: Value =
            serde_json::from_str(recebido.split_once("\r\n\r\n").unwrap().1).unwrap();
        // N4: o modelo pedido NÃO é o apelido `auto/*` (que descarta a imagem)
        assert_eq!(corpo["model"], OMNIROUTE_MODELO_VISAO);
        assert_eq!(corpo["stream"], false); // N1
        assert_eq!(
            corpo["messages"][1]["content"][0]["image_url"]["url"],
            "data:image/png;base64,QUJD"
        );
    }

    #[test]
    fn resposta_em_sse_nao_panica_e_explica_o_que_houve() {
        // exatamente o que o OmniRoute devolvia sem `"stream": false`
        let (porta, servidor) = servidor_falso(
            "200 OK",
            "data: {\"choices\":[{\"delta\":{\"content\":\"o\"}}]}\n\ndata: [DONE]\n\n",
        );
        let cfg = Config {
            provider: Provider::OmniRoute,
            model: "auto/best-fast".into(),
            key: String::new(),
            base_url: format!("http://127.0.0.1:{porta}/v1"),
            vision_model: String::new(),
        };
        let e = rt()
            .block_on(executar(&cfg, "", "oi", None, None))
            .unwrap_err();
        assert!(e.contains("streaming") && e.contains("stream"), "{e}");
        let _ = servidor.join();
    }

    #[test]
    fn catalogo_de_modelos_ponta_a_ponta_e_recusa_de_quem_nao_publica() {
        let (porta, servidor) = servidor_falso(
            "200 OK",
            r#"{"object":"list","data":[{"id":"auto/best-vision"},{"id":"auto/best-fast"}]}"#,
        );
        let cfg = Config {
            provider: Provider::OmniRoute,
            model: "auto/best-fast".into(),
            key: String::new(),
            base_url: format!("http://127.0.0.1:{porta}/v1"),
            vision_model: String::new(),
        };
        let ids = rt().block_on(listar_modelos(&cfg)).unwrap();
        assert_eq!(ids, vec!["auto/best-fast", "auto/best-vision"]); // ordenado
        let recebido = servidor.join().unwrap();
        assert!(recebido.starts_with("GET /v1/models "), "{recebido}");

        // provedor sem catálogo neste formato: erro legível, sem rede
        let e = rt()
            .block_on(listar_modelos(&Config {
                provider: Provider::Anthropic,
                ..cfg
            }))
            .unwrap_err();
        assert!(e.contains("catálogo"), "{e}");
    }

    #[test]
    fn todos_os_provedores_tem_campo_de_chave_declarado_em_campos_de_chave() {
        for p in TODOS_OS_PROVEDORES {
            assert!(
                CAMPOS_DE_CHAVE.contains(&p.key_field()),
                "{} ficou de fora de CAMPOS_DE_CHAVE — o teste de vazamento não o cobriria",
                p.id()
            );
            assert_eq!(Provider::from_id(p.id()), Some(*p));
            assert!(!p.default_model().is_empty());
        }
    }
}
