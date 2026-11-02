// An axum server written as the examples write it: on 127.0.0.1:8080, which Docker cannot
// forward to. DevLaunch reaches it through the loopback bridge.
use axum::{routing::get, Router};

#[tokio::main]
async fn main() {
    let app = Router::new().route("/", get(|| async { "hello from rust\n" }));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:8080").await.unwrap();
    println!("listening on 127.0.0.1:8080");
    axum::serve(listener, app).await.unwrap();
}
