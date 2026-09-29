//! Fila limitada, deduplicacao e cancelamento. Historico publico sem conteudo.
use serde_json::{json, Value};
use std::collections::VecDeque;
use std::future::Future;
use std::sync::{Arc, Mutex, MutexGuard, OnceLock};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};
use tokio::sync::{Notify, Semaphore};

type Outcome = Result<String, String>;
struct Job {
    id: String, key: String, kind: String, started: Instant, created_ms: u64,
    status: Mutex<String>, result: Mutex<Option<Outcome>>, cancel: AtomicBool,
    // Acordam quem espera: sem eles, cada espera era um laço de 50 ms.
    done: Notify, cancelled: Notify,
}
/// Trava que sobrevive a um pânico anterior (o estado da fila é só leitura
/// de status; perder a fila inteira por um pânico seria pior).
fn trava<T>(m: &Mutex<T>) -> MutexGuard<'_, T> { m.lock().unwrap_or_else(|e| e.into_inner()) }
impl Job {
    fn concluir(&self, r: Outcome) {
        *trava(&self.result) = Some(r);
        self.done.notify_waiters();
    }
}
pub struct Queue { items: Mutex<VecDeque<Arc<Job>>>, ai: Semaphore, audio: Semaphore }
impl Default for Queue {
    fn default() -> Self { Self { items: Mutex::new(VecDeque::new()), ai: Semaphore::new(2), audio: Semaphore::new(1) } }
}
static QUEUE: OnceLock<Queue> = OnceLock::new();
fn queue() -> &'static Queue { QUEUE.get_or_init(Queue::default) }

impl Queue {
    pub async fn run<F: Future<Output=Outcome>>(&self, kind: &str, key: String, future: F) -> Outcome {
        let (job, owner) = {
            let mut items = trava(&self.items);
            // Pedido idêntico EM ANDAMENTO: sempre junta (clique duplo não paga
            // duas vezes). Resultado JÁ PRONTO: só a transcrição reaproveita —
            // ela é determinística e cara. IA é gerativa: "Outra versão" com
            // o mesmo contexto devolvia o mesmo texto por 5 minutos.
            let reaproveita_pronto = kind == "audio";
            if let Some(j) = items.iter().find(|j| j.key == key && j.kind == kind
                && j.started.elapsed() < Duration::from_secs(300)
                && !matches!(trava(&j.status).as_str(), "falhou" | "cancelada")
                && (reaproveita_pronto || trava(&j.result).is_none())) {
                (j.clone(), false)
            } else {
                let active = items.iter().filter(|j| trava(&j.result).is_none()).count();
                if active >= 12 { return Err("Fila cheia (12 tarefas). Aguarde ou cancele uma tarefa na Central de tarefas (Painel › IA & TRANSCRIÇÃO).".into()); }
                while items.len() >= 32 {
                    if let Some(i) = items.iter().position(|j| trava(&j.result).is_some()) { items.remove(i); }
                    else { break; }
                }
                let j = Arc::new(Job { id: format!("{:016x}", rand::random::<u64>()), key, kind: kind.into(),
                    started: Instant::now(), created_ms: std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_millis() as u64,
                    status: Mutex::new("na fila".into()), result: Mutex::new(None), cancel: AtomicBool::new(false),
                    done: Notify::new(), cancelled: Notify::new() });
                items.push_back(j.clone()); (j, true)
            }
        };
        if !owner {
            loop {
                // `notified()` antes de conferir: o aviso que chegar entre a
                // conferência e o `await` não se perde.
                let aviso = job.done.notified();
                if let Some(result) = trava(&job.result).clone() { return result; }
                aviso.await;
            }
        }
        struct Finish(Arc<Job>);
        impl Drop for Finish {
            fn drop(&mut self) {
                if trava(&self.0.result).is_some() { return; }
                *trava(&self.0.status) = "cancelada".into();
                self.0.concluir(Err("Tarefa interrompida.".into()));
            }
        }
        let _guard = Finish(job.clone());
        let cancelled = async {
            loop {
                let aviso = job.cancelled.notified();
                if job.cancel.load(Ordering::SeqCst) { break; }
                aviso.await;
            }
        };
        let execute = async {
            let sem = if kind == "audio" { &self.audio } else { &self.ai };
            let _permit = tokio::time::timeout(Duration::from_secs(180), sem.acquire()).await
                .map_err(|_| "Tempo de espera na fila esgotado.")?.map_err(|_| "Fila encerrada.")?;
            *trava(&job.status) = "executando".into();
            tokio::time::timeout(Duration::from_secs(if kind == "audio" { 600 } else { 180 }), future).await
                .map_err(|_| "Tempo limite da tarefa esgotado. Nenhuma nova tentativa automatica foi feita.".to_string())?
        };
        let result = tokio::select! {
            r = execute => r,
            _ = cancelled => Err("Tarefa cancelada. O provedor pode ja ter contabilizado o uso.".into()),
        };
        let result = result.and_then(|s| if s.len() > 128 * 1024 { Err("Resposta excede o limite de 128 KB.".into()) } else { Ok(s) });
        *trava(&job.status) = if job.cancel.load(Ordering::SeqCst) { "cancelada" } else if result.is_ok() { "concluida" } else { "falhou" }.into();
        job.concluir(result.clone());
        result
    }
    fn list(&self) -> Value {
        let items = trava(&self.items);
        json!(items.iter().rev().map(|j| json!({"id":j.id,"kind":j.kind,"status":*trava(&j.status),"createdMs":j.created_ms})).collect::<Vec<_>>())
    }
    fn cancel(&self, id: &str) -> bool {
        let items = trava(&self.items);
        if let Some(job) = items.iter().find(|j| j.id == id && trava(&j.result).is_none()) {
            job.cancel.store(true, Ordering::SeqCst);
            job.cancelled.notify_waiters();
            true
        } else { false }
    }
}

