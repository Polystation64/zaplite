//! Camada de conexão (T2.1), lado Rust.
//!
//! O bundle.js manda heartbeats (~3s) e cada transição de estado. Aqui:
//! - guardamos o estado corrente (consultável por `get_connection_state`);
//! - gravamos uma linha JSON por transição em `<app_config_dir>\connection.log`
//!   (rotação que PRESERVA o histórico gerado pelo próprio app);
//! - emitimos o evento `zaplite://conn-state` a cada transição;
//! - um watchdog detecta webview zumbi (janela visível e >15s sem heartbeat) e
//!   RENAVEGA a webview para o WhatsApp Web (nível 3);
//! - um detector dedicado pega a página que CARREGOU mas não roda o nosso
//!   bundle (página de erro do WebView2, `about:blank`) em ~10s e renavega.
//!
//! Regras de projeto desta camada, todas consequência de auditoria:
//!
//! * **O nível 3 NUNCA destrói a janela.** `WindowDispatcher::destroy()` do
//!   tauri-runtime-wry 2.11.4 só faz `proxy.send_event(WindowMessage::Destroy)`
//!   (verificado na fonte, `src/lib.rs:2283`): é assíncrono. Destruir e recriar
//!   inline no mesmo closure sempre falhava com `WindowLabelAlreadyExists`,
//!   deixando o app sem janela — e, sem janela, o tao emite `ExitRequested`
//!   (`tauri-runtime-wry/src/lib.rs:4310-4324`) e o processo morre. Como a
//!   janela nunca é destruída, o app não tem como ficar sem janela.
//!   Renavegar resolve o caso real (documento travado/zumbi): o WebView2
//!   recarrega o documento, reaplica os `initialization_script` (o nosso bundle
//!   e a ponte `window.__TAURI__`) e o heartbeat volta. O perfil do WebView2
//!   não é tocado, então a sessão logada sobrevive.
//!
//! * **O laço do watchdog nunca chama getter de dispatcher.** `is_visible()` e
//!   `url()` viram `send_user_message` + `rx.recv()` sem timeout
//!   (`webview_getter!`, mesma fonte): se a UI travar, o watchdog trava junto,
//!   cego justamente para o travamento que ele existe para detectar.
//!   Visibilidade vem de um `AtomicBool` alimentado por quem chama show/hide;
//!   a URL vem de uma sonda que POSTA um closure na thread principal.
//!
//! * **A página é fonte de SINAL, nunca de AUTORIDADE.** Tudo que chega por
//!   `conn_heartbeat`/`conn_transition` vem da origem remota
//!   `https://web.whatsapp.com` (ver `capabilities/remote-whatsapp.json`) e
//!   portanto é escrevível por QUALQUER script daquela página. Estado de link
//!   (CONNECTED/OFFLINE/…) só a página enxerga, então ela reporta; contador de
//!   tentativas, veredito de falha e decisão de recuperação são derivados AQUI,
//!   de eventos que o Rust observa com o próprio relógio. Ver `Tentativas`.
//!
//! O log NUNCA recebe conteúdo de mensagens, nomes de contatos, tokens ou URLs
//! com dados: só nomes de estados, origens (esquema+host) e motivos técnicos.


/* A camada de conexão é grande porque o problema é grande: quatro iterações
   de auditoria, cada uma deixando um contador, um teto ou uma carência. Ela
   está separada por RESPONSABILIDADE, não por tamanho:

     tipos     — constantes, tipos simples, funções puras;
     estado    — `Inner`, `ConnMonitor`, carências, vazão remota;
     log       — connection.log: fila, rotação, `log_and_emit`;
     decisao   — `decidir_recuperacao` e tudo o que alimenta a decisão;
     comandos  — a ponte (assinaturas congeladas) e os avisos do app;
     watchdog  — o laço que sonda, julga e conduz a recuperação.

   Os `use` abaixo são reexportados (`pub(crate) use`) de propósito: cada
   submódulo abre com um `use super::*;` e enxerga exatamente o mesmo escopo
   que existia quando isto era um arquivo só. Foi o que permitiu separar sem
   reescrever uma linha de lógica. */

pub(crate) use serde_json::{json, Value};
pub(crate) use std::collections::VecDeque;
pub(crate) use std::fs;
pub(crate) use std::io::Write;
pub(crate) use std::path::{Path, PathBuf};
pub(crate) use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
pub(crate) use std::sync::mpsc::{sync_channel, SyncSender, TrySendError};
pub(crate) use std::sync::{Mutex, MutexGuard, OnceLock};
pub(crate) use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
pub(crate) use tauri::{AppHandle, Emitter, Manager};
// 28 — a pasta do `connection.log` é a da conta ativa (ver `log_path`).
pub(crate) use crate::contas;

mod tipos;
mod estado;
mod log;
mod decisao;
mod comandos;
mod watchdog;
#[cfg(test)]
mod testes;

pub(crate) use tipos::*;
pub(crate) use estado::*;
pub(crate) use log::*;
pub(crate) use decisao::*;
pub(crate) use comandos::*;
pub(crate) use watchdog::*;
