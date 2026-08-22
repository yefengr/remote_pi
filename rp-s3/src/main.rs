use std::{env, net::SocketAddr, path::PathBuf, sync::Arc};

use axum::{
    body::Bytes,
    extract::{Path as UrlPath, Request, State},
    http::{header, HeaderMap, HeaderValue, StatusCode},
    middleware::{self, Next},
    response::Response,
    routing::{get, put},
    Router,
};
use tower_http::{services::ServeDir, trace::TraceLayer};

/// Extensões servidas como download (attachment) com cache imutável —
/// artefatos vivem em diretórios versionados, então a URL nunca é reusada.
const ARTIFACT_EXTENSIONS: [&str; 5] = [".dmg", ".exe", ".deb", ".rpm", ".zip"];

/// Só manifests podem ser publicados via upload — binários ficam nos assets
/// da GitHub Release, então o endpoint nunca aceita artefato grande.
fn is_uploadable_manifest(name: &str) -> bool {
    name == "latest.json" || name == "SHA256SUMS"
}

struct UploadConfig {
    data_dir: PathBuf,
    token: String,
}

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "rp_s3=info,tower_http=info".into()),
        )
        .init();

    let data_dir = env::var("DATA_DIR").unwrap_or_else(|_| "/data".to_string());
    let port: u16 = env::var("PORT")
        .ok()
        .and_then(|p| p.parse().ok())
        .unwrap_or(8080);

    let mut app = Router::new()
        .route("/healthz", get(|| async { "ok" }))
        .nest_service(
            "/downloads",
            ServeDir::new(&data_dir).append_index_html_on_directories(false),
        )
        .layer(middleware::from_fn(set_download_headers));

    // Sem UPLOAD_TOKEN o endpoint nem existe — publicação segue 100% manual.
    match env::var("UPLOAD_TOKEN") {
        Ok(token) if !token.trim().is_empty() => {
            let cfg = Arc::new(UploadConfig {
                data_dir: PathBuf::from(&data_dir),
                token,
            });
            app = app.route(
                "/upload/{product}/{file}",
                put(upload_manifest).with_state(cfg),
            );
            tracing::info!("upload habilitado em PUT /upload/<produto>/<arquivo>");
        }
        _ => tracing::warn!("UPLOAD_TOKEN ausente — endpoint de upload desabilitado"),
    }

    let app = app.layer(TraceLayer::new_for_http());

    let addr = SocketAddr::from(([0, 0, 0, 0], port));
    let listener = tokio::net::TcpListener::bind(addr)
        .await
        .unwrap_or_else(|e| panic!("falha ao bindar {addr}: {e}"));
    tracing::info!("servindo {data_dir} em http://{addr}/downloads");
    axum::serve(listener, app)
        .with_graceful_shutdown(shutdown_signal())
        .await
        .expect("servidor encerrou com erro");
}

async fn upload_manifest(
    State(cfg): State<Arc<UploadConfig>>,
    UrlPath((product, file)): UrlPath<(String, String)>,
    headers: HeaderMap,
    body: Bytes,
) -> (StatusCode, &'static str) {
    let authorized = headers
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .is_some_and(|t| constant_time_eq(t.as_bytes(), cfg.token.as_bytes()));
    if !authorized {
        return (StatusCode::UNAUTHORIZED, "token inválido\n");
    }

    // Segmentos de path do axum não contêm '/', mas '..' e nomes fora da
    // allowlist ainda precisam ser barrados.
    let safe_segment = |s: &str| {
        !s.is_empty() && s != "." && s != ".." && s.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
    };
    if !safe_segment(&product) || !safe_segment(&file) || !is_uploadable_manifest(&file) {
        return (StatusCode::FORBIDDEN, "só manifests (latest.json, SHA256SUMS)\n");
    }
    if body.is_empty() {
        return (StatusCode::BAD_REQUEST, "corpo vazio\n");
    }

    let dir = cfg.data_dir.join(&product);
    if let Err(e) = tokio::fs::create_dir_all(&dir).await {
        tracing::error!("criar {dir:?}: {e}");
        return (StatusCode::INTERNAL_SERVER_ERROR, "erro ao gravar\n");
    }
    // Escrita atômica: quem baixa o manifest nunca vê arquivo pela metade.
    let tmp = dir.join(format!(".{file}.tmp"));
    let dest = dir.join(&file);
    let write = async {
        tokio::fs::write(&tmp, &body).await?;
        tokio::fs::rename(&tmp, &dest).await
    };
    match write.await {
        Ok(()) => {
            tracing::info!("upload {product}/{file} ({} bytes)", body.len());
            (StatusCode::OK, "ok\n")
        }
        Err(e) => {
            tracing::error!("gravar {dest:?}: {e}");
            let _ = tokio::fs::remove_file(&tmp).await;
            (StatusCode::INTERNAL_SERVER_ERROR, "erro ao gravar\n")
        }
    }
}

fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

async fn set_download_headers(req: Request, next: Next) -> Response {
    let path = req.uri().path().to_owned();
    let mut res = next.run(req).await;
    if !path.starts_with("/downloads") || !res.status().is_success() {
        return res;
    }

    let headers = res.headers_mut();
    // O site (Next.js) e qualquer cliente podem ler o manifest de outro domínio.
    headers.insert(
        header::ACCESS_CONTROL_ALLOW_ORIGIN,
        HeaderValue::from_static("*"),
    );

    let lower = path.to_lowercase();
    if ARTIFACT_EXTENSIONS.iter().any(|ext| lower.ends_with(ext)) {
        headers.insert(
            header::CACHE_CONTROL,
            HeaderValue::from_static("public, max-age=31536000, immutable"),
        );
        if let Some(name) = path.rsplit('/').next() {
            if let Ok(value) = HeaderValue::from_str(&format!("attachment; filename=\"{name}\"")) {
                headers.insert(header::CONTENT_DISPOSITION, value);
            }
        }
    } else {
        // latest.json / SHA256SUMS: URL fixa, release novo precisa propagar rápido.
        headers.insert(
            header::CACHE_CONTROL,
            HeaderValue::from_static("public, max-age=300"),
        );
    }
    res
}

async fn shutdown_signal() {
    let ctrl_c = async {
        tokio::signal::ctrl_c()
            .await
            .expect("instalar handler de Ctrl+C");
    };

    #[cfg(unix)]
    let terminate = async {
        tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
            .expect("instalar handler de SIGTERM")
            .recv()
            .await;
    };

    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();

    tokio::select! {
        _ = ctrl_c => {},
        _ = terminate => {},
    }
}