pub async fn run<F: Future<Output=Outcome>>(kind: &str, key: String, f: F) -> Outcome { queue().run(kind, key, f).await }
#[tauri::command]
pub fn jobs_list() -> Value { queue().list() }
#[tauri::command]
pub fn jobs_cancel(id: String) -> bool { queue().cancel(&id) }
#[tauri::command]
pub fn jobs_clear() {
    trava(&queue().items).retain(|j| trava(&j.result).is_none());
}
pub fn fingerprint(parts: &[&[u8]]) -> String {
    use sha2::{Digest, Sha256};
    let mut h = Sha256::new();
    for part in parts { h.update((part.len() as u64).to_le_bytes()); h.update(part); }
    format!("{:x}", h.finalize())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn deduplica_e_cache_nao_executa_duas_vezes() {
        let q = Queue::default();
        let (a,b) = tokio::join!(q.run("ia","same".into(),async { tokio::time::sleep(Duration::from_millis(30)).await; Ok("um".into()) }), q.run("ia","same".into(),async { panic!("duplicou") }));
        assert_eq!(a.unwrap(),"um"); assert_eq!(b.unwrap(),"um");
        // IA pronta NÃO é reaproveitada: "Outra versão" gera de novo.
        assert_eq!(q.run("ia","same".into(),async { Ok("dois".into()) }).await.unwrap(),"dois");
        assert!(!q.list().to_string().contains("same"));
    }
    #[tokio::test]
    async fn transcricao_pronta_e_reaproveitada() {
        let q = Queue::default();
        assert_eq!(q.run("audio","a".into(),async { Ok("texto".into()) }).await.unwrap(),"texto");
        assert_eq!(q.run("audio","a".into(),async { panic!("cache falhou") }).await.unwrap(),"texto");
    }
    #[tokio::test]
    async fn cancelar_libera_a_fila() {
        let q = Arc::new(Queue::default()); let q2 = q.clone();
        let task = tokio::spawn(async move { q2.run("audio","test".into(), std::future::pending()).await });
        tokio::time::sleep(Duration::from_millis(20)).await;
        let id = q.list()[0]["id"].as_str().unwrap().to_string();
        assert!(q.cancel(&id)); assert!(task.await.unwrap().unwrap_err().contains("cancelada"));
        assert_eq!(q.run("audio","next".into(),async { Ok("ok".into()) }).await.unwrap(), "ok");
    }
}
